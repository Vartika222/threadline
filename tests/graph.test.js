/**
 * tests/graph.test.js
 *
 * Tests for the graph module (similarity matrix, MST, traversal).
 * Does NOT require the language model or a browser — uses mock embeddings.
 *
 * Run with: node tests/graph.test.js
 */

import {
  buildSimilarityMatrix,
  buildMST,
  traverseMST,
  annotateChain,
  reannotateChain,
  buildChainOrder,
  bestGreedyOrder,
  improveChain,
  chainSimilarity,
} from '../src/ml/graph.js';

// ─── Mock cosine similarity (no model needed) ────────────────────────────

function cosineSim(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Test utilities ───────────────────────────────────────────────────────

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

function assertClose(a, b, tolerance = 0.01, message) {
  if (Math.abs(a - b) > tolerance) {
    throw new Error(message || `Expected ${a} ≈ ${b} (tolerance ${tolerance})`);
  }
}

// ─── Mock embeddings ──────────────────────────────────────────────────────

// Two clear clusters:
//   Tabs 0, 1, 2 = "Tech" cluster  (high values in dims 0-1)
//   Tabs 3, 4, 5 = "Food" cluster  (high values in dims 2-3)
const MOCK_EMBEDDINGS = [
  [1.0, 0.9, 0.1, 0.0],  // Tab 0 - React
  [0.9, 1.0, 0.1, 0.0],  // Tab 1 - JavaScript
  [0.8, 0.8, 0.2, 0.1],  // Tab 2 - TypeScript
  [0.0, 0.1, 1.0, 0.9],  // Tab 3 - Pasta
  [0.1, 0.0, 0.9, 1.0],  // Tab 4 - Cooking
  [0.1, 0.1, 0.8, 0.8],  // Tab 5 - Recipes
];

// ─── Tests ────────────────────────────────────────────────────────────────

console.log('\n── buildSimilarityMatrix ───────────────────────────────────');

test('diagonal is 1.0', () => {
  const matrix = buildSimilarityMatrix(MOCK_EMBEDDINGS, cosineSim);
  for (let i = 0; i < MOCK_EMBEDDINGS.length; i++) {
    assertClose(matrix[i][i], 1.0, 0.001, `matrix[${i}][${i}] should be 1.0`);
  }
});

test('matrix is symmetric', () => {
  const matrix = buildSimilarityMatrix(MOCK_EMBEDDINGS, cosineSim);
  for (let i = 0; i < MOCK_EMBEDDINGS.length; i++) {
    for (let j = 0; j < MOCK_EMBEDDINGS.length; j++) {
      assertClose(matrix[i][j], matrix[j][i], 0.0001,
        `matrix[${i}][${j}] !== matrix[${j}][${i}]`);
    }
  }
});

test('within-cluster similarity > cross-cluster similarity', () => {
  const matrix = buildSimilarityMatrix(MOCK_EMBEDDINGS, cosineSim);
  const withinTech = (matrix[0][1] + matrix[0][2] + matrix[1][2]) / 3;
  const crossCluster = (matrix[0][3] + matrix[0][4] + matrix[1][3]) / 3;
  assert(withinTech > crossCluster,
    `Within-cluster sim (${withinTech.toFixed(3)}) should be > cross-cluster (${crossCluster.toFixed(3)})`);
});

test('scores are clamped to [0, 1]', () => {
  const matrix = buildSimilarityMatrix(MOCK_EMBEDDINGS, cosineSim);
  for (let i = 0; i < MOCK_EMBEDDINGS.length; i++) {
    for (let j = 0; j < MOCK_EMBEDDINGS.length; j++) {
      assert(matrix[i][j] >= 0 && matrix[i][j] <= 1,
        `matrix[${i}][${j}] = ${matrix[i][j]} is outside [0,1]`);
    }
  }
});

console.log('\n── buildMST ────────────────────────────────────────────────');

test('MST has exactly N-1 edges', () => {
  const n = MOCK_EMBEDDINGS.length;
  const matrix = buildSimilarityMatrix(MOCK_EMBEDDINGS, cosineSim);
  const mst = buildMST(matrix, n);
  assert(mst.length === n - 1, `MST has ${mst.length} edges, expected ${n - 1}`);
});

test('all nodes are reachable from MST', () => {
  const n = MOCK_EMBEDDINGS.length;
  const matrix = buildSimilarityMatrix(MOCK_EMBEDDINGS, cosineSim);
  const mst = buildMST(matrix, n);

  const reachable = new Set();
  for (const { u, v } of mst) {
    reachable.add(u);
    reachable.add(v);
  }
  assert(reachable.size === n, `Only ${reachable.size}/${n} nodes in MST`);
});

test('MST prefers high-weight edges', () => {
  const n = MOCK_EMBEDDINGS.length;
  const matrix = buildSimilarityMatrix(MOCK_EMBEDDINGS, cosineSim);
  const mst = buildMST(matrix, n);
  const avgWeight = mst.reduce((s, e) => s + e.weight, 0) / mst.length;
  // Average MST edge weight should be meaningfully positive
  assert(avgWeight > 0.2, `Average MST edge weight ${avgWeight.toFixed(3)} seems too low`);
});

test('handles single-node graph', () => {
  const mst = buildMST([[1]], 1);
  assert(mst.length === 0, 'Single-node MST should have 0 edges');
});

test('handles two-node graph', () => {
  const matrix = [[1, 0.8], [0.8, 1]];
  const mst = buildMST(matrix, 2);
  assert(mst.length === 1, 'Two-node MST should have 1 edge');
  assertClose(mst[0].weight, 0.8);
});

console.log('\n── traverseMST ─────────────────────────────────────────────');

test('traversal visits every node exactly once', () => {
  const n = MOCK_EMBEDDINGS.length;
  const matrix = buildSimilarityMatrix(MOCK_EMBEDDINGS, cosineSim);
  const mst = buildMST(matrix, n);
  const order = traverseMST(mst, n);

  assert(order.length === n, `Order has ${order.length} items, expected ${n}`);
  const unique = new Set(order);
  assert(unique.size === n, `Order has duplicates: [${order}]`);
  for (let i = 0; i < n; i++) {
    assert(unique.has(i), `Node ${i} missing from traversal`);
  }
});

test('clusters stay together in traversal', () => {
  const n = MOCK_EMBEDDINGS.length;
  const matrix = buildSimilarityMatrix(MOCK_EMBEDDINGS, cosineSim);
  const mst = buildMST(matrix, n);
  const order = traverseMST(mst, n);

  // Tech cluster = indices 0,1,2 and Food cluster = indices 3,4,5
  // In the traversal, each cluster should appear as a contiguous run
  const positions = {};
  order.forEach((nodeIdx, pos) => { positions[nodeIdx] = pos; });

  const techPositions = [0, 1, 2].map(i => positions[i]).sort((a, b) => a - b);
  const foodPositions = [3, 4, 5].map(i => positions[i]).sort((a, b) => a - b);

  // Check that tech positions form a contiguous run
  const techContiguous = techPositions[2] - techPositions[0] === 2;
  const foodContiguous = foodPositions[2] - foodPositions[0] === 2;

  assert(techContiguous || foodContiguous,
    `Neither cluster is contiguous. Tech: ${techPositions}, Food: ${foodPositions}`);
});

test('handles single node', () => {
  const order = traverseMST([], 1);
  assert(order.length === 1 && order[0] === 0);
});

console.log('\n── annotateChain ────────────────────────────────────────────');

test('annotates similarity to next correctly', () => {
  const matrix = [[1, 0.7], [0.7, 1]];
  const chain = annotateChain([0, 1], matrix);
  assertClose(chain[0].similarityToNext, 0.7);
  assert(chain[1].similarityToNext === null, 'Last item should have null similarityToNext');
});

console.log('\n── buildChainOrder ──────────────────────────────────────────');

/** Seeded random symmetric similarity matrix. */
function randomMatrix(n, seed) {
  let x = seed;
  const next = () => (x = (x * 16807) % 2147483647) / 2147483647;
  const m = Array.from({ length: n }, () => new Array(n).fill(1));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) m[i][j] = m[j][i] = next();
  return m;
}
const isPermutation = (order, n) => order.length === n && new Set(order).size === n;

