/**
 * Content Script - SnapLong
 *
 * 运行在页面上下文中，负责：
 * - 检测页面尺寸和滚动信息
 * - 识别并临时隐藏 fixed/sticky 元素
 * - 预滚动触发懒加载
 * - 按步进滚动并通知 background 截图
 */

let fixedElements = [];
let scrollContainers = [];
let selectedContainerIndex = 0;

// ===================== 工具函数 =====================

/**
 * 检测页面中所有可滚动的容器
 * 返回排序后的候选列表（scrollHeight 从大到小），排除狭窄元素（侧边栏）
 */
function detectScrollContainers() {
  const containers = [];
  const vw = window.innerWidth;
  const se = document.scrollingElement || document.documentElement;

  // 检查标准 viewport 滚动
  if (se.scrollHeight > se.clientHeight + 10) {
    containers.push({
      element: se,
      scrollHeight: se.scrollHeight,
      scrollWidth: se.scrollWidth,
      clientHeight: se.clientHeight,
      clientWidth: se.clientWidth,
      tagName: se.tagName.toLowerCase(),
      selector: '页面（默认滚动）',
    });
  }

  // 查找自定义滚动容器（overflow-y: auto/scroll）
  const allEls = document.querySelectorAll('*');
  for (const el of allEls) {
    const style = window.getComputedStyle(el);
    const oy = style.overflowY;
    if ((oy === 'auto' || oy === 'scroll') &&
        el.scrollHeight > el.clientHeight + 5 &&
        el.offsetWidth > 0 && el.offsetHeight > 0) {
      // 跳过窄元素（很可能是侧边栏）
      if (el.clientWidth < vw * 0.3 && el.clientWidth < 250) continue;

      // 生成可读的描述
      let sel = el.tagName.toLowerCase();
      if (el.id) sel += `#${el.id}`;
      else if (el.className && typeof el.className === 'string') {
        const firstClass = el.className.trim().split(/\s+/)[0];
        if (firstClass) sel += `.${firstClass}`;
      }

      containers.push({
        element: el,
        scrollHeight: el.scrollHeight,
        scrollWidth: el.scrollWidth,
        clientHeight: el.clientHeight,
        clientWidth: el.clientWidth,
        tagName: el.tagName.toLowerCase(),
        selector: sel,
      });
    }
  }

  // 按 scrollHeight 降序排列
  containers.sort((a, b) => b.scrollHeight - a.scrollHeight);
  containers.forEach((c, i) => c.index = i);

  return containers;
}

/**
 * 获取当前选中的滚动容器 DOM 元素
 */
function getScrollContainer() {
  if (scrollContainers.length === 0) return window;
  const c = scrollContainers[selectedContainerIndex];
  return c ? c.element : window;
}

/**
 * 获取页面的完整滚动尺寸
 * 自动使用检测到的滚动容器（支持自定义滚动区域）
 */
function getPageDimensions() {
  const container = getScrollContainer();
  const isNative = container === window || container === document.documentElement || container === document.body;

  let scrollW, scrollH, viewH;
  if (isNative) {
    const body = document.body;
    const html = document.documentElement;
    scrollW = Math.max(body.scrollWidth, html.scrollWidth, body.offsetWidth, html.offsetWidth, body.clientWidth, html.clientWidth);
    scrollH = Math.max(body.scrollHeight, html.scrollHeight, body.offsetHeight, html.offsetHeight, body.clientHeight, html.clientHeight);
    viewH = window.innerHeight;
  } else {
    scrollW = container.scrollWidth;
    scrollH = container.scrollHeight;
    viewH = container.clientHeight;
  }

  return {
    scrollWidth: scrollW,
    scrollHeight: scrollH,
    viewportWidth: window.innerWidth,
    viewportHeight: viewH,
    devicePixelRatio: window.devicePixelRatio || 1
  };
}

/**
 * 识别页面中的 fixed 和 sticky 元素
 */
