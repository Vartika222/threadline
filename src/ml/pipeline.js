/**
 * THREADLINE — pipeline.js
 *
 * Orchestrates a full sort in 4 steps:
 *   1. Embed       → one vector per tab (all-MiniLM-L6-v2)
 *   2. Similarity  → N×N cosine similarity matrix
 *   3. Categorise  → a category and subcategory for each tab
 *   4. Chain       → within each subcategory, the most related order
 *
 * @param {Array}    tabs       - Tab objects from background.js
 * @param {Function} onProgress - UI progress string callback
 * @returns {{ chain: Array, clusters: Object, method: string }}
 */

import { embedTexts, cosineSimilarity }                           from './embedder.js';
import { buildSimilarityMatrix, buildChainOrder } from './graph.js';
import { classifyTabs, placementFor, CATEGORY_NAMES }               from './categories.js';
import { consumeImplicitPairs }                                    from './implicitFeedback.js';
import { isPersonalisationEnabled, loadAdjustments, scoreAllPairs } from './personalise.js';
import { trustedStudent }                                         from './student.js';

/**
 * Your corrections and the trained student, as automatic sorting uses them
 * (background.js stores both), so Sort now puts tabs in the same groups.
 * Gemini Nano is left out: at about 3.5 s a tab, a whole window would take minutes.
 */
export async function classifierOptions() {
  const { site_corrections: corrections = {}, student_model: model = null } =
    await chrome.storage.local.get(['site_corrections', 'student_model']);
  return { corrections, student: trustedStudent(model) };
}

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
      ...(await categoriseAlone(tabs)),
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

  // ── STEP 3: CATEGORISE ────────────────────────────────────────────────
  onProgress('Sorting into categories...');
  const placements = (await classifyTabs(tabs, embedTexts, await classifierOptions())).map(placementFor);

  // ── STEP 4: CHAIN ─────────────────────────────────────────────────────
  // Categories in their fixed order, then subcategories, and within each
  // subcategory the strongest chain of related tabs (see graph.js).
  onProgress('Finding your thread...');
  const orderedIndices = orderWithinCategories(placements, simMatrix);

  const chain = orderedIndices.map((index, position) => {
    const next = orderedIndices[position + 1];
    const sameCategory = next !== undefined && placements[next].category === placements[index].category;
    return {
      ...tabs[index],
      placement:        placements[index],
      chainPosition:    position,
      originalIndex:    index,
      // A percentage between unrelated categories means nothing, so don't show one.
      similarityToNext: sameCategory ? simMatrix[index][next] : null,
    };
  });

  const clusters = {};
  const clusterLabels = {};
  tabs.forEach((tab, i) => {
    clusters[tab.tabId] = placements[i].categoryRank;
    clusterLabels[placements[i].categoryRank] = placements[i].category;
  });

  return { chain, clusters, clusterLabels, simMatrix, method, implicitExampleCount: implicitCount };
}

/** A one-tab sort has nothing to chain, but still needs its category. */
async function categoriseAlone(tabs) {
  const [placement] = (await classifyTabs(tabs, embedTexts, await classifierOptions())).map(placementFor);
  tabs[0].placement = placement;
  return {
    chain: [{ ...tabs[0], chainPosition: 0, similarityToNext: null }],
    clusters: { [tabs[0].tabId]: placement.categoryRank },
    clusterLabels: { [placement.categoryRank]: CATEGORY_NAMES[placement.categoryRank] },
  };
}

/** Tab indices ordered by category, then subcategory, then related neighbours. */
function orderWithinCategories(placements, simMatrix) {
  const buckets = new Map();
  placements.forEach((p, i) => {
    const key = p.categoryRank * 100 + p.subcategoryRank;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(i);
  });
  return [...buckets.keys()].sort((a, b) => a - b).flatMap(key => {
    const members = buckets.get(key);
    const subMatrix = members.map(a => members.map(b => simMatrix[a][b]));
    return buildChainOrder(subMatrix).map(position => members[position]);
  });
}
