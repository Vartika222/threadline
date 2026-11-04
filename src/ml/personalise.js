/**
 * THREADLINE — personalise.js
 *
 * Optional, experimental: nudges "how related are these two tabs?" using the
 * user's own corrections. Off unless the user turns it on in the popup.
 *
 * ─── THE MODEL ───────────────────────────────────────────────────────────
 *
 * For unit-length embeddings, cosine similarity is the sum of a[i] * b[i] over
 * all dimensions. This model learns one weight per dimension:
 *
 *   score(a, b) = Σ (1 + adjustment[i]) * a[i] * b[i]
 *
 * With every adjustment at 0 this IS cosine similarity, and regularisation
 * pulls adjustments back towards 0, so it starts from a sensible answer and
 * has to be argued away from it. It compares the two tabs directly, and is
 * symmetric by construction: score(a, b) always equals score(b, a).
 *
 * ─── WHY NOT A NEURAL NETWORK (what this replaced) ───────────────────────
 *
 * A 72,665-parameter network learned from a few dozen examples overfits, and
 * in simulation it made sorting clearly worse on tabs it hadn't seen: neighbour
 * agreement fell from 0.57 to 0.38 at 60 examples. A smaller comparison network
 * and a low-rank model also did damage when a user's corrections were
 * inconsistent. This model is the only one tested that did no real damage, but
 * it hasn't shown much benefit either: within about 0.02 of plain cosine, up or
 * down, and untested on real people. That's why it stays opt-in. See the
 * README's Evaluation section.
 *
 * Training is plain arithmetic: a few milliseconds, with no random steps, so
 * the same examples always give the same weights.
 */

const EXAMPLES_KEY = 'nn_training_examples';
const SEEN_KEY = 'nn_examples_seen';
const WEIGHTS_KEY = 'personal_weights';
const ENABLED_KEY = 'personalisation_enabled';

/** Minimum examples before training starts. */
export const ACTIVATION_THRESHOLD = 15;

/** Once active, retrain after this many NEW examples. */
export const RETRAIN_EVERY = 5;

/** Stored examples are capped: each one holds two embeddings. */
const MAX_STORED_EXAMPLES = 200;

// Training settings. These were the first values tried, not tuned to the test
// data, so the measured results aren't flattered by them.
const EPOCHS = 150;
const LEARNING_RATE = 8;
const REGULARISATION = 0.02; // pull towards plain cosine similarity
const STEEPNESS = 10;        // how sharply the score converts to a probability
const MIDPOINT = 0.2;        // the score treated as "could be either" (between the
                             // model's typical same-topic and other-topic scores)

// ─── ON / OFF ─────────────────────────────────────────────────────────────

/** @returns {Promise<boolean>} false unless the user has turned it on */
export async function isPersonalisationEnabled() {
  const { [ENABLED_KEY]: enabled } = await chrome.storage.local.get(ENABLED_KEY);
  return enabled === true;
}

export async function setPersonalisationEnabled(enabled) {
  await chrome.storage.local.set({ [ENABLED_KEY]: enabled });
}

// ─── TRAINING ─────────────────────────────────────────────────────────────

/**
 * Learns one adjustment per embedding dimension by gradient descent.
 *
 * @param {Array<{embeddingA:number[], embeddingB:number[], label:0|1}>} examples
 * @returns {number[]} one adjustment per dimension
 */
export function trainAdjustments(examples) {
  if (examples.length === 0) return [];

  // Examples saved under a previous embedding model have a different length.
  const dims = examples[examples.length - 1].embeddingA.length;
  examples = examples.filter(e => e.embeddingA.length === dims);
  // The per-dimension products are all the training ever reads.
  const products = examples.map(e => e.embeddingA.map((value, i) => value * e.embeddingB[i]));
  const adjustments = new Float64Array(dims);

  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const gradient = new Float64Array(dims);
    products.forEach((product, n) => {
      let score = 0;
      for (let i = 0; i < dims; i++) score += (1 + adjustments[i]) * product[i];
      const predicted = 1 / (1 + Math.exp(-STEEPNESS * (score - MIDPOINT)));
      const error = STEEPNESS * (predicted - examples[n].label);
      for (let i = 0; i < dims; i++) gradient[i] += error * product[i];
    });
    for (let i = 0; i < dims; i++) {
      adjustments[i] -= LEARNING_RATE * (gradient[i] / examples.length + REGULARISATION * adjustments[i]);
    }
  }
  return Array.from(adjustments);
}

// ─── SCORING ──────────────────────────────────────────────────────────────

