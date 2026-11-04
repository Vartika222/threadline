/**
 * tests/personalise.test.js — the optional learned adjustment to cosine similarity.
 * Run with: node tests/personalise.test.js
 */
import {
  trainAdjustments, scoreAllPairs, saveAdjustments, loadAdjustments,
  isPersonalisationEnabled, setPersonalisationEnabled,
} from '../src/ml/personalise.js';
import { cosineSimilarity } from '../src/ml/embedder.js';
import { mulberry32 } from '../eval/metrics.js';
import { installChromeMock, makeRunner, assert } from './helpers/chromeMock.js';

const { test, section, done } = makeRunner();
const DIM = 64;
const unit = (v) => { const n = Math.hypot(...v); return v.map(x => x / n); };

/** A random unit vector, biased towards one axis if `axis` is given. */
function vector(rand, axis) {
  const v = Array.from({ length: DIM }, () => (rand() - 0.5) * 0.3);
  if (axis !== undefined) v[axis] += 1;
  return unit(v);
}
const noAdjustment = new Array(DIM).fill(0);

section('on / off');

test('off by default', async () => {
  installChromeMock();
  assert(await isPersonalisationEnabled() === false, 'must be opt-in');
});

test('remembers the choice', async () => {
  installChromeMock();
  await setPersonalisationEnabled(true);
  assert(await isPersonalisationEnabled() === true, 'on');
  await setPersonalisationEnabled(false);
  assert(await isPersonalisationEnabled() === false, 'off again');
});

section('scoring');

test('with no adjustment it equals cosine similarity', () => {
  const rand = mulberry32(1);
  const tabs = [0, 1, 2, 3].map(() => ({ embedding: vector(rand) }));
  const m = scoreAllPairs(tabs, noAdjustment);
  const cos = Math.max(0, cosineSimilarity(tabs[0].embedding, tabs[1].embedding));
  assert(Math.abs(m[0][1] - cos) < 1e-9, `${m[0][1]} vs ${cos}`);
});

test('is symmetric and stays on the 0-1 scale, with 1 on the diagonal', () => {
  const rand = mulberry32(2);
  const tabs = [0, 1, 2, 3, 4].map(() => ({ embedding: vector(rand) }));
  const adjustments = Array.from({ length: DIM }, () => (rand() - 0.5) * 20);
  const m = scoreAllPairs(tabs, adjustments);
  tabs.forEach((_, i) => tabs.forEach((__, j) => {
    assert(m[i][j] === m[j][i], 'not symmetric');
    assert(m[i][j] >= 0 && m[i][j] <= 1, `out of range: ${m[i][j]}`);
    if (i === j) assert(m[i][j] === 1, 'diagonal must be 1');
  }));
});

section('training');

test('moves scores the way the corrections say', () => {
  const rand = mulberry32(3);
  // Tabs sharing axis 0 are "related"; tabs across axes 1 and 2 are "unrelated".
  const examples = [];
  for (let i = 0; i < 20; i++) {
    examples.push({ embeddingA: vector(rand, 0), embeddingB: vector(rand, 0), label: 1 });
    examples.push({ embeddingA: vector(rand, 1), embeddingB: vector(rand, 2), label: 0 });
  }
  const adjustments = trainAdjustments(examples);
  const related = [{ embedding: vector(rand, 0) }, { embedding: vector(rand, 0) }];
  const before = scoreAllPairs(related, noAdjustment)[0][1];
  const after = scoreAllPairs(related, adjustments)[0][1];
  assert(after >= before, `related pair fell from ${before} to ${after}`);
  assert(adjustments[0] > 0, 'the dimension behind related pairs should gain weight');
});

test('same examples always give the same weights', () => {
  const rand = mulberry32(4);
  const examples = Array.from({ length: 16 }, (_, i) => ({
    embeddingA: vector(rand), embeddingB: vector(rand), label: i % 2,
  }));
  assert(trainAdjustments(examples).join() === trainAdjustments(examples).join(), 'differs between runs');
});

test('inconsistent corrections leave scores close to cosine', () => {
  const rand = mulberry32(5);
  const examples = Array.from({ length: 60 }, (_, i) => ({
    embeddingA: vector(rand), embeddingB: vector(rand), label: i % 2,
  }));
  const adjustments = trainAdjustments(examples);
  const tabs = [{ embedding: vector(rand, 3) }, { embedding: vector(rand, 3) }];
  const shift = Math.abs(scoreAllPairs(tabs, adjustments)[0][1] - scoreAllPairs(tabs, noAdjustment)[0][1]);
  assert(shift < 0.3, `moved by ${shift}`);
});

test('no examples means no adjustment', () => {
  assert(trainAdjustments([]).length === 0, 'expected nothing');
});

test('200 full-size examples train in well under a second', () => {
  const rand = mulberry32(6);
  const full = () => unit(Array.from({ length: 512 }, () => rand() - 0.5));
  const examples = Array.from({ length: 200 }, (_, i) => ({ embeddingA: full(), embeddingB: full(), label: i % 2 }));
  const t = Date.now();
  trainAdjustments(examples);
  assert(Date.now() - t < 1000, `took ${Date.now() - t}ms`);
});

section('saving');

test('nothing saved until a training run', async () => {
  installChromeMock();
  assert(await loadAdjustments() === null, 'expected null');
});

test('weights survive a save and load, and stay small', async () => {
  const { local } = installChromeMock();
  const adjustments = Array.from({ length: 512 }, (_, i) => Math.sin(i) * 3.14159265);
  await saveAdjustments(adjustments);
  const loaded = await loadAdjustments();
  assert(loaded.length === 512, 'all dimensions kept');
  assert(Math.abs(loaded[7] - adjustments[7]) < 1e-3, 'value kept');
  assert(local.personal_weights.length < 5000, `${local.personal_weights.length} bytes`);
});

await done();
