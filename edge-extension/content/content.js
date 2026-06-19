/**
 * Content Script - PrintScreen 长截图
 *
 * 运行在页面上下文中，负责：
 * - 检测页面尺寸和滚动信息
 * - 识别并临时隐藏 fixed/sticky 元素
 * - 预滚动触发懒加载
 * - 按步进滚动并通知 background 截图
 */

let fixedElements = [];

// ===================== 工具函数 =====================

/**
 * 获取页面的完整滚动尺寸
 */
function getPageDimensions() {
  const body = document.body;
  const html = document.documentElement;

  return {
    scrollWidth: Math.max(
      body.scrollWidth, html.scrollWidth,
      body.offsetWidth, html.offsetWidth,
      body.clientWidth, html.clientWidth
    ),
    scrollHeight: Math.max(
      body.scrollHeight, html.scrollHeight,
      body.offsetHeight, html.offsetHeight,
      body.clientHeight, html.clientHeight
    ),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
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

  // 向下快速滚动
  let currentScroll = 0;
  while (currentScroll < totalScroll) {
    currentScroll = Math.min(currentScroll + step, totalScroll);
    window.scrollTo(0, currentScroll);
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
  window.scrollTo(0, 0);
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
 */
function scrollToPosition(y) {
  return new Promise((resolve) => {
    window.scrollTo(0, y);
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
  const dims = getPageDimensions();
  const fixedCount = scanFixedElements();

  sendResponse({
    success: true,
    dimensions: dims,
    fixedElementCount: fixedCount,
    url: location.href,
    title: document.title
  });
}

async function handleStartCapture(request, sendResponse) {
  try {
    const options = request.options || {};

    // 扫描 fixed 元素
    scanFixedElements();

    if (options.preScroll !== false) {
      await preScrollForLazyLoad();
    }

    // 重新获取尺寸（懒加载后可能变化）
    const dims = getPageDimensions();

    // 计算滚动步进（viewport 高度的 80%，保留 20% 重叠用于拼接）
    const stepHeight = Math.floor(dims.viewportHeight * 0.8);
    const totalHeight = dims.scrollHeight;
    const maxScroll = Math.max(0, totalHeight - dims.viewportHeight);

    // 生成所有需要截图的位置
    const positions = [];
    let currentY = 0;
    while (currentY < maxScroll) {
      positions.push(currentY);
      currentY += stepHeight;
    }
    // 确保最后一张截到底
    if (positions.length === 0 || positions[positions.length - 1] < maxScroll) {
      positions.push(maxScroll);
    }

    // 去重最后一个位置（避免与倒数第二个相同）
    if (positions.length >= 2 && positions[positions.length - 1] === positions[positions.length - 2]) {
      positions.pop();
    }

    sendResponse({
      success: true,
      positions,
      totalHeight,
      viewportHeight: dims.viewportHeight,
      viewportWidth: dims.viewportWidth,
      devicePixelRatio: dims.devicePixelRatio,
      fixedElementCount: fixedElements.length,
      stepHeight
    });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function handleScrollTo(request, sendResponse) {
  try {
    await scrollToPosition(request.y);
    sendResponse({ success: true, scrollY: window.scrollY });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

// 通知 background script 已加载
chrome.runtime.sendMessage({ action: 'contentScriptReady', url: location.href });
