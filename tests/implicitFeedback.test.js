/**
 * tests/implicitFeedback.test.js
 * Tests implicit-pair draining and training-example storage against a mocked
 * chrome.storage. Run with: node tests/implicitFeedback.test.js
 */
import { installChromeMock, makeRunner, assert } from './helpers/chromeMock.js';
import { consumeImplicitPairs, pickLeastSimilar } from '../src/ml/implicitFeedback.js';
import { storeTrainingExample, roundVector, loadTrainingExamples } from '../src/ml/personalise.js';

const { test, section, done } = makeRunner();

/** Unit vector pointing along axis `i` of a 512-dim space. */
function axis(i, jitter = 0) {
  const v = new Array(512).fill(0);
  v[i] = 1;
  v[(i + 1) % 512] = jitter;
  return v;
}
const tab = (tabId, emb, extra = {}) => ({ tabId, embedding: emb, title: `t${tabId}`, ...extra });

section('pickLeastSimilar');

test('picks the least similar tab, excluding given ids', () => {
  const a = tab(1, axis(0));
  const tabs = [a, tab(2, axis(0, 0.1)), tab(3, axis(10)), tab(4, axis(0, 0.5))];
  const far = pickLeastSimilar(a, tabs, new Set([1, 2]));
  assert(far.tabId === 3, `expected tab 3 (orthogonal), got ${far?.tabId}`);
});

test('returns null when nothing is left to choose from', () => {
  const a = tab(1, axis(0));
  assert(pickLeastSimilar(a, [a], new Set([1])) === null, 'no candidates -> null');
});

section('consumeImplicitPairs');

test('stores one positive and one weak negative per live candidate, then clears the queue', async () => {
  installChromeMock();
  await chrome.storage.local.set({
    implicit_training_candidates: JSON.stringify([{ aTabId: 1, bTabId: 2, queuedAt: 1 }]),
  });
  const tabs = [tab(1, axis(0)), tab(2, axis(0, 0.2)), tab(3, axis(40)), tab(4, axis(80))];
  const stored = await consumeImplicitPairs(tabs);
  assert(stored === 2, `expected 2 examples (1 pos + 1 neg), got ${stored}`);

  const examples = await loadTrainingExamples();
  const labels = examples.map(e => e.label).sort().join();
  assert(labels === '0,1', `expected labels 0,1 got ${labels}`);
  const { implicit_training_candidates } = await chrome.storage.local.get('implicit_training_candidates');
  assert(implicit_training_candidates === undefined, 'queue should be cleared');
});

test('drops candidates whose tabs have closed, still clears the queue', async () => {
  installChromeMock();
  await chrome.storage.local.set({
    implicit_training_candidates: JSON.stringify([{ aTabId: 1, bTabId: 99, queuedAt: 1 }]),
  });
  const stored = await consumeImplicitPairs([tab(1, axis(0)), tab(2, axis(5))]);
  assert(stored === 0, 'nothing to store when one tab is gone');
  const { implicit_training_candidates } = await chrome.storage.local.get('implicit_training_candidates');
  assert(implicit_training_candidates === undefined, 'stale queue should be cleared');
});

test('with only the two candidate tabs open, stores the positive but no negative', async () => {
  installChromeMock();
  await chrome.storage.local.set({
    implicit_training_candidates: JSON.stringify([{ aTabId: 1, bTabId: 2, queuedAt: 1 }]),
  });
  const stored = await consumeImplicitPairs([tab(1, axis(0)), tab(2, axis(1))]);
  assert(stored === 1, `expected just 1 positive, got ${stored}`);
});

test('empty queue is a cheap no-op', async () => {
  installChromeMock();
  assert((await consumeImplicitPairs([tab(1, axis(0))])) === 0, 'no candidates -> 0');
});

section('storeTrainingExample');

test('rounds embeddings to 4 decimals and shrinks the stored JSON', async () => {
  installChromeMock();
  const rnd = () => Array.from({ length: 512 }, () => Math.random() * 2 - 1);
  const a = tab(1, rnd());
  const b = tab(2, rnd());
  await storeTrainingExample(a, b, 1);

  const { nn_training_examples } = await chrome.storage.local.get('nn_training_examples');
  const [ex] = JSON.parse(nn_training_examples);
  assert(ex.embeddingA.every(x => Math.abs(x - Math.round(x * 1e4) / 1e4) < 1e-12), 'values rounded to 4 dp');

  const fullPrecision = JSON.stringify({ e: [a.embedding, b.embedding] }).length;
  assert(nn_training_examples.length < fullPrecision * 0.6,
    `rounded JSON (${nn_training_examples.length}) should be well under full precision (${fullPrecision})`);
});

test('keeps at most 200 examples', async () => {
  installChromeMock();
  const a = tab(1, axis(0));
  const b = tab(2, axis(1));
  for (let i = 0; i < 205; i++) await storeTrainingExample(a, b, i % 2);
  assert((await loadTrainingExamples()).length === 200, 'capped at 200');
});

test('roundVector keeps cosine similarity essentially unchanged', () => {
  const v = Array.from({ length: 512 }, (_, i) => Math.sin(i) / 20);
  const r = roundVector(v);
  const dot = v.reduce((s, x, i) => s + x * r[i], 0);
  const nv = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  const nr = Math.sqrt(r.reduce((s, x) => s + x * x, 0));
  assert(dot / (nv * nr) > 0.9999, 'cosine(original, rounded) should be ~1');
});

await done();
