/**
 * tests/eval.test.js — the evaluation harness's own metrics and helpers.
 * Run with: node tests/eval.test.js
 */
import {
  adjacentSameGroupRate, runsPerGroup, adjustedRandIndex,
  mulberry32, shuffled, mean, stdErr,
} from '../eval/metrics.js';
import { hashEmbed } from '../eval/embedders.js';
import { mstDfsOrder, greedyNearestNeighbourOrder } from '../eval/run.js';
import { makeRunner, assert } from './helpers/chromeMock.js';

const { test, section, done } = makeRunner();
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

section('metrics');

test('adjacentSameGroupRate: perfect chain scores 1, alternating scores 0', () => {
  const g = ['a', 'a', 'b', 'b'];
  assert(adjacentSameGroupRate([0, 1, 2, 3], g) === 2 / 3, 'a,a,b,b has 2 of 3 same-group neighbours');
  assert(adjacentSameGroupRate([0, 2, 1, 3], g) === 0, 'a,b,a,b has none');
  assert(adjacentSameGroupRate([0], g) === 1, 'single item is trivially 1');
});

test('runsPerGroup: contiguous topics = 1.0, interleaved is higher', () => {
  const g = ['a', 'a', 'b', 'b'];
  assert(runsPerGroup([0, 1, 2, 3], g) === 1, 'contiguous topics = 1 run each');
  assert(runsPerGroup([0, 2, 1, 3], g) === 2, 'a,b,a,b = 4 runs over 2 groups = 2.0');
});

test('adjustedRandIndex: identical = 1, label names do not matter', () => {
  assert(near(adjustedRandIndex([0, 0, 1, 1], ['x', 'x', 'y', 'y']), 1), 'same partition, different names');
});

test('adjustedRandIndex: orthogonal partitions score <= 0', () => {
  const ari = adjustedRandIndex([0, 0, 1, 1], [0, 1, 0, 1]);
  assert(ari <= 0, `expected <= 0, got ${ari}`);
});

test('adjustedRandIndex: known value (3 of 4 correct grouping)', () => {
  // partitions {0,1,2}{3} vs {0,1}{2,3} -> ARI = 0 by hand: cells=1, rows=3, cols=2, n2=6
  // expected=3*2/6=1, max=(3+2)/2=2.5 -> (1-1)/(2.5-1)=0
  assert(near(adjustedRandIndex([0, 0, 0, 1], [0, 0, 1, 1]), 0), 'hand-computed ARI is 0');
});

test('mean and stdErr', () => {
  assert(mean([1, 2, 3]) === 2, 'mean');
  assert(near(stdErr([1, 2, 3]), Math.sqrt(1 / 3)), 'stdErr of [1,2,3] = sqrt(1/3)');
  assert(stdErr([5]) === 0, 'single value has no spread');
});

section('seeded randomness');

test('mulberry32 is reproducible and in [0,1)', () => {
  const a = mulberry32(5), b = mulberry32(5);
  for (let i = 0; i < 20; i++) {
    const x = a();
    assert(x === b(), 'same seed -> same stream');
    assert(x >= 0 && x < 1, 'value in [0,1)');
  }
});

test('shuffled returns a permutation and does not mutate its input', () => {
  const src = [1, 2, 3, 4, 5, 6];
  const out = shuffled(src, mulberry32(1));
  assert(src.join() === '1,2,3,4,5,6', 'input untouched');
  assert([...out].sort().join() === src.join(), 'same elements');
});

section('offline embedder + orderings');

test('hashEmbed is deterministic, unit-length, 512-dim', () => {
  const v = hashEmbed('React hooks and state');
  assert(v.length === 512, 'dimension');
  assert(near(Math.sqrt(v.reduce((s, x) => s + x * x, 0)), 1, 1e-9), 'unit norm');
  assert(hashEmbed('React hooks and state').join() === v.join(), 'deterministic');
});

test('hashEmbed puts same-topic text closer than off-topic text', () => {
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  const a = hashEmbed('React useEffect hooks tutorial');
  const b = hashEmbed('React hooks useState guide');
  const c = hashEmbed('Authentic carbonara pasta recipe');
  assert(dot(a, b) > dot(a, c), 'related > unrelated');
});

test('mstDfsOrder and greedy order both return a permutation', () => {
  const sim = [
    [1, .9, .1, .1],
    [.9, 1, .1, .1],
    [.1, .1, 1, .8],
    [.1, .1, .8, 1],
  ];
  for (const order of [mstDfsOrder(sim), greedyNearestNeighbourOrder(sim)]) {
    assert([...order].sort().join() === '0,1,2,3', `not a permutation: ${order}`);
  }
});

test('on a clear two-cluster matrix the chain keeps clusters contiguous', () => {
  const sim = [
    [1, .9, .1, .1],
    [.9, 1, .1, .1],
    [.1, .1, 1, .8],
    [.1, .1, .8, 1],
  ];
  const groups = ['a', 'a', 'b', 'b'];
  assert(runsPerGroup(mstDfsOrder(sim), groups) === 1, 'MST chain should be 1 run per topic');
});

await done();
