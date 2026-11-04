/**
 * eval/embedders.js — pluggable embedders for the evaluation harness.
 *
 *   hash : offline, deterministic bag-of-words hashing into 512 dims. A
 *          lexical baseline. Good for checking the harness works anywhere
 *          (no network, no model download). It is NOT the real model, so
 *          its numbers say nothing about Threadline's true quality.
 *   use  : the real Universal Sentence Encoder, exactly as the extension
 *          uses it (src/ml/embedder.js). Needs network access to download
 *          the model weights on first run.
 */

const DIM = 512;

const STOPWORDS = new Set((
  'a an the and or of to in on for with without how what when why is are be it its this that ' +
  'your you at by from as vs more most do does not'
).split(' '));

// FNV-1a 32-bit hash
function fnv1a(str, seed = 2166136261) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t && !STOPWORDS.has(t))
    // crude stemming so "running"/"run", "tabs"/"tab" share a bucket
    .map(t => t.replace(/(ing|ed|es|s)$/, ''));
}

export function hashEmbed(text) {
  const vec = new Array(DIM).fill(0);
  for (const tok of tokenize(text)) {
    // each token lights up 3 hashed dimensions with a hashed sign
    for (let k = 0; k < 3; k++) {
      const h = fnv1a(tok, 2166136261 + k * 7919);
      vec[h % DIM] += (h & 0x80000000) === 0 ? 1 : -1;
    }
  }
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map(x => x / norm);
}

export async function getEmbedder(name) {
  if (name === 'hash') {
    return { name, embed: async (texts) => texts.map(hashEmbed) };
  }
  if (name === 'use') {
    const { embedTexts } = await import('../src/ml/embedder.js');
    return { name, embed: (texts) => embedTexts(texts) };
  }
  throw new Error(`Unknown embedder "${name}" — use "hash" or "use"`);
}
