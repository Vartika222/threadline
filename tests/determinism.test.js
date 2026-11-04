/**
 * tests/determinism.test.js — the same tabs must always get the same clusters.
 * (Before the fix, k-means used Math.random, so labels could differ per run.)
 * Run with: node tests/determinism.test.js
 */
import { clusterTabs } from '../src/ml/clusterer.js';
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

test('same tabs in any order give the same clusters once put in canonical order', () => {
  const tabs = texts.map((content, i) => ({ tabId: i, content, embedding: embeddings[i] }));
  const clustersByTab = (list) => {
    const ordered = canonicalTabOrder(list);
    const assignments = clusterTabs(ordered.map(t => t.embedding));
    const byTab = {};
    ordered.forEach((t, i) => { byTab[t.tabId] = assignments[i]; });
    return JSON.stringify(byTab);
  };
  const baseline = clustersByTab(tabs);
  const rand = mulberry32(5);
  for (let run = 0; run < 10; run++) {
    assert(clustersByTab(shuffled(tabs, rand)) === baseline, `run ${run} grouped the tabs differently`);
  }
});

await done();
