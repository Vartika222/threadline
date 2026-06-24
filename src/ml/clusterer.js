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
 * We use the "elbow method" approximation: try k = 2..sqrt(N) and pick
 * the k where adding another cluster stops reducing variance significantly.
 * For very small N (≤4 tabs) we skip clustering and return all zeros.
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
function kmeans(points, k, maxIter = 100) {
  const n = points.length;

  // K-means++ initialisation: spread initial centroids apart
  // This avoids bad random initialisation that leads to empty clusters
  const centroids = kmeansppInit(points, k);
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
        centroids[c] = points[Math.floor(Math.random() * n)];
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
function kmeansppInit(points, k) {
  const n = points.length;
  const centroids = [];

  // Pick first centroid uniformly at random
  centroids.push(points[Math.floor(Math.random() * n)]);

  for (let c = 1; c < k; c++) {
    // Compute squared distances to nearest centroid for each point
    const dists = points.map(p =>
      Math.min(...centroids.map(cen => euclideanDist2D(p, cen) ** 2))
    );

    // Sample next centroid with probability proportional to distance squared
    const total = dists.reduce((s, d) => s + d, 0);
    let rand = Math.random() * total;
    let chosen = 0;
    for (let i = 0; i < n; i++) {
      rand -= dists[i];
      if (rand <= 0) { chosen = i; break; }
    }
    centroids.push(points[chosen]);
  }

  return centroids;
}

function euclideanDist2D([x1, y1], [x2, y2]) {
  return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
}

// ─── ELBOW METHOD ─────────────────────────────────────────────────────────

/**
 * Estimates the optimal k using the elbow method.
 *
 * Computes Within-Cluster Sum of Squares (WCSS) for k = 2..maxK.
 * The "elbow" is where adding more clusters yields diminishing returns.
 *
 * For small N (≤6), we cap k at 2 to avoid micro-clusters.
 *
 * @param {number[][]} points - 2D points
 * @returns {number} Estimated optimal k
 */
function estimateK(points) {
  const n = points.length;
  if (n <= 3) return 1;
  if (n <= 6) return 2;

  const maxK = Math.min(6, Math.floor(Math.sqrt(n)));
  const wcssValues = [];

  for (let k = 1; k <= maxK; k++) {
    const assignments = kmeans(points, k, 50); // Fewer iters for speed
    let wcss = 0;

    // Compute centroids
    for (let c = 0; c < k; c++) {
      const members = points.filter((_, i) => assignments[i] === c);
      if (members.length === 0) continue;
      const cx = members.reduce((s, p) => s + p[0], 0) / members.length;
      const cy = members.reduce((s, p) => s + p[1], 0) / members.length;
      // Sum of squared distances within this cluster
      members.forEach(p => { wcss += euclideanDist2D(p, [cx, cy]) ** 2; });
    }
    wcssValues.push(wcss);
  }

  // Find elbow: largest second derivative (biggest change in rate of improvement)
  let bestK = 2;
  let maxDelta = -Infinity;
  for (let i = 1; i < wcssValues.length - 1; i++) {
    // Second derivative approximation
    const delta = wcssValues[i - 1] - 2 * wcssValues[i] + wcssValues[i + 1];
    if (delta > maxDelta) { maxDelta = delta; bestK = i + 1; }
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

  // Step 2: Estimate k
  const k = estimateK(points2D);

  // Step 3: Cluster
  const assignments = kmeans(points2D, k);

  return assignments;
}

// Self-test lives in tests/clusterer.test.js — not here.