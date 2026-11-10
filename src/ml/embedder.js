/**
 * THREADLINE — embedder.js
 *
 * Runs all-MiniLM-L6-v2, a pretrained sentence-embedding neural network (a small
 * BERT-style transformer), and converts text into 384-dimensional vectors.
 *
 * WHY THIS MODEL?
 *   - It replaced Universal Sentence Encoder because it tells close topics apart
 *     far better. See the README's Evaluation section.
 *   - The 23MB quantised version ships inside the extension (public/model/), so
 *     it works offline and no tab text leaves the device.
 *   - It runs through Transformers.js and ONNX Runtime on WebAssembly.
 *
 * HOW EMBEDDINGS WORK:
 *   Think of each vector as a point in 384-dimensional space. "React hooks
 *   tutorial" and "useState useEffect guide" land near each other, and "French
 *   cooking recipes" lands far from both. We exploit this geometry to measure
 *   how related two tabs are.
 *
 * USAGE:
 *   import { embedTexts, cosineSimilarity } from './embedder.js';
 *   const vecs = await embedTexts(['React hooks', 'Vue composition API']);
 *   const sim  = cosineSimilarity(vecs[0], vecs[1]);
 */

const MODEL_NAME = 'all-MiniLM-L6-v2';

// Loaded once per popup session.
let _extractor = null;

// Where the model folder lives. Inside the extension that's its own files, so
// nothing is downloaded. Scripts running in Node supply a folder path instead.
let _modelRoot = null;

/** @param {string} path - folder holding the all-MiniLM-L6-v2 folder, ending in "/" */
export function setModelRoot(path) {
  _modelRoot = path;
}

async function loadModel() {
  if (_extractor) return _extractor;

  // Dynamic import — it's large, so we load it lazily
  const { pipeline, env } = await import('@huggingface/transformers');

  const extensionUrl = globalThis.chrome?.runtime?.getURL;
  env.allowRemoteModels = false; // never fetch a model from the internet
  env.allowLocalModels = true;
  env.useBrowserCache = false;
  env.useFSCache = false;
  env.localModelPath = _modelRoot ?? extensionUrl('model/');

  const options = { dtype: 'q8' };
  if (!_modelRoot) {
    // Use the WebAssembly files we ship, not the default CDN copy. One thread,
    // because multi-threaded WebAssembly isn't available to extension popups.
    env.backends.onnx.wasm.wasmPaths = extensionUrl('ort/');
    env.backends.onnx.wasm.numThreads = 1;
    options.device = 'wasm';
  }

  try {
    _extractor = await pipeline('feature-extraction', MODEL_NAME, options);
  } catch (err) {
    console.error('[Threadline] Could not load the model:', err);
    throw new Error(
      'Could not load the language model that ships with Threadline. ' +
      'Try reinstalling the extension.'
    );
  }
  return _extractor;
}

/**
 * Embeds an array of text strings into unit-length vectors.
 *
 * @param {string[]} texts - Array of strings to embed (tab titles/content)
 * @param {Function} [onProgress] - Optional progress callback
 * @returns {Promise<number[][]>} One vector per input string
 */
export async function embedTexts(texts, onProgress) {
  if (!texts || texts.length === 0) return [];

  if (onProgress) onProgress('Loading language model...');
  const extractor = await loadModel();

  if (onProgress) onProgress(`Embedding ${texts.length} tabs...`);
  // One text at a time. In a batch, shorter texts are padded to the longest,
  // and with the quantised model that shifts their vectors slightly, so a tab
  // could land in a different category depending on which tabs were sorted
  // with it. Alone, the same text always gives the same vector.
  const embeddings = [];
  for (const text of texts) {
    const output = await extractor([text], { pooling: 'mean', normalize: true });
    embeddings.push(output.tolist()[0]);
    output.dispose?.();
  }
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
 * @param {number[]} a - First vector
 * @param {number[]} b - Second vector
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
