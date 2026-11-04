/**
 * tests/labeler.test.js
 * Run with: node tests/labeler.test.js
 */

import { labelClusters } from '../src/ml/labeler.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

console.log('\n── labelClusters ─────────────────────────────────────────────');

test('returns one label per distinct cluster index', () => {
  const tabs = [
    { content: 'react hooks tutorial useState useEffect' },
    { content: 'pasta carbonara recipe italian cooking' },
  ];
  const labels = labelClusters(tabs, [0, 1]);
  assert(Object.keys(labels).length === 2, `Expected 2 labels, got ${Object.keys(labels).length}`);
});

test('two topically distinct clusters get different, on-topic labels', () => {
  const tabs = [
    { content: 'react hooks tutorial useState useEffect components' },
    { content: 'react hooks deep dive useState useEffect lifecycle' },
    { content: 'pasta carbonara recipe italian cooking pancetta' },
    { content: 'italian cooking pasta recipe tomato basil' },
  ];
  const labels = labelClusters(tabs, [0, 0, 1, 1]);
  assert(labels[0] !== labels[1], `Labels should differ: "${labels[0]}" vs "${labels[1]}"`);
  assert(/hooks|usestate|useeffect|react/i.test(labels[0]), `Cluster 0 label unrelated to React: "${labels[0]}"`);
  assert(/pasta|cooking|italian|recipe/i.test(labels[1]), `Cluster 1 label unrelated to cooking: "${labels[1]}"`);
});

test('stopwords never appear in a label', () => {
  const tabs = [
    { content: 'the quick and the brief overview of the widget' },
    { content: 'a short guide to the widget and the gadget' },
  ];
  const labels = labelClusters(tabs, [0, 1]);
  const allWords = Object.values(labels).join(' ').toLowerCase();
  for (const stop of ['the', 'and', 'a', 'to', 'of']) {
    assert(!allWords.split(/\s+/).includes(stop), `Stopword "${stop}" leaked into a label`);
  }
});

test('empty/no-content cluster falls back to a generic label, does not throw', () => {
  const tabs = [{ content: '' }, { content: 'react hooks tutorial' }];
  const labels = labelClusters(tabs, [0, 1]);
  assert(typeof labels[0] === 'string' && labels[0].length > 0, 'Expected a non-empty fallback label');
});

test('single cluster still produces a label (no crash on numClusters=1)', () => {
  const tabs = [{ content: 'react hooks tutorial' }, { content: 'react state management' }];
  const labels = labelClusters(tabs, [0, 0]);
  assert(typeof labels[0] === 'string' && labels[0].length > 0);
});

console.log(`\n${'─'.repeat(63)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
