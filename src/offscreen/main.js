/**
 * THREADLINE — offscreen document
 *
 * Service workers can't run WebAssembly models reliably, so this hidden page does
 * the classifying for background.js. It only has chrome.runtime, not storage or
 * tabs, so background.js sends it the tab details, your corrections, whether to
 * ask Gemini Nano, and the trained student model (student.js).
 *
 * After answering, it sends background.js the answers worth learning from
 * (Gemini Nano's, the site list's and your corrections), so the student keeps
 * training on them. background.js stores them and asks this page to retrain.
 */
import { classifyTabs, placementFor, descriptionExamples, CATEGORY_NAMES } from '../ml/categories.js';
import { nanoStatus, classifyWithNano } from '../ml/nano.js';
import { predictStudent, buildStudent, compactVector, exampleKey, CONFIDENCE } from '../ml/student.js';

// Imported only when needed, so sites on the known list never load the model.
const embed = async (texts) => (await import('../ml/embedder.js')).embedTexts(texts);

let embedderLoaded = false;

/** Answers worth training the student on. */
const LEARN_FROM = new Set(['nano', 'rules', 'correction']);

async function classify({ tabs, corrections = {}, useNano = false, student = null }) {
  // Gemini Nano is only used once it has been downloaded (from the popup).
  const nano = useNano ? await nanoStatus() : 'off';
  const timing = { studentTabs: 0, studentMs: 0, nanoTabs: 0, nanoMs: 0 };

  // The student only answers once it has passed its test.
  const trustedStudent = student?.trusted ? {
    confidence: CONFIDENCE,
    predict: (vector) => predictStudent(student, vector),
  } : null;

  const askModel = nano === 'available' ? async (list) => {
    const started = performance.now();
    const answers = await classifyWithNano(list);
    timing.nanoTabs += list.length;
    timing.nanoMs += performance.now() - started;
    return answers;
  } : null;

  // Times the embedding, which is most of what the student costs. The first
  // call also loads the model from disk, once, so it isn't counted.
  const timedEmbed = async (texts) => {
    const started = performance.now();
    const vectors = await embed(texts);
    if (embedderLoaded) {
      timing.embedMs = (timing.embedMs || 0) + (performance.now() - started);
      timing.embedded = (timing.embedded || 0) + texts.length;
    }
    embedderLoaded = true;
    return vectors;
  };

  const results = await classifyTabs(tabs, timedEmbed, { corrections, askModel, student: trustedStudent, withText: true });
  timing.studentTabs = results.filter(r => r.source === 'student').length;

  return {
    response: {
      placements: results.map(result => ({ ...placementFor(result), source: result.source })),
      categoryNames: CATEGORY_NAMES,
      nano,
      timing,
    },
    learnable: results.flatMap((result, i) => (LEARN_FROM.has(result.source) && /^https?:/.test(tabs[i].url || '')
      ? [{ ...result, url: tabs[i].url }] : [])),
  };
}

/** Embeds what's left and sends the examples to background.js. */
async function sendExamples(learnable) {
  if (!learnable.length) return;
  const missing = learnable.filter(r => !r.vector);
  if (missing.length) (await embed(missing.map(r => r.text))).forEach((v, n) => { missing[n].vector = v; });
  const at = Date.now();
  const examples = learnable.map(r => ({
    key: exampleKey(r.url),
    vector: compactVector(r.vector),
    label: `${r.category} › ${r.subcategory}`,
    source: r.source,
    at,
  }));
  await chrome.runtime.sendMessage({ type: 'STUDENT_EXAMPLES', examples }).catch(() => {});
}

async function train({ examples }) {
  const seeds = await descriptionExamples(embed);
  return { student: buildStudent(examples, seeds) };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CLASSIFY_TABS') {
    classify(message)
      .then(({ response, learnable }) => {
        sendResponse(response);
        sendExamples(learnable).catch(err => console.warn('[Threadline] Could not save training examples:', err.message));
      })
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'TRAIN_STUDENT') {
    train(message)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  return false;
});
