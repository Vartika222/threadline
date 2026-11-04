/**
 * tests/determinism.test.js — the same tabs must always get the same clusters.
 * (Before the fix, k-means used Math.random, so labels could differ per run.)
 * Run with: node tests/determinism.test.js
 */
import { clusterTabs } from '../src/ml/clusterer.js';
import { hashEmbed } from '../eval/embedders.js';
import { makeRunner, assert } from './helpers/chromeMock.js';

const { test, done } = makeRunner();

const texts = [
  'React hooks useEffect tutorial', 'useState vs useReducer React', 'Next.js server components React',
  'Authentic carbonara pasta recipe', 'Sourdough bread starter guide', 'Chickpea curry weeknight recipe',
  'Tokyo Kyoto itinerary Japan travel', 'Japan rail pass cost', 'Kyoto temples shrines guide',
  'Couch to 5K running plan', 'Marathon long run pacing', 'Best running shoes beginners',
];
const embeddings = texts.map(hashEmbed);

test('clusterTabs gives identical assignments on 25 repeated runs', () => {
  const first = clusterTabs(embeddings).join();
  for (let i = 0; i < 25; i++) {
    assert(clusterTabs(embeddings).join() === first, `run ${i} differed from the first run`);
  }
});

test('clusterTabs output is one non-negative integer per tab', () => {
  const out = clusterTabs(embeddings);
  assert(out.length === texts.length, 'one label per tab');
  assert(out.every(c => Number.isInteger(c) && c >= 0), 'labels are non-negative integers');
});

await done();
