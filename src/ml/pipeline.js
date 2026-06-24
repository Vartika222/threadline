/**
 * THREADLINE — pipeline.js (V2)
 *
 * Orchestrates the full ML sort in 5 steps:
 *   1. Embed       → USE 512-dim vectors per tab
 *   2. Similarity  → N×N cosine similarity matrix
 *   3. MST         → Maximum Spanning Tree (Kruskal's)
 *   4. Traverse    → DFS traversal order
 *   5. Cluster     → UMAP + k-means topic labels
 *
 * V2 change: NN personalisation uses scoreAllPairs() (one batched model.predict
 * call) instead of the V1 loop that called scoreTabPair N*(N-1)/2 times.
 * For 20 tabs that's 190 individual predict calls in V1 vs 1 call in V2.
 *
 * @param {Array}    tabs       - Tab objects from background.js
 * @param {Function} onProgress - UI progress string callback
 * @returns {{ chain: Array, clusters: Object, method: string }}
 */

import { embedTexts, cosineSimilarity }                           from './embedder.js';
import { buildSimilarityMatrix, buildMST, traverseMST, annotateChain } from './graph.js';
import { clusterTabs }                                             from './clusterer.js';
import {
  loadSavedModel,
  scoreAllPairs,
  NN_ACTIVATION_THRESHOLD,
} from './nn.js';

export async function runMLPipeline(tabs, onProgress = () => {}) {
  if (!tabs || tabs.length === 0) throw new Error('No tabs to sort');

  if (tabs.length === 1) {
    return {
      chain:    [{ ...tabs[0], chainPosition: 0, similarityToNext: null }],
      clusters: { [tabs[0].tabId]: 0 },
      method:   'trivial',
    };
  }

  const contents = tabs.map(t => t.content || t.title || t.url || 'untitled');

  // ── STEP 1: EMBED ─────────────────────────────────────────────────────
  // Universal Sentence Encoder → 512-dim vector per tab.
  // Stored on the tab object so NN training examples can reference them.
  onProgress('Loading language model...');
  const embeddings = await embedTexts(contents, onProgress);
  tabs.forEach((tab, i) => { tab.embedding = embeddings[i]; });

  // ── STEP 2: BASELINE SIMILARITY MATRIX ────────────────────────────────
  // Cosine similarity between all pairs. Always computed — used as fallback
  // and as the 30% component of the personalised blend.
  onProgress('Computing similarities...');
  const cosineMatrix = buildSimilarityMatrix(embeddings, cosineSimilarity);
  let simMatrix = cosineMatrix;

  // ── STEP 2b: NN PERSONALISATION ───────────────────────────────────────
  // Replaces cosine matrix with a personalised blend once enough training
  // examples have been collected from user reorderings.
  let method = 'cosine';
  const nnModel = await loadSavedModel();

  if (nnModel) {
    const { nn_training_examples } = await chrome.storage.local.get('nn_training_examples');
    const exampleCount = nn_training_examples
      ? JSON.parse(nn_training_examples).length
      : 0;

    if (exampleCount >= NN_ACTIVATION_THRESHOLD) {
      onProgress('Applying personalisation...');

      // V2: single batched predict call for all N*(N-1)/2 pairs
      const nnMatrix = await scoreAllPairs(tabs, nnModel);

      // Blend: 70% NN + 30% cosine
      // Full replacement risks weird results when training data is sparse.
      // The blend ensures cosine acts as a regulariser.
      simMatrix = blendMatrices(nnMatrix, cosineMatrix, 0.7, 0.3);
      method = 'personalised';
    }
  }

  // ── STEP 3: MAXIMUM SPANNING TREE ─────────────────────────────────────
  // Kruskal's algorithm finds the tree of strongest similarity connections.
  onProgress('Building relatability graph...');
  const mst = buildMST(simMatrix, tabs.length);

  // ── STEP 4: TRAVERSAL ─────────────────────────────────────────────────
  // DFS on the MST → linear order where adjacent tabs share the most overlap.
  onProgress('Finding your thread...');
  const orderedIndices = traverseMST(mst, tabs.length);
  const annotated      = annotateChain(orderedIndices, simMatrix);

  const chain = annotated.map(({ index, similarityToNext }, chainPos) => ({
    ...tabs[index],
    chainPosition:    chainPos,
    originalIndex:    index,
    similarityToNext,
  }));

  // ── STEP 5: CLUSTER ───────────────────────────────────────────────────
  // UMAP → k-means gives each tab a topic label for colour-coding.
  onProgress('Identifying topics...');
  const clusterAssignments = clusterTabs(embeddings);

  const clusters = {};
  tabs.forEach((tab, i) => { clusters[tab.tabId] = clusterAssignments[i]; });

  return { chain, clusters, method };
}

/**
 * Blends two N×N matrices: result[i][j] = wA * a[i][j] + wB * b[i][j]
 * Preserves diagonal = 1 (a tab is always identical to itself).
 */
function blendMatrices(a, b, wA, wB) {
  return a.map((row, i) =>
    row.map((val, j) => {
      if (i === j) return 1;
      return Math.max(0, Math.min(1, wA * val + wB * b[i][j]));
    })
  );
}