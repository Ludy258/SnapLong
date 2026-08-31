import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

let panelHeight = 900;
let expansions = 0;
let panelScrollTop = 0;

const nativeScroller = {
  scrollHeight: 0,
  scrollWidth: 0,
  clientHeight: 0,
  clientWidth: 0,
  offsetHeight: 0,
  offsetWidth: 0,
  style: {},
};

const panel = {
  tagName: 'SECTION',
  id: 'lazy-panel',
  className: 'scroll-panel',
  scrollWidth: 800,
  clientWidth: 800,
  clientHeight: 400,
  offsetWidth: 800,
  offsetHeight: 400,
  scrollLeft: 0,
  style: {},
  get scrollHeight() {
    return panelHeight;
  },
  get scrollTop() {
    return panelScrollTop;
  },
  set scrollTop(value) {
    panelScrollTop = Math.max(0, Number(value) || 0);
  },
  getBoundingClientRect: () => ({
    top: 0, left: 0, right: 800, bottom: 400, width: 800, height: 400,
  }),
  contains: () => false,
  dispatchEvent() {
    if (panelScrollTop + panel.clientHeight >= panelHeight - 2 && expansions < 2) {
      panelHeight += 400;
      expansions++;
    }
  },
};

const documentStub = {
  body: nativeScroller,
  documentElement: nativeScroller,
  scrollingElement: nativeScroller,
  images: [],
  querySelectorAll: () => [panel],
};

const immediateTimeout = (callback) => {
  callback();
  return 1;
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
    getComputedStyle: (element) => ({
      overflowY: element === panel ? 'auto' : 'visible',
      position: 'static',
    }),
  },
  Event: class Event {},
  requestAnimationFrame: (callback) => callback(),
  location: { href: 'https://fixture.local/lazy' },
  setTimeout: immediateTimeout,
  clearTimeout() {},
  console,
};

vm.createContext(context);
vm.runInContext(fs.readFileSync('edge-extension/content/content.js', 'utf8'), context);

const pageInfo = await new Promise(resolve => context.handleGetPageInfo(resolve));
assert.equal(pageInfo.success, true);
assert.deepEqual(Array.from(pageInfo.scrollContainers, item => item.selector), ['section#lazy-panel']);

const result = await new Promise(resolve => context.handleStartCapture({
  options: { preScroll: true, scrollContainerIndices: [0] },
}, resolve));

assert.equal(result.success, true);
assert.equal(result.containerPlans.length, 1);
assert.equal(result.containerPlans[0].scalarWidth, 800);
assert.equal(result.containerPlans[0].scalarHeight, 1700);
assert.equal(panelScrollTop, 0);
assert.equal(expansions, 2);

console.log('Lazy-scroll stabilization checks passed.');
