/**
 * tests/contentScript.test.js
 *
 * Runs the real content_script.js against a small fake page and a fake clock.
 * Run with: node tests/contentScript.test.js
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { makeRunner, assert } from './helpers/chromeMock.js';

const { test, section, done } = makeRunner();
const source = fs.readFileSync(new URL('../content_script.js', import.meta.url), 'utf8');

/** A fake element: `parts` are strings or child elements, in document order. */
function el(tag, ...parts) {
  const element = {
    tag,
    parts,
    get textContent() {
      return this.parts.map(p => (typeof p === 'string' ? p : p.textContent)).join('');
    },
    cloneNode() {
      return el(tag, ...parts.map(p => (typeof p === 'string' ? p : p.cloneNode())));
    },
    // Only the "a, b, c" tag selectors the script uses.
    querySelectorAll(selector) {
      const tags = selector.split(',').map(s => s.trim());
      const found = [];
      for (const p of this.parts) {
        if (typeof p === 'string') continue;
        if (tags.includes(p.tag)) found.push(p);
        found.push(...p.querySelectorAll(selector));
      }
      return found;
    },
    remove() { /* set by the parent below */ },
  };
  for (const p of parts) {
    if (typeof p !== 'string') p.remove = () => { element.parts = element.parts.filter(x => x !== p); };
  }
  return element;
}

/** Loads the script into a fresh fake page. */
function loadPage({ elements = [], hidden = false } = {}) {
  let now = 0;
  const docListeners = {};
  const winListeners = {};
  let onMessage;

  class FakeDate extends Date {
    constructor() { super(now); }
    static now() { return now; }
  }
  const document = {
    hidden,
    title: 'Page title',
    querySelector: () => null,
    querySelectorAll: (selector) => el('body', ...elements).querySelectorAll(selector),
    addEventListener: (type, fn) => { docListeners[type] = fn; },
  };
  const window = {
    location: { href: 'https://example.com/', hostname: 'example.com' },
    addEventListener: (type, fn) => { winListeners[type] = fn; },
  };
  vm.runInNewContext(source, {
    document, window, Date: FakeDate, Array, setTimeout: () => {},
    chrome: { runtime: { sendMessage: () => Promise.resolve(), onMessage: { addListener: fn => { onMessage = fn; } } } },
  });

  const request = () => {
    let reply;
    onMessage({ type: 'REQUEST_TAB_DATA' }, {}, r => { reply = r; });
    return reply;
  };
  return {
    at: (ms) => { now = ms; },
    hide: () => { document.hidden = true; docListeners.visibilitychange(); },
    show: () => { document.hidden = false; docListeners.visibilitychange(); },
    blur: () => winListeners.blur(),
    focus: () => winListeners.focus(),
    dwell: () => request().dwellMs,
    content: () => request().content,
  };
}

section('dwell time');

test('counts time while visible', () => {
  const page = loadPage();
  page.at(7000);
  assert(page.dwell() === 7000, `got ${page.dwell()}`);
});

test('a tab that loads hidden does not count until shown', () => {
  const page = loadPage({ hidden: true });
  page.at(5000);
  assert(page.dwell() === 0, `got ${page.dwell()}`);
  page.show();
  page.at(8000);
  assert(page.dwell() === 3000, `got ${page.dwell()}`);
});

test('tab switch counts once when hidden fires before blur', () => {
  const page = loadPage();
  page.at(10000); page.hide(); page.blur(); page.at(60000);
  assert(page.dwell() === 10000, `got ${page.dwell()}`);
});

test('tab switch counts once when blur fires before hidden', () => {
  const page = loadPage();
  page.at(10000); page.blur(); page.hide(); page.at(60000);
  assert(page.dwell() === 10000, `got ${page.dwell()}`);
});

test('time away after alt-tab is not counted when the window is then minimised', () => {
  const page = loadPage();
  page.at(10000); page.blur(); page.at(40000); page.hide();
  assert(page.dwell() === 10000, `got ${page.dwell()}`);
});

test('a focus event does not throw away time already running', () => {
  const page = loadPage();
  page.at(30000); page.focus(); page.at(40000);
  assert(page.dwell() === 40000, `got ${page.dwell()}`);
});

test('returning to a tab adds to the total, counting show-then-focus once', () => {
  const page = loadPage();
  page.at(5000); page.hide(); page.blur();
  page.at(20000); page.show();
  page.at(21000); page.focus();
  page.at(31000);
  assert(page.dwell() === 16000, `got ${page.dwell()}`);
});

test('focus on a hidden tab does not start the timer', () => {
  const page = loadPage();
  page.at(1000); page.hide(); page.focus(); page.at(9000);
  assert(page.dwell() === 1000, `got ${page.dwell()}`);
});

section('text extraction');

const css = '.mw-parser-output .IPA-label-small{font-size:85%}';

test('CSS nested inside a paragraph stays out of the text', () => {
  const page = loadPage({
    elements: [el('p', 'Carbonara (', el('style', css), 'Italian) is a pasta dish from Rome made with egg and cheese.')],
  });
  const text = page.content();
  assert(!text.includes('mw-parser-output'), `CSS leaked: ${text}`);
  assert(text.includes('Carbonara (Italian) is a pasta dish'), `paragraph lost: ${text}`);
});

test('CSS does not count towards the 50-character minimum for a first paragraph', () => {
  const page = loadPage({
    elements: [
      el('p', 'Short.', el('style', css.repeat(3))),
      el('p', 'This is the first paragraph that has real readable text in it.'),
    ],
  });
  const text = page.content();
  assert(!text.includes('Short.'), `picked the wrong paragraph: ${text}`);
  assert(text.includes('This is the first paragraph'), `missing paragraph: ${text}`);
});

test('scripts inside headings stay out of the text', () => {
  const page = loadPage({ elements: [el('h1', 'History', el('script', 'var x = 1;'))] });
  const text = page.content();
  assert(text.includes('History') && !text.includes('var x'), `got: ${text}`);
});

test('extraction leaves the live page untouched', () => {
  const style = el('style', css);
  const para = el('p', 'A paragraph long enough to be picked as the first paragraph here.', style);
  loadPage({ elements: [para] }).content();
  assert(para.parts.includes(style), 'the style tag must stay in the real page');
});

await done();
