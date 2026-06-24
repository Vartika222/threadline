/**
 * tests/nn.test.js
 *
 * Tests for the neural network module.
 * The behaviour vector tests run without TF.js.
 * The model build/train tests require TF.js (skip in CI if needed).
 *
 * Run with: node tests/nn.test.js
 */

import { tabToBehaviourVector } from '../src/ml/nn.js';

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

function assertClose(a, b, tol = 0.01) {
  if (Math.abs(a - b) > tol) throw new Error(`${a} ≠ ${b} (tolerance ${tol})`);
}

function assertInRange(val, min, max, label) {
  assert(val >= min && val <= max, `${label}: ${val} not in [${min}, ${max}]`);
}

console.log('\n── tabToBehaviourVector ─────────────────────────────────────');

test('returns 5-element array', () => {
  const vec = tabToBehaviourVector({ dwellMs: 1000, revisitCount: 2, hourOfDay: 14 });
  assert(vec.length === 5, `Expected 5 elements, got ${vec.length}`);
});

test('all values are in [0, 1] or [-1, 1] for cyclical', () => {
  const vec = tabToBehaviourVector({ dwellMs: 5000, revisitCount: 5, hourOfDay: 9 });
  assertInRange(vec[0], 0, 1, 'dwell_norm');
  assertInRange(vec[1], 0, 1, 'revisit_norm');
  assertInRange(vec[2], -1, 1, 'hour_sin');
  assertInRange(vec[3], -1, 1, 'hour_cos');
  assertInRange(vec[4], 0, 1, 'transition_norm');
});

test('zero-dwell tab produces zero dwell_norm', () => {
  const vec = tabToBehaviourVector({ dwellMs: 0 });
  assertClose(vec[0], 0);
});

test('dwell is capped at 1.0 for very long dwell', () => {
  const vec = tabToBehaviourVector({ dwellMs: 999999999 });
  assertClose(vec[0], 1.0);
});

test('revisit count is capped at 1.0', () => {
  const vec = tabToBehaviourVector({ revisitCount: 9999 });
  assertClose(vec[1], 1.0);
});

test('midnight (hour=0) and near-midnight (hour=23) are close', () => {
  const midnight    = tabToBehaviourVector({ hourOfDay: 0 });
  const nearMidnight= tabToBehaviourVector({ hourOfDay: 23 });
  // hour=0 → angle=0, hour=23 → angle=23*2π/24 ≈ 5.76 rad
  // sin(0)=0, sin(23*2π/24)≈-0.26 → diff ≈ 0.26 (close)
  // cos(0)=1, cos(23*2π/24)≈0.97  → diff ≈ 0.03 (very close)
  const sinDiff = Math.abs(midnight[2] - nearMidnight[2]);
  const cosDiff = Math.abs(midnight[3] - nearMidnight[3]);
  assert(sinDiff < 0.5, `sin values too far apart (${sinDiff.toFixed(3)}) — cyclical encoding broken`);
  assert(cosDiff < 0.1, `cos values too far apart (${cosDiff.toFixed(3)}) — cyclical encoding broken`);
});

test('noon and midnight have different hour encodings', () => {
  const noon     = tabToBehaviourVector({ hourOfDay: 12 });
  const midnight = tabToBehaviourVector({ hourOfDay: 0 });
  // noon: sin(π)≈0, cos(π)=-1; midnight: sin(0)=0, cos(0)=1
  // cos values differ by 2.0
  const cosDiff = Math.abs(noon[3] - midnight[3]);
  assert(cosDiff > 1.5, `Noon and midnight cos values too similar (diff=${cosDiff.toFixed(3)})`);
});

test('handles missing fields gracefully', () => {
  // Should not throw, should return sensible defaults
  const vec = tabToBehaviourVector({});
  assert(vec.length === 5);
  assert(vec.every(v => isFinite(v)), 'All values should be finite');
});

console.log('\n─────────────────────────────────────────────────────────────');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);