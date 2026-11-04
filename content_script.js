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

// Guard + IIFE: this file can be injected twice into the same page (once by
// the manifest, once by background.js when the extension is installed while
// the page is already open). Without the guard the second run would throw
// "Identifier 'dwellStart' has already been declared" and add duplicate
// listeners.
(function () {
if (globalThis.__threadlineContentScriptLoaded) return;
globalThis.__threadlineContentScriptLoaded = true;

// ─── Dwell Time Tracking ───────────────────────────────────────────────────

// One timer with two transitions, because the browser fires blur, focus and
// visibilitychange in overlapping combinations. Each transition does nothing
// if the timer is already in that state, so no stretch of time is counted
// twice and an extra focus event can't throw away time already running.
let totalDwell = 0;
let dwellStart = null; // null = not counting right now

function startDwell() {
  if (dwellStart === null && !document.hidden) dwellStart = Date.now();
}

function stopDwell() {
  if (dwellStart === null) return;
  totalDwell += Date.now() - dwellStart;
  dwellStart = null;
}

startDwell();

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopDwell();
  } else {
    startDwell();
    notifyBackground();
  }
});

window.addEventListener('focus', startDwell);
window.addEventListener('blur', stopDwell);

// ─── Content Extraction ───────────────────────────────────────────────────

/**
 * An element's readable text. textContent alone also returns the contents of
 * nested <style> and <script> tags: Wikipedia puts CSS inside its paragraphs,
 * which would otherwise end up in the embedding and in the topic names.
 */
function readableText(element) {
  const copy = element.cloneNode(true);
  copy.querySelectorAll('style, script, noscript').forEach(el => el.remove());
  return copy.textContent.trim();
}

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
    .map(readableText)
    .filter(Boolean)
    .join('. ');

  // First meaningful paragraph
  const firstPara = Array.from(document.querySelectorAll('p'))
    .map(readableText)
    .find(text => text.length > 50)
    ?.slice(0, 200) || '';

  // Combine into a single string for embedding
  // ORDER MATTERS: title is most reliable signal, so weight it by repetition
  const combined = [title, title, metaDesc, headings, firstPara]
    .filter(Boolean)
    .join('. ');

  // On YouTube, the channel says more about a video than its title does.
  const channel = window.location.hostname.endsWith('youtube.com')
    ? (document.querySelector('ytd-watch-metadata ytd-channel-name a, #owner ytd-channel-name a')?.textContent
      || document.querySelector('span[itemprop="author"] link[itemprop="name"]')?.getAttribute('content')
      || '').trim()
    : '';

  return {
    title,
    channel,
    url: window.location.href,
    domain: window.location.hostname,
    description: metaDesc,
    content: combined,
    extractedAt: Date.now()
  };
}

// ─── Communication with Background ────────────────────────────────────────

function getDwellTime() {
  const current = dwellStart === null ? 0 : Date.now() - dwellStart;
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

// YouTube changes video without loading a new page, so this script doesn't rerun.
document.addEventListener('yt-navigate-finish', () => setTimeout(notifyBackground, 1000));
})();
