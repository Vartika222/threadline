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
// the page is already open). Without the guard the second run would add
// duplicate listeners. A copy left over from before the extension was reloaded
// can't reach it any more, so a new copy takes over from it.
(function () {
/** True once this copy has been cut off from the extension (it was reloaded or removed). */
function extensionGone() {
  try {
    return !chrome.runtime?.id;
  } catch {
    return true;
  }
}

if (globalThis.__threadlineContentScriptLoaded && !globalThis.__threadlineContentScriptGone?.()) return;
globalThis.__threadlineContentScriptLoaded = true;
globalThis.__threadlineContentScriptGone = extensionGone;

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

function onVisibilityChange() {
  if (document.hidden) {
    stopDwell();
  } else {
    startDwell();
    notifyBackground();
  }
}

document.addEventListener('visibilitychange', onVisibilityChange);
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

// ─── YouTube ──────────────────────────────────────────────────────────────

/** The id of the YouTube video open in this tab, or null. */
function youtubeVideoId() {
  if (!window.location.hostname.endsWith('youtube.com')) return null;
  const url = new URL(window.location.href);
  if (url.pathname === '/watch') return url.searchParams.get('v');
  return url.pathname.match(/^\/(?:shorts|live)\/([\w-]+)/)?.[1] || null;
}

// YouTube changes video without loading a new page, and doesn't update the
// page's own details when it does, so only the first video can be read here.
const firstVideoId = youtubeVideoId();
const youtubeDetailsCache = new Map(); // video id → { category, channel }

/** Reads a string out of YouTube's page data, undoing JSON escapes like \u0026. */
function jsonString(html, key) {
  const raw = html.match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`))?.[1];
  if (raw === undefined) return '';
  try { return JSON.parse(`"${raw}"`); } catch { return raw; }
}

/**
 * The category YouTube lists for a video (Education, Music, Gaming, ...) and its
 * channel. For any video after the first, this fetches the video's own page from
 * youtube.com, the site this tab is already on. Nothing goes anywhere else.
 */
async function youtubeDetails(videoId) {
  if (!videoId) return null;
  if (youtubeDetailsCache.has(videoId)) return youtubeDetailsCache.get(videoId);

  let details = null;
  if (videoId === firstVideoId) {
    const category = document.querySelector('meta[itemprop="genre"]')?.content;
    if (category) details = { category, channel: '' };
  }
  if (!details) {
    try {
      const response = await fetch(`/watch?v=${encodeURIComponent(videoId)}`);
      const html = await response.text();
      details = { category: jsonString(html, 'category'), channel: jsonString(html, 'ownerChannelName') };
    } catch {
      return null; // offline or blocked: try again next time, don't remember the failure
    }
  }
  youtubeDetailsCache.set(videoId, details);
  return details;
}

// ─── Communication with Background ────────────────────────────────────────

function getDwellTime() {
  const current = dwellStart === null ? 0 : Date.now() - dwellStart;
  return totalDwell + current;
}

/**
 * Passes everything background.js keeps about this tab to `callback`: at once,
 * or after looking up what a YouTube video is.
 */
function withTabData(callback) {
  const data = { ...extractContent(), dwellMs: getDwellTime(), hourOfDay: new Date().getHours() };
  const videoId = youtubeVideoId();
  if (!videoId) {
    callback(data);
    return;
  }
  youtubeDetails(videoId).then((youtube) => {
    if (youtube) {
      data.youtubeCategory = youtube.category;
      if (youtube.channel) data.channel = youtube.channel; // the page's own may be from the last video
    }
    callback(data);
  });
}

function notifyBackground() {
  if (extensionGone()) {
    stopListening();
    return;
  }
  withTabData(sendToBackground);
}

function sendToBackground(data) {
  try {
    chrome.runtime.sendMessage({ type: 'TAB_DATA_UPDATE', payload: data }).catch(() => {
      // The service worker may be asleep: it asks for data when it wakes up.
    });
  } catch {
    // Chrome throws straight away, rather than rejecting, once the extension
    // has been reloaded. This copy is finished; the new one does the work.
    stopListening();
  }
}

function onYouTubeNavigate() {
  setTimeout(notifyBackground, 1000);
}

/** Detaches this copy from the page, so a leftover copy goes quiet. */
function stopListening() {
  stopDwell();
  document.removeEventListener('visibilitychange', onVisibilityChange);
  document.removeEventListener('yt-navigate-finish', onYouTubeNavigate);
  window.removeEventListener('focus', startDwell);
  window.removeEventListener('blur', stopDwell);
}

// Listen for background asking for fresh data
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'REQUEST_TAB_DATA') {
    withTabData(sendResponse);
    return true; // Keep message channel open for async response
  }
});

// Send initial data when script loads
setTimeout(notifyBackground, 1000); // Wait 1s for page to settle

// YouTube changes video without loading a new page, so this script doesn't rerun.
document.addEventListener('yt-navigate-finish', onYouTubeNavigate);
})();
