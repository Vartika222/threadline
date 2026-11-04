/**
 * THREADLINE — nn.js  (V3)
 *
 * True parallel-stream multimodal neural network.
 *
 * ─── V3 CHANGE: RECENCY ──────────────────────────────────────────────────
 * The behaviour vector gained a 6th feature: recencyNorm (how recently
 * this tab was actually touched — see recency.js). V2 only had dwell,
 * revisit, hour-of-day (sin/cos), and transition count; none of those
 * capture "is this tab part of what the user is doing RIGHT NOW". A tab
 * revisited 40 times last week but untouched today shouldn't score the
 * same as one the user just switched into.
 *
 * Changing BEHAV_DIM from 5→6 changes the model's input shape, so old V2
 * weights are incompatible — see the nn_version guard in loadSavedModel().
 *
 * ─── WHY V1 WAS WRONG ────────────────────────────────────────────────────
 *
 * V1 concatenated all four inputs into one 1034-element flat vector, then
 * fed it into a single Dense(256) layer. The problem:
 *
 *   [emb_A(512) | emb_B(512) | beh_A(5) | beh_B(5)]
 *
 * The content embeddings occupy 1024/1034 ≈ 99% of the input. The first
 * Dense layer assigns weights to all 1034 inputs simultaneously. With
 * random initialisation, the 10 behavioural inputs have weights of the same
 * magnitude as the 1024 content inputs — but they represent a completely
 * different scale and meaning. The gradient signal from the behavioural
 * features is statistically swamped by the much larger content signal before
 * the network has any chance to learn that dwell time matters.
 *
 * ─── WHY PARALLEL STREAMS FIX THIS ──────────────────────────────────────
 *
 * Each modality gets its own encoder — a small subnetwork that compresses
 * that modality into a fixed-size representation BEFORE the streams meet.
 *
 *   emb_A(512) → [encoder_content] → 32-dim ──┐
 *   emb_B(512) → [encoder_content] → 32-dim ──┤
 *                                              ├→ concat(80) → [fusion] → score
 *   beh_A(6)   → [encoder_behav]   → 8-dim  ──┤
 *   beh_B(6)   → [encoder_behav]   → 8-dim  ──┘
 *
 * After encoding, all four streams contribute equally at the fusion point
 * (32+32+8+8 = 80 dims). The behaviour signal is amplified proportionally
 * before it ever sees the content signal. The network can learn independently
 * "what makes two content embeddings similar" and "what makes two behavioural
 * patterns similar", then combine those conclusions at fusion.
 *
 * This is the standard approach in multimodal ML research (CLIP, ALIGN,
 * and most vision-language models use similar stream-then-fuse designs).
 *
 * ─── TF.JS FUNCTIONAL API ────────────────────────────────────────────────
 *
 * TF.js's Sequential API only supports a single input tensor and a linear
 * chain of layers. To build a multi-input, multi-stream network we need
 * the Functional API: tf.input() → tf.layers.dense().apply() → tf.model().
 *
 * This is equivalent to Keras's functional API if you've seen that before.
 *
 * ─── WEIGHT SHARING ──────────────────────────────────────────────────────
 *
 * The content encoder is SHARED between stream A and stream B — the same
 * layer object processes both embeddings. This means:
 *   - Fewer parameters (saves memory)
 *   - Both tabs are encoded by the same function, so "content is content"
 *     regardless of which tab is A and which is B
 *
 * Sharing does NOT make the whole network symmetric: the fusion layer sees
 * the concatenation [encA, encB, behA, behB] in a fixed order, so
 * f(A, B) and f(B, A) can differ. Two measures remove that dependence on
 * which tab happens to be listed first:
 *   - trainModel adds a swapped copy (B, A) of every training example
 *   - scoreAllPairs scores each pair in both orders and averages them
 *
 * The behaviour encoder is also shared for the same reasons.
 *
 * ─── CONTRASTIVE LEARNING ────────────────────────────────────────────────
 *
 * Training signal comes from implicit user feedback:
 *   - Positive pair (label=1): user placed tabs adjacent after sorting
 *   - Negative pair (label=0): user placed tabs far apart
 *   - Implicit positive: tabs already in the same Chrome tab group
 *
 * Loss: Binary Cross-Entropy on the sigmoid output.
 * Threshold: NN personalisation activates after 15+ training examples.
 */

import { computeRecencyNorm } from './recency.js';