function scanFixedElements() {
  fixedElements = [];

  const allElements = document.querySelectorAll('*');
  for (const el of allElements) {
    const style = window.getComputedStyle(el);
    if (style.position === 'fixed' || style.position === 'sticky') {
      // 检查元素是否可见且在视口中
      if (el.offsetWidth > 0 && el.offsetHeight > 0) {
        const rect = el.getBoundingClientRect();
        fixedElements.push({
          element: el,
          originalDisplay: el.style.display,
          originalVisibility: el.style.visibility,
          position: style.position,
          rect: {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height
          }
        });
      }
    }
  }

  return fixedElements.length;
}

/**
 * 临时隐藏 fixed/sticky 元素
 */
function hideFixedElements() {
  for (const item of fixedElements) {
    item.element.style.visibility = 'hidden';
  }
}

/**
 * 恢复 fixed/sticky 元素的显示
 */
function restoreFixedElements() {
  for (const item of fixedElements) {
    item.element.style.visibility = item.originalVisibility;
  }
}

/**
 * 预滚动页面以触发懒加载
 * 快速滚到底部，等待加载，再滚回顶部
 */
async function preScrollForLazyLoad() {
  const { scrollHeight, viewportHeight } = getPageDimensions();
  const totalScroll = scrollHeight - viewportHeight;
  const step = viewportHeight;

  const container = getScrollContainer();
  const isNative = container === window || container === document.documentElement || container === document.body;

  function doScroll(y) {
    if (isNative) window.scrollTo(0, y);
    else container.scrollTop = y;
  }

  // 向下快速滚动
  let currentScroll = 0;
  while (currentScroll < totalScroll) {
    currentScroll = Math.min(currentScroll + step, totalScroll);
    doScroll(currentScroll);
    // 触发 IntersectionObserver 等懒加载机制
    document.dispatchEvent(new Event('scroll'));
    // 小延迟让懒加载触发
    await sleep(30);
  }

  // 等待图片加载
  await waitForImagesLoaded();

  // 再等待一下，让可能的 API 请求完成
  await sleep(500);

  // 滚回顶部
  doScroll(0);
  document.dispatchEvent(new Event('scroll'));

  // 等待顶部内容稳定
  await sleep(200);
}

/**
 * 等待页面中所有图片加载完成
 */
function waitForImagesLoaded() {
  return new Promise((resolve) => {
    const images = document.images;
    const total = images.length;
    if (total === 0) {
      resolve();
      return;
    }

    let loaded = 0;
    function onLoad() {
      loaded++;
      if (loaded >= total) {
        resolve();
      }
    }

    for (const img of images) {
      if (img.complete) {
        loaded++;
      } else {
        img.addEventListener('load', onLoad);
        img.addEventListener('error', onLoad); // 加载失败也算完成
      }
    }

    // 如果所有图片已经完成
    if (loaded >= total) {
      resolve();
    }

    // 超时保护：最多等 5 秒
    setTimeout(resolve, 5000);
  });
}

/**
 * 滚动到指定位置并等待渲染完成
 * 支持自定义滚动容器
 */
function scrollToPosition(y) {
  return new Promise((resolve) => {
    const container = getScrollContainer();
    const isNative = container === window || container === document.documentElement || container === document.body;

    if (isNative) {
      window.scrollTo(0, y);
    } else {
      container.scrollTop = y;
    }

    document.dispatchEvent(new Event('scroll'));

    // 等待两次 requestAnimationFrame 确保渲染完成
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });
}

