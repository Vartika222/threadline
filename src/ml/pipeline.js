/**
 * THREADLINE — pipeline.js
 *
 * Orchestrates the full ML sort in 4 steps:
 *   1. Embed       → one vector per tab (all-MiniLM-L6-v2)
 *   2. Similarity  → N×N cosine similarity matrix
 *   3. Chain       → best of MST + DFS and greedy, polished by local search
 *   4. Cluster     → agglomerative topic groups
 *
 * @param {Array}    tabs       - Tab objects from background.js
 * @param {Function} onProgress - UI progress string callback
 * @returns {{ chain: Array, clusters: Object, method: string }}
 */

import { embedTexts, cosineSimilarity }                           from './embedder.js';
import { buildSimilarityMatrix, buildChainOrder, annotateChain } from './graph.js';
import { clusterTabs }                                             from './clusterer.js';
import { labelClusters }                                           from './labeler.js';
import { consumeImplicitPairs }                                    from './implicitFeedback.js';
import { isPersonalisationEnabled, loadAdjustments, scoreAllPairs } from './personalise.js';

/**
 * Puts tabs into one fixed order that doesn't depend on the tab strip.
 *
 * WHY: nearly every step is sensitive to input order, even when seeded. The
 * embedding batch gives very slightly different numbers, and ties in the graph
 * and clustering steps break by index. So the same tabs could get different
 * groups and a different chain after Apply Order rearranged them.
 */
export function canonicalTabOrder(tabs) {
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...tabs].sort((a, b) =>
    compare(a.content || '', b.content || '') || compare(a.url || '', b.url || ''));
}

export async function runMLPipeline(inputTabs, onProgress = () => {}) {
  if (!inputTabs || inputTabs.length === 0) throw new Error('No tabs to sort');
  const tabs = canonicalTabOrder(inputTabs);

  if (tabs.length === 1) {
    return {
      chain:    [{ ...tabs[0], chainPosition: 0, similarityToNext: null }],
      clusters: { [tabs[0].tabId]: 0 },
      clusterLabels: { 0: 'All Tabs' },
      simMatrix: [[1]],
      method:   'trivial',
      implicitExampleCount: 0,
    };
  }

  const contents = tabs.map(t => t.content || t.title || t.url || 'untitled');

  // ── STEP 1: EMBED ─────────────────────────────────────────────────────
  // The language model turns each tab's text into a vector.
  // Stored on the tab object so NN training examples can reference them.
  onProgress('Loading language model...');
  const embeddings = await embedTexts(contents, onProgress);
  tabs.forEach((tab, i) => { tab.embedding = embeddings[i]; });

  // ── STEP 1b: IMPLICIT FEEDBACK ────────────────────────────────────────
  // background.js queues tabId pairs the user kept switching between
  // (attentional residue signal). Now that tabs have embeddings, drain
  // that queue into real training examples. Runs every sort — cheap when
  // the queue is empty, which it usually is.
  onProgress('Learning from tab-switch patterns...');
  const implicitCount = await consumeImplicitPairs(tabs);

  // ── STEP 2: BASELINE SIMILARITY MATRIX ────────────────────────────────
  // Cosine similarity between all pairs.
  onProgress('Computing similarities...');
  let simMatrix = buildSimilarityMatrix(embeddings, cosineSimilarity);

  // ── STEP 2b: OPTIONAL PERSONALISATION ─────────────────────────────────
  // Only if the user opted in and a training run has happened.
  let method = 'cosine';
  if (await isPersonalisationEnabled()) {
    const adjustments = await loadAdjustments();
    if (adjustments?.length === embeddings[0].length) { // ignore weights from another model
      onProgress('Applying personalisation...');
      simMatrix = scoreAllPairs(tabs, adjustments);
      method = 'personalised';
    }
  }

  // ── STEP 3: CHAIN ─────────────────────────────────────────────────────
  // The strongest linear order we can find. See buildChainOrder in graph.js.
  onProgress('Finding your thread...');
  const orderedIndices = buildChainOrder(simMatrix);
  const annotated      = annotateChain(orderedIndices, simMatrix);

  const chain = annotated.map(({ index, similarityToNext }, chainPos) => ({
    ...tabs[index],
    chainPosition:    chainPos,
    originalIndex:    index,
    similarityToNext,
  }));

  // ── STEP 4: CLUSTER ───────────────────────────────────────────────────
  // Agglomerative clustering gives each tab a topic label for colour-coding.
  onProgress('Identifying topics...');
  const clusterAssignments = clusterTabs(embeddings);

  const clusters = {};
  tabs.forEach((tab, i) => { clusters[tab.tabId] = clusterAssignments[i]; });

  // ── STEP 5: LABEL CLUSTERS ─────────────────────────────────────────────
  // TF-IDF over each cluster's tab content picks 1-2 distinguishing words,
  // so the UI can show "React Hooks" / "Trip Planning" instead of just
  // colour dots. See labeler.js for why cluster-level (not tab-level) TF-IDF.
  const clusterLabels = labelClusters(tabs, clusterAssignments);

  return { chain, clusters, clusterLabels, simMatrix, method, implicitExampleCount: implicitCount };
}
