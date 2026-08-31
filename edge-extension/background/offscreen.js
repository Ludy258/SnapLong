/**
 * Offscreen Document - 拼接引擎
 *
 * 有完整 DOM API（Image, Canvas, Blob）。
 * 负责：接收截图数据 → 拼接/复制到剪贴板 → 返回 data URL 给 SW 下载。
 */

const MAX_CANVAS_SIZE = 32767;
const MAX_CANVAS_AREA = 268000000;
const CLIPBOARD_TIMEOUT_MS = 5000;
let nextClipboardTaskId = 1;
const clipboardTasks = new Map();

function assertCanvasSize(width, height, label = 'Canvas') {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`${label} size is invalid: ${width}x${height}`);
  }
  if (width > MAX_CANVAS_SIZE || height > MAX_CANVAS_SIZE || width * height > MAX_CANVAS_AREA) {
    throw new Error(`${label} is too large: ${width}x${height}. Chrome canvas limit is ${MAX_CANVAS_SIZE}px per side and about ${Math.floor(MAX_CANVAS_AREA / 1000000)}MP total.`);
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'stitch') {
    handleStitch(request, sendResponse);
    return true;
  }
  if (request.action === 'writeClipboard') {
    handleWriteClipboard(request, sendResponse);
    return true;
  }
  if (request.action === 'waitClipboard') {
    handleWaitClipboard(request, sendResponse);
    return true;
  }
  sendResponse({ success: false, error: 'Unknown: ' + request.action });
  return true;
});

