/**
 * THREADLINE — clusterer.js
 *
 * Assigns topic cluster labels to tabs for colour-coding.
 *
 * Pipeline:
 *   512-dim embeddings → UMAP (→ 2D) → k-means → cluster assignments
 *
 * ─── WHY TWO STEPS? ──────────────────────────────────────────────────────
 *
 * K-means in 512 dimensions suffers from the "curse of dimensionality" —
 * all points become equidistant from each other, making clustering unreliable.
 * UMAP first compresses the embeddings to 2D while preserving the
 * neighbourhood structure (tabs that are similar in 512D stay near each
 * other in 2D). K-means then clusters these well-separated 2D points.
 *
 * ─── WHY K-MEANS AND NOT HDBSCAN? ───────────────────────────────────────
 *
 * HDBSCAN is theoretically superior (doesn't require specifying k, handles
 * noise, finds non-spherical clusters). BUT:
 *   - No maintained browser-compatible HDBSCAN library exists as of 2025
 *   - K-means works well at the small N we deal with (5–30 tabs)
 *   - K-means is simpler to explain in an interview
 *
 * FUTURE: implement HDBSCAN from scratch in V3 — good research question
 * (OQ-02: does HDBSCAN outperform k-means at small N?)
 *
 * ─── CHOOSING K ──────────────────────────────────────────────────────────
 *
 * Silhouette score: try k = 2..min(8, N/2) and keep the k whose clusters are
 * tightest and best separated. For very small N (3 tabs or fewer) clustering
 * is skipped and every tab gets cluster 0. (An earlier elbow-method version
 * almost always returned k = 2; see estimateK below.)
 */

import { UMAP } from 'umap-js';

// ─── SEEDED PRNG ────────────────────────────────────────────────────────────

/**
 * Mulberry32 — tiny, fast seeded PRNG. Returns a function compatible with
 * umap-js's `random` option (no-arg, returns a float in [0, 1)).
 * Deterministic for a given seed, unlike Math.random().
 */
function seededRandom(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── UMAP ─────────────────────────────────────────────────────────────────

/**
 * Reduces 512-dim embeddings to 2D using UMAP.
 *
 * UMAP hyperparameters we care about:
 *   nNeighbors  - how many nearby points to consider when building the graph.
 *                 Lower = more local structure preserved. Min 2, max N-1.
 *   minDist     - minimum distance between points in 2D output.
 *                 Lower = tighter clusters. 0.1 works well for tab counts.
 *   nComponents - output dimensions. We use 2 for clustering.
 *
 * @param {number[][]} embeddings - Array of 512-dim vectors
 * @returns {number[][]} Array of [x, y] 2D coordinates
 */
export function reduceWithUMAP(embeddings) {
  const n = embeddings.length;
  if (n < 4) {
    // UMAP needs at least nNeighbors+1 points. For tiny sets, return mock 2D.
    return embeddings.map((_, i) => [i, 0]);
  }

  const umap = new UMAP({
    nNeighbors:  Math.min(15, Math.max(2, Math.floor(n / 2))),
    minDist:     0.1,
    nComponents: 2,
    // Seeded PRNG for reproducible output — same tabs always produce the
    // same layout. NOTE: this must produce varying values. umap-js uses
    // rejection sampling internally (draws random indices until it finds
    // ones it hasn't picked yet) — a constant random function makes that
    // loop spin forever, since every draw collides with the first pick.
    random:      seededRandom(42),
  });

  // umap-js fit() returns the 2D coordinates directly
  return umap.fit(embeddings);
}

// ─── K-MEANS ──────────────────────────────────────────────────────────────

/**
 * Runs k-means clustering on 2D points.
 *
 * K-means algorithm:
 *   1. Initialise k centroids (we use k-means++ for better initialisation)
 *   2. Assign each point to nearest centroid
 *   3. Recompute centroids as mean of assigned points
 *   4. Repeat 2-3 until assignments stop changing (or max iterations)
 *
 * @param {number[][]} points - Array of [x, y] coordinates
 * @param {number} k - Number of clusters
 * @param {number} maxIter - Maximum iterations (default 100)
 * @returns {number[]} Cluster assignment for each point (0-indexed)
 */
function kmeans(points, k, maxIter = 100, rand = Math.random) {
  const n = points.length;

  // K-means++ initialisation: spread initial centroids apart
  // This avoids bad random initialisation that leads to empty clusters.
  // `rand` is a seeded generator (see clusterTabs) so the same tabs always
  // get the same clusters — previously Math.random made the colours and
  // labels flicker between two sorts of identical tabs.
  const centroids = kmeansppInit(points, k, rand);
  let assignments = new Array(n).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    // Step 1: Assign each point to nearest centroid
    let changed = false;
    for (let i = 0; i < n; i++) {
      let minDist = Infinity;
      let nearest = 0;
      for (let c = 0; c < k; c++) {
        const d = euclideanDist2D(points[i], centroids[c]);
        if (d < minDist) { minDist = d; nearest = c; }
      }
      if (assignments[i] !== nearest) { assignments[i] = nearest; changed = true; }
    }

    if (!changed) break; // Converged

    // Step 2: Recompute centroids
    for (let c = 0; c < k; c++) {
      const members = points.filter((_, i) => assignments[i] === c);
      if (members.length === 0) {
        // Empty cluster — reinitialise to a random point
        centroids[c] = points[Math.floor(rand() * n)];
      } else {
        centroids[c] = [
          members.reduce((s, p) => s + p[0], 0) / members.length,
          members.reduce((s, p) => s + p[1], 0) / members.length,
        ];
      }
    }
  }

  return assignments;
}

