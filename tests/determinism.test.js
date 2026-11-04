/**
 * tests/determinism.test.js — the same tabs must always give the same result.
 * Run with: node tests/determinism.test.js
 */
import { cosineSimilarity } from '../src/ml/embedder.js';
import { buildSimilarityMatrix, buildChainOrder } from '../src/ml/graph.js';
import { hashEmbed } from '../eval/embedders.js';
import { mulberry32, shuffled } from '../eval/metrics.js';
import { canonicalTabOrder } from '../src/ml/pipeline.js';
import { makeRunner, assert } from './helpers/chromeMock.js';

const { test, done } = makeRunner();

const texts = [
  'React hooks useEffect tutorial', 'useState vs useReducer React', 'Next.js server components React',
  'Authentic carbonara pasta recipe', 'Sourdough bread starter guide', 'Chickpea curry weeknight recipe',
  'Tokyo Kyoto itinerary Japan travel', 'Japan rail pass cost', 'Kyoto temples shrines guide',
  'Couch to 5K running plan', 'Marathon long run pacing', 'Best running shoes beginners',
];
const embeddings = texts.map(hashEmbed);

const chainOf = (vectors) => buildChainOrder(buildSimilarityMatrix(vectors, cosineSimilarity));

test('the chain is identical on 25 repeated runs', () => {
  const first = chainOf(embeddings).join();
  for (let i = 0; i < 25; i++) {
    assert(chainOf(embeddings).join() === first, `run ${i} differed from the first run`);
  }
});

test('canonicalTabOrder gives one order whatever order the tabs arrive in', () => {
  const tabs = texts.map((content, i) => ({ tabId: i, content, url: `https://a.com/${i}` }));
  const baseline = canonicalTabOrder(tabs).map(t => t.tabId).join();
  const rand = mulberry32(3);
  for (let run = 0; run < 25; run++) {
    const got = canonicalTabOrder(shuffled(tabs, rand)).map(t => t.tabId).join();
    assert(got === baseline, `run ${run} gave a different order`);
  }
});

test('canonicalTabOrder falls back to the URL when text matches, and leaves its input alone', () => {
  const a = { content: 'same', url: 'https://a.com' };
  const b = { content: 'same', url: 'https://b.com' };
  const input = [b, a];
  assert(canonicalTabOrder(input)[0] === a, 'URL breaks the tie');
  assert(input[0] === b, 'input array is not reordered');
});

test('same tabs in any order give the same chain once put in canonical order', () => {
  const tabs = texts.map((content, i) => ({ tabId: i, content, embedding: embeddings[i] }));
  const chainByTab = (list) => {
    const ordered = canonicalTabOrder(list);
    return chainOf(ordered.map(t => t.embedding)).map(i => ordered[i].tabId).join();
  };
  const baseline = chainByTab(tabs);
  const rand = mulberry32(5);
  for (let run = 0; run < 10; run++) {
    assert(chainByTab(shuffled(tabs, rand)) === baseline, `run ${run} gave a different chain`);
  }
});

await done();
