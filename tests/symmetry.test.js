/**
 * tests/symmetry.test.js — the network must not care which tab is listed first.
 *
 * The architecture concatenates [encA, encB, behA, behB] in a fixed order, so
 * a raw prediction f(A, B) differs from f(B, A). scoreAllPairs averages both
 * orders and trainModel trains on swapped copies. Uses TensorFlow.js on the
 * CPU in Node; builds a real model, so allow a few seconds.
 * Run with: node tests/symmetry.test.js
 */
import { buildModel, scoreTabPair, scoreAllPairs, trainModel, tabToBehaviourVector } from '../src/ml/nn.js';
import { mulberry32 } from '../eval/metrics.js';
import { makeRunner, assert } from './helpers/chromeMock.js';

const { test, section, done } = makeRunner();

function unitVec(rand) {
  const v = Array.from({ length: 512 }, () => rand() - 0.5);
  const n = Math.hypot(...v);
  return v.map(x => x / n);
}
const rand = mulberry32(21);
const NOW = Date.now();
const mkTab = (id, extra = {}) => ({
  tabId: id, embedding: unitVec(rand),
  dwellMs: 120000, revisitCount: 4, hourOfDay: 14, transitionCount: 3, lastActive: NOW - 60000,
  ...extra,
});

let model;

section('symmetry');

test('builds the model with 72,665 parameters', async () => {
  model = await buildModel();
  assert(model.countParams() === 72665, `expected 72665 params, got ${model.countParams()}`);
});

test('a raw single-pair prediction IS order dependent (why averaging is needed)', async () => {
  const a = mkTab(1), b = mkTab(2, { dwellMs: 480000, revisitCount: 11, hourOfDay: 3 });
  const ab = await scoreTabPair(a.embedding, tabToBehaviourVector(a), b.embedding, tabToBehaviourVector(b), model);
  const ba = await scoreTabPair(b.embedding, tabToBehaviourVector(b), a.embedding, tabToBehaviourVector(a), model);
  assert(Math.abs(ab - ba) > 1e-6, `expected a visible difference, got ${ab} vs ${ba}`);
});

test('scoreAllPairs gives the same score whichever order the tabs are listed in', async () => {
  const a = mkTab(1), b = mkTab(2, { dwellMs: 480000, revisitCount: 11, hourOfDay: 3 });
  const m1 = await scoreAllPairs([a, b], model);
  const m2 = await scoreAllPairs([b, a], model);
  assert(Math.abs(m1[0][1] - m2[0][1]) < 1e-6, `${m1[0][1]} vs ${m2[0][1]}`);
});

test('scoreAllPairs returns a symmetric matrix with a unit diagonal, values in [0,1]', async () => {
  const tabs = [mkTab(1), mkTab(2), mkTab(3), mkTab(4)];
  const m = await scoreAllPairs(tabs, model);
  for (let i = 0; i < 4; i++) {
    assert(m[i][i] === 1, 'diagonal is 1');
    for (let j = 0; j < 4; j++) {
      assert(m[i][j] === m[j][i], `matrix not symmetric at ${i},${j}`);
      assert(m[i][j] >= 0 && m[i][j] <= 1, 'score in [0,1]');
    }
  }
});

test('a single tab gives a 1x1 matrix without crashing', async () => {
  const m = await scoreAllPairs([mkTab(1)], model);
  assert(m.length === 1 && m[0][0] === 1, '1x1 identity');
});

section('training');

test('trainModel runs on swapped copies and produces finite loss', async () => {
  const fresh = await buildModel();
  const examples = Array.from({ length: 6 }, (_, i) => {
    const a = mkTab(10 + i), b = mkTab(20 + i);
    return {
      embeddingA: a.embedding, behaviourA: tabToBehaviourVector(a),
      embeddingB: b.embedding, behaviourB: tabToBehaviourVector(b),
      label: i % 2,
    };
  });
  const history = await trainModel(examples, fresh, { epochs: 2, batchSize: 4 });
  const loss = history.history.loss;
  assert(loss.length === 2 && loss.every(Number.isFinite), `bad loss history: ${loss}`);
});

test('trainModel still rejects fewer than 4 examples', async () => {
  let threw = false;
  try { await trainModel([], await buildModel()); } catch { threw = true; }
  assert(threw, 'should throw on too few examples');
});

await done();