/**
 * K-means++ initialisation — picks initial centroids with probability
 * proportional to squared distance from already-chosen centroids.
 * This ensures centroids start spread across the data.
 */
function kmeansppInit(points, k, rand = Math.random) {
  const n = points.length;
  const centroids = [];

  // Pick first centroid uniformly at random
  centroids.push(points[Math.floor(rand() * n)]);

  for (let c = 1; c < k; c++) {
    // Compute squared distances to nearest centroid for each point
    const dists = points.map(p =>
      Math.min(...centroids.map(cen => euclideanDist2D(p, cen) ** 2))
    );

    // Sample next centroid with probability proportional to distance squared
    const total = dists.reduce((s, d) => s + d, 0);
    let target = rand() * total;
    let chosen = 0;
    for (let i = 0; i < n; i++) {
      target -= dists[i];
      if (target <= 0) { chosen = i; break; }
    }
    centroids.push(points[chosen]);
  }

  return centroids;
}

function euclideanDist2D([x1, y1], [x2, y2]) {
  return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
}

// ─── CHOOSING K (SILHOUETTE) ──────────────────────────────────────────────

/**
 * Mean silhouette score of a clustering, in [-1, 1].
 *
 * For each point: a = mean distance to the other points in its own cluster,
 * b = the smallest mean distance to any other cluster, and
 * s = (b - a) / max(a, b). Near 1 = the point sits snugly inside a well
 * separated cluster; near 0 = it sits on a boundary; negative = probably in
 * the wrong cluster. A point alone in its cluster scores 0.
 *
 * @param {number[][]} points - 2D points
 * @param {number[]} assignments - cluster index per point
 * @param {number} k - number of clusters
 */
export function silhouetteScore(points, assignments, k) {
  const n = points.length;
  const sizes = new Array(k).fill(0);
  for (const c of assignments) sizes[c]++;

  let total = 0;
  for (let i = 0; i < n; i++) {
    const own = assignments[i];
    if (sizes[own] <= 1) continue; // singleton: silhouette defined as 0

    const distSum = new Array(k).fill(0);
    for (let j = 0; j < n; j++) {
      if (j !== i) distSum[assignments[j]] += euclideanDist2D(points[i], points[j]);
    }

    const a = distSum[own] / (sizes[own] - 1);
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c !== own && sizes[c] > 0) b = Math.min(b, distSum[c] / sizes[c]);
    }
    if (!Number.isFinite(b)) continue;

    const denom = Math.max(a, b);
    total += denom === 0 ? 0 : (b - a) / denom;
  }
  return total / n;
}

/** Never propose more clusters than the legend and colour palette can show. */
export const MAX_CLUSTERS = 8;

/**
 * Picks the number of clusters by trying k = 2..maxK and keeping the k with
 * the best mean silhouette.
 *
 * WHY NOT THE ELBOW METHOD (what this replaced):
 * The old code located the elbow with a second-difference search that could
 * only ever return k between 2 and maxK-1, where maxK = min(6, floor(sqrt(n))).
 * In practice that meant exactly 2 clusters for up to 15 tabs and 2 or 3 for
 * up to 48, however many topics were open. Silhouette compares clusterings
 * directly, so the data decides.
 *
 * WHY THERE IS NO "k = 1" FALLBACK FOR A SINGLE TOPIC:
 * Measured on this project's data, the best silhouette of structureless
 * scatter (0.38 to 0.55) overlaps the best silhouette of genuinely
 * multi-topic tab sets (0.34 to 0.45), so no threshold separates them. With
 * four or more tabs the tabs are always split into at least two groups, the
 * same as before.
 *
 * Each cluster needs at least two tabs on average, hence maxK <= n/2.
 *
 * @param {number[][]} points - 2D points
 * @param {() => number} rand - seeded generator, keeps the choice deterministic
 * @returns {number} chosen k (1 only for three tabs or fewer)
 */
export function estimateK(points, rand = Math.random) {
  const n = points.length;
  if (n <= 3) return 1;

  const maxK = Math.min(MAX_CLUSTERS, Math.floor(n / 2));
  let bestK = 2;
  let bestScore = -Infinity;

  for (let k = 2; k <= maxK; k++) {
    const assignments = kmeans(points, k, 50, rand); // fewer iterations for speed
    const score = silhouetteScore(points, assignments, k);
    if (score > bestScore) {
      bestScore = score;
      bestK = k;
    }
  }
  return bestK;
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────

/**
 * Main entry point. Takes embeddings, returns cluster assignment per tab.
 *
 * @param {number[][]} embeddings - Array of 512-dim vectors (one per tab)
 * @returns {number[]} Cluster index for each tab (0-indexed)
 */
export function clusterTabs(embeddings) {
  const n = embeddings.length;
  if (n <= 1) return new Array(n).fill(0);

  // Step 1: Reduce to 2D
  const points2D = reduceWithUMAP(embeddings);

  // One seeded generator shared by k estimation and the final fit, so the
  // whole clustering step is deterministic for a given set of tabs.
  const rand = seededRandom(1337);

  // Step 2: Estimate k
  const k = estimateK(points2D, rand);

  // Step 3: Cluster
  const assignments = kmeans(points2D, k, 100, rand);

  return assignments;
}

// Self-test lives in tests/clusterer.test.js — not here.