test('returns every tab exactly once, for any number of tabs', () => {
  for (const n of [0, 1, 2, 3, 4, 7, 20, 60]) {
    assert(isPermutation(buildChainOrder(randomMatrix(n, 7 + n)), n), `not a permutation for n=${n}`);
  }
});

test('local search never lowers the total and keeps every tab', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const m = randomMatrix(15, seed * 31);
    const start = bestGreedyOrder(m);
    const improved = improveChain(start, m);
    assert(isPermutation(improved, 15), 'lost a tab');
    assert(chainSimilarity(improved, m) >= chainSimilarity(start, m) - 1e-9, 'total went down');
  }
});

test('chain is at least as strong as MST + DFS and as greedy', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const m = randomMatrix(15, seed * 37);
    const total = chainSimilarity(buildChainOrder(m), m);
    assert(total >= chainSimilarity(traverseMST(buildMST(m, 15), 15), m) - 1e-9, 'weaker than MST + DFS');
    assert(total >= chainSimilarity(bestGreedyOrder(m), m) - 1e-9, 'weaker than greedy');
  }
});

test('local search repairs a chain with a crossed connection', () => {
  // Best path is 0-1-2-3; the start order has its middle reversed.
  const m = [[1, 0.9, 0.1, 0.1], [0.9, 1, 0.9, 0.1], [0.1, 0.9, 1, 0.9], [0.1, 0.1, 0.9, 1]];
  const out = improveChain([0, 2, 1, 3], m);
  assert(chainSimilarity(out, m) > 2.69, `total ${chainSimilarity(out, m)}, expected 2.7`);
});