async function handleStitch(request, sendResponse) {
  try {
    const { containerStrips, primaryContainerIndex, viewportWidth, devicePixelRatio, format,
            contextFrame, copyToClipboard } = request;

    if (!containerStrips || containerStrips.length === 0) throw new Error('No container strips');

    const hasNativeStrip = containerStrips.some(strip => strip.isNative === true);
    const hasCustomStrip = containerStrips.some(strip => strip.isNative !== true && strip.cropRect);
    if (hasNativeStrip && hasCustomStrip) {
      throw new Error('页面级滚动不能与自定义滚动区域同时合成');
    }

    console.log('[Offscreen] Stitching', containerStrips.length, 'containers, compositing:', !!contextFrame);

    const dprValue = Number(devicePixelRatio);
    const dpr = Number.isFinite(dprValue) && dprValue > 0 ? dprValue : 1;
    const viewportWidthValue = Number(viewportWidth);
    if (!Number.isFinite(viewportWidthValue) || viewportWidthValue <= 0) {
      throw new Error(`Viewport width is invalid: ${viewportWidth}`);
    }
    const fullW = Math.round(viewportWidthValue * dpr);

    // Step 1: 每个容器独立裁剪 + 拼接
    const stitchedStrips = [];
    let primaryStripHeight = 0;

    for (const cs of containerStrips) {
      if (!cs.frames || cs.frames.length === 0) continue;
      for (const frame of cs.frames) {
        if (typeof frame.dataUrl !== 'string' || !Number.isFinite(Number(frame.y))) {
          throw new Error(`Container ${cs.containerIndex} has an invalid capture frame`);
        }
      }

      // 加载本容器的帧
      let images = await Promise.all(cs.frames.map(f => loadImage(f.dataUrl)));

      // 裁剪到容器区域
      if (cs.cropRect) {
        for (let i = 0; i < images.length; i++) {
          const cropped = cropToRect(images[i], cs.cropRect, dpr);
          if (!cropped) {
            throw new Error(`Container ${cs.containerIndex} frame ${i + 1} is outside the visible area`);
          }
          images[i] = cropped;
        }
      }

      // 拼接本容器
      const offsets = calculateOffsets(images, cs.frames);
      const lastIdx = images.length - 1;
      const stripHeight = offsets[lastIdx] + images[lastIdx].height;

      // 生成 strip canvas
      const stripW = cs.cropRect ? Math.round(cs.cropRect.width * dpr) : fullW;
      assertCanvasSize(stripW, stripHeight, `Container ${cs.containerIndex} canvas`);
      const stripCanvas = document.createElement('canvas');
      stripCanvas.width = stripW;
      stripCanvas.height = stripHeight;
      const sctx = stripCanvas.getContext('2d');
      for (let i = 0; i < images.length; i++) {
        sctx.drawImage(images[i], 0, offsets[i]);
      }

      // 清理
      images.forEach(img => {
        if (img._canvas) { img._canvas = null; img._ctx = null; img._imageData = null; img._pixels = null; }
      });

      stitchedStrips.push({
        containerIndex: cs.containerIndex,
        canvas: stripCanvas,
        cropRect: cs.cropRect,
        height: stripHeight,
      });

      if (cs.containerIndex === primaryContainerIndex) {
        primaryStripHeight = stripHeight;
      }
    }

    if (stitchedStrips.length === 0) throw new Error('No valid strips');

    // 用主容器高度；若无指定则用最长
    const middleHeight = primaryStripHeight > 0
      ? primaryStripHeight
      : Math.max(...stitchedStrips.map(s => s.height));

    // 负载上下文帧
    let contextImg = null;
    if (contextFrame) {
      contextImg = await loadImage(contextFrame);
    }

    const fullH = contextImg ? (contextImg.naturalHeight || contextImg.height) : 0;

    // 找到所有容器的覆盖范围
    let minTop = Infinity, maxBottom = 0;
    for (const s of stitchedStrips) {
      if (s.cropRect) {
        const t = Math.round(s.cropRect.top * dpr);
        const b = t + Math.round(s.cropRect.height * dpr);
        if (t < minTop) minTop = t;
        if (b > maxBottom) maxBottom = b;
      }
    }
    if (minTop === Infinity) { minTop = 0; maxBottom = fullH; }

    const topHeight = minTop;
    const bottomHeight = Math.max(0, fullH - maxBottom);
    const totalHeight = topHeight + middleHeight + bottomHeight;

    console.log('[Offscreen] Composite size:', fullW, 'x', totalHeight);
    assertCanvasSize(fullW, totalHeight || middleHeight, 'Final screenshot canvas');

    // Step 2: 合成最终画布
    let canvas;

    if (contextImg) {
      canvas = document.createElement('canvas');
      canvas.width = fullW;
      canvas.height = totalHeight;
      const ctx = canvas.getContext('2d');

      // 取样底色
      const bgColor = sampleBgColor(contextImg, 2, minTop + 10);

      // 上部：所有容器上方
      if (topHeight > 0) {
        ctx.drawImage(contextImg, 0, 0, fullW, topHeight, 0, 0, fullW, topHeight);
      }

      // 中部：先画上下文帧原始内容（保留侧边栏等），再覆盖容器拼接
      const midCtxHeight = maxBottom - minTop; // 可见容器区域高度（物理像素）
      const midCtxSrcTop = minTop;

      // 上下文帧原始内容（全宽，保留侧边栏、固定元素等）
      ctx.drawImage(contextImg, 0, midCtxSrcTop, fullW, midCtxHeight,
                    0, topHeight, fullW, midCtxHeight);

      // 找出容器覆盖的左右边界
      let coverLeft = fullW, coverRight = 0;
      for (const s of stitchedStrips) {
        if (!s.cropRect) continue;
        const x = Math.round(s.cropRect.left * dpr);
        const r = x + s.canvas.width;
        if (x < coverLeft) coverLeft = x;
        if (r > coverRight) coverRight = r;
      }

      // 容器拼接内容覆盖在上下文上方（全高）
      for (const s of stitchedStrips) {
        if (!s.cropRect) continue;
        const x = Math.round(s.cropRect.left * dpr);
        const y = topHeight + Math.round(s.cropRect.top * dpr) - minTop;
        ctx.drawImage(s.canvas, 0, 0, s.canvas.width, s.height,
                      x, y, s.canvas.width, s.height);
      }

      // 超出上下文高度的区域：左右空白填底色
      if (middleHeight > midCtxHeight) {
        const extraTop = topHeight + midCtxHeight;
        const extraH = middleHeight - midCtxHeight;
        if (coverLeft > 0) {
          ctx.fillStyle = bgColor;
          ctx.fillRect(0, extraTop, coverLeft, extraH);
        }
        if (coverRight < fullW) {
          ctx.fillStyle = bgColor;
          ctx.fillRect(coverRight, extraTop, fullW - coverRight, extraH);
        }
        // 容器间间隙也填底色
        const sorted = stitchedStrips
          .filter(s => s.cropRect)
          .map(s => ({ x: Math.round(s.cropRect.left * dpr), r: Math.round(s.cropRect.left * dpr) + s.canvas.width }))
          .sort((a, b) => a.x - b.x);
        for (let i = 1; i < sorted.length; i++) {
          const gapStart = sorted[i - 1].r;
          const gapEnd = sorted[i].x;
          if (gapEnd > gapStart) {
            ctx.fillStyle = bgColor;
            ctx.fillRect(gapStart, extraTop, gapEnd - gapStart, extraH);
          }
        }
      }

      // 下部：所有容器下方
      if (bottomHeight > 0) {
        ctx.drawImage(contextImg, 0, maxBottom, fullW, bottomHeight,
                      0, topHeight + middleHeight, fullW, bottomHeight);
      }

    } else if (stitchedStrips.length === 1) {
      // 单容器无合成 → 直接用 strip canvas（向后兼容）
      canvas = stitchedStrips[0].canvas;

    } else {
      // 多容器无上下文帧 → 水平拼接
      // 找到最大高度，各容器下方填底色
      assertCanvasSize(fullW, middleHeight, 'Multi-container canvas');
      canvas = document.createElement('canvas');
      canvas.width = fullW;
      canvas.height = middleHeight;
      const ctx = canvas.getContext('2d');

      for (const s of stitchedStrips) {
        const x = s.cropRect ? Math.round(s.cropRect.left * dpr) : 0;
        ctx.drawImage(s.canvas, x, 0);
        if (s.height < middleHeight) {
          const bg = sampleBgColor(s.canvas, 1, s.height - 1);
          ctx.fillStyle = bg;
          ctx.fillRect(x, s.height, s.canvas.width, middleHeight - s.height);
        }
      }
    }

    // 根据格式处理
    let dataUrl;
    if (format === 'pdf') {
      dataUrl = generatePaginatedPdf(canvas);
    } else {
      const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
      const quality = format === 'jpeg' ? 0.92 : undefined;
      dataUrl = canvas.toDataURL(mimeType, quality);
    }

    // 先返回导出数据，让 Service Worker 尽快开始下载；剪贴板任务单独等待结果。
    const clipboardTaskId = copyToClipboard === true
      ? startClipboardTask((isCancelled) => copyCanvasToClipboard(canvas, isCancelled))
      : '';

    console.log('[Offscreen] Output:', Math.round(dataUrl.length / 1024), 'KB');
    sendResponse({
      success: true,
      dataUrl,
      clipboardCopied: false,
      clipboardError: '',
      clipboardPending: Boolean(clipboardTaskId),
      clipboardTaskId,
    });

  } catch (error) {
    console.error('[Offscreen] Error:', error);
    sendResponse({ success: false, error: error.message });
  }
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = dataUrl;
  });
}