// ─── BEHAVIOUR VECTOR ─────────────────────────────────────────────────────

/**
 * Converts raw tab data into a normalised 6-feature behaviour vector.
 *
 * Features:
 *   [dwell_norm, revisit_norm, hour_sin, hour_cos, transition_norm, recency_norm]
 *
 * All continuous features normalised to [0,1] (sin/cos to [-1,1]).
 * Hour uses cyclical sin/cos encoding so midnight and 23:00 are close.
 * Recency uses tab.lastActive vs. "now" — see recency.js for why.
 *
 * @param {object} tab
 * @param {number} [now] - epoch ms "now", injectable for deterministic tests
 * @returns {number[]} 6-element vector
 */
export function tabToBehaviourVector(tab, now = Date.now()) {
  const DWELL_CAP       = 10 * 60 * 1000; // 10 min in ms
  const REVISIT_CAP     = 20;
  const TRANSITION_CAP  = 50;

  const dwellMs         = tab.dwellMs        || 0;
  const revisitCount    = tab.revisitCount   || 0;
  const hourOfDay       = tab.hourOfDay      ?? 12; // ?? not || so hour=0 (midnight) works
  const transitionCount = tab.transitionCount || 0;

  const dwellNorm      = Math.min(dwellMs / DWELL_CAP, 1);
  const revisitNorm    = Math.min(revisitCount / REVISIT_CAP, 1);
  const transitionNorm = Math.min(transitionCount / TRANSITION_CAP, 1);
  const recencyNorm    = computeRecencyNorm(tab.lastActive, now);

  // Cyclical hour encoding: maps 24-hour clock onto a unit circle.
  // hour=0 and hour=23 will be close; hour=0 and hour=12 will be opposite.
  const angle   = (2 * Math.PI * hourOfDay) / 24;
  const hourSin = Math.sin(angle);
  const hourCos = Math.cos(angle);

  return [dwellNorm, revisitNorm, hourSin, hourCos, transitionNorm, recencyNorm];
}

// ─── MODEL DIMENSIONS ─────────────────────────────────────────────────────

const EMBED_DIM   = 512; // USE output dimension
const BEHAV_DIM   = 6;   // Behaviour vector dimension (V3: +recencyNorm)
const CONTENT_ENC = 32;  // Content encoder output dimension (per stream)
const BEHAV_ENC   = 8;   // Behaviour encoder output dimension (per stream)
const FUSION_DIM  = CONTENT_ENC * 2 + BEHAV_ENC * 2; // 80

// ─── MODEL ARCHITECTURE (FUNCTIONAL API) ──────────────────────────────────

/**
 * Builds the parallel-stream multimodal network using TF.js Functional API.
 *
 * Inputs:  4 tensors — embA, embB, behA, behB
 * Output:  1 scalar — relatability score in [0, 1]
 *
 * @returns {Promise<tf.LayersModel>}
 */
export async function buildModel() {
  const tf = await import('@tensorflow/tfjs');

  // ── Shared encoders ──────────────────────────────────────────────────
  // These layer objects are reused for both A and B streams.
  // Shared weights = symmetric metric + fewer parameters.

  const contentDense1 = tf.layers.dense({
    units: 128, activation: 'relu',
    kernelInitializer: 'glorotUniform',
    name: 'content_enc_1',
  });
  const contentDense2 = tf.layers.dense({
    units: CONTENT_ENC, activation: 'relu',
    name: 'content_enc_2',
  });

  const behavDense1 = tf.layers.dense({
    units: 16, activation: 'relu',
    kernelInitializer: 'glorotUniform',
    name: 'behav_enc_1',
  });
  const behavDense2 = tf.layers.dense({
    units: BEHAV_ENC, activation: 'relu',
    name: 'behav_enc_2',
  });

  // ── Define inputs ────────────────────────────────────────────────────
  const inputEmbA = tf.input({ shape: [EMBED_DIM], name: 'emb_a' });
  const inputEmbB = tf.input({ shape: [EMBED_DIM], name: 'emb_b' });
  const inputBehA = tf.input({ shape: [BEHAV_DIM], name: 'beh_a' });
  const inputBehB = tf.input({ shape: [BEHAV_DIM], name: 'beh_b' });

  // ── Encode each stream independently ─────────────────────────────────
  // Content streams: 512 → 128 → 32
  const encEmbA = contentDense2.apply(contentDense1.apply(inputEmbA));
  const encEmbB = contentDense2.apply(contentDense1.apply(inputEmbB));

  // Behaviour streams: 6 → 16 → 8
  const encBehA = behavDense2.apply(behavDense1.apply(inputBehA));
  const encBehB = behavDense2.apply(behavDense1.apply(inputBehB));

  // ── Fusion ───────────────────────────────────────────────────────────
  // Concatenate all four encoded streams: 32+32+8+8 = 80 dims.
  // At this point every stream has equal representation before the
  // fusion layers decide how to combine them.
  const fused = tf.layers.concatenate({ name: 'fusion' })
    .apply([encEmbA, encEmbB, encBehA, encBehB]);

  // Fusion layers learn cross-modal interactions
  const fusion1 = tf.layers.dense({
    units: 32, activation: 'relu', name: 'fusion_1',
  }).apply(fused);

  const dropout = tf.layers.dropout({
    rate: 0.2, name: 'dropout',
  }).apply(fusion1);

  const output = tf.layers.dense({
    units: 1, activation: 'sigmoid', name: 'relatability',
  }).apply(dropout);

  // ── Assemble model ───────────────────────────────────────────────────
  const model = tf.model({
    inputs:  [inputEmbA, inputEmbB, inputBehA, inputBehB],
    outputs: output,
    name:    'threadline_multimodal_v3',
  });

  model.compile({
    optimizer: tf.train.adam(0.001),
    loss:      'binaryCrossentropy',
    metrics:   ['accuracy'],
  });

  return model;
}

