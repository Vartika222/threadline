/**
 * THREADLINE — implicitFeedback.js
 *
 * Converts "the user kept bouncing back and forth between these two tabs"
 * (tracked passively in background.js) into contrastive training examples
 * — without asking the user to do anything.
 *
 * ─── WHY THIS IS A REAL SIGNAL ───────────────────────────────────────────
 * This mirrors "attentional residue" (Sophie Leroy's research on task
 * switching): when someone hasn't mentally finished with something, they
 * keep returning to it while working on something else. Two tabs that get
 * bounced between repeatedly are — behaviourally — a pair the user treats
 * as related, even if they never dragged them next to each other in the
 * chain. Drag corrections (feedback.js) capture explicit judgement;
 * this captures the same kind of judgement expressed implicitly.
 *
 * ─── WHY THIS IS QUEUED, NOT APPLIED IMMEDIATELY ─────────────────────────
 * background.js can observe WHICH tabIds get bounced between, but it can't
 * compute embeddings: the language model loads in the popup (see embedder.js).
 * So background.js queues candidate pairs by tabId in chrome.storage.
 * The next time the popup runs the ML pipeline — and therefore has fresh
 * embeddings for every open tab — we drain that queue here, turning tabId
 * pairs into full (embedding, label) training examples.
 *
 * Candidates referencing tabs that have since closed (no matching tab in
 * the current pipeline run) are silently dropped — we can't train on a
 * tab we no longer have data for.
 *
 * ─── WHY WE ALSO ADD A NEGATIVE ───────────────────────────────────────────
 * Tab-switch bursts can only ever say "these two ARE related" (label 1).
 * A binary classifier fed only positives learns to answer "related" for
 * everything. For every positive pair we store, we also store one weak
 * negative: tab A paired with the open tab whose content is LEAST similar
 * to A (by cosine). That is a heuristic, not ground truth — the user could
 * in principle relate even those — but the least-similar tab is the safest
 * guess for "unrelated", and it keeps the label balance at 1:1 from this
 * source. Drag corrections (feedback.js) still provide the true negatives.
 */

import { storeTrainingExample } from './personalise.js';
import { cosineSimilarity } from './embedder.js';

const CANDIDATES_KEY = 'implicit_training_candidates';

/**
 * Picks the tab (other than the excluded ids) whose embedding is least
 * similar to `anchor`. Returns null if there is nothing to choose from.
 *
 * @param {{embedding:number[]}} anchor
 * @param {Array<{tabId:number, embedding:number[]}>} tabs
 * @param {Set<number>} excludeIds
 */
export function pickLeastSimilar(anchor, tabs, excludeIds = new Set()) {
  let best = null;
  let bestSim = Infinity;

  for (const t of tabs) {
    if (excludeIds.has(t.tabId) || !t.embedding) continue;
    const sim = cosineSimilarity(anchor.embedding, t.embedding);
    if (sim < bestSim) {
      bestSim = sim;
      best = t;
    }
  }
  return best;
}

/**
 * Drains the implicit-pair queue, turning each surviving candidate into a
 * label=1 training example plus one weak label=0 example, then clears the
 * queue.
 *
 * @param {Array} tabs - tabs from the current pipeline run, each carrying
 *                       a freshly-computed .embedding (set earlier in
 *                       pipeline.js's embed step)
 * @returns {Promise<number>} how many implicit examples were stored
 *          (positives and negatives together)
 */
export async function consumeImplicitPairs(tabs) {
  const { [CANDIDATES_KEY]: raw } = await chrome.storage.local.get(CANDIDATES_KEY);
  const candidates = raw ? JSON.parse(raw) : [];
  if (candidates.length === 0) return 0;

  const tabById = Object.fromEntries(tabs.map(t => [t.tabId, t]));
  let stored = 0;

  for (const { aTabId, bTabId } of candidates) {
    const tabA = tabById[aTabId];
    const tabB = tabById[bTabId];
    if (!tabA?.embedding || !tabB?.embedding) continue; // tab closed since queued

    // Implicit signal, not an explicit drag — but stored as an ordinary
    // positive example alongside drag-derived ones. The NN doesn't need
    // to know the provenance of a label; a related pair is a related pair.
    await storeTrainingExample(tabA, tabB, 1);
    stored++;

    // Balance it with one weak negative (see header comment). Needs at
    // least one other tab to pair against.
    const farTab = pickLeastSimilar(tabA, tabs, new Set([aTabId, bTabId]));
    if (farTab) {
      await storeTrainingExample(tabA, farTab, 0);
      stored++;
    }
  }

  // This batch is spent either way — matched or not, we don't want to
  // re-attempt the same closed-tab candidates on every future sort.
  await chrome.storage.local.remove(CANDIDATES_KEY);
  return stored;
}
