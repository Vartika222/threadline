/**
 * THREADLINE — offscreen document
 *
 * Service workers can't run WebAssembly models reliably, so this hidden page does
 * the classifying for background.js. It only has chrome.runtime, not storage or
 * tabs, so background.js sends it the tab details, your corrections, and
 * whether to ask Gemini Nano first.
 */
import { classifyTabs, placementFor, CATEGORY_NAMES } from '../ml/categories.js';
import { nanoStatus, classifyWithNano } from '../ml/nano.js';

// Imported only when needed, so sites on the known list never load the model.
const embed = async (texts) => (await import('../ml/embedder.js')).embedTexts(texts);

async function classify({ tabs, corrections = {}, useNano = false }) {
  // Gemini Nano is only used once it has been downloaded (from the popup).
  const nano = useNano ? await nanoStatus() : 'off';
  const askModel = nano === 'available' ? classifyWithNano : null;
  const results = await classifyTabs(tabs, embed, { corrections, askModel });
  return {
    placements: results.map(result => ({ ...placementFor(result), source: result.source })),
    categoryNames: CATEGORY_NAMES,
    nano,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'CLASSIFY_TABS') return false;
  classify(message)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message }));
  return true;
});
