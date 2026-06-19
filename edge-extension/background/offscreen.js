/**
 * Offscreen Document - 拼接引擎
 *
 * 有完整 DOM API（Image, Canvas, Blob）。
 * 负责：接收截图数据 → 拼接 → 返回 data URL 给 SW 下载。
 */

const MAX_CANVAS_SIZE = 32767;
const MAX_CANVAS_AREA = 268000000;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'stitch') {
    handleStitch(request, sendResponse);
    return true;
  }
  sendResponse({ success: false, error: 'Unknown: ' + request.action });
  return true;
});

async function handleStitch(request, sendResponse) {
  try {
    const { frames, viewportWidth, viewportHeight, devicePixelRatio, format, cropRect,
            contextFrame } = request;

    if (!frames || frames.length === 0) throw new Error('No frames');

    console.log('[Offscreen] Stitching', frames.length, 'frames, compositing:', !!contextFrame && !!cropRect);

    const dpr = devicePixelRatio || 1;

    // 加载容器滚动帧
    let images = await Promise.all(frames.map(d => loadImage(d.dataUrl)));

    // 裁剪容器帧（自定义滚动容器时每帧裁剪到容器区域）
    if (cropRect) {
      console.log('[Offscreen] Cropping to container:', cropRect);
      for (let i = 0; i < images.length; i++) {
        const cropped = cropToRect(images[i], cropRect, dpr);
        if (cropped) images[i] = cropped;
      }
    }

    // 计算容器帧拼接偏移
    const containerOffsets = calculateOffsets(images, frames);
    const lastIdx = images.length - 1;
    const containerTotalHeight = containerOffsets[lastIdx] + images[lastIdx].height;

    let canvas;

    if (contextFrame && cropRect) {
      // ===== 合成模式：容器拼接内容嵌入到完整视口上下文帧 =====
      const contextImg = await loadImage(contextFrame);

      const fullW = Math.round(viewportWidth * dpr);
      const fullH = Math.round(viewportHeight * dpr);

      const ctxLeft   = Math.round(cropRect.left * dpr);
      const ctxTop    = Math.round(cropRect.top * dpr);
      const ctxW      = Math.round(cropRect.width * dpr);
      const ctxH      = Math.round(cropRect.height * dpr);
      const ctxRight  = ctxLeft + ctxW;
      const ctxBottom = ctxTop + ctxH;

      const topHeight    = ctxTop;
      const middleHeight = containerTotalHeight;
      const bottomHeight = Math.max(0, fullH - ctxBottom);
      const totalHeight  = topHeight + middleHeight + bottomHeight;

      console.log('[Offscreen] Composite:', fullW, 'x', totalHeight);

      canvas = document.createElement('canvas');
      canvas.width = fullW;
      canvas.height = totalHeight;
      const ctx = canvas.getContext('2d');

      // 1. 上部：容器上方的一切（完整视口宽度）
      if (topHeight > 0) {
        ctx.drawImage(contextImg, 0, 0, fullW, topHeight, 0, 0, fullW, topHeight);
      }

      // 2. 中部：左区域 + 容器拼接 + 右区域
      // 取样页面底色（边缘像素）
      const lbg = sampleBgColor(contextImg, 2, ctxTop + 10);
      const rbg = sampleBgColor(contextImg, fullW - 3, ctxTop + 10);

      // 左区域 — 原始内容1:1 + 下方空白填底色
      if (ctxLeft > 0) {
        ctx.drawImage(contextImg, 0, ctxTop, ctxLeft, ctxH,
                      0, topHeight, ctxLeft, ctxH);
        if (middleHeight > ctxH) {
          ctx.fillStyle = lbg;
          ctx.fillRect(0, topHeight + ctxH, ctxLeft, middleHeight - ctxH);
        }
      }
      // 容器拼接内容
      for (let i = 0; i < images.length; i++) {
        const dy = topHeight + containerOffsets[i];
        ctx.drawImage(images[i], ctxLeft, dy);
      }
      // 右区域 — 原始内容1:1 + 下方空白填底色
      if (ctxRight < fullW) {
        const rw = fullW - ctxRight;
        ctx.drawImage(contextImg, ctxRight, ctxTop, rw, ctxH,
                      ctxRight, topHeight, rw, ctxH);
        if (middleHeight > ctxH) {
          ctx.fillStyle = rbg;
          ctx.fillRect(ctxRight, topHeight + ctxH, rw, middleHeight - ctxH);
        }
      }

      // 3. 下部：容器下方的一切（完整视口宽度）
      if (bottomHeight > 0) {
        ctx.drawImage(contextImg, 0, ctxBottom, fullW, bottomHeight,
                      0, topHeight + middleHeight, fullW, bottomHeight);
      }

    } else {
      // 标准/仅容器模式（无合成）
      const imageWidth = cropRect
        ? Math.round(cropRect.width * dpr)
        : Math.round(viewportWidth * dpr);
      const imageHeight = containerTotalHeight;

      console.log('[Offscreen] Size:', imageWidth, 'x', imageHeight);

      if (imageWidth > MAX_CANVAS_SIZE || imageHeight > MAX_CANVAS_SIZE ||
          imageWidth * imageHeight > MAX_CANVAS_AREA) {
        canvas = stitchWithSlicing(images, containerOffsets, imageWidth, imageHeight);
      } else {
        canvas = stitchToCanvas(images, containerOffsets, imageWidth, imageHeight);
      }
    }

    // 根据格式处理
    let dataUrl;
    if (format === 'pdf') {
      const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.9);
      dataUrl = generateSimplePdf(jpegDataUrl, canvas.width, canvas.height);
    } else {
      const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
      const quality = format === 'jpeg' ? 0.92 : undefined;
      dataUrl = canvas.toDataURL(mimeType, quality);
    }

    // 清理
    images.forEach(img => {
      if (img._canvas) { img._canvas = null; img._ctx = null; img._imageData = null; img._pixels = null; }
    });

    console.log('[Offscreen] Output:', Math.round(dataUrl.length / 1024), 'KB');
    sendResponse({ success: true, dataUrl });

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

function calculateOffsets(images, frames) {
  const offsets = [0];
  for (let i = 1; i < images.length; i++) {
    const prev = images[i - 1], curr = images[i];
    const estimatedOverlap = prev.height - (frames[i].y - frames[i - 1].y);
    if (estimatedOverlap <= 0) { offsets.push(offsets[i - 1] + prev.height); continue; }
    const actualOverlap = findBestOverlap(prev, curr, estimatedOverlap);
    offsets.push(actualOverlap > 0 ? offsets[i - 1] + prev.height - actualOverlap : offsets[i - 1] + prev.height - estimatedOverlap);
  }
  return offsets;
}

function findBestOverlap(prevImage, currImage, estimatedOverlap) {
  const overlapMin = Math.max(10, Math.floor(estimatedOverlap * 0.5));
  const overlapMax = Math.min(prevImage.height, currImage.height, Math.floor(estimatedOverlap * 1.5));
  let bestOverlap = estimatedOverlap, bestScore = Infinity;
  const sampleColumns = getSampleColumns(prevImage.width);
  for (let to = overlapMin; to <= overlapMax; to++) {
    let score = 0, n = 0;
    for (const col of sampleColumns) {
      for (let row = 0; row < to; row++) {
        const pr = prevImage.height - to + row, cr = row;
        if (pr < 0 || cr >= currImage.height) continue;
        const pp = getPixel(prevImage, col, pr), cp = getPixel(currImage, col, cr);
        score += Math.abs(pp.r - cp.r) + Math.abs(pp.g - cp.g) + Math.abs(pp.b - cp.b);
        n++;
      }
    }
    if (n > 0) { const a = score / n; if (a < bestScore) { bestScore = a; bestOverlap = to; } }
  }
  return bestScore < 30 ? bestOverlap : estimatedOverlap;
}

function getSampleColumns(width) {
  const m = 10;
  if (width <= m * 2 + 3) return [Math.floor(width / 2)];
  const s = Math.max(1, Math.floor((width - m * 2) / 4));
  const cols = [];
  for (let i = m; i < width - m; i += s) cols.push(i);
  return cols;
}

function getPixel(image, x, y) {
  if (!image._canvas) {
    image._canvas = document.createElement('canvas');
    image._canvas.width = image.width; image._canvas.height = image.height;
    image._ctx = image._canvas.getContext('2d');
    image._ctx.drawImage(image, 0, 0);
    image._imageData = image._ctx.getImageData(0, 0, image.width, image.height);
    image._pixels = image._imageData.data;
  }
  const idx = (y * image.width + x) * 4;
  return { r: image._pixels[idx], g: image._pixels[idx + 1], b: image._pixels[idx + 2], a: image._pixels[idx + 3] };
}

function stitchToCanvas(images, offsets, width, height) {
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
  const srcW = Math.min(sw, Math.max(0, imgW - sx));
  const srcH = Math.min(sh, Math.max(0, imgH - sy));
  if (srcW <= 0 || srcH <= 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = srcW;
  canvas.height = srcH;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, sx, sy, srcW, srcH, 0, 0, srcW, srcH);
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
  const c = document.createElement('canvas');
  c.width = 1; c.height = 1;
  const cx = c.getContext('2d');
  cx.drawImage(image, x, y, 1, 1, 0, 0, 1, 1);
  const d = cx.getImageData(0, 0, 1, 1).data;
  return `rgb(${d[0]},${d[1]},${d[2]})`;
}

console.log('[Offscreen] Ready');

// ===================== PDF 生成 =====================

/**
 * 将 JPEG 图片嵌入到最小 PDF 文件中
 * @param {string} jpegDataUrl - data:image/jpeg;base64,...
 * @param {number} imgWidth - 图片宽度（像素）
 * @param {number} imgHeight - 图片高度（像素）
 * @returns {string} data:application/pdf;base64,...
 */
function generateSimplePdf(jpegDataUrl, imgWidth, imgHeight) {
  // 提取 JPEG 二进制数据
  const base64 = jpegDataUrl.split(',')[1];
  const raw = atob(base64);
  const jpegLen = raw.length;

  // A4 尺寸（点）：595.28 x 841.89
  // 图片适配页面宽度，保留边距
  const margin = 28; // ~1cm
  const pageW = 595.28;
  const pageH = 841.89;
  const maxW = pageW - margin * 2;
  const maxH = pageH - margin * 2;
  const scale = Math.min(maxW / imgWidth, maxH / imgHeight, 1);
  const dispW = (imgWidth * scale).toFixed(2);
  const dispH = (imgHeight * scale).toFixed(2);
  const x = margin.toFixed(2);
  const y = (pageH - margin - parseFloat(dispH)).toFixed(2);

  // 构建 PDF 对象
  let objCount = 0;
  const objects = [];

  function obj(content) {
    objCount++;
    const streamStart = content.indexOf('stream\n');
    const streamEnd = content.lastIndexOf('\nendstream');
    let dict = content;
    if (streamStart !== -1) {
      dict = content.substring(0, streamStart);
    }
    objects.push({ num: objCount, data: content });
    return objCount;
  }

  // Object 1: Image XObject（JPEG 流）
  obj(`1 0 obj
<< /Type /XObject /Subtype /Image /Width ${imgWidth} /Height ${imgHeight}
   /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode
   /Length ${jpegLen} >>
stream
${raw}
endstream
endobj`);

  // Object 2: 页面内容流（绘制图片）
  const contentStream = `q
${dispW} 0 0 ${dispH} ${x} ${y} cm
/Im0 Do
Q`;
  obj(`2 0 obj
<< /Length ${contentStream.length} >>
stream
${contentStream}
endstream
endobj`);

  // Object 3: 页面资源字典
  obj(`3 0 obj
<< /ProcSet [/PDF /ImageC]
   /XObject << /Im0 1 0 R >>
 >>
endobj`);

  // Object 4: Page
  obj(`4 0 obj
<< /Type /Page /Parent 5 0 R
   /MediaBox [0 0 ${pageW} ${pageH}]
   /Contents 2 0 R
   /Resources 3 0 R
 >>
endobj`);

  // Object 5: Pages
  obj(`5 0 obj
<< /Type /Pages /Kids [4 0 R] /Count 1 >>
endobj`);

  // Object 6: Catalog
  obj(`6 0 obj
<< /Type /Catalog /Pages 5 0 R >>
endobj`);

  // 计算每个对象的偏移
  let pdf = '%PDF-1.4\n%\xFF\xFF\xFF\xFF\n';
  const offsets = [];
  for (const ob of objects) {
    offsets.push(pdf.length);
    pdf += ob.data + '\n';
  }

  // xref 表
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objCount + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  }

  // trailer
  pdf += `trailer
<< /Size ${objCount + 1} /Root 6 0 R >>
startxref
${xrefOffset}
%%EOF`;

  return 'data:application/pdf;base64,' + btoa(pdf);
}
