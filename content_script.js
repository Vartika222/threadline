/**
 * THREADLINE — content_script.js
 *
 * Injected into every tab. Responsible for:
 * 1. Extracting text content (title, description, headings)
 * 2. Tracking dwell time (how long user is active on this tab)
 * 3. Sending data to background.js on request
 *
 * LEARNING NOTE:
 * Content scripts run in the context of the web page but in an isolated
 * JS environment. They can read the DOM but cannot access page JS variables.
 * They communicate with background.js via chrome.runtime.sendMessage.
 */

// ─── Dwell Time Tracking ───────────────────────────────────────────────────

let dwellStart = Date.now();
let totalDwell = 0;
let isVisible = !document.hidden;

// Track when the tab becomes visible/hidden
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Tab became hidden — accumulate dwell
    totalDwell += Date.now() - dwellStart;
    isVisible = false;
  } else {
    // Tab became visible — start new dwell period
    dwellStart = Date.now();
    isVisible = true;
    notifyBackground();
  }
});

// Update background whenever user refocuses
window.addEventListener('focus', () => {
  dwellStart = Date.now();
  isVisible = true;
});

window.addEventListener('blur', () => {
  if (isVisible) {
    totalDwell += Date.now() - dwellStart;
    isVisible = false;
  }
});

// ─── Content Extraction ───────────────────────────────────────────────────

/**
 * Extracts meaningful text from the page for embedding.
 * We prioritise: title → meta description → h1/h2 headings → first paragraph
 * This gives USE enough signal without sending the full page.
 */
function extractContent() {
  const title = document.title || '';

  // Meta description (most pages have this — very informative)
  const metaDesc = document.querySelector('meta[name="description"]')?.content
    || document.querySelector('meta[property="og:description"]')?.content
    || '';

  // Top-level headings
  const headings = Array.from(document.querySelectorAll('h1, h2'))
    .slice(0, 5)
    .map(h => h.textContent.trim())
    .filter(Boolean)
    .join('. ');

  // First meaningful paragraph
  const firstPara = Array.from(document.querySelectorAll('p'))
    .find(p => p.textContent.trim().length > 50)
    ?.textContent.trim().slice(0, 200) || '';

  // Combine into a single string for embedding
  // ORDER MATTERS: title is most reliable signal, so weight it by repetition
  const combined = [title, title, metaDesc, headings, firstPara]
    .filter(Boolean)
    .join('. ');

  return {
    title,
    url: window.location.href,
    domain: window.location.hostname,
    description: metaDesc,
    content: combined,
    extractedAt: Date.now()
  };
}

// ─── Communication with Background ────────────────────────────────────────

function getDwellTime() {
  const current = isVisible ? (Date.now() - dwellStart) : 0;
  return totalDwell + current;
}

function notifyBackground() {
  const data = {
    ...extractContent(),
    dwellMs: getDwellTime(),
    hourOfDay: new Date().getHours(),
  };

  chrome.runtime.sendMessage({
    type: 'TAB_DATA_UPDATE',
    payload: data
  }).catch(() => {
    // Background service worker may be sleeping — that's fine, it'll
    // ask for data when it wakes up
  });
}

// Listen for background asking for fresh data
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'REQUEST_TAB_DATA') {
    sendResponse({
      ...extractContent(),
      dwellMs: getDwellTime(),
      hourOfDay: new Date().getHours(),
    });
    return true; // Keep message channel open for async response
  }
});

// Send initial data when script loads
setTimeout(notifyBackground, 1000); // Wait 1s for page to settle