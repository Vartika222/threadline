/**
 * tests/kselection.test.js — choosing the number of clusters.
 *
 * The previous elbow heuristic returned exactly 2 clusters for up to 15 tabs
 * and never more than 5 for any input. These tests pin the silhouette-based
 * replacement: k follows the structure of the data.
 * Run with: node tests/kselection.test.js
 */
import { estimateK, silhouetteScore, clusterTabs, MAX_CLUSTERS } from '../src/ml/clusterer.js';
import { hashEmbed } from '../eval/embedders.js';
import { mulberry32 } from '../eval/metrics.js';
import { makeRunner, assert } from './helpers/chromeMock.js';

const { test, section, done } = makeRunner();

/** `perBlob` points scattered tightly around each centre. */
function blobs(centres, perBlob, spread, seed = 1) {
  const rand = mulberry32(seed);
  const pts = [];
  for (const [cx, cy] of centres) {
    for (let i = 0; i < perBlob; i++) {
      pts.push([cx + (rand() - 0.5) * spread, cy + (rand() - 0.5) * spread]);
    }
  }
  return pts;
}

section('estimateK');

test('3 tabs or fewer: a single cluster', () => {
  assert(estimateK([[0, 0], [5, 5], [9, 1]], mulberry32(1)) === 1, 'k should be 1');
});

test('two well-separated blobs -> k = 2', () => {
  const pts = blobs([[0, 0], [20, 20]], 6, 1);
  assert(estimateK(pts, mulberry32(2)) === 2, 'expected 2');
});

test('three well-separated blobs -> k = 3 (the old heuristic could not do this for 15 or fewer tabs)', () => {
  const pts = blobs([[0, 0], [20, 0], [10, 18]], 5, 1); // 15 points
  assert(estimateK(pts, mulberry32(3)) === 3, 'expected 3');
});

test('five well-separated blobs -> k = 5', () => {
  const pts = blobs([[0, 0], [30, 0], [0, 30], [30, 30], [15, 15]], 5, 1);
  assert(estimateK(pts, mulberry32(4)) === 5, 'expected 5');
});

test('four or more tabs are always split into at least 2 groups', () => {
  const pts = blobs([[5, 5]], 12, 2);
  assert(estimateK(pts, mulberry32(5)) >= 2, 'k should be at least 2');
  assert(estimateK(blobs([[0, 0]], 4, 1), mulberry32(5)) === 2, 'four points -> exactly 2 (maxK is n/2)');
});

test('never exceeds MAX_CLUSTERS, even with many distinct blobs', () => {
  const centres = Array.from({ length: 14 }, (_, i) => [(i % 5) * 40, Math.floor(i / 5) * 40]);
  const k = estimateK(blobs(centres, 3, 1), mulberry32(6));
  assert(k <= MAX_CLUSTERS, `k=${k} exceeds ${MAX_CLUSTERS}`);
});

test('same points and seed always give the same k', () => {
  const pts = blobs([[0, 0], [20, 0], [10, 18]], 5, 1.5, 9);
  const first = estimateK(pts, mulberry32(7));
  for (let i = 0; i < 10; i++) assert(estimateK(pts, mulberry32(7)) === first, 'k changed between runs');
});

section('silhouetteScore');

test('perfectly separated clusters score close to 1', () => {
  const pts = blobs([[0, 0], [100, 100]], 5, 0.5);
  const labels = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1];
  assert(silhouetteScore(pts, labels, 2) > 0.95, 'should be near 1');
});

test('a wrong assignment scores far lower than the right one', () => {
  const pts = blobs([[0, 0], [100, 100]], 5, 0.5);
  const right = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1];
  const wrong = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1];
  assert(silhouetteScore(pts, wrong, 2) < silhouetteScore(pts, right, 2) - 0.5, 'wrong labelling should be much worse');
});

test('singleton clusters contribute 0 and never produce NaN', () => {
  const s = silhouetteScore([[0, 0], [1, 0], [50, 50]], [0, 0, 1], 2);
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
  assert(new Set(labels).size >= 3, `expected at least 3 clusters, got ${new Set(labels).size}`);
});

await done();
