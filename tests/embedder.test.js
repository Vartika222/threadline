/**
 * tests/embedder.test.js — the bundled language model loads and makes sense.
 * Loads the real model from public/model/ with no network. Run with: node tests/embedder.test.js
 */
import { getEmbedder } from '../eval/embedders.js';
import { cosineSimilarity } from '../src/ml/embedder.js';
import { makeRunner, assert } from './helpers/chromeMock.js';

const { test, done } = makeRunner();

const { embed } = await getEmbedder('minilm');
const [hooks, state, pasta] = await embed([
  'React hooks and component lifecycle',
  'useState useEffect JavaScript framework',
  'French cooking recipes pasta carbonara',
]);

test('gives unit-length 384-dimensional vectors', () => {
  assert(hooks.length === 384, `got ${hooks.length} dimensions`);
  assert(Math.abs(Math.hypot(...hooks) - 1) < 1e-3, 'should be unit length');
});

test('related text scores higher than unrelated text', () => {
  assert(cosineSimilarity(hooks, state) > cosineSimilarity(hooks, pasta), 'React should be closer to React');
});

test('text with no known words still gives a usable vector', async () => {
  const [blank] = await embed(['   ']);
  assert(blank.length === 384 && blank.every(Number.isFinite), 'blank text must not break a sort');
});

await done();