async function handleWriteClipboard(request, sendResponse) {
  try {
    if (typeof request.dataUrl !== 'string') throw new Error('没有可复制的截图数据');
    const taskId = startClipboardTask((isCancelled) => copyDataUrlToClipboard(request.dataUrl, isCancelled));
    sendResponse(await waitForClipboardTask(taskId));
  } catch (error) {
    console.error('[Offscreen] Clipboard error:', error);
    const message = error?.message || '剪贴板写入失败';
    sendResponse({ success: false, clipboardCopied: false, clipboardError: message, error: message });
  }
}

async function handleWaitClipboard(request, sendResponse) {
  try {
    if (typeof request.taskId !== 'string' || !request.taskId) {
      throw new Error('没有可等待的剪贴板任务');
    }
    sendResponse(await waitForClipboardTask(request.taskId));
  } catch (error) {
    console.error('[Offscreen] Clipboard wait error:', error);
    const message = error?.message || '剪贴板写入失败';
    sendResponse({ success: false, clipboardCopied: false, clipboardError: message, error: message });
  }
}

function startClipboardTask(taskFactory) {
  const taskId = String(nextClipboardTaskId++);
  const state = {
    cancelled: false,
    settled: false,
    result: null,
    promise: null,
  };

  state.promise = Promise.resolve()
    .then(() => taskFactory(() => state.cancelled))
    .then(
      () => ({ success: true, clipboardCopied: true, clipboardError: '' }),
      (error) => ({
        success: false,
        clipboardCopied: false,
        clipboardError: error?.message || '剪贴板写入失败',
        error: error?.message || '剪贴板写入失败',
      })
    )
    .then((result) => {
      state.result = result;
      state.settled = true;
      if (state.cancelled) clipboardTasks.delete(taskId);
      return result;
    });

  clipboardTasks.set(taskId, state);
  return taskId;
}