// ─── INFERENCE ────────────────────────────────────────────────────────────

/**
 * Scores a pair of tabs for relatability.
 *
 * @param {number[]} embeddingA  512-dim content vector for tab A
 * @param {number[]} behaviourA  6-dim behaviour vector for tab A
 * @param {number[]} embeddingB  512-dim content vector for tab B
 * @param {number[]} behaviourB  6-dim behaviour vector for tab B
 * @param {tf.LayersModel} model
 * @returns {Promise<number>} Relatability score in [0, 1]
 */
export async function scoreTabPair(embeddingA, behaviourA, embeddingB, behaviourB, model) {
  const tf = await import('@tensorflow/tfjs');

  // Four separate input tensors — one per model input
  const tEmbA = tf.tensor2d([embeddingA]); // [1, 512]
  const tEmbB = tf.tensor2d([embeddingB]); // [1, 512]
  const tBehA = tf.tensor2d([behaviourA]); // [1, 5]
  const tBehB = tf.tensor2d([behaviourB]); // [1, 5]

  const outputTensor = model.predict([tEmbA, tEmbB, tBehA, tBehB]);
  const score = (await outputTensor.data())[0];

  // Always dispose tensors after use — prevents GPU memory leak
  [tEmbA, tEmbB, tBehA, tBehB, outputTensor].forEach(t => t.dispose());

  return score;
}

// ─── BATCH INFERENCE ──────────────────────────────────────────────────────

/**
 * Scores all N*(N-1)/2 tab pairs in one batched call.
 * More efficient than calling scoreTabPair in a loop.
 *
 * Each pair is scored in BOTH orders, (i, j) and (j, i), and the two scores
 * are averaged. The network is not symmetric on its own (see the header), so
 * without this the score of a pair would depend on which tab happened to come
 * first in the list.
 *
 * @param {object[]} tabs - Tab objects with .embedding and behaviour fields
 * @param {tf.LayersModel} model
 * @returns {Promise<number[][]>} N×N score matrix (symmetric)
 */
