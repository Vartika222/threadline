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
import { classifyTabs, placementFor, descriptionExamples, correctionKey, CATEGORY_NAMES } from '../ml/categories.js';
import { nanoStatus, classifyWithNano } from '../ml/nano.js';
import { trustedStudent, buildStudent, compactVector, exampleKey } from '../ml/student.js';
import { getAll, update } from '../memory/db.js';
import { memoryText, resurface } from '../memory/memory.js';

// Imported only when needed, so sites on the known list never load the model.
const embed = async (texts) => (await import('../ml/embedder.js')).embedTexts(texts);

let embedderLoaded = false;

/** Answers worth training the student on. */
const LEARN_FROM = new Set(['nano', 'rules', 'correction']);

async function classify({ tabs, corrections = {}, useNano = false, student = null }) {
  // Gemini Nano is only used once it has been downloaded (from the popup).
  const nano = useNano ? await nanoStatus() : 'off';
  const timing = { studentTabs: 0, studentMs: 0, nanoTabs: 0, nanoMs: 0 };


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

  const results = await classifyTabs(tabs, timedEmbed, { corrections, askModel, student: trustedStudent(student), withText: true });
  timing.studentTabs = results.filter(r => r.source === 'student').length;

  return {
    response: {
      placements: results.map(result => ({ ...placementFor(result), source: result.source })),
      categoryNames: CATEGORY_NAMES,
      nano,
      timing,
    },
    learnable: results.flatMap((result, i) => (LEARN_FROM.has(result.source) && /^https?:/.test(tabs[i].url || '')
      ? [{ ...result, url: tabs[i].url, site: correctionKey(tabs[i]) }] : [])),
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
    site: r.site, // what a correction is kept under, so forgetting it can remove this
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

const INDEX_BATCH = 40;

/**
 * Embeds pages and stash items that are new or whose text changed, gives a
 * category to any without one, and says which open pages have related stash
 * items (resurfacing). A batch at a time; `more` asks to be called again.
 */
async function indexMemory({ corrections = {} }) {
  const [pages, stash] = await Promise.all([getAll('pages'), getAll('stash')]);
  const todo = [
    ...stash.filter(r => r.needsVector).map(record => ({ store: 'stash', key: record.id, record })),
    ...pages.filter(r => r.needsVector).map(record => ({ store: 'pages', key: record.url, record })),
  ];
  const batch = todo.slice(0, INDEX_BATCH);
  if (!batch.length) return { resurface: [] };

  const vectors = await embed(batch.map(({ record }) => memoryText(record)));
  const unsorted = batch.filter(({ record }) => !record.category);
  const answers = unsorted.length ? await classifyTabs(
    unsorted.map(({ record }) => ({ url: record.url, title: record.title, content: record.quote || record.text })),
    embed, { corrections }) : [];
  const categoryOf = new Map(unsorted.map((entry, i) => [entry, answers[i]]));

  const notes = [];
  for (let i = 0; i < batch.length; i++) {
    const { store, key, record } = batch[i];
    const vector = Float32Array.from(vectors[i]);
    const answer = categoryOf.get(batch[i]);
    const saved = await update(store, key, (current) => current && {
      ...current,
      vector,
      // The text may have changed while this one was being embedded: then do it again.
      needsVector: memoryText(current) !== memoryText(record),
      category: current.category || answer?.category || null,
      subcategory: current.subcategory || answer?.subcategory || null,
    });
    if (store === 'pages' && saved) {
      const related = resurface(saved, stash);
      if (related.length) notes.push({ url: saved.url, count: related.length, since: related[0].savedAt });
    }
  }
  return { resurface: notes, more: todo.length > batch.length };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'INDEX_MEMORY') {
    indexMemory(message)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
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
