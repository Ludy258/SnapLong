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
  const formatSegments = document.querySelectorAll('#formatSelect .seg-option');
  const delayInput = document.getElementById('delayInput');
  const delayValue = document.getElementById('delayValue');
  const savePathInput = document.getElementById('savePathInput');
  const saveAsCheck = document.getElementById('saveAsCheck');
  const savePathHint = document.getElementById('savePathHint');
  const messageSection = document.getElementById('messageSection');
  const messageText = document.getElementById('messageText');
  const headerBadge = document.querySelector('.header-badge');
  const badgeText = headerBadge?.querySelector('.badge-text');

  const shortcutLink = document.getElementById('shortcutSettingsLink');
  const themeSegments = document.querySelectorAll('#themeSelect .seg-option');
  const containerSection = document.getElementById('containerSection');
  const containerCheckList = document.getElementById('containerCheckList');
  const keepHeaderFooterCheck = document.getElementById('keepHeaderFooterCheck');

  let isCapturing = false;
  let currentFormat = 'png';
  let currentTheme = 'auto';
  let selectedContainerIndices = [];
  let primaryContainerIndex = 0;
  const MIN_SCROLL_DELAY = 500;
  const MAX_SCROLL_DELAY = 1500;

  btnCapture.disabled = true;
  btnViewport.disabled = true;

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
    const delay = normalizeScrollDelay(saved.scrollDelay);
    delayInput.value = delay;
    delayValue.textContent = `${delay}ms`;

    // 恢复格式选中状态
    setFormat(saved.format);
    updateSavePathHint();

    // 恢复主题
    currentTheme = saved.theme || 'auto';
    themeSegments.forEach(b => {
      const active = b.dataset.value === currentTheme;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    applyTheme(currentTheme);

    // 恢复保留页眉页脚
    if (saved.keepHeaderFooter) keepHeaderFooterCheck.checked = true;
  });

  // ===================== 快捷键 =====================

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
      scrollDelay: normalizeScrollDelay(delayInput.value),
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
      themeSegments.forEach(b => {
        const active = b.dataset.value === currentTheme;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      applyTheme(currentTheme);
      saveOptions();
    });
  });
  delayInput.addEventListener('input', () => {
    const delay = normalizeScrollDelay(delayInput.value);
    delayInput.value = delay;
    delayValue.textContent = `${delay}ms`;
    saveOptions();
  });

  function updateSavePathHint() {
    const folder = savePathInput.value.trim() || 'SnapLong';
    savePathHint.textContent = saveAsCheck.checked
      ? `每次确认  ~/Downloads/${folder}/`
      : `保存到  ~/Downloads/${folder}/`;
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
    formatSegments.forEach(b => {
      const active = b.dataset.value === value;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
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
        showMessage('Service Worker 未启动，请刷新扩展', 'error');
        return;
      }

      // 获取页面信息
      const resp = await getPageInfo(tab.id);

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

  async function getPageInfo(tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { action: 'getPageInfo' });
      if (response) return response;
    } catch (error) {
      console.warn('Content script not ready, injecting it:', error);
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js']
    });
    return chrome.tabs.sendMessage(tabId, { action: 'getPageInfo' });
  }

  function normalizeScrollDelay(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return MIN_SCROLL_DELAY;
    return Math.min(MAX_SCROLL_DELAY, Math.max(MIN_SCROLL_DELAY, Math.round(numeric / 50) * 50));
  }

  /**
   * 更新滚动容器选择器
   * 当页面有多个可滚动区域时显示多选列表（复选 + 主容器单选）
   */
  function updateContainerSelector(containers) {
    if (!containerSection || !containerCheckList) return;

    containerCheckList.innerHTML = '';
    selectedContainerIndices = [];
    primaryContainerIndex = 0;

    if (!containers || containers.length <= 1) {
      containerSection.style.display = 'none';
      return;
    }

    // 默认全勾选；主容器决定最终截图高度，因此优先选择最长的滚动区域。
    let maxScrollHeight = 0;
    let maxClientWidth = 0;
    for (const c of containers) {
      const isTaller = c.scrollHeight > maxScrollHeight;
      const hasSameHeightAndWiderViewport = c.scrollHeight === maxScrollHeight && c.clientWidth > maxClientWidth;
      if (isTaller || hasSameHeightAndWiderViewport) {
        maxScrollHeight = c.scrollHeight;
        maxClientWidth = c.clientWidth;
        primaryContainerIndex = c.index;
      }
    }
    selectedContainerIndices = containers.map(c => c.index);

    let rowIndex = 0;
    for (const c of containers) {
      const row = document.createElement('div');
      row.className = 'container-check-item';
      row.style.setProperty('--row-index', String(rowIndex++));

      // 主容器单选（自定义圆点）
      const radioWrap = document.createElement('label');
      radioWrap.className = 'cc-radio-wrap';
      radioWrap.title = '设为主容器（决定截图总高度）';
      const rb = document.createElement('input');
      rb.type = 'radio';
      rb.name = 'primaryContainer';
      rb.value = c.index;
      rb.checked = c.index === primaryContainerIndex;
      rb.addEventListener('change', () => {
        primaryContainerIndex = c.index;
        const checkbox = containerCheckList.querySelector(
          `input[type="checkbox"][data-index="${c.index}"]`
        );
        if (checkbox && !checkbox.checked) checkbox.checked = true;
        updateContainerBadges(containers);
        syncContainerSelection(containers);
      });
      const radioDot = document.createElement('span');
      radioDot.className = 'cc-radio-dot';
      radioWrap.appendChild(rb);
      radioWrap.appendChild(radioDot);
      row.appendChild(radioWrap);

      // 名称 + 尺寸
      const info = document.createElement('span');
      info.className = 'cc-info';
      const nameEl = document.createElement('span');
      nameEl.className = 'cc-name';
      nameEl.textContent = c.selector;
      const sizeEl = document.createElement('span');
      sizeEl.className = 'cc-size';
      const sizeLabel = c.scrollWidth > 9999
        ? `${(c.scrollWidth / 1000).toFixed(0)}k×${(c.scrollHeight / 1000).toFixed(0)}k`
        : `${c.scrollWidth}×${c.scrollHeight}`;
      sizeEl.textContent = sizeLabel;
      info.appendChild(nameEl);
      info.appendChild(sizeEl);
      row.appendChild(info);

      // 主容器徽章
      const badge = document.createElement('span');
      badge.className = 'cc-primary-badge';
      badge.textContent = '主';
      badge.dataset.containerIndex = c.index;
      if (c.index === primaryContainerIndex) badge.classList.add('active');
      row.appendChild(badge);

      // 截取开关（自定义 toggle）
      const toggleWrap = document.createElement('label');
      toggleWrap.className = 'cc-toggle-wrap';
      toggleWrap.title = '截取此区域';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.dataset.index = c.index;
      cb.addEventListener('change', () => syncContainerSelection(containers));
      const toggleTrack = document.createElement('span');
      toggleTrack.className = 'cc-toggle-track';
      toggleWrap.appendChild(cb);
      toggleWrap.appendChild(toggleTrack);
      row.appendChild(toggleWrap);

      containerCheckList.appendChild(row);
    }

    containerSection.style.display = 'block';
  }

  /** 更新主容器徽章和单选状态 */
  function updateContainerBadges(containers) {
    const badges = containerCheckList.querySelectorAll('.cc-primary-badge');
    badges.forEach(b => {
      const idx = parseInt(b.dataset.containerIndex);
      b.classList.toggle('active', idx === primaryContainerIndex);
    });
    const rbs = containerCheckList.querySelectorAll('input[type="radio"]');
    rbs.forEach(rb => { rb.checked = parseInt(rb.value) === primaryContainerIndex; });
  }

  /** 同步复选框勾选状态 */
  function syncContainerSelection(containers) {
    const checked = [];
    const cbs = containerCheckList.querySelectorAll('input[type="checkbox"]');
    cbs.forEach(cb => { if (cb.checked) checked.push(parseInt(cb.dataset.index)); });
    selectedContainerIndices = checked;

    // 若当前主容器被取消勾选，自动切到第一个勾选项
    if (!selectedContainerIndices.includes(primaryContainerIndex) && selectedContainerIndices.length > 0) {
      primaryContainerIndex = selectedContainerIndices[0];
      updateContainerBadges(containers);
    }

    saveOptions();
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
    if (isCapturing) return;
    isCapturing = true;
    btnCapture.disabled = btnViewport.disabled = true;

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('没有找到活动标签页');

      showProgress(true);
      showMessage('正在分析页面...', 'info');

      if (containerSection && containerSection.style.display !== 'none' && selectedContainerIndices.length === 0) {
        throw new Error('请至少选择一个滚动区域');
      }

      const hasContainerSelection = containerSection && containerSection.style.display !== 'none';
      const options = {
        format: currentFormat,
        scrollDelay: normalizeScrollDelay(delayInput.value),
        preScroll: true,
        savePath: savePathInput.value.trim() || 'SnapLong',
        saveAs: saveAsCheck.checked,
        scrollContainerIndices: hasContainerSelection ? selectedContainerIndices : undefined,
        primaryContainerIndex: hasContainerSelection ? primaryContainerIndex : undefined,
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
        const captureCount = response.totalCaptures ?? response.totalFrames ?? 0;
        showMessage(`截图完成：${captureCount} 帧，已导出 ${ext}。${where}`, 'success');
      } else {
        throw new Error(response?.error || '截图失败');
      }
    } catch (e) {
      showMessage(e.message, 'error');
      showProgress(false);
    } finally {
      isCapturing = false;
      btnCapture.disabled = btnViewport.disabled = false;
    }
  }

  async function captureViewport() {
    if (isCapturing) return;
    isCapturing = true;
    btnCapture.disabled = btnViewport.disabled = true;

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('没有找到活动标签页');

      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);

      await new Promise((resolve, reject) => {
        chrome.downloads.download({
          url: dataUrl,
          filename: `screenshot_${ts}.png`,
        }, (downloadId) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else if (!Number.isInteger(downloadId)) reject(new Error('下载未启动'));
          else resolve(downloadId);
        });
      });

      showMessage('截图已保存', 'success');
    } catch (e) {
      showMessage(e.message, 'error');
    } finally {
      isCapturing = false;
      btnCapture.disabled = btnViewport.disabled = false;
    }
  }

  // ===================== 进度 & 消息 =====================

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.action) {
      case 'captureProgress':
        progressBar.style.width = `${msg.percentage}%`;
        if (msg.containerTotal && msg.containerTotal > 1) {
          progressText.textContent = `容器 ${msg.containerCurrent}/${msg.containerTotal} · 帧 ${msg.current}/${msg.total}`;
        } else {
          progressText.textContent = `正在截图 ${msg.current}/${msg.total}`;
        }
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