export async function scoreAllPairs(tabs, model) {
  const tf = await import('@tensorflow/tfjs');
  const n = tabs.length;

  const behaviours = tabs.map(t => tabToBehaviourVector(t));

  // Flatten all pairs into batched input arrays: first every (i, j) with
  // i < j, then the same pairs swapped, (j, i).
  const embAs = [], embBs = [], behAs = [], behBs = [];
  const pairIndices = [];

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      embAs.push(tabs[i].embedding);
      embBs.push(tabs[j].embedding);
      behAs.push(behaviours[i]);
      behBs.push(behaviours[j]);
      pairIndices.push([i, j]);
    }
  }

  if (embAs.length === 0) {
    // Fewer than two tabs: nothing to score, just the identity.
    return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  }

  const pairCount = pairIndices.length;
  for (const [i, j] of pairIndices) {
    embAs.push(tabs[j].embedding);
    embBs.push(tabs[i].embedding);
    behAs.push(behaviours[j]);
    behBs.push(behaviours[i]);
  }

  const tEmbA = tf.tensor2d(embAs);
  const tEmbB = tf.tensor2d(embBs);
  const tBehA = tf.tensor2d(behAs);
  const tBehB = tf.tensor2d(behBs);

  const outputTensor = model.predict([tEmbA, tEmbB, tBehA, tBehB]);
  const scores = await outputTensor.data();

  [tEmbA, tEmbB, tBehA, tBehB, outputTensor].forEach(t => t.dispose());

  // Reconstruct N×N symmetric matrix
  const matrix = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  );

  pairIndices.forEach(([i, j], idx) => {
    const averaged = (scores[idx] + scores[idx + pairCount]) / 2;
    const s = Math.max(0, Math.min(1, averaged));
    matrix[i][j] = s;
    matrix[j][i] = s;
  });

  return matrix;
}

// ─── TRAINING ─────────────────────────────────────────────────────────────

/**
 * Trains the model on stored (tabA, tabB, label) examples.
 *
 * @param {Array<{embeddingA, behaviourA, embeddingB, behaviourB, label}>} examples
 * @param {tf.LayersModel} model
 * @param {{ epochs?: number, batchSize?: number }} options
 * @returns {Promise<object>} Training history
 */
export async function trainModel(examples, model, options = {}) {
  const tf = await import('@tensorflow/tfjs');
  const { epochs = 20, batchSize = 8 } = options;

  if (examples.length < 4) {
    throw new Error(`Need at least 4 training examples, got ${examples.length}`);
  }

  // Every example is used in both orders — (A, B) and (B, A) — so the network
  // cannot learn that the first-listed tab matters. See the header note on
  // symmetry. Copies are interleaved so a validation split never holds only
  // swapped copies.
  const withSwaps = examples.flatMap(e => [
    e,
    {
      embeddingA: e.embeddingB, behaviourA: e.behaviourB,
      embeddingB: e.embeddingA, behaviourB: e.behaviourA,
      label: e.label,
    },
  ]);

  // Build four separate input tensors to match the model's input signature
  const embAs = withSwaps.map(e => e.embeddingA);
  const embBs = withSwaps.map(e => e.embeddingB);
  const behAs = withSwaps.map(e => e.behaviourA);
  const behBs = withSwaps.map(e => e.behaviourB);
  const labels = withSwaps.map(e => [e.label]);

  const tEmbA  = tf.tensor2d(embAs);
  const tEmbB  = tf.tensor2d(embBs);
  const tBehA  = tf.tensor2d(behAs);
  const tBehB  = tf.tensor2d(behBs);
  const tLabels = tf.tensor2d(labels);

  const history = await model.fit(
    [tEmbA, tEmbB, tBehA, tBehB],
    tLabels,
    {
      epochs,
      batchSize,
      validationSplit: withSwaps.length >= 10 ? 0.2 : 0,
      shuffle: true,
      verbose: 0,
    }
  );

  [tEmbA, tEmbB, tBehA, tBehB, tLabels].forEach(t => t.dispose());

  return history;
}

// ─── PERSISTENCE ──────────────────────────────────────────────────────────

/**
 * Serialises model weights to chrome.storage.local.
 * TF.js IndexedDB storage isn't available in all extension contexts,
 * so we serialise weights manually as JSON.
 */
export async function saveModel(model) {
  const weights = model.getWeights().map(w => ({
    shape: w.shape,
    data:  Array.from(w.dataSync()),
    name:  w.name,
  }));

  await chrome.storage.local.set({
    nn_weights:   JSON.stringify(weights),
    nn_version:   3, // Track architecture version to avoid loading V1/V2 weights into V3 model
    nn_saved_at:  Date.now(),
  });
}

/**
 * Loads model weights from chrome.storage.local.
 * Returns null if no saved weights exist or if saved weights are from a
 * different architecture version (would corrupt the model).
 */
