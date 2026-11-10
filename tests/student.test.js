/**
 * tests/student.test.js — the small classifier that learns from Gemini Nano
 * (src/ml/student.js), how classifyTabs uses it, and how background.js stores
 * its examples and asks for training.
 * Run with: node tests/student.test.js
 */
import { makeRunner, assert, installChromeMock } from './helpers/chromeMock.js';

const { test, section, done } = makeRunner();
const student = await import('../src/ml/student.js');
const { classifyTabs } = await import('../src/ml/categories.js');

// Made-up embeddings: one random direction per label, plus noise, unit length.
function random(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = random(7);
const unit = (v) => { const n = Math.hypot(...v); return v.map(x => x / n); };
const centres = student.STUDENT_LABELS.map(() => unit(Array.from({ length: 384 }, () => rand() - 0.5)));
const near = (labelIndex, noise = 0.6) => unit(centres[labelIndex].map(x => x + (rand() - 0.5) * noise / 4));
const example = (n, labelIndex, source = 'nano') => ({
  key: `https://site${n}.test/`, vector: near(labelIndex), label: student.STUDENT_LABELS[labelIndex], source, at: n,
});
const examples = (count, labels = 8) => Array.from({ length: count }, (_, n) => example(n, n % labels));

section('the student model');

test('learns labels it was shown and is right on pages it never saw', () => {
  const model = student.trainStudent(examples(80));
  let right = 0;
  for (let n = 0; n < 40; n++) {
    const answer = student.predictStudent(model, near(n % 8));
    if (`${answer.category} › ${answer.subcategory}` === student.STUDENT_LABELS[n % 8]) right++;
  }
  assert(right >= 38, `${right}/40 right`);
});

test('the same examples always give the same model', () => {
  const data = examples(30);
  const a = student.trainStudent(data), b = student.trainStudent(data);
  assert(a.weights.every((w, k) => w.every((x, d) => x === b.weights[k][d])), 'weights differ');
});

test('trains on a full set of examples in well under a few seconds', () => {
  const started = Date.now();
  const built = student.buildStudent(examples(student.MAX_EXAMPLES, 30), examples(120, 30).map(e => ({ ...e, key: `d${e.key}`, source: 'description' })));
  const ms = Date.now() - started;
  console.log(`    (trained and tested on ${student.MAX_EXAMPLES} examples in ${ms} ms)`);
  assert(ms < 8000, `${ms} ms`);
  assert(built.weights.length === student.STUDENT_LABELS.length && built.weights[0].length === 384, 'shape');
  assert(JSON.stringify(built).length < 400000, `stored size ${JSON.stringify(built).length}`);
});

test('a prediction from the stored (rounded) model matches the full one', () => {
  const data = examples(60);
  const full = student.trainStudent(data);
  const stored = JSON.parse(JSON.stringify(student.buildStudent(data)));
  const v = near(3);
  const a = student.predictStudent(full, v), b = student.predictStudent(stored, v);
  assert(a.subcategory === b.subcategory && Math.abs(a.confidence - b.confidence) < 0.01, `${a.confidence} vs ${b.confidence}`);
});

test('only labels Threadline has, and never "Unsure"', () => {
  assert(student.STUDENT_LABELS.includes('Work › AI Tools'), 'AI Tools');
  assert(!student.STUDENT_LABELS.some(l => l.endsWith('Unsure')), 'no Unsure');
});

section('examples');

test('a page seen again replaces its old example', () => {
  const merged = student.mergeExamples([example(1, 0)], [{ ...example(1, 2), at: 99 }]);
  assert(merged.length === 1 && merged[0].label === student.STUDENT_LABELS[2], JSON.stringify(merged.map(e => e.label)));
});

test("a guess never replaces your correction, but a new correction does", () => {
  const yours = example(1, 0, 'correction');
  assert(student.mergeExamples([yours], [example(1, 2, 'nano')])[0].label === yours.label, 'kept');
  assert(student.mergeExamples([yours], [example(1, 2, 'correction')])[0].label === student.STUDENT_LABELS[2], 'replaced');
});

test('keeps only the newest examples, and drops unknown labels and sources', () => {
  const merged = student.mergeExamples([], [...examples(10), { ...example(50, 0), label: 'Made › Up' }, { ...example(51, 0), source: 'student' }], 4);
  assert(merged.length === 4 && merged[0].at === 6, merged.map(e => e.at).join());
});

test('the held-back pages are always the same ones, about 1 in 5', () => {
  const keys = Array.from({ length: 1000 }, (_, n) => `https://page${n}.test/`);
  const held = keys.filter(student.isHeldOut).length;
  assert(held > 150 && held < 250, `${held}/1000`);
  assert(keys.filter(student.isHeldOut).join() === keys.filter(student.isHeldOut).join(), 'stable');
});

section('trust');

test("isn't trusted until it has been tested on enough Gemini Nano pages", () => {
  const few = student.buildStudent(examples(10));
  assert(!few.trusted, JSON.stringify(few.evaluation));
  const many = student.buildStudent(examples(120));
  assert(many.evaluation.tested >= student.TRUST_MIN_TESTED, JSON.stringify(many.evaluation));
  assert(many.trusted, JSON.stringify(many.evaluation));
});

test('the site list and your corrections train it but are not what it is tested on', () => {
  const data = examples(120).map(e => ({ ...e, source: 'rules' }));
  const built = student.buildStudent(data);
  assert(built.evaluation.tested === 0 && !built.trusted, JSON.stringify(built.evaluation));
  assert(built.counts.rules === 120, JSON.stringify(built.counts));
});

test('is not trusted when it disagrees with Gemini Nano on unseen pages', () => {
  // Labels that have nothing to do with the embeddings can't be learned.
  const noise = examples(150).map((e, n) => ({ ...e, label: student.STUDENT_LABELS[(n * 7919) % 30] }));
  const built = student.buildStudent(noise);
  assert(!built.trusted, JSON.stringify(built.evaluation));
});

section('sorting with the student');

const tabsFor = (labels) => labels.map((_, n) => ({ url: `https://unknown-site-${n}.test/`, title: `Page ${n}` }));

test('answers the tabs it is sure about, and Gemini Nano gets only the rest', async () => {
  const model = student.trainStudent(examples(80));
  const tabs = tabsFor([0, 1, 2]);
  // tab 0 and 1 look like known labels; tab 2 is halfway between two
  const vectors = [near(0), near(1), unit(centres[2].map((x, d) => x + centres[3][d]))];
  const embed = async (texts) => texts.map(t => vectors[Number(t.match(/Page (\d)/)[1])]);
  let askedAbout = [];
  const results = await classifyTabs(tabs, embed, {
    student: { confidence: student.CONFIDENCE, predict: (v) => student.predictStudent(model, v) },
    askModel: async (list) => { askedAbout = list.map(t => t.url); return list.map(() => ({ category: 'Study', subcategory: 'Reference' })); },
  });
  assert(results[0].source === 'student' && results[1].source === 'student', results.map(r => r.source).join());
  assert(`${results[0].category} › ${results[0].subcategory}` === student.STUDENT_LABELS[0], 'right label');
  assert(results[2].source === 'nano' && askedAbout.length === 1 && askedAbout[0] === tabs[2].url, askedAbout.join());
});

test('each tab is embedded only once, and withText returns its text and embedding', async () => {
  const model = student.trainStudent(examples(80));
  let embedded = 0;
  const embed = async (texts) => { embedded += texts.length; return texts.map(() => unit(centres[2].map((x, d) => x + centres[3][d]))); };
  const results = await classifyTabs(tabsFor([0]), embed, {
    student: { confidence: 0.999, predict: (v) => student.predictStudent(model, v) },
    withText: true,
  });
  // The descriptions are embedded once for the whole module, so count only the tab.
  assert(results[0].source === 'model' && results[0].text.includes('Page 0') && results[0].vector.length === 384, JSON.stringify(results[0]).slice(0, 120));
  assert(embedded >= 1, 'embedded');
});

test('without a student nothing changes', async () => {
  const results = await classifyTabs([{ url: 'https://github.com/' }], async () => { throw new Error('should not embed'); });
  assert(results[0].source === 'rules', results[0].source);
});

section('background.js');

let importCounter = 0;
async function boot(openTabs = []) {
  const sent = [];
  const classifier = (message) => {
    sent.push(message);
    if (message.type === 'TRAIN_STUDENT') return { student: { ...student.buildStudent(message.examples), marker: message.examples.length } };
    return { placements: message.tabs.map(() => ({ category: 'Study', subcategory: 'Reference', color: 'blue', categoryRank: 0, subcategoryRank: 0 })), categoryNames: ['Study'], timing: { nanoTabs: 2, nanoMs: 7000, studentTabs: 1 } };
  };
  const mock = installChromeMock({ classifier, openTabs });
  await import(`../background.js?student=${++importCounter}`);
  const send = (message) => new Promise(resolve => mock.listeners.onMessage[0](message, {}, resolve));
  return { ...mock, sent, send, api: globalThis.threadline };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

test('stores examples and retrains after every few new ones', async () => {
  const { send, sent, local } = await boot();
  await send({ type: 'STUDENT_EXAMPLES', examples: examples(2) });
  await settle();
  assert(!sent.some(m => m.type === 'TRAIN_STUDENT'), 'not yet');
  await send({ type: 'STUDENT_EXAMPLES', examples: examples(3).map(e => ({ ...e, key: e.key + 'b' })) });
  await settle();
  const training = sent.filter(m => m.type === 'TRAIN_STUDENT');
  assert(training.length === 1 && training[0].examples.length === 5, `${training.length} trainings`);
  const summary = await send({ type: 'GET_STUDENT' });
  assert(summary.examples === 5 && summary.newSinceTraining === 0 && summary.model, JSON.stringify(summary).slice(0, 200));
  assert(!('weights' in summary.model), 'the popup is not sent the weights');
  assert(local.student_model?.marker === 5, 'model stored');
});

test('each sort sends the stored model, and its timings are added up', async () => {
  const { send, sent, api } = await boot([{ id: 1, title: 'A page', url: 'https://unknown.test/', status: 'complete' }]);
  await send({ type: 'STUDENT_EXAMPLES', examples: examples(3) });
  await settle();
  const before = sent.length;
  await api.runAutoSort();
  const classify = sent.slice(before).find(m => m.type === 'CLASSIFY_TABS');
  assert(classify && classify.student?.marker === 3, 'model sent with the sort');
  const speed = (await send({ type: 'GET_STUDENT' })).speed;
  assert(speed.nanoTabs === 2 && speed.nanoMs === 7000 && speed.studentTabs === 1, JSON.stringify(speed));
});

test('Forget clears the examples and the model', async () => {
  const { send } = await boot();
  await send({ type: 'STUDENT_EXAMPLES', examples: examples(3) });
  await settle();
  await send({ type: 'FORGET_STUDENT' });
  const summary = await send({ type: 'GET_STUDENT' });
  assert(summary.examples === 0 && summary.model === null, JSON.stringify(summary));
});

test('background.js merges examples the same way as student.js', async () => {
  const { api } = await boot();
  const stored = [example(1, 0, 'correction'), example(2, 1), example(3, 2)];
  const incoming = [example(1, 5, 'nano'), { ...example(2, 4), at: 50 }, example(9, 3, 'rules'), { ...example(10, 0), source: 'model' }];
  const a = api.mergeStudentExamples(stored, incoming, 3).map(e => `${e.key}:${e.label}`).join();
  const b = student.mergeExamples(stored, incoming, 3).map(e => `${e.key}:${e.label}`).join();
  assert(a === b, `${a}\nvs\n${b}`);
});

await done();