async function waitForClipboardTask(taskId, timeoutMs = CLIPBOARD_TIMEOUT_MS) {
  const state = clipboardTasks.get(taskId);
  if (!state) throw new Error('剪贴板任务不存在或已过期');
  if (state.settled) {
    clipboardTasks.delete(taskId);
    return state.result;
  }

  const timeoutToken = {};
  let timer;
  try {
    const result = await Promise.race([
      state.promise,
      new Promise(resolve => {
        timer = setTimeout(() => resolve(timeoutToken), timeoutMs);
      }),
    ]);
    if (result === timeoutToken) {
      // 不能取消已经交给浏览器的原生 clipboard.write，但可以阻止后续
      // 图片加载、DOM fallback 或新的扩展写入继续执行。
      state.cancelled = true;
      return {
        success: false,
        clipboardCopied: false,
        clipboardError: '剪贴板写入超时',
        error: '剪贴板写入超时',
      };
    }
    clipboardTasks.delete(taskId);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function throwIfClipboardCancelled(isCancelled) {
  if (isCancelled && isCancelled()) throw new Error('剪贴板任务已取消');
}

async function copyCanvasToClipboard(canvas, isCancelled) {
  if (!canvas || typeof canvas.toBlob !== 'function') {
    throw new Error('当前浏览器不支持异步图片编码');
  }

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error('无法生成剪贴板图片'));
    }, 'image/png');
  });

  throwIfClipboardCancelled(isCancelled);
  await copyImageBlobToClipboard(blob, isCancelled);
}

async function copyDataUrlToClipboard(dataUrl, isCancelled) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    throw new Error('没有可复制的图片数据');
  }

  const response = await fetch(dataUrl);
  if (!response.ok) throw new Error('无法读取截图数据');
  const blob = await response.blob();
  throwIfClipboardCancelled(isCancelled);
  await copyImageBlobToClipboard(blob, isCancelled);
}