export async function loadSavedModel() {
  const tf = await import('@tensorflow/tfjs');
  const { nn_weights, nn_version } = await chrome.storage.local.get(['nn_weights', 'nn_version']);

  if (!nn_weights) return null;

  // Version guard: don't load V1/V2 weights (5-dim behaviour vector) into
  // the V3 model (6-dim behaviour vector, +recencyNorm) — shapes wouldn't match.
  if (nn_version !== 3) {
    console.warn('[Threadline] Saved weights are from a different model version — starting fresh');
    await chrome.storage.local.remove(['nn_weights', 'nn_version', 'nn_trained_count']);
    return null;
  }

  const model = await buildModel();
  const savedWeights = JSON.parse(nn_weights);

  const weightTensors = savedWeights.map(w => tf.tensor(w.data, w.shape));
  model.setWeights(weightTensors);
  weightTensors.forEach(t => t.dispose());

  return model;
}

// ─── TRAINING DATA COLLECTION ─────────────────────────────────────────────

/** Minimum examples before NN replaces cosine similarity */
export const NN_ACTIVATION_THRESHOLD = 15;

/** Once active, retrain after this many NEW examples. */
export const RETRAIN_EVERY = 5;

/**
 * Decides whether to train now.
 *
 * It compares the current example count with the count at the LAST training
 * run, instead of testing for exact counts (15, 20, 25...). A single drag can
 * add 2-6 examples at once, and a tab-switch burst adds 2 per pair, so the
 * count often jumps past an exact checkpoint; testing for equality then
 * skipped training until the count happened to land on the next one.
 *
 * Both counts must be lifetime totals (see loadExamplesSeen), not the number
 * stored: storage is capped at 200, so a stored count stops growing and
 * training would never run again.
 *
 * @param {number} total        examples ever collected
 * @param {number} trainedCount lifetime total at the last training run (0/undefined = never trained)
 */
export function shouldRetrain(total, trainedCount, {
  threshold = NN_ACTIVATION_THRESHOLD,
  every = RETRAIN_EVERY,
} = {}) {
  if (total < threshold) return false;
  if (!trainedCount) return true;
  return total - trainedCount >= every;
}

/**
 * Rounds each component to 4 decimal places. USE embeddings are unit-length
 * floats, so 4 decimals keeps cosine similarity accurate to ~1e-4 while
 * shrinking the JSON a lot.
 */
export function roundVector(vec) {
  return Array.from(vec, v => Math.round(v * 1e4) / 1e4);
}

/**
 * Stores a training example when the user manually reorders tabs.
 *
 * @param {object} tabA - Full tab data with .embedding field set
 * @param {object} tabB - Full tab data with .embedding field set
 * @param {0|1} label   - 1 = related (placed adjacent), 0 = unrelated
 * @returns {Promise<number>} Total examples stored
 */
export async function storeTrainingExample(tabA, tabB, label) {
  const KEY = 'nn_training_examples';
  const { [KEY]: existing, nn_examples_seen: seen } =
    await chrome.storage.local.get([KEY, 'nn_examples_seen']);
  const examples = existing ? JSON.parse(existing) : [];
  // Data saved before this counter existed starts from what's stored.
  const examplesSeen = (seen ?? examples.length) + 1;

  examples.push({
    embeddingA:  roundVector(tabA.embedding),
    behaviourA:  tabToBehaviourVector(tabA),
    embeddingB:  roundVector(tabB.embedding),
    behaviourB:  tabToBehaviourVector(tabB),
    label,
    timestamp:   Date.now(),
  });

  // Cap at 200 examples. Storage cost, measured honestly: each example holds
  // two 512-float embeddings serialised as JSON. At full float precision
  // (~20 chars per number) that is about 21KB per example (measured), so 200
  // examples would be about 4.3MB of the 10MB chrome.storage.local quota.
  // Rounding embeddings to 4 decimals (see roundVector) cuts that to about
  // 7.7KB per example, so 200 examples stay around 1.5MB. The saved network
  // weights add roughly another 1.5MB of JSON.
  const trimmed = examples.slice(-200);
  await chrome.storage.local.set({
    [KEY]: JSON.stringify(trimmed),
    nn_examples_seen: examplesSeen,
  });

  return trimmed.length;
}

/**
 * @returns {Promise<number>} Examples ever collected, including any since
 *          dropped by the 200-example cap. This is what shouldRetrain compares.
 */
export async function loadExamplesSeen() {
  const { nn_examples_seen: seen } = await chrome.storage.local.get('nn_examples_seen');
  return seen ?? (await loadTrainingExamples()).length;
}

/**
 * @returns {Promise<Array>} All stored training examples
 */
export async function loadTrainingExamples() {
  const { nn_training_examples } = await chrome.storage.local.get('nn_training_examples');
  return nn_training_examples ? JSON.parse(nn_training_examples) : [];
}