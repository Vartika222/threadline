/**
 * tests/recency.test.js
 * Run with: node tests/recency.test.js
 */

import { computeRecencyNorm, formatIdleDuration, RECENCY_CAP_MS } from '../src/ml/recency.js';

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

const NOW = 1_000_000_000_000;

console.log('\n── computeRecencyNorm ────────────────────────────────────────');

test('active right now returns 1', () => {
  assert(computeRecencyNorm(NOW, NOW) === 1);
});

test('active at exactly the cap returns 0', () => {
  const v = computeRecencyNorm(NOW - RECENCY_CAP_MS, NOW);
  assert(Math.abs(v) < 1e-9, `Expected ~0, got ${v}`);
});

test('active well past the cap clamps to 0, does not go negative', () => {
  const v = computeRecencyNorm(NOW - RECENCY_CAP_MS * 5, NOW);
  assert(v === 0, `Expected 0, got ${v}`);
});

test('halfway through the cap returns ~0.5', () => {
  const v = computeRecencyNorm(NOW - RECENCY_CAP_MS / 2, NOW);
  assert(Math.abs(v - 0.5) < 0.01, `Expected ~0.5, got ${v}`);
});

test('missing lastActive is treated as fully stale', () => {
  assert(computeRecencyNorm(undefined, NOW) === 0);
  assert(computeRecencyNorm(null, NOW) === 0);
  assert(computeRecencyNorm(0, NOW) === 0);
});

console.log('\n── formatIdleDuration ────────────────────────────────────────');

test('just-touched tab formats as "just now"', () => {
  assert(formatIdleDuration(NOW, NOW) === 'just now');
});

test('5 minutes idle formats in minutes', () => {
  assert(formatIdleDuration(NOW - 5 * 60 * 1000, NOW) === 'idle 5m');
});

test('2 hours idle formats in hours', () => {
  assert(formatIdleDuration(NOW - 2 * 60 * 60 * 1000, NOW) === 'idle 2h');
});

console.log(`\n${'─'.repeat(63)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
