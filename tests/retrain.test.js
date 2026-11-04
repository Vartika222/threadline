/**
 * tests/retrain.test.js — when does the personalisation model train?
 *
 * Regression: App.jsx used to train only when the example count was EXACTLY
 * 15, 20, 25... A single drag adds 2-4 examples, so the count often jumped
 * past a checkpoint (13 -> 16) and training was skipped until it happened to
 * land on the next one.
 * Run with: node tests/retrain.test.js
 */
import { shouldRetrain, NN_ACTIVATION_THRESHOLD, RETRAIN_EVERY } from '../src/ml/nn.js';
import { makeRunner, assert } from './helpers/chromeMock.js';

const { test, section, done } = makeRunner();

section('shouldRetrain');

test('defaults: activate at 15 examples, retrain every 5 new ones', () => {
  assert(NN_ACTIVATION_THRESHOLD === 15, 'threshold');
  assert(RETRAIN_EVERY === 5, 'cadence');
});

test('below the threshold never trains', () => {
  for (const total of [0, 1, 8, 14]) assert(shouldRetrain(total, 0) === false, `total ${total}`);
});

test('first training happens at the threshold', () => {
  assert(shouldRetrain(15, 0) === true, '15 with no model yet');
  assert(shouldRetrain(15, undefined) === true, 'undefined trained count means never trained');
});

test('jumping past the threshold still triggers the first training (13 -> 16)', () => {
  assert(shouldRetrain(16, 0) === true, 'old equality check returned false here');
  assert(shouldRetrain(19, 0) === true, 'and here');
  assert(shouldRetrain(31, 0) === true, 'and a long way past');
});

test('after training, waits for 5 new examples', () => {
  assert(shouldRetrain(16, 15) === false, '1 new example');
  assert(shouldRetrain(19, 15) === false, '4 new examples');
  assert(shouldRetrain(20, 15) === true, '5 new examples');
});

test('a jump of several examples past the next checkpoint still triggers (e.g. 17 -> 22)', () => {
  assert(shouldRetrain(22, 17) === true, '5 new examples, not on a multiple of 5');
  assert(shouldRetrain(21, 17) === false, 'only 4 new');
});

test('simulated session: trains once per 5 new examples, whatever the step sizes', () => {
  let total = 0, trainedCount = 0, trainings = 0;
  const steps = [2, 3, 4, 2, 2, 3, 4, 2, 3, 3, 2, 4, 4, 3, 2, 2];
  for (const step of steps) {
    total += step;
    if (shouldRetrain(total, trainedCount)) { trainedCount = total; trainings++; }
  }
  assert(trainings >= 3, `expected several trainings over ${total} examples, got ${trainings}`);
  assert(total - trainedCount < RETRAIN_EVERY, 'never more than 4 untrained examples left over');
});

await done();
