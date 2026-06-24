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
 *   REQUEST_SORT      → from popup, triggers ML pipeline
 *   REQUEST_SNAPSHOT  → from popup, saves current tab state
 *   RESTORE_SNAPSHOT  → from popup, restores a saved state
 */

// ─── State Management ─────────────────────────────────────────────────────

/**
 * Load the full tab store from chrome.storage.
 * Always do this at the start of handlers — don't trust in-memory state.
 */
async function loadTabStore() {
  const result = await chrome.storage.local.get('tabStore');
  return result.tabStore || {};
}

async function saveTabStore(store) {
  await chrome.storage.local.set({ tabStore: store });
}

// ─── Tab Lifecycle Listeners ──────────────────────────────────────────────

// When a new tab is created, register it in our store
chrome.tabs.onCreated.addListener(async (tab) => {
  const store = await loadTabStore();
  store[tab.id] = {
    tabId: tab.id,
    title: tab.title || '',
    url: tab.url || '',
    domain: '',
    content: tab.title || '',
    dwellMs: 0,
    revisitCount: 0,
    openedAt: Date.now(),
    hourOfDay: new Date().getHours(),
    lastActive: Date.now(),
  };
  await saveTabStore(store);
});

// When a tab is removed, clean up our store
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const store = await loadTabStore();
  delete store[tabId];
  await saveTabStore(store);
});

// When a tab is activated (user switches to it), increment revisit count
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const store = await loadTabStore();
  if (store[tabId]) {
    store[tabId].revisitCount = (store[tabId].revisitCount || 0) + 1;
    store[tabId].lastActive = Date.now();

    // Ask the content script for fresh data
    try {
      const freshData = await chrome.tabs.sendMessage(tabId, { type: 'REQUEST_TAB_DATA' });
      if (freshData) {
        store[tabId] = { ...store[tabId], ...freshData };
      }
    } catch {
      // Tab may not have content script (chrome:// pages, PDFs, etc.)
    }

    await saveTabStore(store);
  }
});

// When a tab finishes loading, update its metadata
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;

  const store = await loadTabStore();
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
    domain: new URL(tab.url || 'about:blank').hostname || '',
    lastUpdated: Date.now(),
  };

  await saveTabStore(store);
});

// ─── Message Handlers (from popup and content scripts) ────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(err => {
    sendResponse({ error: err.message });
  });
  return true; // Required to use async sendResponse
});

async function handleMessage(message, sender) {
  const store = await loadTabStore();

  switch (message.type) {

    case 'TAB_DATA_UPDATE': {
      // Content script is pushing fresh data for its tab
      const tabId = sender.tab?.id;
      if (tabId && store[tabId]) {
        store[tabId] = { ...store[tabId], ...message.payload };
        await saveTabStore(store);
      }
      return { ok: true };
    }

    case 'GET_ALL_TABS': {
      // Popup asking for all tab data to display
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
      const { orderedTabIds } = message;
      for (let i = 0; i < orderedTabIds.length; i++) {
        await chrome.tabs.move(orderedTabIds[i], { index: i });
      }
      return { ok: true };
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
      const existing = (await chrome.storage.local.get('snapshots')).snapshots || [];
      existing.unshift(snapshot);
      await chrome.storage.local.set({ snapshots: existing.slice(0, 10) }); // Keep last 10
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