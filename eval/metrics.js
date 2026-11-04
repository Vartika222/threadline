/**
 * eval/metrics.js — pure functions for scoring tab orderings and clusters.
 * Tested in tests/eval.test.js.
 */

/** Seeded PRNG (mulberry32) so every evaluation run is reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle returning a new array. */
export function shuffled(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Share of adjacent pairs in the chain that belong to the same ground-truth
 * group. 1.0 = every neighbour is on-topic. Higher is better.
 *
 * @param {number[]} order  chain of item indices
 * @param {string[]} groups ground-truth group label per item index
 */
export function adjacentSameGroupRate(order, groups) {
  if (order.length < 2) return 1;
  let same = 0;
  for (let i = 0; i < order.length - 1; i++) {
    if (groups[order[i]] === groups[order[i + 1]]) same++;
  }
  return same / (order.length - 1);
}

/**
 * Contiguous runs per group, averaged over the groups present. 1.0 means each
 * topic forms one unbroken stretch of the chain (ideal); larger means topics
 * are scattered. Lower is better.
 */
export function runsPerGroup(order, groups) {
  if (order.length === 0) return 0;
  let runs = 0;
  for (let i = 0; i < order.length; i++) {
    if (i === 0 || groups[order[i]] !== groups[order[i - 1]]) runs++;
  }
  return runs / new Set(order.map(i => groups[i])).size;
}

/**
 * Adjusted Rand Index between two labelings (any label types).
 * 1 = identical partitions, ~0 = random agreement, can be negative.
 */
export function adjustedRandIndex(a, b) {
  const n = a.length;
  if (n !== b.length) throw new Error('labelings must have equal length');
  if (n < 2) return 1;

  const table = new Map();
  const rowSums = new Map();
  const colSums = new Map();
  for (let i = 0; i < n; i++) {
    const key = `${a[i]}\u0000${b[i]}`;
    table.set(key, (table.get(key) || 0) + 1);
    rowSums.set(a[i], (rowSums.get(a[i]) || 0) + 1);
    colSums.set(b[i], (colSums.get(b[i]) || 0) + 1);
  }

  const c2 = (x) => (x * (x - 1)) / 2;
  let sumCells = 0;
  for (const v of table.values()) sumCells += c2(v);
  let sumRows = 0;
  for (const v of rowSums.values()) sumRows += c2(v);
  let sumCols = 0;
  for (const v of colSums.values()) sumCols += c2(v);

  const expected = (sumRows * sumCols) / c2(n);
  const maxIndex = (sumRows + sumCols) / 2;
  if (maxIndex === expected) return 1; // both partitions trivial
  return (sumCells - expected) / (maxIndex - expected);
}

export function mean(xs) {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Standard error of the mean. */
export function stdErr(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance / xs.length);
}
