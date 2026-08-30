import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const nativeScroller = {};
const documentStub = {
  body: nativeScroller,
  documentElement: nativeScroller,
  scrollingElement: nativeScroller,
  images: [],
  querySelectorAll: () => [],
};

const context = {
  chrome: {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage() { return Promise.resolve(); },
    },
  },
  document: documentStub,
  window: {
    innerWidth: 1200,
    innerHeight: 800,
    scrollY: 0,
    scrollX: 0,
    devicePixelRatio: 1,
    scrollTo() {},
    getComputedStyle: () => ({ overflowY: 'visible' }),
  },
  Event: class Event {},
  requestAnimationFrame: (callback) => callback(),
  location: { href: 'https://fixture.local/' },
  setTimeout,
  console,
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('edge-extension/content/content.js', 'utf8'), context);

function element(rect, descendants = []) {
  return {
    getBoundingClientRect: () => rect,
    contains: (other) => descendants.includes(other),
  };
}

function candidate(name, rect, elementRef, scrollHeight = 1800) {
  return {
    selector: name,
    element: elementRef,
    isNative: false,
    scrollHeight,
    scrollWidth: rect.width,
    clientHeight: rect.height,
    clientWidth: rect.width,
  };
}

const inner = element({ top: 180, left: 180, width: 600, height: 280 });
const outer = element({ top: 80, left: 80, width: 800, height: 650 }, [inner]);
const nested = context.filterIndependentContainers([
  candidate('outer', outer.getBoundingClientRect(), outer),
  candidate('inner', inner.getBoundingClientRect(), inner),
]);
assert.deepEqual(Array.from(nested, item => item.selector), ['outer']);

const base = element({ top: 70, left: 70, width: 900, height: 700 });
const overlay = element({ top: 110, left: 110, width: 800, height: 620 });
const overlapping = context.filterIndependentContainers([
  candidate('base', base.getBoundingClientRect(), base),
  candidate('overlay', overlay.getBoundingClientRect(), overlay),
]);
assert.deepEqual(Array.from(overlapping, item => item.selector), ['base']);

const left = element({ top: 80, left: 40, width: 520, height: 650 });
const right = element({ top: 80, left: 640, width: 520, height: 650 });
const independent = context.filterIndependentContainers([
  candidate('left', left.getBoundingClientRect(), left),
  candidate('right', right.getBoundingClientRect(), right),
]);
assert.deepEqual(Array.from(independent, item => item.selector), ['left', 'right']);

const pageCandidate = {
  selector: 'page',
  element: nativeScroller,
  isNative: true,
  scrollHeight: 2400,
  scrollWidth: 1200,
  clientHeight: 800,
  clientWidth: 1200,
};
const withPage = context.filterIndependentContainers([
  pageCandidate,
  candidate('left', left.getBoundingClientRect(), left),
  candidate('right', right.getBoundingClientRect(), right),
]);
assert.deepEqual(Array.from(withPage, item => item.selector), ['page', 'left', 'right']);

assert.deepEqual(Array.from(context.createCapturePositions(2000, 500)), [0, 400, 800, 1200, 1500]);
assert.equal(context.capturePlanLayoutChanged(
  { cropRect: { top: 10, left: 10, width: 300, height: 400 }, viewportWidth: 1200, viewportHeight: 400, scalarHeight: 1800 },
  { cropRect: { top: 14, left: 10, width: 300, height: 400 }, viewportWidth: 1200, viewportHeight: 400, scalarHeight: 1800 },
), true);
assert.equal(context.capturePlanLayoutChanged(
  { cropRect: { top: 10, left: 10, width: 300, height: 400 }, viewportWidth: 1200, viewportHeight: 400, scalarHeight: 1800 },
  { cropRect: { top: 11, left: 10, width: 300, height: 400 }, viewportWidth: 1200, viewportHeight: 400, scalarHeight: 1800 },
), false);

console.log('Content-script multi-region logic checks passed.');