test('topics stay contiguous on clearly separated data', () => {
  const topic = (i) => Math.floor(i / 4);
  const m = Array.from({ length: 12 }, (_, i) => Array.from({ length: 12 }, (_, j) =>
    i === j ? 1 : topic(i) === topic(j) ? 0.8 + ((i + j) % 3) * 0.05 : 0.1 + ((i * j) % 5) * 0.02));
  const order = buildChainOrder(m);
  let runs = 1;
  for (let k = 1; k < 12; k++) if (topic(order[k]) !== topic(order[k - 1])) runs++;
  assert(runs === 3, `expected 3 runs, got ${runs}: ${order}`);
});

test('200 tabs finish in well under a second', () => {
  const m = randomMatrix(200, 99);
  const t = Date.now();
  buildChainOrder(m);
  assert(Date.now() - t < 1000, `took ${Date.now() - t}ms`);
});

console.log('\n── reannotateChain ──────────────────────────────────────────');

test('after a reorder, each tab reports similarity to its new neighbour', () => {
  const matrix = [[1, 0.9, 0.2], [0.9, 1, 0.5], [0.2, 0.5, 1]];
  const placement = { category: 'Study' };
  const chain = [{ originalIndex: 0, placement }, { originalIndex: 1, placement }, { originalIndex: 2, placement }];
  const moved = reannotateChain([chain[1], chain[0], chain[2]], matrix);
  assertClose(moved[0].similarityToNext, 0.9);
  assertClose(moved[1].similarityToNext, 0.2);
  assert(moved[2].similarityToNext === null, 'Last item should have null similarityToNext');
});

test('no percentage between tabs in different categories', () => {
  const out = reannotateChain(
    [{ originalIndex: 0, placement: { category: 'Study' } }, { originalIndex: 1, placement: { category: 'News' } }],
    [[1, 0.4], [0.4, 1]]);
  assert(out[0].similarityToNext === null, 'expected no percentage');
});

test('reannotateChain keeps the other tab fields and does not mutate its input', () => {
  const tab = { originalIndex: 0, title: 'A', similarityToNext: 0.1 };
  const out = reannotateChain([tab, { originalIndex: 1 }], [[1, 0.4], [0.4, 1]]);
  assert(out[0].title === 'A', 'title kept');
  assert(tab.similarityToNext === 0.1, 'input left alone');
});

// ─── Summary ──────────────────────────────────────────────────────────────

console.log('\n─────────────────────────────────────────────────────────────');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);