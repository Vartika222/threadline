/**
 * tests/kselection.test.js — does clusterTabs find the right number of topics?
 *
 * Uses synthetic embeddings: each topic is a direction in space, and each tab
 * is that direction plus a little noise.
 * Run with: node tests/kselection.test.js
 */
import { silhouetteScore, clusterTabs, MAX_CLUSTERS, SAME_TOPIC_SIMILARITY } from '../src/ml/clusterer.js';
import { hashEmbed } from '../eval/embedders.js';
import { mulberry32 } from '../eval/metrics.js';
import { makeRunner, assert } from './helpers/chromeMock.js';

const { test, section, done } = makeRunner();
const DIM = 64;

/** `perTopic` tabs for each of `topics` separate topics, as unit vectors. */
function topicTabs(topics, perTopic, noise = 0.1, seed = 1) {
  const rand = mulberry32(seed);
  const tabs = [];
  for (let t = 0; t < topics; t++) {
    for (let i = 0; i < perTopic; i++) {
      const v = Array.from({ length: DIM }, () => (rand() - 0.5) * noise);
      v[t] += 1;
      const norm = Math.hypot(...v);
      tabs.push(v.map(x => x / norm));
    }
  }
  return tabs;
}
const groupCount = (labels) => new Set(labels).size;

section('choosing the number of groups');

test('3 tabs or fewer: a single group', () => {
  assert(groupCount(clusterTabs(topicTabs(3, 1))) === 1, 'expected 1');
});

test('one topic stays one group', () => {
  assert(groupCount(clusterTabs(topicTabs(1, 8))) === 1, 'expected 1');
});

test('identical tabs stay one group', () => {
  const same = new Array(6).fill(topicTabs(1, 1)[0]);
  assert(groupCount(clusterTabs(same)) === 1, 'expected 1');
});

for (const k of [2, 3, 5]) {
  test(`${k} separate topics give ${k} groups, with the right tabs together`, () => {
    const labels = clusterTabs(topicTabs(k, 4));
    assert(groupCount(labels) === k, `expected ${k}, got ${groupCount(labels)}`);
    for (let t = 0; t < k; t++) {
      assert(new Set(labels.slice(t * 4, t * 4 + 4)).size === 1, `topic ${t} was split`);
    }
  });
}

test('labels run from 0 to k-1, so each has a colour and legend entry', () => {
  const labels = clusterTabs(topicTabs(4, 3));
  const sorted = [...new Set(labels)].sort((a, b) => a - b);
  assert(sorted.join() === '0,1,2,3', `got ${sorted}`);
});

test('never exceeds MAX_CLUSTERS, even with many topics', () => {
  const k = groupCount(clusterTabs(topicTabs(14, 3)));
  assert(k <= MAX_CLUSTERS, `k=${k} exceeds ${MAX_CLUSTERS}`);
});

test('never more groups than half the tabs', () => {
  assert(groupCount(clusterTabs(topicTabs(6, 1))) <= 3, 'six unrelated tabs make at most 3 groups');
});

test('the single-topic rule is a real similarity on the 0-1 scale', () => {
  assert(SAME_TOPIC_SIMILARITY > 0 && SAME_TOPIC_SIMILARITY < 1, 'out of range');
});

test('same tabs always give the same result', () => {
  const tabs = topicTabs(3, 5, 0.3, 9);
  const first = clusterTabs(tabs).join();
  for (let i = 0; i < 10; i++) assert(clusterTabs(tabs).join() === first, 'changed between runs');
});

section('silhouetteScore');

/** Distance matrix for points on a line. */
const onLine = (xs) => xs.map(a => xs.map(b => Math.abs(a - b)));

test('perfectly separated clusters score close to 1', () => {
  const d = onLine([0, 0.1, 0.2, 100, 100.1, 100.2]);
  assert(silhouetteScore(d, [0, 0, 0, 1, 1, 1], 2) > 0.95, 'should be near 1');
});

test('a wrong assignment scores far lower than the right one', () => {
  const d = onLine([0, 0.1, 0.2, 100, 100.1, 100.2]);
  const right = silhouetteScore(d, [0, 0, 0, 1, 1, 1], 2);
  const wrong = silhouetteScore(d, [0, 1, 0, 1, 0, 1], 2);
  assert(wrong < right - 0.5, 'wrong labelling should be much worse');
});

test('singleton clusters contribute 0 and never produce NaN', () => {
  const s = silhouetteScore(onLine([0, 1, 50]), [0, 0, 1], 2);
  assert(Number.isFinite(s), 'score must be finite');
});

section('end to end');

test('twelve tabs on three clear topics give more than 2 clusters', () => {
  const texts = [
    'React useEffect hooks cleanup', 'React useState hooks state', 'React useMemo useCallback hooks', 'React component hooks render',
    'Carbonara pasta recipe eggs', 'Sourdough bread starter recipe', 'Chickpea curry recipe spices', 'Pasta sauce recipe cooking',
    'Kyoto Japan temples travel', 'Tokyo Japan itinerary travel', 'Japan rail pass travel', 'Osaka Japan travel food',
  ];
  const labels = clusterTabs(texts.map(hashEmbed));
  assert(groupCount(labels) >= 3, `expected at least 3 clusters, got ${groupCount(labels)}`);
});

await done();
