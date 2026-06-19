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
            contextFrame, headerRegion, footerRegion } = request;

    if (!frames || frames.length === 0) throw new Error('No frames');

    console.log('[Offscreen] Stitching', frames.length, 'frames...');

    // 加载容器滚动帧
    let images = await Promise.all(frames.map(d => loadImage(d.dataUrl)));

    // 如果指定了裁剪区域（用于自定义滚动容器），裁剪每帧到容器可见区域
    if (cropRect) {
      console.log('[Offscreen] Cropping to container:', cropRect);
      for (let i = 0; i < images.length; i++) {
        images[i] = cropToRect(images[i], cropRect, devicePixelRatio);
      }
    }

    // 计算容器帧拼接偏移
    const containerOffsets = calculateOffsets(images, frames);
    const dpr = devicePixelRatio || 1;

    // === 处理页眉页脚（保留上下文帧的非容器区域） ===
    let allImages = [];
    let allOffsets = [];
    let headerHeightPx = 0;

    if (contextFrame && (headerRegion || footerRegion)) {
      const contextImg = await loadImage(contextFrame);

      // 提取页眉区域（视口顶部到容器顶部）
      if (headerRegion) {
        const headerImg = cropToRect(contextImg, headerRegion, dpr);
        headerHeightPx = headerImg.height;
        allImages.push(headerImg);
        allOffsets.push(0);
      }

      // 容器帧（偏移量加上页眉高度）
      for (let i = 0; i < images.length; i++) {
        allImages.push(images[i]);
        allOffsets.push(containerOffsets[i] + headerHeightPx);
      }

      // 提取页脚区域（容器底部到视口底部）
      if (footerRegion) {
        const footerImg = cropToRect(contextImg, footerRegion, dpr);
        allImages.push(footerImg);
        const lastBottom = allOffsets[allOffsets.length - 1] + images[images.length - 1].height;
        allOffsets.push(lastBottom);
      }
    } else {
      // 无页眉页脚，直接使用容器帧
      allImages = images;
      allOffsets = containerOffsets;
    }

    // 计算最终尺寸
    const imageWidth = cropRect
      ? Math.round(cropRect.width * dpr)
      : Math.round(viewportWidth * dpr);

    const lastImg = allImages[allImages.length - 1];
    const lastOffset = allOffsets[allOffsets.length - 1] || 0;
    const imageHeight = lastOffset + lastImg.height;

    console.log('[Offscreen] Size:', imageWidth, 'x', imageHeight);

    let canvas;
    if (imageWidth > MAX_CANVAS_SIZE || imageHeight > MAX_CANVAS_SIZE ||
        imageWidth * imageHeight > MAX_CANVAS_AREA) {
      canvas = stitchWithSlicing(allImages, allOffsets, imageWidth, imageHeight);
    } else {
      canvas = stitchToCanvas(allImages, allOffsets, imageWidth, imageHeight);
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
    allImages.forEach(img => {
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
 * @param {HTMLImageElement} image - 原始图片
 * @param {{top:number, left:number, width:number, height:number}} rect - CSS 像素坐标的裁剪区域
 * @param {number} dpr - 设备像素比
 * @returns {HTMLCanvasElement} 裁剪后的 canvas
 */
function cropToRect(image, rect, dpr) {
  const sx = Math.round(rect.left * dpr);
  const sy = Math.round(rect.top * dpr);
  const sw = Math.round(rect.width * dpr);
  const sh = Math.round(rect.height * dpr);
  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas;
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
