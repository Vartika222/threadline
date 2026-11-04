/**
 * tests/feedback.test.js
 *
 * Tests for deriving contrastive training pairs from drag reorders.
 * Pure function, no TF.js or chrome.* APIs needed.
 *
 * Run with: node tests/feedback.test.js
 */

import { deriveTrainingPairs } from '../src/ml/feedback.js';

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

function tabs(...ids) {
  return ids.map(tabId => ({ tabId }));
}

function findPair(pairs, a, b) {
  return pairs.find(p =>
    (p.aId === a && p.bId === b) || (p.aId === b && p.bId === a)
  );
}

console.log('\n── deriveTrainingPairs ──────────────────────────────────────');

test('no-op reorder produces zero pairs', () => {
  const before = tabs(1, 2, 3, 4);
  const after = tabs(1, 2, 3, 4);
  const pairs = deriveTrainingPairs(before, after);
  assert(pairs.length === 0, `Expected 0 pairs, got ${pairs.length}`);
});

test('moving a tab next to a new neighbour creates one positive pair', () => {
  // 4 moved to sit next to 1 → (1,4) becomes adjacent and wasn't before
  const before = tabs(1, 2, 3, 4);
  const after = tabs(1, 4, 2, 3);
  const pairs = deriveTrainingPairs(before, after);
  const positive = findPair(pairs, 1, 4);
  assert(positive && positive.label === 1, 'Expected positive pair (1,4)');
});

test('breaking an old adjacency creates one negative pair', () => {
  const before = tabs(1, 2, 3, 4);
  const after = tabs(1, 4, 2, 3);
  const pairs = deriveTrainingPairs(before, after);
  // (2,3) was adjacent before, still adjacent after → no signal
  // (1,2) was adjacent before, broken after → negative
  const negative = findPair(pairs, 1, 2);
  assert(negative && negative.label === 0, 'Expected negative pair (1,2)');
});

test('untouched adjacent pairs produce no signal either way', () => {
  const before = tabs(1, 2, 3, 4);
  const after = tabs(1, 4, 2, 3);
  const pairs = deriveTrainingPairs(before, after);
  const untouched = findPair(pairs, 2, 3); // adjacent in both
  assert(!untouched, '(2,3) should not appear — no action was taken on it');
});

test('pair order (aId, bId) does not matter for de-duplication', () => {
  const before = tabs(1, 2, 3);
  const after = tabs(3, 2, 1); // fully reversed but same adjacencies
  const pairs = deriveTrainingPairs(before, after);
  assert(pairs.length === 0, `Reversal keeps all adjacencies — expected 0, got ${pairs.length}`);
});

test('moving the last tab to the front generates expected pairs', () => {
  const before = tabs(1, 2, 3, 4, 5);
  const after = tabs(5, 1, 2, 3, 4);
  const pairs = deriveTrainingPairs(before, after);
  // New adjacency: (5,1). Broken adjacency: (4,5).
  assert(findPair(pairs, 5, 1)?.label === 1, 'Expected positive pair (5,1)');
  assert(findPair(pairs, 4, 5)?.label === 0, 'Expected negative pair (4,5)');
  assert(pairs.length === 2, `Expected exactly 2 pairs, got ${pairs.length}`);
});

test('single-tab chains produce no pairs', () => {
  const pairs = deriveTrainingPairs(tabs(1), tabs(1));
  assert(pairs.length === 0, 'Single tab has no adjacencies to compare');
});

console.log(`\n${'─'.repeat(63)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
