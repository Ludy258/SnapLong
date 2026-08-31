import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const manifest = JSON.parse(fs.readFileSync('edge-extension/manifest.json', 'utf8'));
assert.ok(manifest.permissions.includes('clipboardWrite'));
const serviceWorkerJs = fs.readFileSync('edge-extension/background/service-worker.js', 'utf8');

const popupHtml = fs.readFileSync('edge-extension/popup/popup.html', 'utf8');
const popupJs = fs.readFileSync('edge-extension/popup/popup.js', 'utf8');
assert.match(popupHtml, /id="copyToClipboardCheck"/);
assert.match(popupJs, /copyToClipboard:\s*copyToClipboardCheck\.checked/);
assert.match(popupJs, /action:\s*'downloadViewport'/);
assert.match(popupJs, /clearTimeout\(messageTimer\)/);
assert.match(serviceWorkerJs, /case\s*'downloadViewport'/);
assert.match(serviceWorkerJs, /offscreenLeaseCount/);

const listeners = [];
const writes = [];
const testConsole = {
  log: console.log,
  warn: () => {},
  error: () => {},
};

class ClipboardItemStub {
  constructor(data) {
    this.data = data;
    this.types = Object.keys(data);
  }

  static supports(type) {
    return type === 'image/png';
  }
}

const context = {
  Blob,
  ClipboardItem: ClipboardItemStub,
  navigator: {
    clipboard: {
      write: async (items) => writes.push(items),
    },
  },
  fetch: async (dataUrl) => ({
    ok: dataUrl.startsWith('data:'),
    blob: async () => new Blob(['fixture'], { type: 'image/png' }),
  }),
  setTimeout,
  clearTimeout,
  chrome: {
    runtime: {
      onMessage: { addListener: (listener) => listeners.push(listener) },
    },
  },
  console: testConsole,
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('edge-extension/background/offscreen.js', 'utf8'), context);

assert.equal(typeof context.copyDataUrlToClipboard, 'function');
assert.equal(typeof context.copyCanvasToClipboard, 'function');
assert.equal(typeof context.startClipboardTask, 'function');
assert.equal(typeof context.waitForClipboardTask, 'function');
assert.equal(typeof context.calculateOffsets, 'function');

await context.copyDataUrlToClipboard('data:image/png;base64,AA==');
await context.copyCanvasToClipboard({
  toBlob: (callback) => callback(new Blob(['fixture'], { type: 'image/png' })),
});

assert.equal(writes.length, 2);
assert.deepEqual(writes[0][0].types, ['image/png']);
assert.deepEqual(writes[1][0].types, ['image/png']);
assert.deepEqual(
  Array.from(context.calculateOffsets(
    [{ height: 100 }, { height: 100 }, { height: 100 }],
    [{ y: 0 }, { y: 80 }, { y: 160 }],
  )),
  [0, 80, 160],
);

assert.equal(listeners.length, 1);
const listenerResponse = await new Promise((resolve) => {
  const handled = listeners[0](
    { action: 'writeClipboard', dataUrl: 'data:image/png;base64,AA==' },
    {},
    resolve,
  );
  assert.equal(handled, true);
});
assert.equal(listenerResponse.success, true);
assert.equal(listenerResponse.clipboardCopied, true);

const mixedResponse = await new Promise((resolve) => {
  listeners[0](
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

const timeoutTaskId = context.startClipboardTask(() => new Promise(() => {}));
const timeoutResult = await context.waitForClipboardTask(timeoutTaskId, 5);
assert.equal(timeoutResult.success, false);
assert.equal(timeoutResult.clipboardError, '剪贴板写入超时');

console.log('Clipboard logic checks passed.');
