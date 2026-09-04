import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

let documentExists = false;
let createCount = 0;
let closeCount = 0;
let lastDownload = null;
let hasDocumentStarted = null;
let releaseHasDocument = null;
let blockHasDocument = false;
let lastScript = null;
const messageListeners = [];

const context = {
  chrome: {
    runtime: {
      onMessage: { addListener: listener => messageListeners.push(listener) },
      sendMessage: async () => undefined,
    },
    commands: {
      onCommand: { addListener() {} },
    },
    offscreen: {
      hasDocument: async () => {
        if (blockHasDocument) {
          hasDocumentStarted?.();
          await new Promise(resolve => { releaseHasDocument = resolve; });
        }
        return documentExists;
      },
      createDocument: async () => {
        createCount++;
        await new Promise(resolve => setTimeout(resolve, 10));
        documentExists = true;
      },
      closeDocument: async () => {
        closeCount++;
        documentExists = false;
      },
    },
    tabs: {
      query: async () => [],
      get: async tabId => ({ id: tabId, active: true, windowId: 1 }),
      sendMessage() {},
      captureVisibleTab() {},
    },
    storage: { local: { get: async () => ({}) } },
  scripting: {
    executeScript: async details => {
      lastScript = details;
      return [{ result: { success: true, clipboardCopied: true, clipboardError: '' } }];
    },
  },
    downloads: {
      download: (options, callback) => {
        lastDownload = options;
        callback?.(42);
      },
    },
  },
  console,
  setTimeout,
  clearTimeout,
  Promise,
};

vm.createContext(context);
vm.runInContext(fs.readFileSync('edge-extension/background/service-worker.js', 'utf8'), context);

await Promise.all([context.acquireOffscreen(), context.acquireOffscreen()]);
assert.equal(createCount, 1);
assert.equal(documentExists, true);

await context.closeOffscreen();
assert.equal(closeCount, 0);
await context.releaseOffscreen();
assert.equal(closeCount, 0);
await context.releaseOffscreen();
assert.equal(closeCount, 1);
await context.closeOffscreen();
assert.equal(closeCount, 1);

// A new acquire racing with a pending close must keep the shared document alive.
await context.acquireOffscreen();
await context.releaseOffscreen();
hasDocumentStarted = null;
releaseHasDocument = null;
blockHasDocument = true;
const closeBegan = new Promise(resolve => { hasDocumentStarted = resolve; });
const closePromise = context.closeOffscreen();
await closeBegan;
const reacquirePromise = context.acquireOffscreen();
releaseHasDocument?.();
blockHasDocument = false;
await Promise.all([closePromise, reacquirePromise]);
assert.equal(documentExists, true);
assert.equal(createCount, 2);
assert.equal(closeCount, 1);
await context.releaseOffscreen();
await context.closeOffscreen();
assert.equal(closeCount, 2);

assert.equal(messageListeners.length, 1);
assert.match(context.generateFilename('Page / title', 'png', { subfolder: 'SnapLong' }), /^SnapLong\/Page___title_.*\.png$/);

const viewportResponse = await new Promise((resolve) => {
  messageListeners[0](
    {
      action: 'downloadViewport',
      dataUrl: 'data:image/png;base64,AA==',
      savePath: 'ViewportShots',
      saveAs: true,
    },
    {},
    resolve,
  );
});
assert.equal(viewportResponse.success, true);
assert.equal(lastDownload.saveAs, true);
assert.match(lastDownload.filename, /^ViewportShots\/screenshot_.*\.png$/);

const clipboardResponse = await new Promise((resolve) => {
  messageListeners[0](
    {
      action: 'copyToClipboard',
      tabId: 42,
      dataUrl: 'data:image/png;base64,AA==',
    },
    {},
    resolve,
  );
});
assert.equal(clipboardResponse.success, true);
assert.equal(clipboardResponse.clipboardCopied, true);
assert.equal(lastScript.target.tabId, 42);
assert.equal(lastScript.args[0], 'data:image/png;base64,AA==');
assert.equal(typeof lastScript.func, 'function');

console.log('Service-worker lifecycle checks passed.');
