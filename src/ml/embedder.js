/**
 * THREADLINE — embedder.js
 *
 * Loads Universal Sentence Encoder (USE) via TensorFlow.js and converts
 * an array of text strings into 512-dimensional embedding vectors.
 *
 * WHY USE?
 *   - Trained on a huge corpus of text to map similar meanings to nearby vectors
 *   - 512 dimensions is enough signal for tab content without being too heavy
 *   - Runs fully in-browser via WebGL — no data leaves the device
 *   - Small enough (≈25MB) to load in an extension popup context
 *
 * HOW EMBEDDINGS WORK:
 *   Think of each 512-dim vector as a point in 512-dimensional space.
 *   "React hooks tutorial" and "useState useEffect guide" will be
 *   near each other. "French cooking recipes" will be far away from both.
 *   We exploit this geometry to measure tab relatability.
 *
 * USAGE:
 *   import { embedTexts, cosineSimilarity } from './embedder.js';
 *   const vecs = await embedTexts(['React hooks', 'Vue composition API']);
 *   const sim  = cosineSimilarity(vecs[0], vecs[1]); // e.g. 0.82
 */

// Module-level cache so we only load the model once per popup session.
// Loading USE takes ~1-2s the first time; after that it's instant.
let _model = null;

/**
 * Loads the USE model. Subsequent calls return the cached instance.
 * @returns {Promise<object>} The loaded USE model
 */
async function loadModel() {
  if (_model) return _model;

  // Dynamic import — TF.js is large, so we load it lazily
  // In a Chrome extension, @tensorflow-models/universal-sentence-encoder
  // fetches the model weights from its own CDN on first use.
  // For production, you'd want to bundle the weights locally.
  const use = await import('@tensorflow-models/universal-sentence-encoder');
  await import('@tensorflow/tfjs');

  _model = await use.load();
  return _model;
}

/**
 * Embeds an array of text strings into 512-dimensional vectors.
 *
 * @param {string[]} texts - Array of strings to embed (tab titles/content)
 * @param {Function} [onProgress] - Optional progress callback
 * @returns {Promise<number[][]>} Array of 512-dim vectors (one per input string)
 */
export async function embedTexts(texts, onProgress) {
  if (!texts || texts.length === 0) return [];

  if (onProgress) onProgress('Loading language model...');

  const model = await loadModel();

  if (onProgress) onProgress(`Embedding ${texts.length} tabs...`);

  // USE expects an array of strings.
  // model.embed() returns a 2D tensor of shape [texts.length, 512]
  const embeddingTensor = await model.embed(texts);

  // .array() converts the tensor to a regular JS array of arrays.
  // Each inner array is 512 numbers — the embedding vector.
  const embeddings = await embeddingTensor.array();

  // Always dispose tensors you're done with to free GPU memory.
  // Forgetting this causes memory leaks in long-running popups.
  embeddingTensor.dispose();

  return embeddings;
}

/**
 * Computes cosine similarity between two embedding vectors.
 *
 * Cosine similarity = dot(a, b) / (|a| * |b|)
 *
 * WHY COSINE AND NOT EUCLIDEAN DISTANCE?
 *   Euclidean distance measures how far apart two points are.
 *   Cosine similarity measures the ANGLE between them.
 *   For text embeddings, angle is more meaningful than distance:
 *   a short tab title and a long article about the same topic will
 *   have similar directions but different magnitudes. Cosine handles
 *   this correctly; Euclidean would score them as dissimilar.
 *
 * @param {number[]} a - First 512-dim vector
 * @param {number[]} b - Second 512-dim vector
 * @returns {number} Similarity score between -1 and 1 (typically 0.1–0.9 for tabs)
 */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) throw new Error('Vector dimensions must match');

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0; // Guard against zero vectors

  return dot / denom;
}

/**
 * Quick self-test — run this in Node to verify the embedder works.
 * Expected: similarity(texts[0], texts[1]) > similarity(texts[0], texts[2])
 *
 * To run: node --experimental-vm-modules src/ml/embedder.test.js
 */
export async function selfTest() {
  const texts = [
    'React hooks and component lifecycle',
    'useState useEffect JavaScript framework',
    'French cooking recipes pasta carbonara',
  ];

  console.log('Loading USE model...');
  const vecs = await embedTexts(texts);

  const sim01 = cosineSimilarity(vecs[0], vecs[1]);
  const sim02 = cosineSimilarity(vecs[0], vecs[2]);

  console.log(`[0] vs [1] (should be HIGH): ${sim01.toFixed(4)}`);
  console.log(`[0] vs [2] (should be LOW):  ${sim02.toFixed(4)}`);
  console.log(`Test ${sim01 > sim02 ? 'PASSED ✓' : 'FAILED ✗'}`);
}