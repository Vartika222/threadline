/**
 * THREADLINE — background.js
 *
 * The service worker. Acts as the brain of the extension.
 * Responsibilities:
 * 1. Maintain a store of all open tabs and their metadata
 * 2. Listen for tab events (open, close, update, activate)
 * 3. Coordinate the ML pipeline when user requests a sort
 * 4. Persist data to chrome.storage
 *
 * LEARNING NOTE:
 * Manifest V3 service workers are NOT persistent — Chrome can kill them
 * at any time. Always read state from chrome.storage at the start of
 * each event handler. Never rely on in-memory variables surviving.
 *
 * Message types this worker handles:
 *   TAB_DATA_UPDATE   → from content_script, stores fresh tab data
 *   GET_ALL_TABS      → from popup, lists current tabs with stored metadata
 *   REQUEST_SORT      → from popup, returns tab data for the ML pipeline
 *   APPLY_ORDER       → from popup, moves tabs into the sorted order
 *   SAVE_SNAPSHOT     → from popup, saves current tab state
 *   GET_SNAPSHOTS     → from popup, lists saved states
 */

// ─── State Management ─────────────────────────────────────────────────────

/**
 * WHY A WRITE QUEUE?
 * Every handler below used to do: load the whole tabStore, change one entry,
 * save the whole tabStore. Tab events fire in bursts (opening a window
 * restores many tabs at once), and each handler awaits storage, so two
 * handlers would load the SAME snapshot, each change a different tab, and
 * whichever saved last silently erased the other's change.
 *
 * Fix: every read-modify-write goes through one promise chain, so they run
 * strictly one after another. Reads that don't write don't need the lock.
 */
let storeQueue = Promise.resolve();

function withStoreLock(fn) {
  const run = storeQueue.then(fn);
  // Keep the chain alive even if fn throws, so one failure can't block
  // every later write.
  storeQueue = run.catch(() => {});
  return run;
}

/**
 * Load the full tab store from chrome.storage (read-only use).
 */
async function loadTabStore() {
  const result = await chrome.storage.local.get('tabStore');
  return result.tabStore || {};
}

async function saveTabStore(store) {
  await chrome.storage.local.set({ tabStore: store });
}

/**
 * Atomic read-modify-write of the tab store.
 * `mutator` receives the current store and edits it in place.
 */
function updateTabStore(mutator) {
  return withStoreLock(async () => {
    const store = await loadTabStore();
    const result = await mutator(store);
    await saveTabStore(store);
    return result;
  });
}

/** A URL without its #fragment: jumping within a page is not a new page. */
function withoutHash(url) {
  return (url || '').split('#')[0];
}

/** Returns the hostname for a URL, or '' if the URL can't be parsed. */
function safeHostname(url) {
  try {
    return new URL(url || 'about:blank').hostname || '';
  } catch {
    return '';
  }
}

/**
 * Tracks the previously-active tab across onActivated events, so we can
 * count how often the user actually SWITCHES INTO a given tab from another
 * one — as opposed to revisitCount, which just counts total activations.
 *
 * Kept in chrome.storage.session (cleared when the browser closes) as well
 * as in memory, so a service worker restart mid-session doesn't make the
 * next tab switch look like a first activation.
 */
const PREVIOUS_ACTIVE_KEY = 'previous_active_tab_id';
let previousActiveTabId = null;

async function readPreviousActiveTabId() {
  if (previousActiveTabId !== null) return previousActiveTabId;
  try {
    const got = await chrome.storage.session?.get(PREVIOUS_ACTIVE_KEY);
    const stored = got?.[PREVIOUS_ACTIVE_KEY];
    return typeof stored === 'number' ? stored : null;
  } catch {
    return null;
  }
}

async function writePreviousActiveTabId(tabId) {
  previousActiveTabId = tabId;
  try {
    await chrome.storage.session?.set({ [PREVIOUS_ACTIVE_KEY]: tabId });
  } catch {
    // session storage unavailable — in-memory copy is enough
  }
}

