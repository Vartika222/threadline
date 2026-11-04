/**
 * THREADLINE — clusterer.js
 *
 * Assigns topic cluster labels to tabs for colour-coding.
 *
 * Pipeline:
 *   Embeddings → cosine similarities → agglomerative clustering
 *                      → cut the merge history at the best silhouette score
 *
 * ─── AGGLOMERATIVE CLUSTERING (AVERAGE LINKAGE) ──────────────────────────
 *
 * Start with every tab in its own group, then repeatedly merge the two groups
 * whose tabs are most similar on average, until one group remains. Each step
 * of that history is a candidate clustering, and we choose among them.
 *
 * It has no random steps, works directly on the similarities the chain uses,
 * and copes with the small numbers of tabs we deal with.
 *
 * WHY NOT UMAP + K-MEANS (what this replaced): measured on the same data,
 * mean adjusted Rand index rose from about 0.24 to 0.42 on eval/tabs.json at
 * 20 tabs, and from 0.28 to 0.82 on real page text. The old pipeline usually
 * found 2 or 3 groups however many topics were open, and needed a seeded
 * random number generator to be repeatable at all.
 *
 * ─── CHOOSING THE NUMBER OF GROUPS ───────────────────────────────────────
 *
 * If even the final merge joins groups at least SAME_TOPIC_SIMILARITY alike,
 * everything is treated as one topic. Otherwise the silhouette score picks
 * from k = 2..min(8, N/2). Three tabs or fewer always form one group.
 */

import { cosineSimilarity } from './embedder.js';

/** Never propose more clusters than the legend and colour palette can show. */
export const MAX_CLUSTERS = 8;

/**
 * Above this similarity, the last two groups are treated as one topic.
 *
 * Tied to the embedding model's scale, so re-check it after changing models.
 * It's a trade-off: at 0.3 closely related topics such as WWI and WWII stay apart
 * (84% of the time), but a broad single topic such as "cooking" usually gets split
 * into two groups. A lower value reverses that. Splitting was the milder mistake:
 * "pasta" and "bread" are reasonable sub-groups, but a merged pair hides the
 * distinction you came for.
 */
export const SAME_TOPIC_SIMILARITY = 0.3;

/**
 * Mean silhouette score of a clustering, in [-1, 1].
 *
 * For each tab: a = mean distance to the other tabs in its own cluster,
 * b = the smallest mean distance to any other cluster, and
 * s = (b - a) / max(a, b). Near 1 = it sits snugly inside a well separated
 * cluster; near 0 = it sits on a boundary; negative = probably in the wrong
 * cluster. A tab alone in its cluster scores 0.
 *
 * @param {number[][]} distances - N×N distance matrix
 * @param {number[]} assignments - cluster index per tab
 * @param {number} k - number of clusters
 */
export function silhouetteScore(distances, assignments, k) {
  const n = assignments.length;
  const sizes = new Array(k).fill(0);
  for (const c of assignments) sizes[c]++;

  let total = 0;
  for (let i = 0; i < n; i++) {
    const own = assignments[i];
    if (sizes[own] <= 1) continue; // singleton: silhouette defined as 0

    const distSum = new Array(k).fill(0);
    for (let j = 0; j < n; j++) {
      if (j !== i) distSum[assignments[j]] += distances[i][j];
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

/**
 * Runs average-linkage clustering all the way down to one group.
 *
 * @param {number[][]} similarity - N×N similarity matrix
 * @param {number} maxK - only record clusterings with at most this many groups
 * @returns {{ candidates: Array<{k:number, assignments:number[]}>, finalMerge: number }}
 *          finalMerge is the similarity of the last two groups joined
 */
function agglomerate(similarity, maxK) {
  const n = similarity.length;
  let groups = similarity.map((_, i) => [i]);
  // Average similarity between groups. Updated on each merge rather than
  // recomputed, weighting each side by its size (Lance-Williams).
  const between = similarity.map(row => Array.from(row));

  const candidates = [];
  let finalMerge = 1;

  while (groups.length > 1) {
    if (groups.length <= maxK) {
      const assignments = new Array(n);
      groups.forEach((members, c) => members.forEach(tab => { assignments[tab] = c; }));
      candidates.push({ k: groups.length, assignments });
    }

    let bestI = 0;
    let bestJ = 1;
    let best = -Infinity;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (between[i][j] > best) { best = between[i][j]; bestI = i; bestJ = j; }
      }
    }
    finalMerge = best;

    const sizeI = groups[bestI].length;
    const sizeJ = groups[bestJ].length;
    for (let c = 0; c < groups.length; c++) {
      if (c === bestI || c === bestJ) continue;
      const merged = (sizeI * between[bestI][c] + sizeJ * between[bestJ][c]) / (sizeI + sizeJ);
      between[bestI][c] = merged;
      between[c][bestI] = merged;
    }
    groups[bestI] = groups[bestI].concat(groups[bestJ]);
    groups.splice(bestJ, 1);
    between.splice(bestJ, 1);
    between.forEach(row => row.splice(bestJ, 1));
  }

  return { candidates, finalMerge };
}

/**
 * Main entry point. Takes embeddings, returns cluster assignment per tab.
 *
 * @param {number[][]} embeddings - One vector per tab
 * @returns {number[]} Cluster index for each tab (0-indexed)
 */
export function clusterTabs(embeddings) {
  const n = embeddings.length;
  const oneGroup = new Array(n).fill(0);
  if (n <= 3) return oneGroup;

  const similarity = embeddings.map(a => embeddings.map(b => cosineSimilarity(a, b)));
  const maxK = Math.min(MAX_CLUSTERS, Math.floor(n / 2));
  const { candidates, finalMerge } = agglomerate(similarity, maxK);
  if (finalMerge >= SAME_TOPIC_SIMILARITY) return oneGroup;

  const distances = similarity.map(row => row.map(s => 1 - s));
  let best = oneGroup;
  let bestScore = -Infinity;
  for (const { k, assignments } of candidates) {
    const score = silhouetteScore(distances, assignments, k);
    if (score > bestScore) {
      bestScore = score;
      best = assignments;
    }
  }
  return best;
}

// Self-test lives in tests/clusterer.test.js — not here.
