/**
 * THREADLINE — student.js
 *
 * A small classifier trained on this computer, which learns to give Gemini
 * Nano's answers in a few milliseconds. Gemini Nano is the "teacher": it takes
 * about 3.5 seconds a tab. This "student" learns from its answers (this is
 * called distillation) and from your corrections. Once it agrees with Gemini
 * Nano on tabs it never trained on, it answers by itself whenever it's sure,
 * and Gemini Nano is only asked about the rest.
 *
 * ─── THE MODEL ───────────────────────────────────────────────────────────
 *
 * Softmax regression (multinomial logistic regression) on the 384-number
 * MiniLM embedding of the tab. It learns one weight per number, per label:
 * about 12,700 weights in all. That's small on purpose. This project found
 * that a 72,665-weight network overfit a few dozen examples (see
 * personalise.js), so the student:
 *
 *   - is linear, with L2 regularisation pulling its weights towards zero
 *   - also trains on every category description, so it starts out close to
 *     the description-matching model it replaces
 *   - is only trusted after it's tested on examples held back from training
 *
 * Training starts from zero weights with no random steps, so the same
 * examples always give the same model.
 *
 * ─── EXAMPLES ────────────────────────────────────────────────────────────
 *
 * { key, vector, label: "Category › Subcategory", source, at }
 * source is who gave the answer: 'nano', 'correction' or 'rules' (the site
 * list). Answers the student or the description model gave are never used,
 * since it would only learn its own mistakes back.
 */
import { CATEGORIES } from './categories.js';

/** Every label the student can give. */
export const STUDENT_LABELS = CATEGORIES.flatMap(c => Object.keys(c.subcategories)
  .filter(sub => sub !== 'Unsure')
  .map(sub => `${c.name} › ${sub}`));

/** How much each kind of example counts. Your own corrections count most. */
export const SOURCE_WEIGHTS = { correction: 3, nano: 1, rules: 0.5, description: 1 };

/** Stored examples are capped; the oldest go first. */
export const MAX_EXAMPLES = 400;

/** Retrain after this many new examples. */
export const RETRAIN_EVERY = 3;

/** The student answers a tab only when its top label has at least this probability. */
export const CONFIDENCE = 0.6;

/** Before it's trusted, on held-back Gemini Nano examples it was sure about: */
export const TRUST_MIN_TESTED = 6;    // at least this many
export const TRUST_MIN_ACCURACY = 0.85; // at least this share right

// 40 rounds scored the same as 80 and 120 in eval/student.js, in a third of the time.
const EPOCHS = 40;
const LEARNING_RATE = 2;
const MOMENTUM = 0.9;
const L2 = 0.0005;

/** Rounds a vector so examples take less storage. */
export function compactVector(vector) {
  return Array.from(vector, x => Math.round(x * 1000) / 1000);
}

const roundWeights = (w) => Array.from(w, x => Math.round(x * 10000) / 10000);

/** The key an example is stored under: the page, without its #fragment. */
export function exampleKey(url) {
  return String(url || '').split('#')[0];
}

/**
 * Adds new examples to the stored ones. A page seen again replaces its old
 * example, and only the newest MAX_EXAMPLES are kept.
 */
export function mergeExamples(stored, incoming, max = MAX_EXAMPLES) {
  const byKey = new Map(stored.map(e => [e.key, e]));
  for (const example of incoming) {
    // These arrive by message from the classifier page; 'description' examples are never stored.
    if (!example?.key || !Array.isArray(example.vector) || !STUDENT_LABELS.includes(example.label)
      || !(example.source in SOURCE_WEIGHTS) || example.source === 'description') continue;
    // A correction isn't overwritten by a guess about the same page.
    const old = byKey.get(example.key);
    if (old && old.source === 'correction' && example.source !== 'correction') continue;
    byKey.delete(example.key);
    byKey.set(example.key, example);
  }
  return [...byKey.values()].sort((a, b) => (a.at || 0) - (b.at || 0)).slice(-max);
}

/** Deterministically holds back about 1 in 5 pages for testing. */
export function isHeldOut(key) {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 5 === 0;
}

function softmaxInPlace(logits) {
  let max = -Infinity;
  for (const x of logits) if (x > max) max = x;
  let sum = 0;
  for (let k = 0; k < logits.length; k++) { logits[k] = Math.exp(logits[k] - max); sum += logits[k]; }
  for (let k = 0; k < logits.length; k++) logits[k] /= sum;
  return logits;
}

/**
 * Trains the student. Each example is { vector, label, source }.
 * Returns { labels, weights (one array per label), bias }.
 *
 * Full-batch gradient descent with momentum on the weighted cross-entropy,
 * plus L2. The weights live in one flat array, which keeps it fast.
 */
