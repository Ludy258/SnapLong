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

const CAPTURE_INTERVAL_MS = 500;
const MAX_SCROLL_DELAY_MS = 1500;
let lastCaptureAt = 0;

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
    case 'stitch':
      // Handled by offscreen document — don't respond here
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

      // 读取保存的设置，直接启动截图（避免自消息不可靠）
      const saved = await chrome.storage.local.get({
        format: 'png', scrollDelay: 500, savePath: 'SnapLong', saveAs: false, keepHeaderFooter: false
      });

      handleStartCapture(
        {
          options: {
            format: saved.format,
            scrollDelay: saved.scrollDelay,
            preScroll: true,
            savePath: saved.savePath,
            saveAs: saved.saveAs,
            keepHeaderFooter: saved.keepHeaderFooter,
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
  let capturePlan = null;
  let fixedHidden = false;
  let pageStateRestored = false;

  captureState.isCapturing = true;
  captureState.tabId = tabId;
  captureState.options = options;

  try {
    const targetTab = await chrome.tabs.get(tabId);
    if (!targetTab?.active) {
      throw new Error('请保持目标页面处于当前活动标签页');
    }
    const captureWindowId = targetTab.windowId;

    // 1. 获取页面信息
    const pageInfo = await getPageInfoFromTab(tabId);
    if (!pageInfo?.success) throw new Error('Get page info failed: ' + (pageInfo?.error || 'no response'));

    // 2. 准备截图（返回 containerPlans[]）
    capturePlan = await sendMessageToTab(tabId, { action: 'startCapture', options });
    if (!capturePlan?.success) throw new Error('Prepare capture failed: ' + (capturePlan?.error || 'no response'));

    const containerPlans = capturePlan.containerPlans || [];
    if (containerPlans.length === 0) throw new Error('No containers to capture');

    captureState.pageInfo = pageInfo;
    captureState.capturePlan = capturePlan;

    const primaryIdx = Number.isInteger(options.primaryContainerIndex)
      ? options.primaryContainerIndex
      : 0;
    const hasCustomContainer = containerPlans.some(p => p.cropRect);
    const shouldHideFixed = capturePlan.fixedElementCount > 0 &&
      containerPlans.some(p => p.positions.length > 1);
    const requestedDelay = Number(options.scrollDelay);
    const scrollDelay = Number.isFinite(requestedDelay)
      ? Math.min(MAX_SCROLL_DELAY_MS, Math.max(CAPTURE_INTERVAL_MS, requestedDelay))
      : CAPTURE_INTERVAL_MS;

    // 3a. 上下文帧（完整视口，保留 fixed）
    let contextFrame = null;
    if (options.keepHeaderFooter && hasCustomContainer) {
      contextFrame = await captureVisibleTab(captureWindowId, tabId);
    }

    // 3b. 隐藏 fixed 元素
    if (shouldHideFixed) {
      await sendMessageToTab(tabId, { action: 'hideFixed' });
      fixedHidden = true;
    }

    // 4. 为每个容器独立滚动截图
    const containerStrips = [];
    let globalFrameIdx = 0;

    // 计算总帧数（用于进度）
    const totalFrames = containerPlans.reduce((sum, p) => sum + p.positions.length, 0);

    for (let ci = 0; ci < containerPlans.length; ci++) {
      if (!captureState.isCapturing) break;

      const plan = containerPlans[ci];
      const frames = [];

      for (let fi = 0; fi < plan.positions.length; fi++) {
        if (!captureState.isCapturing) break;

        const y = plan.positions[fi];
        const scrollResult = await sendMessageToTab(tabId, {
          action: 'scrollTo', y, containerIndex: plan.containerIndex
        });
        if (!scrollResult?.success) {
          throw new Error(scrollResult?.error || `Scroll failed at ${y}px`);
        }
        await sleep(scrollDelay);

        const dataUrl = await captureVisibleTab(captureWindowId, tabId);
        const actualY = Number.isFinite(scrollResult.y) ? scrollResult.y : y;
        frames.push({
          dataUrl,
          y: Math.round(actualY * (plan.devicePixelRatio || 1)),
        });
        globalFrameIdx++;
        notifyProgress({
          current: fi + 1,
          total: plan.positions.length,
          containerCurrent: ci + 1,
          containerTotal: containerPlans.length,
          percentage: Math.round((globalFrameIdx / totalFrames) * 100),
        });
      }

      if (frames.length > 0) {
        containerStrips.push({
          containerIndex: plan.containerIndex,
          cropRect: plan.cropRect,
          viewportHeight: plan.viewportHeight,
          frames,
        });
      }
    }

    // 5. 恢复 fixed + 用户开始截图前的滚动位置
    await restorePageState(tabId, capturePlan, fixedHidden);
    pageStateRestored = true;

    if (containerStrips.length === 0) throw new Error('No frames captured');

    // 6. 创建 offscreen 做拼接
    await createOffscreen();

    const format = options.format || 'png';
    console.log('[SnapLong] Sending', containerStrips.length, 'container strips to offscreen...');

    const stitchResult = await chrome.runtime.sendMessage({
      action: 'stitch',
      containerStrips,
      primaryContainerIndex: primaryIdx,
      viewportWidth: pageInfo.dimensions?.viewportWidth || containerPlans[0]?.viewportWidth,
      devicePixelRatio: containerPlans[0]?.devicePixelRatio || 1,
      format,
      contextFrame,
    });

    if (!stitchResult?.success) {
      throw new Error('Stitch failed: ' + (stitchResult?.error || 'unknown'));
    }

    // 7. 下载
    const dataUrl = stitchResult.dataUrl;
    const saveOptions = {
      subfolder: options.savePath || 'SnapLong',
      saveAs: options.saveAs === true
    };
    const filename = generateFilename(pageInfo.title || 'screenshot', format, saveOptions);

    console.log('[SnapLong] Downloading:', filename, 'size:', Math.round(dataUrl.length / 1024), 'KB');

    const downloadId = await downloadDataUrl(dataUrl, filename, saveOptions.saveAs);
    console.log('[SnapLong] Download started, id:', downloadId);

    sendResponse({ success: true, totalFrames: globalFrameIdx, totalCaptures: globalFrameIdx });

  } catch (error) {
    console.error('[SnapLong] Error:', error);
    sendResponse({ success: false, error: error.message });
  } finally {
    if (!pageStateRestored && capturePlan) {
      await restorePageState(tabId, capturePlan, fixedHidden);
    }
    cleanup();
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

async function getPageInfoFromTab(tabId) {
  try {
    const response = await sendMessageToTab(tabId, { action: 'getPageInfo' });
    if (response) return response;
  } catch (error) {
    console.warn('[SnapLong] Content script not ready, injecting it:', error.message);
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/content.js']
  });
  return sendMessageToTab(tabId, { action: 'getPageInfo' });
}

async function captureVisibleTab(windowId, tabId) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = Math.max(0, CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt));
    if (wait > 0) await sleep(wait);

    try {
      const activeTab = await chrome.tabs.get(tabId);
      if (!activeTab?.active || activeTab.windowId !== windowId) {
        throw new Error('截图过程中请保持目标页面为当前活动标签页');
      }
      const dataUrl = await captureVisibleTabOnce(windowId);
      if (!dataUrl) throw new Error('captureVisibleTab returned no image');
      return dataUrl;
    } catch (error) {
      lastError = error;
      console.warn(`[SnapLong] captureVisibleTab attempt ${attempt + 1} failed:`, error.message);
      await sleep(CAPTURE_INTERVAL_MS);
    }
  }
  throw lastError || new Error('captureVisibleTab failed');
}

