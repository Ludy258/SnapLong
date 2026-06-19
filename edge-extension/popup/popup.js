/**
 * Popup - SnapLong
 */

document.addEventListener('DOMContentLoaded', () => {
  // DOM
  const btnCapture = document.getElementById('btnCapture');
  const btnViewport = document.getElementById('btnCaptureViewport');
  const progressSection = document.getElementById('progressSection');
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');
  const progressDetail = document.getElementById('progressDetail');
  const progressPercentage = document.getElementById('progressPercentage');
  const formatSegments = document.querySelectorAll('.seg-option');
  const delayInput = document.getElementById('delayInput');
  const delayValue = document.getElementById('delayValue');
  const savePathInput = document.getElementById('savePathInput');
  const saveAsCheck = document.getElementById('saveAsCheck');
  const savePathHint = document.getElementById('savePathHint');
  const messageSection = document.getElementById('messageSection');
  const messageText = document.getElementById('messageText');
  const headerBadge = document.querySelector('.header-badge');
  const badgeText = headerBadge?.querySelector('.badge-text');

  const keyPopup = document.getElementById('key-popup');
  const keyCapture = document.getElementById('key-capture');
  const shortcutLink = document.getElementById('shortcutSettingsLink');
  const container = document.querySelector('.container');
  const themeSegments = document.querySelectorAll('#themeSelect .seg-option');
  const containerSection = document.getElementById('containerSection');
  const containerSelect = document.getElementById('containerSelect');
  const keepHeaderFooterCheck = document.getElementById('keepHeaderFooterCheck');

  let isCapturing = false;
  let currentFormat = 'png';
  let currentTheme = 'auto';
  let scrollContainerIndex = 0;

  // 应用主题
  function applyTheme(mode) {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = mode === 'dark' || (mode === 'auto' && prefersDark);
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  }

  // 监听系统主题变化
  const darkModeMedia = window.matchMedia('(prefers-color-scheme: dark)');
  darkModeMedia.addEventListener('change', () => {
    if (currentTheme === 'auto') {
      applyTheme('auto');
    }
  });

  // ===================== 初始化 =====================

  // 恢复保存的设置
  chrome.storage.local.get({
    savePath: '', saveAs: false, format: 'png', scrollDelay: 500, theme: 'auto', keepHeaderFooter: false
  }, (saved) => {
    if (saved.savePath) savePathInput.value = saved.savePath;
    saveAsCheck.checked = saved.saveAs;
    delayInput.value = saved.scrollDelay;
    delayValue.textContent = `${saved.scrollDelay}ms`;

    // 恢复格式选中状态
    setFormat(saved.format);
    updateSavePathHint();

    // 恢复主题
    currentTheme = saved.theme || 'auto';
    themeSegments.forEach(b => b.classList.toggle('active', b.dataset.value === currentTheme));
    applyTheme(currentTheme);

    // 恢复保留页眉页脚
    if (saved.keepHeaderFooter) keepHeaderFooterCheck.checked = true;
  });

  // ===================== 快捷键 =====================

  // 读取当前快捷键绑定
  chrome.commands.getAll((commands) => {
    for (const cmd of commands) {
      if (cmd.name === '_execute_action' && keyPopup) {
        keyPopup.textContent = cmd.shortcut || '未设置';
      }
      if (cmd.name === 'capture-long-screenshot' && keyCapture) {
        keyCapture.textContent = cmd.shortcut || '未设置';
      }
    }
  });

  // 点击跳转快捷键设置
  if (shortcutLink) {
    shortcutLink.addEventListener('click', (e) => {
      e.preventDefault();
      const isEdge = navigator.userAgent.includes('Edg');
      chrome.tabs.create({ url: isEdge ? 'edge://extensions/shortcuts' : 'chrome://extensions/shortcuts' });
    });
  }

  // 自动保存设置
  function saveOptions() {
    chrome.storage.local.set({
      savePath: savePathInput.value.trim(),
      saveAs: saveAsCheck.checked,
      format: currentFormat,
      scrollDelay: parseInt(delayInput.value) || 500,
      theme: currentTheme,
      keepHeaderFooter: keepHeaderFooterCheck.checked
    });
  }

  savePathInput.addEventListener('input', () => { updateSavePathHint(); saveOptions(); });
  saveAsCheck.addEventListener('change', () => { updateSavePathHint(); saveOptions(); });
  keepHeaderFooterCheck.addEventListener('change', saveOptions);

  // 主题切换
  themeSegments.forEach(btn => {
    btn.addEventListener('click', () => {
      currentTheme = btn.dataset.value;
      themeSegments.forEach(b => b.classList.toggle('active', b.dataset.value === currentTheme));
      applyTheme(currentTheme);
      saveOptions();
    });
  });
  delayInput.addEventListener('input', () => {
    delayValue.textContent = `${delayInput.value}ms`;
    saveOptions();
  });

  function updateSavePathHint() {
    const folder = savePathInput.value.trim() || 'SnapLong';
    savePathHint.textContent = saveAsCheck.checked
      ? `📂 ~/Downloads/${folder}/  (每次询问)`
      : `📁 ~/Downloads/${folder}/`;
  }

  // ===================== 格式切换 =====================

  formatSegments.forEach(btn => {
    btn.addEventListener('click', () => {
      setFormat(btn.dataset.value);
      saveOptions();
    });
  });

  function setFormat(value) {
    currentFormat = value;
    formatSegments.forEach(b => b.classList.toggle('active', b.dataset.value === value));
  }

  // ===================== 状态检测 =====================

  detectPageInfo();

  async function detectPageInfo() {
    setBadge('检测中', 'warning');

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
        setBadge('不支持此页面', 'error');
        btnCapture.disabled = btnViewport.disabled = true;
        return;
      }

      // 检查 Service Worker
      const swAlive = await pingSW();
      if (!swAlive) {
        setBadge('Service Worker 未响应', 'error');
        btnCapture.disabled = btnViewport.disabled = true;
        showMessage('⚠️ Service Worker 未启动，请刷新扩展', 'error');
        return;
      }

      // 注入 content script
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/content.js']
        });
      } catch (e) {}

      // 获取页面信息
      const resp = await chrome.tabs.sendMessage(tab.id, { action: 'getPageInfo' });

      if (resp?.success) {
        const d = resp.dimensions;
        setBadge(`${d.scrollWidth}×${d.scrollHeight}`, 'loaded');
        btnCapture.disabled = btnViewport.disabled = false;

        // 处理多滚动容器选择
        updateContainerSelector(resp.scrollContainers);
      } else {
        setBadge('无法获取页面信息', 'error');
      }
    } catch (e) {
      setBadge('连接失败', 'error');
      console.error(e);
    }
  }

  /**
   * 更新滚动容器选择器
   * 当页面有多个可滚动区域时显示供用户选择
   */
  function updateContainerSelector(containers) {
    if (!containerSection || !containerSelect) return;

    // 清空并重置
    containerSelect.innerHTML = '';
    scrollContainerIndex = 0;

    // 只有多容器时才显示选择器
    if (!containers || containers.length <= 1) {
      containerSection.style.display = 'none';
      return;
    }

    // 填充选项
    for (const c of containers) {
      const opt = document.createElement('option');
      opt.value = c.index;
      const sizeLabel = c.scrollWidth > 9999
        ? `${(c.scrollWidth / 1000).toFixed(0)}k×${(c.scrollHeight / 1000).toFixed(0)}k`
        : `${c.scrollWidth}×${c.scrollHeight}`;
      opt.textContent = `${c.selector} (${sizeLabel})`;
      containerSelect.appendChild(opt);
    }

    containerSelect.value = '0';
    containerSection.style.display = 'block';
  }

  // 容器选择变更
  if (containerSelect) {
    containerSelect.addEventListener('change', () => {
      scrollContainerIndex = parseInt(containerSelect.value) || 0;
    });
  }

  function setBadge(text, type) {
    if (badgeText) badgeText.textContent = text;
    if (headerBadge) {
      headerBadge.className = 'header-badge';
      if (type) headerBadge.classList.add(type);
    }
  }

  async function pingSW() {
    try {
      const r = await chrome.runtime.sendMessage({ action: 'ping' });
      return r?.success;
    } catch { return false; }
  }

  // ===================== 截图 =====================

  btnCapture.addEventListener('click', () => { if (!isCapturing) startCapture(); });
  btnViewport.addEventListener('click', () => { if (!isCapturing) captureViewport(); });

  async function startCapture() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('没有找到活动标签页');

      isCapturing = true;
      btnCapture.disabled = btnViewport.disabled = true;
      showProgress(true);
      showMessage('⏳ 正在分析页面...', 'info');

      const options = {
        format: currentFormat,
        scrollDelay: parseInt(delayInput.value),
        preScroll: true,
        savePath: savePathInput.value.trim() || 'SnapLong',
        saveAs: saveAsCheck.checked,
        scrollContainerIndex: scrollContainerIndex,
        keepHeaderFooter: keepHeaderFooterCheck.checked
      };

      const response = await chrome.runtime.sendMessage({
        action: 'startCapture', tabId: tab.id, options
      });

      showProgress(false);

      if (response?.success) {
        const ext = { png: 'PNG', jpeg: 'JPG', pdf: 'PDF' }[currentFormat] || 'PNG';
        const where = options.saveAs
          ? '请在对话框中选择保存位置'
          : `已保存到 ~/Downloads/${options.savePath}/`;
        showMessage(`✅ 截图完成！${response.totalCaptures} 帧 → ${ext}  ${where}`, 'success');
      } else {
        throw new Error(response?.error || '截图失败');
      }
    } catch (e) {
      showMessage(`❌ ${e.message}`, 'error');
      showProgress(false);
    } finally {
      isCapturing = false;
      btnCapture.disabled = btnViewport.disabled = false;
    }
  }

  async function captureViewport() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('没有找到活动标签页');

      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);

      chrome.downloads.download({
        url: dataUrl,
        filename: `screenshot_${ts}.png`,
      });

      showMessage('✅ 截图已保存', 'success');
    } catch (e) {
      showMessage(`❌ ${e.message}`, 'error');
    }
  }

  // ===================== 进度 & 消息 =====================

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.action) {
      case 'captureProgress':
        progressBar.style.width = `${msg.percentage}%`;
        progressText.textContent = `正在截图 ${msg.current}/${msg.total}`;
        progressDetail.textContent = `第 ${msg.current} 帧`;
        progressPercentage.textContent = `${msg.percentage}%`;
        break;
      case 'captureMessage':
        if (msg.text) progressText.textContent = msg.text;
        break;
    }
  });

  function showProgress(show) {
    progressSection.classList.toggle('active', show);
    if (show) {
      progressBar.style.width = '0%';
      progressText.textContent = '准备中...';
      progressDetail.textContent = '正在截图';
      progressPercentage.textContent = '0%';
    }
  }

  function showMessage(text, type = 'info') {
    messageSection.className = 'message show ' + type;
    messageText.textContent = text;
    if (type !== 'error') {
      setTimeout(() => { messageSection.className = 'message hidden'; }, 5000);
    }
  }

});
