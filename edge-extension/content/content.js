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
 * 返回彼此独立的候选列表（scrollHeight 从大到小）。页面级滚动保留，
 * 自定义容器会排除父子嵌套和几乎完全重叠的重复候选。
 */
function detectScrollContainers() {
  const containers = [];
  const vw = window.innerWidth;
  const se = document.scrollingElement || document.documentElement;

  // 检查标准 viewport 滚动
  if (se.scrollHeight > se.clientHeight + 10) {
    containers.push({
      element: se,
      isNative: true,
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
    if (el === se || el === document.documentElement || el === document.body) continue;
    const style = window.getComputedStyle(el);
    const oy = style.overflowY;
    if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
        el.scrollHeight > el.clientHeight + 5 &&
        el.offsetWidth > 0 && el.offsetHeight > 0 &&
        isRectFullyVisible(el.getBoundingClientRect())) {
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
        isNative: false,
        scrollHeight: el.scrollHeight,
        scrollWidth: el.scrollWidth,
        clientHeight: el.clientHeight,
        clientWidth: el.clientWidth,
        tagName: el.tagName.toLowerCase(),
        selector: sel,
      });
    }
  }

  const independentContainers = filterIndependentContainers(containers);
  containers.length = 0;
  containers.push(...independentContainers);

  // 页面没有任何滚动区域时，仍生成一帧当前视口的截图计划。
  if (containers.length === 0) {
    containers.push({
      element: se,
      isNative: true,
      scrollHeight: Math.max(se.scrollHeight, window.innerHeight),
      scrollWidth: Math.max(se.scrollWidth, window.innerWidth),
      clientHeight: window.innerHeight,
      clientWidth: window.innerWidth,
      tagName: se.tagName.toLowerCase(),
      selector: '页面（当前视口）',
    });
  }

  // 按 scrollHeight 降序排列
  containers.sort((a, b) => b.scrollHeight - a.scrollHeight);
  containers.forEach((c, i) => c.index = i);

  return containers;
}