/**
 * Promise 化的 setTimeout
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ===================== 消息处理 =====================

/**
 * 处理来自 background script 或 popup 的消息
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'getPageInfo':
      handleGetPageInfo(sendResponse);
      return true; // 保持消息通道开放

    case 'startCapture':
      handleStartCapture(request, sendResponse);
      return true;

    case 'scrollTo':
      handleScrollTo(request, sendResponse);
      return true;

    case 'hideFixed':
      hideFixedElements();
      sendResponse({ success: true, count: fixedElements.length });
      return true;

    case 'restoreFixed':
      restoreFixedElements();
      sendResponse({ success: true });
      return true;

    default:
      sendResponse({ error: `Unknown action: ${request.action}` });
      return true;
  }
});

function handleGetPageInfo(sendResponse) {
  // 检测滚动容器
  scrollContainers = detectScrollContainers();
  selectedContainerIndex = 0;

  const dims = getPageDimensions();
  const fixedCount = scanFixedElements();

  // 返回容器列表（不含 DOM 引用，可序列化）
  const containerList = scrollContainers.map(c => ({
    index: c.index,
    scrollHeight: c.scrollHeight,
    scrollWidth: c.scrollWidth,
    clientWidth: c.clientWidth,
    tagName: c.tagName,
    selector: c.selector,
  }));

  sendResponse({
    success: true,
    dimensions: dims,
    fixedElementCount: fixedCount,
    url: location.href,
    title: document.title,
    scrollContainers: containerList,
    autoSelectedIndex: 0,
  });
}

async function handleStartCapture(request, sendResponse) {
  try {
    const options = request.options || {};

    // 重新检测滚动容器（如果尚未检测）
    if (scrollContainers.length === 0) {
      scrollContainers = detectScrollContainers();
    }

    // 确定要截取的容器列表
    let indices;
    if (options.scrollContainerIndices && options.scrollContainerIndices.length > 0) {
      indices = options.scrollContainerIndices.filter(i => scrollContainers[i]);
    } else if (options.scrollContainerIndex !== undefined && scrollContainers[options.scrollContainerIndex]) {
      // 向后兼容：单容器模式
      indices = [options.scrollContainerIndex];
    } else {
      // 默认：全选
      indices = scrollContainers.map((_, i) => i);
    }

    // 扫描 fixed 元素
    scanFixedElements();

    // 预滚动触发懒加载（用最大容器）
    if (options.preScroll !== false && indices.length > 0) {
      const saveIdx = selectedContainerIndex;
      selectedContainerIndex = indices[0]; // 用第一个选中的做懒加载
      await preScrollForLazyLoad();
      selectedContainerIndex = saveIdx;
    }

    // 为每个容器生成独立的 capture plan
    const containerPlans = [];

    for (const idx of indices) {
      selectedContainerIndex = idx;
      const c = scrollContainers[idx];
      if (!c) continue;

      const isNative = c.element === window || c.element === document.documentElement || c.element === document.body;

      // 容器尺寸
      const viewH = isNative ? window.innerHeight : c.element.clientHeight;
      const scrollH = isNative
        ? Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
        : c.element.scrollHeight;
      const maxScroll = Math.max(0, scrollH - viewH);

      // 步进
      const stepHeight = Math.floor(viewH * 0.8);

      // 滚动位置列表
      const positions = [];
      let currentY = 0;
      while (currentY < maxScroll) {
        positions.push(currentY);
        currentY += stepHeight;
      }
      if (positions.length === 0 || positions[positions.length - 1] < maxScroll) {
        positions.push(maxScroll);
      }
      if (positions.length >= 2 && positions[positions.length - 1] === positions[positions.length - 2]) {
        positions.pop();
      }

      // 裁剪区域
      let cropRect = null;
      if (!isNative) {
        const r = c.element.getBoundingClientRect();
        cropRect = {
          top: Math.round(r.top),
          left: Math.round(r.left),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      }

      containerPlans.push({
        containerIndex: idx,
        positions,
        viewportWidth: window.innerWidth,
        viewportHeight: viewH,
        devicePixelRatio: window.devicePixelRatio || 1,
        scalarHeight: scrollH,
        isNative,
        cropRect,
      });
    }

    // 恢复默认选中
    selectedContainerIndex = indices[0] || 0;

    sendResponse({
      success: true,
      containerPlans,
      fixedElementCount: fixedElements.length,
    });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function handleScrollTo(request, sendResponse) {
  try {
    // 支持指定容器索引（多容器模式）
    if (request.containerIndex !== undefined && scrollContainers[request.containerIndex]) {
      const prev = selectedContainerIndex;
      selectedContainerIndex = request.containerIndex;
      await scrollToPosition(request.y);
      selectedContainerIndex = prev;
    } else {
      await scrollToPosition(request.y);
    }
    sendResponse({ success: true });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

// 通知 background script 已加载
chrome.runtime.sendMessage({ action: 'contentScriptReady', url: location.href });
