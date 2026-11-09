/**
 * THREADLINE — nano.js
 *
 * Optional second classifier: Gemini Nano, the language model built into
 * Chrome (the Prompt API, Chrome 138+ for extensions). It runs on this
 * computer, is free, and knows what many sites are, which the embedding model
 * can only guess from the page's words. Off by default; when it isn't there or
 * fails, the embedding model answers instead.
 *
 * Chrome only lets the model answer with one of the "Category › Subcategory"
 * labels (responseConstraint), so it can't invent a category.
 */
import { CATEGORIES, cleanTitle } from './categories.js';

const LABELS = CATEGORIES.flatMap(c => Object.keys(c.subcategories)
  .filter(sub => sub !== 'Unsure')
  .map(sub => `${c.name} › ${sub}`));

// Chrome can take a long time to answer, or never answer, on a computer where
// the model isn't set up. Give up rather than hold up sorting.
const STATUS_TIMEOUT_MS = 3000;
const PROMPT_TIMEOUT_MS = 20000;

/** Resolves like `promise`, or rejects after `ms`. */
export function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took too long`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const LANGUAGES = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };

/** What each label means, from the same descriptions the embedding model uses. */
const GUIDE = CATEGORIES.flatMap(c => Object.entries(c.subcategories)
  .filter(([sub]) => sub !== 'Unsure')
  .map(([sub, descriptions]) => `- ${c.name} › ${sub}: ${descriptions.join('; ')}`)).join('\n');

const SYSTEM_PROMPT = `You sort a student's browser tabs into groups. For each tab, answer with exactly one label from this list:
${GUIDE}

Judge what the person is doing in the tab, not just the company behind it. AI assistants such as Gemini or ChatGPT are Work › AI Tools. Self-help and habit advice is Work › Productivity. Coding practice and interview prep sites are Study. A YouTube video goes by its topic.`;

/**
 * 'unsupported' when this Chrome has no Prompt API here, otherwise what Chrome
 * says: 'unavailable', 'downloadable', 'downloading' or 'available'.
 */
export async function nanoStatus() {
  if (typeof globalThis.LanguageModel === 'undefined') return 'unsupported';
  try {
    return await withTimeout(globalThis.LanguageModel.availability(LANGUAGES), STATUS_TIMEOUT_MS, 'Checking Gemini Nano');
  } catch (err) {
    return /too long/.test(err.message) ? 'no-answer' : 'unavailable';
  }
}

let baseSession = null;

/**
 * Starts the model, downloading it first if needed. A download only starts from
 * a click, so call this from the popup for that; later calls can come from anywhere.
 */
export async function startNano({ onProgress } = {}) {
  if (baseSession) return baseSession;
  const options = {
    ...LANGUAGES,
    initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => onProgress?.(e.loaded));
    },
  };
  try {
    // Most predictable answers. Extensions must give both of these or neither.
    baseSession = await globalThis.LanguageModel.create({ ...options, topK: 1, temperature: 0 });
  } catch {
    baseSession = await globalThis.LanguageModel.create(options);
  }
  return baseSession;
}

/** The text the model is shown about one tab. */
export function describeTab(tab) {
  let site = '';
  try { site = new URL(tab.url).hostname.replace(/^www\./, ''); } catch { /* not a URL */ }
  const lines = [
    `Site: ${site}`,
    `Title: ${cleanTitle(tab.title) || '(none)'}`,
    tab.channel && `YouTube channel: ${tab.channel}`,
    tab.youtubeCategory && `YouTube category: ${tab.youtubeCategory}`,
    tab.query && `Search: ${tab.query}`,
    tab.description && `Description: ${tab.description.slice(0, 300)}`,
    !tab.description && tab.content && `Page text: ${tab.content.slice(0, 300)}`,
  ];
  return lines.filter(Boolean).join('\n');
}

/** Turns the model's reply into { category, subcategory }, or null. */
export function parseLabel(reply) {
  let label = reply;
  try { label = JSON.parse(reply); } catch { /* already plain text */ }
  if (typeof label !== 'string' || !LABELS.includes(label)) return null;
  const [category, subcategory] = label.split(' › ');
  return { category, subcategory };
}

/**
 * Asks Gemini Nano for each tab, one at a time on a copy of the started
 * session, so tabs don't influence each other. Null for any it couldn't answer.
 */
export async function classifyWithNano(tabs) {
  const session = await withTimeout(startNano(), PROMPT_TIMEOUT_MS, 'Starting Gemini Nano');
  const results = [];
  for (const tab of tabs) {
    let copy = null;
    try {
      copy = await session.clone();
      const reply = await withTimeout(copy.prompt(`Tab:\n${describeTab(tab)}\n\nLabel:`, {
        responseConstraint: { type: 'string', enum: LABELS },
      }), PROMPT_TIMEOUT_MS, 'Gemini Nano');
      results.push(parseLabel(reply));
    } catch {
      results.push(null); // the embedding model answers this one
    } finally {
      copy?.destroy();
    }
  }
  return results;
}

export { LABELS };