export function trainStudent(examples) {
  const labels = STUDENT_LABELS;
  const labelIndex = new Map(labels.map((l, i) => [l, i]));
  const data = examples.filter(e => labelIndex.has(e.label) && e.vector?.length);
  const K = labels.length;
  const D = data[0]?.vector.length || 0;
  const N = data.length;
  const W = new Float64Array(K * D);
  const bias = new Float64Array(K);
  const unpack = () => ({ labels, weights: labels.map((_, k) => W.subarray(k * D, (k + 1) * D)), bias });
  if (!N) return unpack();

  const X = new Float64Array(N * D);
  data.forEach((e, n) => X.set(e.vector, n * D));
  const ys = Int32Array.from(data, e => labelIndex.get(e.label));
  const ws = Float64Array.from(data, e => SOURCE_WEIGHTS[e.source] ?? 1);
  const totalWeight = ws.reduce((a, b) => a + b, 0);

  const gradW = new Float64Array(K * D);
  const gradB = new Float64Array(K);
  const velW = new Float64Array(K * D);
  const velB = new Float64Array(K);
  const p = new Float64Array(K);

  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    gradW.fill(0);
    gradB.fill(0);
    for (let n = 0; n < N; n++) {
      const xo = n * D;
      for (let k = 0; k < K; k++) {
        const wo = k * D;
        let z = bias[k];
        for (let d = 0; d < D; d++) z += W[wo + d] * X[xo + d];
        p[k] = z;
      }
      softmaxInPlace(p);
      const scale = ws[n] / totalWeight;
      for (let k = 0; k < K; k++) {
        const g = (p[k] - (k === ys[n] ? 1 : 0)) * scale;
        if (Math.abs(g) < 1e-7) continue; // too small to matter
        gradB[k] += g;
        const wo = k * D;
        for (let d = 0; d < D; d++) gradW[wo + d] += g * X[xo + d];
      }
    }
    for (let i = 0; i < W.length; i++) {
      velW[i] = MOMENTUM * velW[i] - LEARNING_RATE * (gradW[i] + L2 * W[i]);
      W[i] += velW[i];
    }
    for (let k = 0; k < K; k++) {
      velB[k] = MOMENTUM * velB[k] - LEARNING_RATE * gradB[k];
      bias[k] += velB[k];
    }
  }
  return unpack();
}

/** The student's answer for one embedding: { category, subcategory, confidence }. */
export function predictStudent(model, vector) {
  if (!model?.weights?.length || !vector?.length) return null;
  const logits = new Float64Array(model.labels.length);
  for (let k = 0; k < logits.length; k++) {
    const w = model.weights[k];
    let z = model.bias[k];
    for (let d = 0; d < vector.length; d++) z += w[d] * vector[d];
    logits[k] = z;
  }
  softmaxInPlace(logits);
  let best = 0;
  for (let k = 1; k < logits.length; k++) if (logits[k] > logits[best]) best = k;
  const [category, subcategory] = model.labels[best].split(' › ');
  return { category, subcategory, confidence: logits[best] };
}

/** What classifyTabs takes as `student`: the stored model, but only once it has passed its test. */
export function trustedStudent(model) {
  return model?.trusted ? { confidence: CONFIDENCE, predict: (vector) => predictStudent(model, vector) } : null;
}

/**
 * Trains on everything except the held-back pages, then tests on the held-back
 * Gemini Nano examples, which are the kind of tab the student actually gets
 * (the site list and corrections settle the others first).
 */
export function evaluateStudent(examples, seeds = []) {
  const train = examples.filter(e => !isHeldOut(e.key));
  const test = examples.filter(e => isHeldOut(e.key) && e.source === 'nano');
  const model = trainStudent([...seeds, ...train]);
  let right = 0, sure = 0, sureRight = 0;
  for (const e of test) {
    const answer = predictStudent(model, e.vector);
    const correct = `${answer.category} › ${answer.subcategory}` === e.label;
    if (correct) right++;
    if (answer.confidence >= CONFIDENCE) {
      sure++;
      if (correct) sureRight++;
    }
  }
  return {
    tested: test.length,
    accuracy: test.length ? right / test.length : null,
    sure,
    sureAccuracy: sure ? sureRight / sure : null,
  };
}

/** Whether the test results are good enough to let the student answer by itself. */
export function isTrusted(evaluation) {
  return Boolean(evaluation)
    && evaluation.sure >= TRUST_MIN_TESTED
    && evaluation.sureAccuracy >= TRUST_MIN_ACCURACY;
}

/** How many examples came from each source. */
export function countSources(examples) {
  const counts = { nano: 0, correction: 0, rules: 0 };
  for (const e of examples) counts[e.source] = (counts[e.source] || 0) + 1;
  return counts;
}

/**
 * Trains the model the extension uses: test first, then train on everything.
 * The result can be stored as JSON.
 */
export function buildStudent(examples, seeds = []) {
  const started = Date.now();
  const evaluation = evaluateStudent(examples, seeds);
  const model = trainStudent([...seeds, ...examples]);
  return {
    labels: model.labels,
    weights: model.weights.map(roundWeights),
    bias: roundWeights(model.bias),
    evaluation,
    trusted: isTrusted(evaluation),
    counts: countSources(examples),
    trainedAt: Date.now(),
    trainingMs: Date.now() - started,
  };
}
