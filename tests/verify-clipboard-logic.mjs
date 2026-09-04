import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const manifest = JSON.parse(fs.readFileSync('edge-extension/manifest.json', 'utf8'));
assert.ok(manifest.permissions.includes('clipboardWrite'));

const offscreenJs = fs.readFileSync('edge-extension/background/offscreen.js', 'utf8');
const serviceWorkerJs = fs.readFileSync('edge-extension/background/service-worker.js', 'utf8');
const popupHtml = fs.readFileSync('edge-extension/popup/popup.html', 'utf8');
const popupJs = fs.readFileSync('edge-extension/popup/popup.js', 'utf8');

assert.match(popupHtml, /id="copyToClipboardCheck"/);
assert.match(popupJs, /copyToClipboard:\s*copyToClipboardCheck\.checked/);
assert.match(popupJs, /action:\s*'downloadViewport'/);
assert.match(popupJs, /writePngToExtensionClipboard/);
assert.match(popupJs, /response\.clipboardDataUrl/);
assert.match(serviceWorkerJs, /clipboardDataUrl/);
assert.match(serviceWorkerJs, /writeClipboardToTab/);
assert.match(serviceWorkerJs, /func:\s*writePngToPageClipboard/);
assert.doesNotMatch(serviceWorkerJs, /waitForClipboardInOffscreen/);
assert.doesNotMatch(offscreenJs, /execCommand/);
assert.doesNotMatch(offscreenJs, /clipboardTaskId/);

const offscreenListeners = [];
const canvasFormats = [];
class ImageStub {
  constructor() {
    this.width = 10;
    this.height = 10;
    this.naturalWidth = 10;
    this.naturalHeight = 10;
  }

  set src(value) {
    this._src = value;
    this.onload?.();
  }
}

function createCanvasStub() {
  return {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {}, fillRect() {} }),
    toDataURL: mimeType => {
      canvasFormats.push(mimeType);
      return `data:${mimeType};base64,AA==`;
    },
  };
}

const offscreenContext = {
  Blob,
  Image: ImageStub,
  document: { createElement: tagName => tagName === 'canvas' ? createCanvasStub() : {} },
  fetch: async (dataUrl) => ({
    ok: dataUrl.startsWith('data:'),
    blob: async () => new Blob(['fixture'], { type: 'image/png' }),
  }),
  chrome: {
    runtime: {
      onMessage: { addListener: (listener) => offscreenListeners.push(listener) },
    },
  },
  console: {
    log: () => {},
    warn: () => {},
    error: () => {},
  },
};
vm.createContext(offscreenContext);
vm.runInContext(offscreenJs, offscreenContext);

assert.equal(typeof offscreenContext.calculateOffsets, 'function');
assert.deepEqual(
  Array.from(offscreenContext.calculateOffsets(
    [{ height: 100 }, { height: 100 }, { height: 100 }],
    [{ y: 0 }, { y: 80 }, { y: 160 }],
  )),
  [0, 80, 160],
);

const mixedResponse = await new Promise((resolve) => {
  offscreenListeners[0](
    {
      action: 'stitch',
      containerStrips: [
        { isNative: true, frames: [] },
        { isNative: false, cropRect: { top: 0, left: 0, width: 10, height: 10 }, frames: [] },
      ],
    },
    {},
    resolve,
  );
});
assert.equal(mixedResponse.success, false);
assert.match(mixedResponse.error, /不能与自定义滚动区域同时合成/);

const stitchResponse = await new Promise((resolve) => {
  offscreenListeners[0](
    {
      action: 'stitch',
      containerStrips: [{
        containerIndex: 0,
        isNative: true,
        frames: [{ dataUrl: 'data:image/png;base64,AA==', y: 0 }],
      }],
      primaryContainerIndex: 0,
      viewportWidth: 10,
      devicePixelRatio: 1,
      format: 'jpeg',
      copyToClipboard: true,
    },
    {},
    resolve,
  );
});
assert.equal(stitchResponse.success, true);
assert.match(stitchResponse.dataUrl, /^data:image\/jpeg/);
assert.match(stitchResponse.clipboardDataUrl, /^data:image\/png/);
assert.deepEqual(canvasFormats, ['image/jpeg', 'image/png']);

const writes = [];
class ClipboardItemStub {
  constructor(data) {
    this.data = data;
    this.types = Object.keys(data);
  }

  static supports(type) {
    return type === 'image/png';
  }
}

const serviceListeners = [];
let scriptDetails = null;
const serviceContext = {
  Blob,
  ClipboardItem: ClipboardItemStub,
  window: { isSecureContext: true },
  navigator: {
    clipboard: {
      write: async (items) => writes.push(items),
    },
  },
  fetch: async (dataUrl) => ({
    ok: dataUrl.startsWith('data:image/png'),
    blob: async () => new Blob(['fixture'], { type: 'image/png' }),
  }),
  chrome: {
    runtime: {
      onMessage: { addListener: (listener) => serviceListeners.push(listener) },
      sendMessage: async () => undefined,
    },
    commands: {
      onCommand: { addListener() {} },
    },
    tabs: {
      get: async () => ({ id: 42, active: true }),
      query: async () => [],
      sendMessage() {},
      captureVisibleTab() {},
    },
    storage: { local: { get: async () => ({}) } },
    scripting: {
      executeScript: async (details) => {
        scriptDetails = details;
        return [{ result: { success: true, clipboardCopied: true, clipboardError: '' } }];
      },
    },
    offscreen: {
      hasDocument: async () => false,
      createDocument: async () => {},
      closeDocument: async () => {},
    },
    downloads: { download() {} },
  },
  console: {
    log: () => {},
    warn: () => {},
    error: () => {},
  },
  setTimeout,
  clearTimeout,
  Promise,
};
vm.createContext(serviceContext);
vm.runInContext(serviceWorkerJs, serviceContext);

const dataUrl = 'data:image/png;base64,AA==';
const pageResult = await serviceContext.writePngToPageClipboard(dataUrl);
assert.equal(pageResult.success, true);
assert.equal(pageResult.clipboardCopied, true);
assert.equal(writes.length, 1);
assert.deepEqual(writes[0][0].types, ['image/png']);

const tabResult = await serviceContext.writeClipboardToTab(42, dataUrl);
assert.equal(tabResult.clipboardCopied, true);
assert.equal(scriptDetails.target.tabId, 42);
assert.equal(scriptDetails.func, serviceContext.writePngToPageClipboard);
assert.equal(scriptDetails.args.length, 1);
assert.equal(scriptDetails.args[0], dataUrl);

serviceContext.window.isSecureContext = false;
const insecureResult = await serviceContext.writePngToPageClipboard(dataUrl);
assert.equal(insecureResult.success, false);
assert.match(insecureResult.clipboardError, /HTTPS/);

assert.equal(serviceListeners.length, 1);
console.log('Clipboard logic checks passed.');