function getContainerCropRect(container) {
  if (isNativeScrollContainer(container)) return null;
  const rect = container.getBoundingClientRect();
  return {
    top: Math.round(rect.top),
    left: Math.round(rect.left),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function isRectFullyVisible(rect) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  const bottom = Number.isFinite(rect.bottom) ? rect.bottom : rect.top + rect.height;
  const right = Number.isFinite(rect.right) ? rect.right : rect.left + rect.width;
  return rect.top >= 0 && rect.left >= 0 &&
    bottom <= window.innerHeight && right <= window.innerWidth;
}

function rectArea(rect) {
  return rect ? Math.max(0, rect.width) * Math.max(0, rect.height) : 0;
}

function rectOverlapRatio(first, second) {
  if (!first || !second) return 0;
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  const right = Math.min(first.left + first.width, second.left + second.width);
  const bottom = Math.min(first.top + first.height, second.top + second.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const smallerArea = Math.min(rectArea(first), rectArea(second));
  return smallerArea > 0 ? intersection / smallerArea : 0;
}

function filterIndependentContainers(containers) {
  const nativeContainers = containers.filter(c => c.isNative);
  const customContainers = containers
    .filter(c => !c.isNative)
    .map(c => ({ ...c, rect: getContainerCropRect(c.element) }))
    .filter(c => isRectFullyVisible(c.rect))
    .sort((a, b) => rectArea(b.rect) - rectArea(a.rect) || b.scrollHeight - a.scrollHeight);
  const accepted = [];

  for (const candidate of customContainers) {
    const conflictsWithAccepted = accepted.some((other) => {
      const nested = other.element.contains(candidate.element) || candidate.element.contains(other.element);
      const mostlyOverlaps = rectOverlapRatio(other.rect, candidate.rect) >= 0.8;
      return nested || mostlyOverlaps;
    });
    if (!conflictsWithAccepted) accepted.push(candidate);
  }

  return [...nativeContainers, ...accepted];
}

function createCapturePositions(scrollHeight, viewportHeight) {
  const maxScroll = Math.max(0, scrollHeight - viewportHeight);
  const stepHeight = Math.max(1, Math.floor(viewportHeight * 0.8));
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
  return positions;
}

function buildCapturePlan(containerIndex, initialPosition = {}) {
  const candidate = scrollContainers[containerIndex];
  if (!candidate) throw new Error(`Scroll container not found: ${containerIndex}`);

  const container = candidate.element;
  const isNative = isNativeScrollContainer(container);
  const viewportHeight = isNative ? window.innerHeight : container.clientHeight;
  const scrollWidth = isNative
    ? Math.max(document.body.scrollWidth, document.documentElement.scrollWidth,
      document.body.offsetWidth, document.documentElement.offsetWidth,
      document.body.clientWidth, document.documentElement.clientWidth)
    : container.scrollWidth;
  const scrollHeight = isNative
    ? Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
    : container.scrollHeight;

  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0 ||
      !Number.isFinite(scrollWidth) || scrollWidth <= 0 ||
      !Number.isFinite(scrollHeight) || scrollHeight <= 0) {
    throw new Error(`Invalid scroll container size at index ${containerIndex}`);
  }

  const cropRect = getContainerCropRect(container);
  if (cropRect && !isRectFullyVisible(cropRect)) {
    throw new Error(`Scroll container is not visible: ${containerIndex}`);
  }

  return {
    containerIndex,
    positions: createCapturePositions(scrollHeight, viewportHeight),
    viewportWidth: window.innerWidth,
    viewportHeight,
    scalarWidth: scrollWidth,
    devicePixelRatio: window.devicePixelRatio || 1,
    scalarHeight: scrollHeight,
    initialScrollX: Number.isFinite(initialPosition.initialScrollX)
      ? initialPosition.initialScrollX
      : getScrollLeft(container),
    initialScrollY: Number.isFinite(initialPosition.initialScrollY)
      ? initialPosition.initialScrollY
      : getScrollTop(container),
    isNative,
    cropRect,
  };
}

function cropRectsMatch(first, second, tolerance = 2) {
  if (!first || !second) return first === second;
  return Math.abs(first.top - second.top) <= tolerance &&
    Math.abs(first.left - second.left) <= tolerance &&
    Math.abs(first.width - second.width) <= tolerance &&
    Math.abs(first.height - second.height) <= tolerance;
}

function capturePlanLayoutChanged(previousPlan, nextPlan) {
  if (!previousPlan) return false;
  return !cropRectsMatch(previousPlan.cropRect, nextPlan.cropRect) ||
    previousPlan.isNative !== nextPlan.isNative ||
    Math.abs(Number(previousPlan.viewportHeight) - nextPlan.viewportHeight) > 2 ||
    Math.abs(Number(previousPlan.scalarWidth) - nextPlan.scalarWidth) > 2 ||
    Math.abs(Number(previousPlan.scalarHeight) - nextPlan.scalarHeight) > 2 ||
    Math.abs(Number(previousPlan.viewportWidth) - nextPlan.viewportWidth) > 2 ||
    (Number.isFinite(Number(previousPlan.devicePixelRatio)) &&
      Number.isFinite(Number(nextPlan.devicePixelRatio)) &&
      Math.abs(Number(previousPlan.devicePixelRatio) - Number(nextPlan.devicePixelRatio)) > 0.01);
}

/**
 * 获取当前选中的滚动容器 DOM 元素
 */
function getScrollContainer() {
  if (scrollContainers.length === 0) return window;
  const c = scrollContainers[selectedContainerIndex];
  return c ? c.element : window;
}

function isNativeScrollContainer(container) {
  return container === window || container === document.scrollingElement ||
    container === document.documentElement || container === document.body;
}

function getScrollTop(container) {
  return isNativeScrollContainer(container)
    ? (window.scrollY || document.documentElement.scrollTop || document.body?.scrollTop || 0)
    : container.scrollTop;
}

function getScrollLeft(container) {
  return isNativeScrollContainer(container)
    ? (window.scrollX || document.documentElement.scrollLeft || document.body?.scrollLeft || 0)
    : container.scrollLeft;
}

function setScrollTop(container, y, x) {
  const targetY = Number.isFinite(Number(y)) ? Math.max(0, Number(y)) : 0;
  const targetX = Number.isFinite(Number(x)) ? Math.max(0, Number(x)) : getScrollLeft(container);
  const isNative = isNativeScrollContainer(container);
  const scrollElement = isNative ? document.scrollingElement : container;
  const previousBehavior = scrollElement?.style.scrollBehavior;

  // 页面自身可能设置了 smooth scrolling；截图必须等到目标位置稳定后再执行。
  if (scrollElement) scrollElement.style.scrollBehavior = 'auto';
  try {
    if (isNative) window.scrollTo(targetX, targetY);
    else {
      if (x !== undefined) container.scrollLeft = targetX;
      container.scrollTop = targetY;
    }
  } finally {
    if (scrollElement) scrollElement.style.scrollBehavior = previousBehavior;
  }
}

function dispatchScrollEvent(container) {
  const target = isNativeScrollContainer(container) ? document : container;
  target.dispatchEvent(new Event('scroll'));
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
  const container = getScrollContainer();

  function doScroll(y) {
    setScrollTop(container, y);
  }

  // 懒加载可能在首次到底后继续增加 scrollHeight；最多重新探测几轮，
  // 避免计划在内容尚未展开时就固定下来。
  let previousExtent = -1;
  for (let pass = 0; pass < 3; pass++) {
    const { scrollHeight, viewportHeight } = getPageDimensions();
    const totalScroll = Math.max(0, scrollHeight - viewportHeight);
    const step = Math.max(1, viewportHeight);

    // 向下快速滚动
    let currentScroll = 0;
    while (currentScroll < totalScroll) {
      currentScroll = Math.min(currentScroll + step, totalScroll);
      doScroll(currentScroll);
      // 触发 IntersectionObserver 等懒加载机制
      dispatchScrollEvent(container);
      // 小延迟让懒加载触发
      await sleep(30);
    }

    // 等待图片加载和可能由到底触发的异步内容。
    await waitForImagesLoaded();
    await sleep(500);

    const after = getPageDimensions();
    const afterExtent = Math.max(0, after.scrollHeight - after.viewportHeight);
    if (afterExtent <= totalScroll + 2 || afterExtent <= previousExtent + 2) break;
    previousExtent = afterExtent;
  }

  // 滚回顶部
  doScroll(0);
  dispatchScrollEvent(container);

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
    let settled = false;
    let timer = null;
    const pendingImages = [];

    function finish() {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      for (const img of pendingImages) {
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onLoad);
      }
      resolve();
    }

    function onLoad() {
      if (settled) return;
      loaded++;
      if (loaded >= total) finish();
    }

    for (const img of images) {
      if (img.complete) {
        loaded++;
      } else {
        pendingImages.push(img);
        img.addEventListener('load', onLoad);
        img.addEventListener('error', onLoad); // 加载失败也算完成
      }
    }

    // 如果所有图片已经完成
    if (loaded >= total) finish();

    // 超时保护：最多等 5 秒
    if (!settled) timer = setTimeout(finish, 5000);
  });
}

