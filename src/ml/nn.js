/**
 * THREADLINE — nn.js  (V2)
 *
 * True parallel-stream multimodal neural network.
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
 *   beh_A(5)   → [encoder_behav]   → 8-dim  ──┤
 *   beh_B(5)   → [encoder_behav]   → 8-dim  ──┘
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
 *   - The encoder learns a symmetric similarity metric: if A relates to B,
 *     B relates to A the same way
 *   - Consistent with the assumption that "content is content" regardless
 *     of which tab is A and which is B
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

// ─── BEHAVIOUR VECTOR ─────────────────────────────────────────────────────

/**
 * Converts raw tab data into a normalised 5-feature behaviour vector.
 *
 * Features:
 *   [dwell_norm, revisit_norm, hour_sin, hour_cos, transition_norm]
 *
 * All continuous features normalised to [0,1].
 * Hour uses cyclical sin/cos encoding so midnight and 23:00 are close.
 *
 * @param {object} tab
 * @returns {number[]} 5-element vector
 */
export function tabToBehaviourVector(tab) {
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

  // Cyclical hour encoding: maps 24-hour clock onto a unit circle.
  // hour=0 and hour=23 will be close; hour=0 and hour=12 will be opposite.
  const angle   = (2 * Math.PI * hourOfDay) / 24;
  const hourSin = Math.sin(angle);
  const hourCos = Math.cos(angle);

  return [dwellNorm, revisitNorm, hourSin, hourCos, transitionNorm];
}

// ─── MODEL DIMENSIONS ─────────────────────────────────────────────────────

const EMBED_DIM   = 512; // USE output dimension
const BEHAV_DIM   = 5;   // Behaviour vector dimension
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

  // Behaviour streams: 5 → 16 → 8
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
    name:    'threadline_multimodal_v2',
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
 * @param {number[]} behaviourA  5-dim behaviour vector for tab A
 * @param {number[]} embeddingB  512-dim content vector for tab B
 * @param {number[]} behaviourB  5-dim behaviour vector for tab B
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
 * @param {object[]} tabs - Tab objects with .embedding and behaviour fields
 * @param {tf.LayersModel} model
 * @returns {Promise<number[][]>} N×N score matrix (symmetric)
 */
export async function scoreAllPairs(tabs, model) {
  const tf = await import('@tensorflow/tfjs');
  const n = tabs.length;

  // Flatten all pairs into batched input arrays
  const embAs = [], embBs = [], behAs = [], behBs = [];
  const pairIndices = [];

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      embAs.push(tabs[i].embedding);
      embBs.push(tabs[j].embedding);
      behAs.push(tabToBehaviourVector(tabs[i]));
      behBs.push(tabToBehaviourVector(tabs[j]));
      pairIndices.push([i, j]);
    }
  }

  if (embAs.length === 0) return Array.from({ length: n }, () => new Array(n).fill(0));

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
    const s = Math.max(0, Math.min(1, scores[idx]));
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

  // Build four separate input tensors to match the model's input signature
  const embAs = examples.map(e => e.embeddingA);
  const embBs = examples.map(e => e.embeddingB);
  const behAs = examples.map(e => e.behaviourA);
  const behBs = examples.map(e => e.behaviourB);
  const labels = examples.map(e => [e.label]);

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
      validationSplit: examples.length >= 10 ? 0.2 : 0,
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
    nn_version:   2, // Track architecture version to avoid loading V1 weights into V2 model
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

  // Version guard: don't load V1 flat weights into V2 parallel-stream model
  if (nn_version !== 2) {
    console.warn('[Threadline] Saved weights are from a different model version — starting fresh');
    await chrome.storage.local.remove(['nn_weights', 'nn_version']);
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
  const { [KEY]: existing } = await chrome.storage.local.get(KEY);
  const examples = existing ? JSON.parse(existing) : [];

  examples.push({
    embeddingA:  tabA.embedding,
    behaviourA:  tabToBehaviourVector(tabA),
    embeddingB:  tabB.embedding,
    behaviourB:  tabToBehaviourVector(tabB),
    label,
    timestamp:   Date.now(),
  });

  // Cap at 200 to limit storage (~4KB per example × 200 = 800KB max)
  const trimmed = examples.slice(-200);
  await chrome.storage.local.set({ [KEY]: JSON.stringify(trimmed) });

  return trimmed.length;
}

/**
 * @returns {Promise<Array>} All stored training examples
 */
export async function loadTrainingExamples() {
  const { nn_training_examples } = await chrome.storage.local.get('nn_training_examples');
  return nn_training_examples ? JSON.parse(nn_training_examples) : [];
}