async function copyImageBlobToClipboard(blob, isCancelled) {
  const pngBlob = await ensurePngBlob(blob, isCancelled);
  throwIfClipboardCancelled(isCancelled);

  // 优先使用真正的 ClipboardItem，避免把 HTML 图片引用误当作 PNG 复制成功。
  try {
    await writePngBlobToClipboard(pngBlob);
    return;
  } catch (apiError) {
    console.warn('[Offscreen] Clipboard API copy failed:', apiError?.message || apiError);
  }

  // Offscreen 文档在部分 Edge 版本中无法使用 Clipboard API 时，再尝试 DOM 兼容路径。
  if (canUseDomCopy()) {
    try {
      const imageSource = await blobToDataUrl(pngBlob, isCancelled);
      throwIfClipboardCancelled(isCancelled);
      await copyImageWithExecCommand(imageSource, isCancelled);
      return;
    } catch (error) {
      console.warn('[Offscreen] DOM clipboard copy failed:', error?.message || error);
    }
  }

  throw new Error('当前浏览器不支持图片剪贴板');
}

async function ensurePngBlob(blob, isCancelled) {
  if (!blob) throw new Error('没有可复制的图片数据');
  if (blob.type === 'image/png') return blob;

  const image = await loadImage(await blobToDataUrl(blob, isCancelled));
  throwIfClipboardCancelled(isCancelled);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  assertCanvasSize(width, height, 'Clipboard image');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(image, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error('无法转换剪贴板图片为 PNG'));
    }, 'image/png');
  });
}

function blobToDataUrl(blob, isCancelled) {
  throwIfClipboardCancelled(isCancelled);
  if (typeof FileReader !== 'function') throw new Error('当前浏览器不支持图片读取');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        throwIfClipboardCancelled(isCancelled);
        resolve(reader.result);
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(new Error('无法读取剪贴板图片'));
    reader.readAsDataURL(blob);
  });
}

function canUseDomCopy() {
  return typeof document !== 'undefined' &&
    document.body &&
    typeof document.createElement === 'function' &&
    typeof document.createRange === 'function' &&
    typeof document.execCommand === 'function' &&
    typeof window !== 'undefined' &&
    typeof window.getSelection === 'function';
}

async function copyImageWithExecCommand(imageSource, isCancelled) {
  const wrapper = document.createElement('div');
  const image = document.createElement('img');
  wrapper.contentEditable = 'true';
  wrapper.tabIndex = -1;
  wrapper.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;';
  image.alt = '';
  wrapper.appendChild(image);
  document.body.appendChild(wrapper);

  const selection = window.getSelection();
  if (!selection) {
    wrapper.remove();
    throw new Error('当前文档不支持图片选择');
  }
  try {
    await loadClipboardImage(image, imageSource);
    throwIfClipboardCancelled(isCancelled);
    wrapper.focus();
    const range = document.createRange();
    range.selectNode(image);
    selection.removeAllRanges();
    selection.addRange(range);
    throwIfClipboardCancelled(isCancelled);
    if (!document.execCommand('copy')) {
      throw new Error('DOM 复制命令未执行');
    }
  } finally {
    selection.removeAllRanges();
    wrapper.remove();
  }
}

function loadClipboardImage(image, source) {
  return new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('无法加载剪贴板图片'));
    image.src = source;
    if (image.complete && (!('naturalWidth' in image) || image.naturalWidth > 0)) {
      resolve();
    }
  });
}

async function writePngBlobToClipboard(blob) {
  if (!blob) throw new Error('没有可复制的图片数据');
  if (!navigator.clipboard || typeof navigator.clipboard.write !== 'function') {
    throw new Error('当前浏览器不支持图片剪贴板');
  }

  const ClipboardItemConstructor = globalThis.ClipboardItem;
  if (typeof ClipboardItemConstructor !== 'function') {
    throw new Error('当前浏览器不支持图片剪贴板');
  }
  if (typeof ClipboardItemConstructor.supports === 'function' &&
      !ClipboardItemConstructor.supports('image/png')) {
    throw new Error('当前浏览器不支持 PNG 剪贴板');
  }

  const pngBlob = blob.type === 'image/png' ? blob : new Blob([blob], { type: 'image/png' });
  await navigator.clipboard.write([
    new ClipboardItemConstructor({ 'image/png': pngBlob }),
  ]);
}