/**
 * 滚动到指定位置并等待渲染完成
 * 支持自定义滚动容器
 */
function scrollToPosition(y, x) {
  return new Promise((resolve) => {
    const container = getScrollContainer();
    setScrollTop(container, y, x);

    dispatchScrollEvent(container);

    // 等待两次 requestAnimationFrame 确保渲染完成
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve({
          y: getScrollTop(container),
          cropRect: getContainerCropRect(container),
        });
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

    case 'refreshCapturePlan':
      handleRefreshCapturePlan(request, sendResponse);
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
    isNative: c.isNative === true,
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
  const originalSelectedIndex = selectedContainerIndex;
  let initialScrollPositions = null;

  try {
    const options = request.options || {};

    // 重新检测滚动容器（如果尚未检测）
    if (scrollContainers.length === 0) {
      scrollContainers = detectScrollContainers();
    }

    initialScrollPositions = new Map(
      scrollContainers.map((c, i) => [i, {
        x: getScrollLeft(c.element),
        y: getScrollTop(c.element),
      }])
    );

    // 确定要截取的容器列表
    const indices = resolveCaptureIndices(options, scrollContainers);

    if (indices.length === 0) {
      throw new Error('No scroll containers selected');
    }

    // 扫描 fixed 元素
    scanFixedElements();

    // 预滚动所有选中的容器，确保多面板页面的懒加载内容也被触发。
    if (options.preScroll !== false && indices.length > 0) {
      const saveIdx = selectedContainerIndex;
      try {
        for (const idx of indices) {
          selectedContainerIndex = idx;
          await preScrollForLazyLoad();
        }
      } finally {
        selectedContainerIndex = saveIdx;
      }
    }

    // 为每个容器生成独立的 capture plan。
    const containerPlans = indices.map(idx => buildCapturePlan(idx, {
      initialScrollX: initialScrollPositions.get(idx)?.x || 0,
      initialScrollY: initialScrollPositions.get(idx)?.y || 0,
    }));

    // 恢复默认选中
    selectedContainerIndex = indices[0] ?? 0;

    sendResponse({
      success: true,
      containerPlans,
      fixedElementCount: fixedElements.length,
    });
  } catch (error) {
    // 预滚动或生成计划失败时，也恢复用户开始截图前的页面位置。
    if (initialScrollPositions) {
      for (const [idx, y] of initialScrollPositions) {
        const container = scrollContainers[idx]?.element;
        if (!container) continue;
        selectedContainerIndex = idx;
        setScrollTop(container, y.y, y.x);
      }
      selectedContainerIndex = originalSelectedIndex;
    }
    sendResponse({ success: false, error: error.message });
  }
}

function resolveCaptureIndices(options = {}, containers = scrollContainers) {
  const hasExplicitSelection = Array.isArray(options.scrollContainerIndices) ||
    options.scrollContainerIndex !== undefined;
  let indices;
  if (Array.isArray(options.scrollContainerIndices)) {
    const seen = new Set();
    indices = options.scrollContainerIndices
      .map(value => Number(value))
      .filter(index => {
        if (!Number.isInteger(index) || !containers[index] || seen.has(index)) return false;
        seen.add(index);
        return true;
      });
  } else if (options.scrollContainerIndex !== undefined && containers[options.scrollContainerIndex]) {
    // 向后兼容：单容器模式
    indices = [options.scrollContainerIndex];
  } else {
    // 默认：全选
    indices = containers.map((_, i) => i);
  }

  // 页面级滚动和内部面板使用不同坐标系，不能在同一张图中直接合成。
  // 默认优先截取自定义面板；显式混选则尽早报错，避免输出错位图片。
  const hasNative = indices.some(i => containers[i]?.isNative);
  const customIndices = indices.filter(i => !containers[i]?.isNative);
  if (hasNative && customIndices.length > 0) {
    if (hasExplicitSelection) {
      throw new Error('页面级滚动不能与自定义滚动区域同时选择');
    }
    indices = customIndices;
  }

  return indices;
}

async function handleScrollTo(request, sendResponse) {
  try {
    // 支持指定容器索引（多容器模式）
    if (request.containerIndex !== undefined && !scrollContainers[request.containerIndex]) {
      throw new Error('Scroll container not found');
    }

    let result;
    if (request.containerIndex !== undefined) {
      const prev = selectedContainerIndex;
      selectedContainerIndex = request.containerIndex;
      try {
        result = await scrollToPosition(request.y, request.x);
      } finally {
        selectedContainerIndex = prev;
      }
    } else {
      result = await scrollToPosition(request.y, request.x);
    }
    sendResponse({ success: true, y: result.y, cropRect: result.cropRect });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

function handleRefreshCapturePlan(request, sendResponse) {
  try {
    const previousPlan = request.previousPlan || {};
    const plan = buildCapturePlan(request.containerIndex, previousPlan);
    sendResponse({
      success: true,
      changed: capturePlanLayoutChanged(previousPlan, plan),
      plan,
    });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

// 通知 background script 已加载
chrome.runtime.sendMessage({ action: 'contentScriptReady', url: location.href });
