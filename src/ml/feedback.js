/**
 * THREADLINE — feedback.js
 *
 * Turns a user's manual drag-and-drop reorder into contrastive training
 * examples for the personalisation NN (see nn.js).
 *
 * ─── THE CORE IDEA ────────────────────────────────────────────────────────
 * The MST/DFS chain is Threadline's *hypothesis* about which tabs relate.
 * When the user drags a tab elsewhere, they're correcting that hypothesis.
 * That correction is free supervision — we don't need to ask "are these
 * related?", we just watch what the user does with the order we gave them.
 *
 * ─── WHAT COUNTS AS A SIGNAL ──────────────────────────────────────────────
 *   1. NEW ADJACENCY (positive, label=1)
 *      Two tabs that were NOT next to each other before, and ARE next to
 *      each other after the drag → the user judged them related enough
 *      to sit side by side.
 *   2. BROKEN ADJACENCY (negative, label=0)
 *      Two tabs that WERE next to each other before, and are no longer
 *      adjacent after the drag → the user judged the model's pairing wrong.
 *   3. UNTOUCHED ADJACENCY → no signal.
 *      Pairs adjacent before AND after aren't included. The user didn't
 *      act on them, so we can't tell agreement from apathy.
 *
 * We deliberately only look at NEIGHBOUR pairs that changed, not every
 * pair whose relative position shifted because of the move. One drag is
 * weak evidence about one relationship — treating it as signal about
 * every pair it displaced would let a single click overfit dozens of
 * unrelated tabs.
 */

/**
 * @param {Array<{tabId:number}>} beforeChain - chain order before the drag
 * @param {Array<{tabId:number}>} afterChain  - chain order after the drag
 * @returns {Array<{aId:number, bId:number, label:0|1}>}
 */
export function deriveTrainingPairs(beforeChain, afterChain) {
  const adjacentPairs = (chain) => {
    const set = new Set();
    for (let i = 0; i < chain.length - 1; i++) {
      set.add(pairKey(chain[i].tabId, chain[i + 1].tabId));
    }
    return set;
  };

  const before = adjacentPairs(beforeChain);
  const after = adjacentPairs(afterChain);

  const pairs = [];

  for (const key of after) {
    if (!before.has(key)) pairs.push({ ...unpackKey(key), label: 1 });
  }
  for (const key of before) {
    if (!after.has(key)) pairs.push({ ...unpackKey(key), label: 0 });
  }

  return pairs;
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function unpackKey(key) {
  const [aId, bId] = key.split('|').map(Number);
  return { aId, bId };
}
