/**
 * tests/clusterer.test.js
 *
 * Tests for UMAP + k-means clustering.
 * Run with: node tests/clusterer.test.js
 */

import { clusterTabs, reduceWithUMAP } from '../src/ml/clusterer.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

// Two tight clusters in 4-dim space
const CLUSTER_A = [
  [1.0, 0.9, 0.0, 0.0],
  [0.9, 1.0, 0.0, 0.0],
  [0.95, 0.95, 0.05, 0.0],
  [1.0, 0.85, 0.0, 0.05],
];
const CLUSTER_B = [
  [0.0, 0.0, 1.0, 0.9],
  [0.0, 0.0, 0.9, 1.0],
  [0.05, 0.0, 0.95, 0.95],
  [0.0, 0.05, 0.85, 1.0],
];
const MOCK_EMBEDDINGS = [...CLUSTER_A, ...CLUSTER_B];

console.log('\n── clusterTabs ─────────────────────────────────────────────');

test('returns one label per tab', () => {
  const result = clusterTabs(MOCK_EMBEDDINGS);
  assert(result.length === MOCK_EMBEDDINGS.length,
    `Expected ${MOCK_EMBEDDINGS.length} labels, got ${result.length}`);
});

test('all labels are non-negative integers', () => {
  const result = clusterTabs(MOCK_EMBEDDINGS);
  result.forEach((label, i) => {
    assert(Number.isInteger(label) && label >= 0,
      `Label at index ${i} is ${label} — expected non-negative integer`);
  });
});

test('two clear clusters are distinguished', () => {
  const result = clusterTabs(MOCK_EMBEDDINGS);
  const groupA = new Set(result.slice(0, 4));
  const groupB = new Set(result.slice(4, 8));

  assert(groupA.size === 1, `Cluster A has multiple labels: ${[...groupA]}`);
  assert(groupB.size === 1, `Cluster B has multiple labels: ${[...groupB]}`);
  assert([...groupA][0] !== [...groupB][0], 'Cluster A and B got same label');
});

test('handles single tab', () => {
  const result = clusterTabs([[1, 0, 0, 0]]);
  assert(result.length === 1 && result[0] === 0);
});

test('handles two tabs', () => {
  const result = clusterTabs([[1, 0], [0, 1]]);
  assert(result.length === 2);
});

console.log('\n── reduceWithUMAP ───────────────────────────────────────────');

test('output has same length as input', () => {
  const points = reduceWithUMAP(MOCK_EMBEDDINGS);
  assert(points.length === MOCK_EMBEDDINGS.length);
});

test('each output point has 2 dimensions', () => {
  const points = reduceWithUMAP(MOCK_EMBEDDINGS);
  points.forEach((p, i) => {
    assert(Array.isArray(p) && p.length === 2,
      `Point ${i} has ${p.length} dimensions, expected 2`);
  });
});

test('output values are finite numbers', () => {
  const points = reduceWithUMAP(MOCK_EMBEDDINGS);
  points.forEach((p, i) => {
    assert(isFinite(p[0]) && isFinite(p[1]),
      `Point ${i} has non-finite values: [${p}]`);
  });
});

console.log('\n─────────────────────────────────────────────────────────────');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);