// ─── Implicit Pair Detection (attentional residue) ────────────────────────
//
// If the user keeps switching back and forth between the SAME two tabs
// within a short window, that's a behavioural signal that those tabs are
// related in the user's head — even if they never dragged them together
// in the chain. We track a rolling switch-count per tab pair; once a pair
// crosses BURST_THRESHOLD genuine switches, we queue it as an implicit
// training candidate for implicitFeedback.js to convert into a real
// training example next time the popup has embeddings available.

const TRANSITION_PAIR_COUNTS_KEY = 'transition_pair_counts';
const IMPLICIT_CANDIDATES_KEY    = 'implicit_training_candidates';
const TRANSITION_WINDOW_MS       = 5 * 60 * 1000; // switches must be within 5 min of each other to count as a streak
const BURST_THRESHOLD            = 3;             // 3 genuine switches between the same two tabs = queue it
const MAX_QUEUED_CANDIDATES      = 50;

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function recordTransitionForImplicitSignal(fromTabId, toTabId) {
  return withStoreLock(async () => {
    const { [TRANSITION_PAIR_COUNTS_KEY]: raw } = await chrome.storage.local.get(TRANSITION_PAIR_COUNTS_KEY);
    const counts = raw ? JSON.parse(raw) : {};

    const key = pairKey(fromTabId, toTabId);
    const now = Date.now();
    const entry = counts[key] || { count: 0, lastSeen: 0 };

    // Streak went cold — too long since these two were last switched between.
    if (now - entry.lastSeen > TRANSITION_WINDOW_MS) entry.count = 0;

    entry.count += 1;
    entry.lastSeen = now;
    counts[key] = entry;

    if (entry.count >= BURST_THRESHOLD) {
      await queueImplicitCandidate(fromTabId, toTabId);
      delete counts[key]; // reset so we don't requeue this exact pair on every subsequent switch
    }

    await chrome.storage.local.set({ [TRANSITION_PAIR_COUNTS_KEY]: JSON.stringify(counts) });
  });
}

// Called only from inside withStoreLock (see above) — do not lock again here.
async function queueImplicitCandidate(aTabId, bTabId) {
  const { [IMPLICIT_CANDIDATES_KEY]: raw } = await chrome.storage.local.get(IMPLICIT_CANDIDATES_KEY);
  const candidates = raw ? JSON.parse(raw) : [];

  const alreadyQueued = candidates.some(c =>
    (c.aTabId === aTabId && c.bTabId === bTabId) ||
    (c.aTabId === bTabId && c.bTabId === aTabId)
  );
  if (alreadyQueued) return;

  candidates.push({ aTabId, bTabId, queuedAt: Date.now() });
  await chrome.storage.local.set({
    [IMPLICIT_CANDIDATES_KEY]: JSON.stringify(candidates.slice(-MAX_QUEUED_CANDIDATES)),
  });
}

// ─── Tab Lifecycle Listeners ──────────────────────────────────────────────

/** A fresh store entry for a tab we have just learned about. */
function newTabEntry(tab) {
  return {
    tabId: tab.id,
    title: tab.title || '',
    url: tab.url || '',
    domain: safeHostname(tab.url),
    content: tab.title || '',
    dwellMs: 0,
    revisitCount: 0,
    openedAt: Date.now(),
    hourOfDay: new Date().getHours(),
    lastActive: Date.now(),
  };
}

/**
 * Registers every tab that is open right now, and forgets entries for tabs
 * that no longer exist.
 *
 * WHY: tab events only tell us about tabs that open or change AFTER the
 * service worker is listening. Tabs that were already open when the
 * extension was installed (or when the browser restarted, which gives every
 * tab a new id) would otherwise never be tracked — and the ML pipeline would
 * have to fall back to titles for them. Pruning also stops stale ids from
 * piling up in storage after a browser crash.
 */
async function syncStoreWithOpenTabs() {
  const tabs = await chrome.tabs.query({});
  const liveIds = new Set(tabs.map(t => t.id));

  await updateTabStore((store) => {
    for (const tab of tabs) {
      if (!store[tab.id]) store[tab.id] = newTabEntry(tab);
    }
    for (const id of Object.keys(store)) {
      if (!liveIds.has(Number(id))) delete store[id];
    }
  });
}