function calculateOffsets(images, frames) {
  if (images.length === 0) return [];

  // scrollTop 已经是内容坐标，直接使用它比在重复背景上猜重叠像素可靠。
  const originY = Number(frames[0]?.y);
  const offsets = [0];
  for (let i = 1; i < images.length; i++) {
    const measuredOffset = Number(frames[i]?.y) - originY;
    const previousOffset = offsets[i - 1];
    if (Number.isFinite(measuredOffset) && measuredOffset >= previousOffset - 2) {
      offsets.push(Math.max(previousOffset, Math.round(measuredOffset)));
    } else {
      // 异常的非递增滚动坐标不能让后续帧反向覆盖，退化为无重叠拼接。
      offsets.push(previousOffset + images[i - 1].height);
    }
  }
  return offsets;
}

function stitchToCanvas(images, offsets, width, height) {
  assertCanvasSize(width, height, 'Stitched canvas');
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  for (let i = 0; i < images.length; i++) {
    ctx.drawImage(images[i], 0, offsets[i], images[i].width, images[i].height);
  }
  return canvas;
}

function stitchWithSlicing(images, offsets, width, height) {
  // 超长图：只保留最后一张拼接结果作为缩略图
  console.warn('[Offscreen] Image too large, returning last slice');
  return stitchToCanvas(images, offsets, width, height);
}

/**
 * 裁剪图片到指定区域
 * @param {HTMLImageElement|HTMLCanvasElement} image - 原始图片
 * @param {{top:number, left:number, width:number, height:number}} rect - CSS 像素坐标的裁剪区域
 * @param {number} dpr - 设备像素比
 * @returns {HTMLCanvasElement|null} 裁剪后的 canvas，无效区域返回 null
 */
function cropToRect(image, rect, dpr) {
  if (!image || !rect) return null;
  const sx = Math.round(rect.left * dpr);
  const sy = Math.round(rect.top * dpr);
  const sw = Math.round(rect.width * dpr);
  const sh = Math.round(rect.height * dpr);
  if (sw <= 0 || sh <= 0) return null;
  // 确保不超出原始图片边界
  const imgW = image.naturalWidth || image.width;
  const imgH = image.naturalHeight || image.height;
  const visibleLeft = Math.max(0, sx);
  const visibleTop = Math.max(0, sy);
  const visibleRight = Math.min(imgW, sx + sw);
  const visibleBottom = Math.min(imgH, sy + sh);
  if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return null;

  // 保留请求的裁剪尺寸，越出视口的部分保持透明，避免负坐标导致内容错位。
  assertCanvasSize(sw, sh, 'Cropped container canvas');
  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  const visibleW = visibleRight - visibleLeft;
  const visibleH = visibleBottom - visibleTop;
  ctx.drawImage(
    image,
    visibleLeft, visibleTop, visibleW, visibleH,
    visibleLeft - sx, visibleTop - sy, visibleW, visibleH
  );
  return canvas;
}

/**
 * 从图像指定位置取样像素颜色，返回 CSS 颜色字符串
 * 用于提取页面底色填充侧方空白区域
 * @param {HTMLImageElement|HTMLCanvasElement} image
 * @param {number} x - 物理像素 x 坐标
 * @param {number} y - 物理像素 y 坐标
 * @returns {string} eg. "rgb(245,247,250)"
 */
function sampleBgColor(image, x, y) {
  const imageW = image.naturalWidth || image.width;
  const imageH = image.naturalHeight || image.height;
  const sampleX = Math.min(imageW - 1, Math.max(0, Math.round(x)));
  const sampleY = Math.min(imageH - 1, Math.max(0, Math.round(y)));
  const c = document.createElement('canvas');
  c.width = 1; c.height = 1;
  const cx = c.getContext('2d');
  cx.drawImage(image, sampleX, sampleY, 1, 1, 0, 0, 1, 1);
  const d = cx.getImageData(0, 0, 1, 1).data;
  return `rgb(${d[0]},${d[1]},${d[2]})`;
}