function captureVisibleTabOnce(windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
      lastCaptureAt = Date.now();
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(dataUrl);
      }
    });
  });
}

async function restorePageState(tabId, capturePlan, fixedHidden) {
  if (!capturePlan) return;

  if (fixedHidden || capturePlan.fixedElementCount > 0) {
    try {
      await sendMessageToTab(tabId, { action: 'restoreFixed' });
    } catch (error) {
      console.warn('[SnapLong] Failed to restore fixed elements:', error.message);
    }
  }

  const restored = new Set();
  for (const plan of capturePlan.containerPlans || []) {
    if (restored.has(plan.containerIndex)) continue;
    restored.add(plan.containerIndex);
    try {
      await sendMessageToTab(tabId, {
        action: 'scrollTo',
        y: Number.isFinite(plan.initialScrollY) ? plan.initialScrollY : 0,
        x: Number.isFinite(plan.initialScrollX) ? plan.initialScrollX : 0,
        containerIndex: plan.containerIndex,
      });
    } catch (error) {
      console.warn('[SnapLong] Failed to restore scroll position:', error.message);
    }
  }
}

function downloadDataUrl(url, filename, saveAs) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs }, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!Number.isInteger(downloadId)) {
        reject(new Error('Download did not start'));
      } else {
        resolve(downloadId);
      }
    });
  });
}

function generateFilename(title, format, saveOptions) {
  const ext = format === 'pdf' ? 'pdf' : (format === 'jpeg' ? 'jpg' : 'png');
  const sanitized = title.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').substring(0, 100);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const basename = `${sanitized || 'screenshot'}_${ts}.${ext}`;
  if (saveOptions?.subfolder) {
    const folder = saveOptions.subfolder
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\.\.+/g, '_')
      .replace(/[\u0000-\u001f]/g, '_')
      .trim();
    return folder ? `${folder}/${basename}` : basename;
  }
  return basename;
}

function cleanup() {
  captureState = { isCapturing: false, tabId: null, options: {}, frames: [], totalPositions: [], currentIndex: 0, pageInfo: null, capturePlan: null };
  closeOffscreen();
}

function notifyProgress({ current, total, containerCurrent, containerTotal, percentage }) {
  chrome.runtime.sendMessage({
    action: 'captureProgress',
    current, total, containerCurrent, containerTotal, percentage
  }).catch(() => {});
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

console.log('[SnapLong] Service Worker loaded');