/**
 * Content scripts are only injected into pages that load AFTER the extension
 * is installed or reloaded, so already-open pages have none and can't report
 * their text or dwell time. Inject it into the http(s) tabs that are open now.
 */
async function injectContentScriptIntoOpenTabs() {
  if (!chrome.scripting?.executeScript) return;
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!/^https?:/.test(tab.url || '')) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content_script.js'],
      });
    } catch {
      // Restricted pages (Chrome Web Store, PDF viewer, etc.) refuse injection.
    }
  }
}

chrome.runtime.onInstalled?.addListener(async () => {
  await syncStoreWithOpenTabs();
  await injectContentScriptIntoOpenTabs();
});

chrome.runtime.onStartup?.addListener(async () => {
  await syncStoreWithOpenTabs();
});

// When a new tab is created, register it in our store
chrome.tabs.onCreated.addListener(async (tab) => {
  await updateTabStore((store) => {
    store[tab.id] = newTabEntry(tab);
  });
});

// When a tab is removed, clean up our store
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await updateTabStore((store) => {
    delete store[tabId];
  });
});

// When a tab is activated (user switches to it), increment revisit count
// and — if this was a genuine switch FROM a different tab — transitionCount.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const priorTabId = await readPreviousActiveTabId();
  const isGenuineTransition = priorTabId !== null && priorTabId !== tabId;
  await writePreviousActiveTabId(tabId);

  if (isGenuineTransition) {
    await recordTransitionForImplicitSignal(priorTabId, tabId);
  }

  // Ask the content script for fresh data BEFORE taking the store lock —
  // the round trip to the page can be slow and must not block other writes.
  let freshData = null;
  try {
    freshData = await chrome.tabs.sendMessage(tabId, { type: 'REQUEST_TAB_DATA' });
  } catch {
    // Tab may not have content script (chrome:// pages, PDFs, etc.)
  }

  // A tab can be activated before we ever saw it created (it was open when
  // the worker started, or its create event arrived while the worker was
  // asleep). Learn about it now instead of ignoring it forever.
  let knownTab = null;
  try {
    knownTab = await chrome.tabs.get(tabId);
  } catch {
    // tab already closed
  }

  await updateTabStore((store) => {
    if (!store[tabId] && knownTab) store[tabId] = newTabEntry(knownTab);
    if (!store[tabId]) return;

    store[tabId].revisitCount = (store[tabId].revisitCount || 0) + 1;
    store[tabId].lastActive = Date.now();

    if (isGenuineTransition) {
      store[tabId].transitionCount = (store[tabId].transitionCount || 0) + 1;
    }

    if (freshData) {
      store[tabId] = { ...store[tabId], ...freshData };
    }
  });
});

/**
 * Forgets a tab's page text as soon as it navigates to a different page.
 *
 * WHY: the new page's content script normally replaces the text about a second
 * later, but some pages never run one (Chrome Web Store, PDF viewer, browser
 * error pages). Without this, those tabs keep being embedded using the text of
 * whatever page they showed before. The sort falls back to the tab's title.
 */
function forgetPageTextOnNavigation(tabId, newUrl) {
  return updateTabStore((store) => {
    const entry = store[tabId];
    if (!entry || withoutHash(entry.url) === withoutHash(newUrl)) return;
    entry.url = newUrl;
    entry.domain = safeHostname(newUrl);
    entry.content = '';
    entry.description = '';
  });
}

// When a tab navigates or finishes loading, update its metadata
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url) await forgetPageTextOnNavigation(tabId, changeInfo.url);
  if (changeInfo.status !== 'complete') return;

  await updateTabStore((store) => {
    if (!store[tabId]) {
      store[tabId] = {
        tabId,
        revisitCount: 0,
        openedAt: Date.now(),
        hourOfDay: new Date().getHours(),
      };
    }

    store[tabId] = {
      ...store[tabId],
      title: tab.title || '',
      url: tab.url || '',
      domain: safeHostname(tab.url),
      content: store[tabId].content || tab.title || '',
      lastUpdated: Date.now(),
    };
  });
});

