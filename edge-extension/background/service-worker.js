/**
 * Service Worker - SnapLong
 *
 * Manifest V3 Service Worker
 * 负责：协调截图 → 委托 offscreen 拼接 → SW 下载
 */

let captureState = {
  isCapturing: false, tabId: null, options: {},
  frames: [], totalPositions: [], currentIndex: 0,
  pageInfo: null, capturePlan: null,
};

// ===================== 消息处理 =====================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'startCapture':
      handleStartCapture(request, sender.tab?.id || request.tabId, sendResponse);
      return true;
    case 'ping':
      sendResponse({ success: true, alive: true });
      return true;
    case 'contentScriptReady':
      sendResponse({ success: true });
      return true;
    default:
      sendResponse({ error: 'Unknown: ' + request.action });
      return true;
  }
});

// ===================== 快捷键处理 =====================

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'capture-long-screenshot') {
    console.log('[SnapLong] Shortcut triggered: capture-long-screenshot');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) return;

      // 注入 content script（如果尚未注入）
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/content.js']
        });
      } catch (e) {}

      // 读取保存的设置，直接启动截图（避免自消息不可靠）
      const saved = await chrome.storage.local.get({
        format: 'png', scrollDelay: 500, savePath: 'SnapLong', saveAs: false
      });

      handleStartCapture(
        {
          options: {
            format: saved.format,
            scrollDelay: saved.scrollDelay,
            preScroll: true,
            savePath: saved.savePath,
            saveAs: saved.saveAs,
          }
        },
        tab.id,
        (response) => {
          if (!response.success) {
            console.error('[SnapLong] Shortcut capture error:', response.error);
          }
        }
      );
    } catch (e) {
      console.error('[SnapLong] Shortcut error:', e);
    }
  }
});

// ===================== 截图流程 =====================

async function handleStartCapture(request, tabId, sendResponse) {
  if (!tabId) { sendResponse({ success: false, error: 'No tab ID' }); return; }
  if (captureState.isCapturing) { sendResponse({ success: false, error: 'Already capturing' }); return; }

  const options = request.options || {};

  try {
    // 1. 获取页面信息
    const pageInfo = await sendMessageToTab(tabId, { action: 'getPageInfo' });
    if (!pageInfo?.success) throw new Error('Get page info failed: ' + (pageInfo?.error || 'no response'));

    // 2. 准备截图
    const capturePlan = await sendMessageToTab(tabId, { action: 'startCapture', options });
    if (!capturePlan?.success) throw new Error('Prepare capture failed: ' + (capturePlan?.error || 'no response'));

    captureState.isCapturing = true;
    captureState.tabId = tabId;
    captureState.options = options;
    captureState.frames = [];
    captureState.totalPositions = capturePlan.positions || [];
    captureState.currentIndex = 0;
    captureState.pageInfo = pageInfo;
    captureState.capturePlan = capturePlan;

    // 3. 隐藏 fixed 元素
    if (capturePlan.fixedElementCount > 0) {
      try { await sendMessageToTab(tabId, { action: 'hideFixed' }); } catch (e) {}
    }

    // 4. 逐位置截图（间隔 500ms 避免限频）
    for (let i = 0; i < captureState.totalPositions.length; i++) {
      if (!captureState.isCapturing) break;
      captureState.currentIndex = i;

      try { await sendMessageToTab(tabId, { action: 'scrollTo', y: captureState.totalPositions[i] }); } catch (e) {}
      await sleep(500);

      const dataUrl = await captureVisibleTab();
      if (dataUrl) {
        captureState.frames.push({
          dataUrl,
          y: Math.round(captureState.totalPositions[i] * (capturePlan.devicePixelRatio || 1)),
        });
      }
      notifyProgress(i + 1, captureState.totalPositions.length);
    }

    // 5. 恢复 fixed + 滚回顶部
    try {
      if (capturePlan.fixedElementCount > 0) await sendMessageToTab(tabId, { action: 'restoreFixed' });
      await sendMessageToTab(tabId, { action: 'scrollTo', y: 0 });
    } catch (e) {}

    if (captureState.frames.length === 0) throw new Error('No frames captured');

    // 6. 创建 offscreen 文档做拼接
    await createOffscreen();

    const format = options.format || 'png';
    console.log('[SnapLong] Sending', captureState.frames.length, 'frames to offscreen...');

    const stitchResult = await chrome.runtime.sendMessage({
      action: 'stitch',
      frames: captureState.frames.map(f => ({ dataUrl: f.dataUrl, y: f.y })),
      viewportWidth: capturePlan.viewportWidth,
      viewportHeight: capturePlan.viewportHeight,
      devicePixelRatio: capturePlan.devicePixelRatio || 1,
      format,
      cropRect: capturePlan.cropRect || null,
    });

    if (!stitchResult?.success) {
      throw new Error('Stitch failed: ' + (stitchResult?.error || 'unknown'));
    }

    // 7. 从 SW 直接下载（data URL 可直接传给 chrome.downloads.download）
    const dataUrl = stitchResult.dataUrl;
    const saveOptions = {
      subfolder: options.savePath || 'SnapLong',
      saveAs: options.saveAs === true
    };
    const filename = generateFilename(pageInfo.title || 'screenshot', format, saveOptions);

    console.log('[SnapLong] Downloading:', filename, 'size:', Math.round(dataUrl.length / 1024), 'KB');

    chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: saveOptions.saveAs,
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('[SnapLong] Download error:', chrome.runtime.lastError.message);
      } else {
        console.log('[SnapLong] Download started, id:', downloadId);
      }
    });

    cleanup();
    sendResponse({ success: true, totalCaptures: captureState.frames.length });

  } catch (error) {
    console.error('[SnapLong] Error:', error);
    cleanup();
    sendResponse({ success: false, error: error.message });
  }
}

// ===================== Offscreen 管理 =====================

async function createOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (existing) return;

  await chrome.offscreen.createDocument({
    url: 'background/offscreen.html',
    reasons: ['DOM_SCRAPING', 'BLOBS'],
    justification: 'Stitch screenshots on canvas',
  });
  console.log('[SnapLong] Offscreen created');
  await sleep(300);
}

async function closeOffscreen() {
  try {
    const existing = await chrome.offscreen.hasDocument();
    if (existing) await chrome.offscreen.closeDocument();
  } catch (e) {}
}

// ===================== 辅助 =====================

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (r) => {
      chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(r);
    });
  });
}

function captureVisibleTab() {
  return new Promise((resolve) => {
    chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) { console.error('[SnapLong] captureVisibleTab error:', chrome.runtime.lastError.message); resolve(null); }
      else { resolve(dataUrl); }
    });
  });
}

function generateFilename(title, format, saveOptions) {
  const ext = format === 'pdf' ? 'pdf' : (format === 'jpeg' ? 'jpg' : 'png');
  const sanitized = title.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').substring(0, 100);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const basename = `${sanitized || 'screenshot'}_${ts}.${ext}`;
  if (saveOptions?.subfolder) {
    const folder = saveOptions.subfolder.replace(/[<>:"\\|?*]/g, '_').trim();
    return folder ? `${folder}/${basename}` : basename;
  }
  return basename;
}

function cleanup() {
  captureState = { isCapturing: false, tabId: null, options: {}, frames: [], totalPositions: [], currentIndex: 0, pageInfo: null, capturePlan: null };
  closeOffscreen();
}

function notifyProgress(current, total) {
  chrome.runtime.sendMessage({ action: 'captureProgress', current, total, percentage: Math.round((current / total) * 100) }).catch(() => {});
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

console.log('[SnapLong] Service Worker loaded');
