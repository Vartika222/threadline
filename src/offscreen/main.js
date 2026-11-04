/**
 * THREADLINE — offscreen document
 *
 * Service workers can't run WebAssembly models reliably, so this hidden page does
 * the classifying for background.js. It only has chrome.runtime, not storage or
 * tabs, so background.js sends it the tab details it needs.
 */
import { classifyTabs, placementFor, CATEGORY_NAMES } from '../ml/categories.js';

// Imported only when needed, so sites on the known list never load the model.
const embed = async (texts) => (await import('../ml/embedder.js')).embedTexts(texts);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'CLASSIFY_TABS') return false;
  classifyTabs(message.tabs, embed)
    .then(results => sendResponse({ placements: results.map(placementFor), categoryNames: CATEGORY_NAMES }))
    .catch(err => sendResponse({ error: err.message }));
  return true;
});