// ─── Message Handlers (from popup and content scripts) ────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(err => {
    sendResponse({ error: err.message });
  });
  return true; // Required to use async sendResponse
});

/**
 * Moves tabs into the chain's order, as far as Chrome allows.
 *
 * Chrome keeps pinned tabs before all others, so each kind is ordered within
 * its own region. Using one running index for both would make Chrome clamp the
 * moves and scatter the unpinned tabs. Tabs that were closed since the sort are
 * skipped, so one missing tab can't abandon the reorder halfway.
 */
async function applyTabOrder(orderedTabIds) {
  const windowTabs = await chrome.tabs.query({ currentWindow: true });
  const byId = new Map(windowTabs.map(t => [t.id, t]));
  const live = orderedTabIds.filter(id => byId.has(id));

  const pinnedTotal = windowTabs.filter(t => t.pinned).length;
  const pinned = live.filter(id => byId.get(id).pinned);
  const unpinned = live.filter(id => !byId.get(id).pinned);
  const moves = [
    ...pinned.map((id, i) => [id, pinnedTotal - pinned.length + i]),
    ...unpinned.map((id, i) => [id, pinnedTotal + i]),
  ];

  let failed = 0;
  for (const [id, index] of moves) {
    try {
      await chrome.tabs.move(id, { index: index - failed });
    } catch {
      failed++; // closed mid-loop: everything after it shifts left by one
    }
  }
  return { ok: true, skipped: orderedTabIds.length - live.length + failed };
}

async function handleMessage(message, sender) {
  switch (message.type) {

    case 'TAB_DATA_UPDATE': {
      // Content script is pushing fresh data for its tab
      const tabId = sender.tab?.id;
      if (tabId) {
        await updateTabStore((store) => {
          if (store[tabId]) {
            store[tabId] = { ...store[tabId], ...message.payload };
          }
        });
      }
      return { ok: true };
    }

    case 'GET_ALL_TABS': {
      // Popup asking for all tab data to display
      const store = await loadTabStore();
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const enriched = tabs.map(tab => ({
        ...store[tab.id],
        tabId: tab.id,
        title: tab.title,
        url: tab.url,
        favIconUrl: tab.favIconUrl,
        active: tab.active,
        index: tab.index,
      }));
      return { tabs: enriched };
    }

    case 'REQUEST_SORT': {
      // Popup wants the ML-sorted chain
      // The actual ML runs in the popup (TF.js is heavy, better in popup context)
      // Background just returns the raw tab data for the popup to sort
      const store = await loadTabStore();
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const tabData = tabs
        .filter(t => t.url && !t.url.startsWith('chrome://'))
        .map(tab => ({
          ...store[tab.id],
          tabId: tab.id,
          title: tab.title || 'Untitled',
          url: tab.url,
          favIconUrl: tab.favIconUrl,
          active: tab.active,
          index: tab.index,
          content: store[tab.id]?.content || tab.title || tab.url,
        }));
      return { tabs: tabData };
    }

    case 'APPLY_ORDER': {
      // Popup has sorted the tabs and wants to rearrange them in Chrome
      return applyTabOrder(message.orderedTabIds);
    }

    case 'SAVE_SNAPSHOT': {
      // Save current tab state as a named session
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const snapshot = {
        id: Date.now(),
        name: message.name || `Session ${new Date().toLocaleTimeString()}`,
        createdAt: Date.now(),
        tabs: tabs.map(t => ({ url: t.url, title: t.title, index: t.index }))
      };
      await withStoreLock(async () => {
        const existing = (await chrome.storage.local.get('snapshots')).snapshots || [];
        existing.unshift(snapshot);
        await chrome.storage.local.set({ snapshots: existing.slice(0, 10) }); // Keep last 10
      });
      return { ok: true, snapshot };
    }

    case 'GET_SNAPSHOTS': {
      const { snapshots } = await chrome.storage.local.get('snapshots');
      return { snapshots: snapshots || [] };
    }

    default:
      return { error: `Unknown message type: ${message.type}` };
  }
}