console.log('[Offscreen] Ready');

// ===================== PDF 生成 =====================

/**
 * 将长截图按 A4 页面切片生成 PDF，避免整张图被压缩到单页。
 * @param {HTMLCanvasElement} sourceCanvas
 * @returns {string} data:application/pdf;base64,...
 */
function generatePaginatedPdf(sourceCanvas) {
  const imgWidth = sourceCanvas.width;
  const imgHeight = sourceCanvas.height;

  const margin = 28; // ~1cm
  const pageW = 595.28;
  const pageH = 841.89;
  const maxW = pageW - margin * 2;
  const maxH = pageH - margin * 2;
  const scale = Math.min(maxW / imgWidth, 1);
  const sliceHeightPx = Math.max(1, Math.floor(maxH / scale));
  const pageCount = Math.ceil(imgHeight / sliceHeightPx);
  const pagesObjNum = pageCount * 4 + 1;
  const catalogObjNum = pagesObjNum + 1;

  const objects = [];
  const pageNums = [];

  function addObject(body) {
    const num = objects.length + 1;
    objects.push({ num, data: `${num} 0 obj\n${body}\nendobj` });
    return num;
  }

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    const sy = pageIndex * sliceHeightPx;
    const sliceH = Math.min(sliceHeightPx, imgHeight - sy);
    assertCanvasSize(imgWidth, sliceH, `PDF page ${pageIndex + 1} image`);

    const slice = document.createElement('canvas');
    slice.width = imgWidth;
    slice.height = sliceH;
    const ctx = slice.getContext('2d');
    ctx.drawImage(sourceCanvas, 0, sy, imgWidth, sliceH, 0, 0, imgWidth, sliceH);

    const raw = atob(slice.toDataURL('image/jpeg', 0.9).split(',')[1]);
    const imageObj = addObject(`<< /Type /XObject /Subtype /Image /Width ${imgWidth} /Height ${sliceH}
   /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode
   /Length ${raw.length} >>
stream
${raw}
endstream`);

    const dispW = (imgWidth * scale).toFixed(2);
    const dispH = (sliceH * scale).toFixed(2);
    const x = margin.toFixed(2);
    const y = (pageH - margin - parseFloat(dispH)).toFixed(2);
    const imageName = `Im${pageIndex}`;
    const contentStream = `q\n${dispW} 0 0 ${dispH} ${x} ${y} cm\n/${imageName} Do\nQ`;
    const contentObj = addObject(`<< /Length ${contentStream.length} >>
stream
${contentStream}
endstream`);

    const resourcesObj = addObject(`<< /ProcSet [/PDF /ImageC]
   /XObject << /${imageName} ${imageObj} 0 R >>
 >>`);

    const pageObj = addObject(`<< /Type /Page /Parent ${pagesObjNum} 0 R
   /MediaBox [0 0 ${pageW} ${pageH}]
   /Contents ${contentObj} 0 R
   /Resources ${resourcesObj} 0 R
 >>`);
    pageNums.push(pageObj);
  }

  addObject(`<< /Type /Pages /Kids [${pageNums.map(n => `${n} 0 R`).join(' ')}] /Count ${pageNums.length} >>`);
  addObject(`<< /Type /Catalog /Pages ${pagesObjNum} 0 R >>`);

  let pdf = '%PDF-1.4\n%\xFF\xFF\xFF\xFF\n';
  const offsets = [];
  for (const ob of objects) {
    offsets.push(pdf.length);
    pdf += ob.data + '\n';
  }

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${catalogObjNum + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  }

  pdf += `trailer
<< /Size ${catalogObjNum + 1} /Root ${catalogObjNum} 0 R >>
startxref
${xrefOffset}
%%EOF`;

  return 'data:application/pdf;base64,' + btoa(pdf);
}
