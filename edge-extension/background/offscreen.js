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
    const { containerStrips, primaryContainerIndex, viewportWidth, devicePixelRatio, format,
            contextFrame } = request;

    if (!containerStrips || containerStrips.length === 0) throw new Error('No container strips');

    console.log('[Offscreen] Stitching', containerStrips.length, 'containers, compositing:', !!contextFrame);

    const dpr = devicePixelRatio || 1;
    const fullW = Math.round(viewportWidth * dpr);

    // Step 1: 每个容器独立裁剪 + 拼接
    const stitchedStrips = [];
    let primaryStripHeight = 0;

    for (const cs of containerStrips) {
      if (!cs.frames || cs.frames.length === 0) continue;

      // 加载本容器的帧
      let images = await Promise.all(cs.frames.map(f => loadImage(f.dataUrl)));

      // 裁剪到容器区域
      if (cs.cropRect) {
        for (let i = 0; i < images.length; i++) {
          const cropped = cropToRect(images[i], cs.cropRect, dpr);
          if (cropped) images[i] = cropped;
        }
      }

      // 拼接本容器
      const offsets = calculateOffsets(images, cs.frames);
      const lastIdx = images.length - 1;
      const stripHeight = offsets[lastIdx] + images[lastIdx].height;

      // 生成 strip canvas
      const stripCanvas = document.createElement('canvas');
      const stripW = cs.cropRect ? Math.round(cs.cropRect.width * dpr) : fullW;
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
        ctx.drawImage(s.canvas, 0, 0, s.canvas.width, s.height,
                      x, topHeight, s.canvas.width, s.height);
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
      const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.9);
      dataUrl = generateSimplePdf(jpegDataUrl, canvas.width, canvas.height);
    } else {
      const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
      const quality = format === 'jpeg' ? 0.92 : undefined;
      dataUrl = canvas.toDataURL(mimeType, quality);
    }

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