/**
 * Personalised N×N similarity matrix, on the same 0-1 scale as cosine.
 *
 * @param {Array<{embedding:number[]}>} tabs
 * @param {number[]} adjustments - from trainAdjustments
 * @returns {number[][]}
 */
export function scoreAllPairs(tabs, adjustments) {
  const n = tabs.length;
  const matrix = Array.from({ length: n }, () => new Array(n).fill(1));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = tabs[i].embedding;
      const b = tabs[j].embedding;
      let score = 0;
      for (let d = 0; d < a.length; d++) score += (1 + adjustments[d]) * a[d] * b[d];
      matrix[i][j] = matrix[j][i] = Math.max(0, Math.min(1, score));
    }
  }
  return matrix;
}

// ─── PERSISTENCE ──────────────────────────────────────────────────────────

export async function saveAdjustments(adjustments) {
  await chrome.storage.local.set({ [WEIGHTS_KEY]: JSON.stringify(adjustments.map(roundTo4)) });
}

/** @returns {Promise<number[]|null>} null until a training run has happened */
export async function loadAdjustments() {
  const { [WEIGHTS_KEY]: saved } = await chrome.storage.local.get(WEIGHTS_KEY);
  return saved ? JSON.parse(saved) : null;
}

// ─── TRAINING DATA ────────────────────────────────────────────────────────

/**
 * Decides whether to train now.
 *
 * It compares the current example count with the count at the LAST training
 * run, instead of testing for exact counts (15, 20, 25...). A single drag can
 * add 2-4 examples at once, and a tab-switch burst adds 2 per pair, so the
 * count often jumps past an exact checkpoint.
 *
 * Both counts must be lifetime totals (see loadExamplesSeen), not the number
 * stored: storage is capped, so a stored count stops growing and training
 * would never run again.
 *
 * @param {number} total        examples ever collected
 * @param {number} trainedCount lifetime total at the last training run (0/undefined = never trained)
 */
export function shouldRetrain(total, trainedCount, {
  threshold = ACTIVATION_THRESHOLD,
  every = RETRAIN_EVERY,
} = {}) {
  if (total < threshold) return false;
  if (!trainedCount) return true;
  return total - trainedCount >= every;
}

const roundTo4 = (v) => Math.round(v * 1e4) / 1e4;

/**
 * Rounds each component to 4 decimal places. The embeddings are unit-length
 * floats, so 4 decimals keeps cosine similarity accurate to ~1e-4 while
 * shrinking the JSON a lot.
 */
export function roundVector(vec) {
  return Array.from(vec, roundTo4);
}

/**
 * Stores a training example when the user corrects the order.
 *
 * @param {object} tabA - tab with .embedding set
 * @param {object} tabB - tab with .embedding set
 * @param {0|1} label   - 1 = related (placed adjacent), 0 = unrelated
 * @returns {Promise<number>} Total examples stored
 */
export async function storeTrainingExample(tabA, tabB, label) {
  const { [EXAMPLES_KEY]: existing, [SEEN_KEY]: seen } =
    await chrome.storage.local.get([EXAMPLES_KEY, SEEN_KEY]);
  const examples = existing ? JSON.parse(existing) : [];
  // Data saved before this counter existed starts from what's stored.
  const examplesSeen = (seen ?? examples.length) + 1;

  examples.push({
    embeddingA: roundVector(tabA.embedding),
    embeddingB: roundVector(tabB.embedding),
    label,
    timestamp: Date.now(),
  });

  // Roughly 6KB per example, so the cap keeps this around 1.5MB of the 10MB
  // chrome.storage.local quota.
  const trimmed = examples.slice(-MAX_STORED_EXAMPLES);
  await chrome.storage.local.set({
    [EXAMPLES_KEY]: JSON.stringify(trimmed),
    [SEEN_KEY]: examplesSeen,
  });

  return trimmed.length;
}

/**
 * @returns {Promise<number>} Examples ever collected, including any since
 *          dropped by the storage cap. This is what shouldRetrain compares.
 */
export async function loadExamplesSeen() {
  const { [SEEN_KEY]: seen } = await chrome.storage.local.get(SEEN_KEY);
  return seen ?? (await loadTrainingExamples()).length;
}

/**
 * @returns {Promise<Array>} All stored training examples
 */
export async function loadTrainingExamples() {
  const { [EXAMPLES_KEY]: stored } = await chrome.storage.local.get(EXAMPLES_KEY);
  return stored ? JSON.parse(stored) : [];
}
