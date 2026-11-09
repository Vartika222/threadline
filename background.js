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
 *   APPLY_SORT        → from popup, puts tabs in order and into named groups
 *   UNDO_SORT         → from popup, restores the tabs from before the last sort
 *   GET_SORT_STATE    → from popup, auto-sort setting and what Undo can do
 *   SET_AUTO_SORT     → from popup, turns automatic sorting on or off
 *   START_FOCUS, END_FOCUS, GET_FOCUS, SET_STRICT_FOCUS, FOCUS_ALLOW, FOCUS_GO_BACK
 *                     → focus mode (see below)
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
  scheduleAutoSort();
});

chrome.runtime.onStartup?.addListener(async () => {
  await syncStoreWithOpenTabs();
  scheduleAutoSort();
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
  await forgetPlacement(tabId);
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

  await showTabCategoryOnBadge(tabId);
  await enforceFocus(tabId);
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
    entry.channel = '';
    entry.youtubeCategory = '';
  });
}

// When a tab navigates or finishes loading, update its metadata
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.groupId !== undefined) await learnFromMove(tabId, changeInfo.groupId);
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
  scheduleAutoSort();
});

// ─── Automatic Sorting ────────────────────────────────────────────────────
//
// When a tab finishes loading, it moves into a named tab group for its category.
// Only tabs on a new URL are touched, or tabs whose details only arrived after
// they were sorted (page text, a YouTube channel or category), so everything
// else stays put. If you move a tab by hand it stays there until it navigates
// somewhere new. Groups you made yourself are never changed.

const AUTO_SORT_KEY = 'auto_sort_enabled';
const PLACEMENTS_KEY = 'tab_placements';   // tabId → { url, category, subcategory, ... }
const UNDO_KEY = 'undo_state';
const AUTO_SORT_DELAY_MS = 1500;           // lets the page text arrive, and groups bursts of tabs
const TAB_EDIT_RETRIES = 6;
const TAB_EDIT_RETRY_MS = 400;

let autoSortTimer = null;
let autoSortRunning = false;
let autoSortAgain = false;

function scheduleAutoSort() {
  clearTimeout(autoSortTimer);
  autoSortTimer = setTimeout(runAutoSort, AUTO_SORT_DELAY_MS);
  autoSortTimer.unref?.(); // tests under Node shouldn't wait for this
}

async function isAutoSortOn() {
  const { [AUTO_SORT_KEY]: enabled } = await chrome.storage.local.get(AUTO_SORT_KEY);
  return enabled !== false;
}

async function loadPlacements() {
  const { [PLACEMENTS_KEY]: placements } = await chrome.storage.session.get(PLACEMENTS_KEY);
  return placements || {};
}

function savePlacements(placements) {
  return chrome.storage.session.set({ [PLACEMENTS_KEY]: placements });
}

function forgetPlacement(tabId) {
  return withStoreLock(async () => {
    const placements = await loadPlacements();
    delete placements[tabId];
    await savePlacements(placements);
  });
}

const isSortable = (tab) => /^https?:/.test(tab.url || '') && !tab.pinned;

// Threadline's own tab moves fire the same events as yours. While it is moving
// tabs, and for a moment after, a tab changing group isn't taken as a correction.
const OWN_EDIT_QUIET_MS = 1500;
let ownEditsRunning = 0;
let ownEditsQuietUntil = 0;

async function asOwnEdit(action) {
  ownEditsRunning++;
  try {
    return await action();
  } finally {
    ownEditsRunning--;
    ownEditsQuietUntil = Date.now() + OWN_EDIT_QUIET_MS;
  }
}

const isOwnEditMoment = () => ownEditsRunning > 0 || Date.now() < ownEditsQuietUntil;

/** Chrome refuses tab changes while the user is dragging a tab, so try again. */
async function editTabs(action) {
  return asOwnEdit(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await action();
      } catch (err) {
        const busy = /cannot be edited|dragging/i.test(err.message);
        if (!busy || attempt >= TAB_EDIT_RETRIES) throw err;
        await new Promise(resolve => setTimeout(resolve, TAB_EDIT_RETRY_MS));
      }
    }
  });
}

/** Starts the hidden page that runs the model, if it isn't already running. */
async function ensureClassifierPage() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Runs the on-device language model that classifies tabs.',
  });
}

/** What the content script saved for a tab, if it is about the page open now. */
function savedDetails(store, tab) {
  const saved = store[tab.id];
  return saved && withoutHash(saved.url) === withoutHash(tab.url) ? saved : {};
}

/**
 * The details a tab was sorted on. When this changes, for example YouTube's
 * category for a video arrives a second after the video opened, the tab is
 * sorted again. The title isn't part of it: many titles keep changing.
 */
function sortBasis(store, tab) {
  const saved = savedDetails(store, tab);
  return [saved.content ? 'text' : '', saved.channel || '', saved.youtubeCategory || ''].join('|');
}

async function classifyInBackground(tabs) {
  const store = await loadTabStore();
  await ensureClassifierPage();
  const response = await chrome.runtime.sendMessage({
    type: 'CLASSIFY_TABS',
    corrections: await loadCorrections(),
    useNano: await isNanoOn(),
    tabs: tabs.map(tab => {
      const saved = savedDetails(store, tab);
      return {
        url: tab.url,
        title: tab.title,
        description: saved.description || '',
        content: saved.content || '',
        channel: saved.channel || '',
        youtubeCategory: saved.youtubeCategory || '',
      };
    }),
  });
  if (response?.error) throw new Error(response.error);
  if (response.nano) await chrome.storage.session.set({ [NANO_STATUS_KEY]: response.nano });
  return response;
}

async function runAutoSort() {
  if (autoSortRunning) {
    autoSortAgain = true;
    return;
  }
  autoSortRunning = true;
  try {
    if (!(await isAutoSortOn())) return;

    const placements = await loadPlacements();
    const store = await loadTabStore();
    // A page can stay "loading" for a long time on ads and video. Once its text
    // has arrived, there's enough to sort it.
    // A YouTube video waits for its channel and category, so it doesn't land in
    // Entertainment first and jump to Study a second later.
    const hasText = (tab) => Boolean(savedDetails(store, tab).content);
    const isYouTubeVideo = (tab) => /^https:\/\/(www\.|m\.)?youtube\.com\/(watch|shorts\/|live\/)/.test(tab.url || '');
    const isReady = (tab) => hasText(tab) || (tab.status !== 'loading' && !isYouTubeVideo(tab));
    const isSorted = (tab) => placements[tab.id]?.url === withoutHash(tab.url)
      && placements[tab.id]?.basis === sortBasis(store, tab);
    const tabs = (await chrome.tabs.query({})).filter(tab => isSortable(tab) && isReady(tab) && !isSorted(tab));
    if (tabs.length === 0) return;

    const { placements: results, categoryNames } = await classifyInBackground(tabs);
    const managed = new Set(categoryNames);

    await saveUndoState(tabs.map(tab => tab.windowId));
    for (let i = 0; i < tabs.length; i++) {
      // A tab put in place by a snapshot keeps its spot until it navigates away.
      const manual = placements[tabs[i].id]?.manual && placements[tabs[i].id].url === withoutHash(tabs[i].url);
      placements[tabs[i].id] = { url: withoutHash(tabs[i].url), basis: sortBasis(store, tabs[i]), ...results[i], ...(manual && { manual }) };
      if (!manual) await placeTabInGroup(tabs[i], results[i], managed, placements);
    }
    await savePlacements(placements);

    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active) {
      await showTabCategoryOnBadge(active.id);
      await enforceFocus(active.id);
    }
  } catch (err) {
    console.warn('[Threadline] Automatic sort failed:', err.message);
  } finally {
    autoSortRunning = false;
    if (autoSortAgain) {
      autoSortAgain = false;
      scheduleAutoSort();
    }
  }
}

/** The group in this window for a category, if there is one. */
async function findCategoryGroup(windowId, category) {
  const groups = await chrome.tabGroups.query({ windowId });
  return groups.find(group => group.title === category) || null;
}

async function moveTabIntoCategoryGroup(tabId, windowId, placement) {
  const existing = await findCategoryGroup(windowId, placement.category);
  if (existing) {
    await editTabs(() => chrome.tabs.group({ groupId: existing.id, tabIds: [tabId] }));
    return existing.id;
  }
  const groupId = await editTabs(() => chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } }));
  await editTabs(() => chrome.tabGroups.update(groupId, { title: placement.category, color: placement.color }));
  return groupId;
}

/** Puts a tab in its group, keeping the group's tabs in subcategory order. */
async function placeTabInGroup(tab, placement, managed, placements) {
  if (tab.groupId !== undefined && tab.groupId !== -1) {
    const current = await chrome.tabGroups.get(tab.groupId);
    if (!managed.has(current.title)) return; // a group the user made
    if (current.title === placement.category) return;
  }
  const groupId = await moveTabIntoCategoryGroup(tab.id, tab.windowId, placement);

  const members = (await chrome.tabs.query({ groupId })).sort((a, b) => a.index - b.index);
  const others = members.filter(member => member.id !== tab.id);
  const following = others.find(member =>
    (placements[member.id]?.subcategoryRank ?? Infinity) > placement.subcategoryRank);
  const self = members.find(member => member.id === tab.id);
  if (!following || !self) return;
  const target = following.index < self.index ? following.index : following.index - 1;
  if (target !== self.index) await editTabs(() => chrome.tabs.move(tab.id, { index: target }));
}

/** Puts a popup sort into the tab strip: chain order, inside named groups. */
async function applySort(entries) {
  const windowTabs = await chrome.tabs.query({ currentWindow: true });
  const byId = new Map(windowTabs.map(tab => [tab.id, tab]));
  const groups = await chrome.tabGroups.query({ windowId: windowTabs[0]?.windowId });
  const titles = new Map(groups.map(group => [group.id, group.title]));
  const managed = new Set(entries.map(entry => entry.placement.category));
  const isUserGrouped = (tab) => tab.groupId !== undefined && tab.groupId !== -1 && !isManagedTitle(titles.get(tab.groupId), managed);

  const live = entries.filter(({ tabId }) => {
    const tab = byId.get(tabId);
    return tab && !tab.pinned && !isUserGrouped(tab);
  });
  await saveUndoState([windowTabs[0]?.windowId]);

  // Empty the old groups first: moving a tab across a group would pull it in.
  const managedTabs = live.map(entry => entry.tabId).filter(id => {
    const groupId = byId.get(id).groupId;
    return groupId !== undefined && groupId !== -1;
  });
  if (managedTabs.length) await editTabs(() => chrome.tabs.ungroup(managedTabs));

  const result = await applyTabOrder(live.map(entry => entry.tabId));

  const placements = await loadPlacements();
  const store = await loadTabStore();
  const tabsAfter = await chrome.tabs.query({ currentWindow: true });
  const stillOpen = new Set(tabsAfter.map(tab => tab.id));
  const byCategory = new Map();
  for (const { tabId, placement } of live) {
    if (!stillOpen.has(tabId)) continue;
    if (!byCategory.has(placement.category)) byCategory.set(placement.category, { placement, tabIds: [] });
    byCategory.get(placement.category).tabIds.push(tabId);
    placements[tabId] = { url: withoutHash(byId.get(tabId).url), basis: sortBasis(store, byId.get(tabId)), ...placement };
  }
  for (const { placement, tabIds } of byCategory.values()) {
    const groupId = await editTabs(() => chrome.tabs.group({ tabIds, createProperties: { windowId: tabsAfter[0].windowId } }));
    await editTabs(() => chrome.tabGroups.update(groupId, { title: placement.category, color: placement.color }));
  }
  await savePlacements(placements);

  const active = tabsAfter.find(tab => tab.active);
  if (active) await showTabCategoryOnBadge(active.id);
  return result;
}

// Every category a sort could produce isn't in `entries`, so a group from an
// earlier sort counts as ours if the placements recorded it.
function isManagedTitle(title, managed) {
  return managed.has(title) || KNOWN_GROUP_TITLES.has(title);
}
const KNOWN_GROUP_TITLES = new Set(['Study', 'Work', 'Entertainment', 'Games', 'Social', 'Shopping & Art', 'News', 'Life & Other']);

/** Records how the tabs are arranged, so Undo can put them back. */
async function saveUndoState(windowIds) {
  const state = [];
  for (const windowId of new Set(windowIds)) {
    if (windowId === undefined) continue;
    const tabs = await chrome.tabs.query({ windowId });
    const groups = await chrome.tabGroups.query({ windowId });
    state.push({
      windowId,
      tabs: tabs.sort((a, b) => a.index - b.index).map(tab => ({ id: tab.id, index: tab.index, groupId: tab.groupId ?? -1, pinned: !!tab.pinned })),
      groups: groups.map(group => ({ id: group.id, title: group.title, color: group.color, collapsed: group.collapsed })),
    });
  }
  await chrome.storage.session.set({ [UNDO_KEY]: { windows: state, placements: await loadPlacements() } });
}

async function undoLastSort() {
  const { [UNDO_KEY]: state } = await chrome.storage.session.get(UNDO_KEY);
  if (!state) return { ok: false };

  // Put categories back too. Tabs sorted for the first time keep their entry, so
  // automatic sorting doesn't immediately redo what was just undone.
  await savePlacements({ ...(await loadPlacements()), ...state.placements });

  for (const { windowId, tabs, groups } of state.windows) {
    const open = new Map((await chrome.tabs.query({ windowId })).map(tab => [tab.id, tab]));
    const grouped = [...open.values()].filter(tab => tab.groupId !== undefined && tab.groupId !== -1).map(tab => tab.id);
    if (grouped.length) await editTabs(() => chrome.tabs.ungroup(grouped));

    for (const { id, index } of tabs) {
      if (open.has(id)) await editTabs(() => chrome.tabs.move(id, { index })).catch(() => {});
    }
    for (const group of groups) {
      const tabIds = tabs.filter(tab => tab.groupId === group.id && open.has(tab.id)).map(tab => tab.id);
      if (tabIds.length === 0) continue;
      const groupId = await editTabs(() => chrome.tabs.group({ tabIds, createProperties: { windowId } }));
      await editTabs(() => chrome.tabGroups.update(groupId, { title: group.title, color: group.color, collapsed: group.collapsed }));
    }
  }
  await chrome.storage.session.remove(UNDO_KEY);
  return { ok: true };
}

/** Shows the tab's category on the toolbar icon. Focus mode's timer takes priority. */
async function showTabCategoryOnBadge(tabId) {
  if (await loadFocus()) return;
  const placement = (await loadPlacements())[tabId];
  if (!placement?.category) {
    await chrome.action.setBadgeText({ tabId, text: '' });
    return;
  }
  await chrome.action.setBadgeText({ tabId, text: placement.category.slice(0, 2).toUpperCase() });
  await chrome.action.setTitle({ tabId, title: `Threadline: ${placement.category} › ${placement.subcategory}` });
}

// ─── Focus Mode ───────────────────────────────────────────────────────────
//
// Pick a category and a duration, and the other groups collapse until the timer
// ends. Opening a tab from another category shows "!" on the badge, or with strict
// focus enabled, sends it to a "Back to Study" page. Tabs marked Unsure are never
// blocked, and the blocked page can always allow the site or end focus, because
// the classifier will sometimes be wrong.
//
// No screen controls this yet. In the service worker console:
//   threadline.startFocus('Study', 50)   threadline.endFocus()
//   threadline.setStrictFocus(true)

const FOCUS_KEY = 'focus_state';
const STRICT_FOCUS_KEY = 'strict_focus_enabled';
const FOCUS_END_ALARM = 'focus-end';
const FOCUS_TICK_ALARM = 'focus-tick';

async function loadFocus() {
  const { [FOCUS_KEY]: focus } = await chrome.storage.local.get(FOCUS_KEY);
  return focus && focus.endsAt > Date.now() ? focus : null;
}

async function isStrictFocusOn() {
  const { [STRICT_FOCUS_KEY]: enabled } = await chrome.storage.local.get(STRICT_FOCUS_KEY);
  return enabled === true;
}

async function showFocusBadge() {
  const focus = await loadFocus();
  if (!focus) return;
  const minutes = Math.max(1, Math.ceil((focus.endsAt - Date.now()) / 60000));
  await chrome.action.setBadgeText({ text: `${minutes}m` });
  await chrome.action.setTitle({ title: `Threadline: focusing on ${focus.category}` });
}

/** Collapses every category group except the one being focused on. */
async function collapseOtherGroups(category) {
  const groups = await chrome.tabGroups.query({});
  for (const group of groups) {
    if (!KNOWN_GROUP_TITLES.has(group.title)) continue;
    const collapsed = group.title !== category;
    if (group.collapsed !== collapsed) {
      await editTabs(() => chrome.tabGroups.update(group.id, { collapsed })).catch(() => {});
    }
  }
}

async function startFocus(category, minutes) {
  if (!KNOWN_GROUP_TITLES.has(category)) return { error: `Unknown category: ${category}` };
  if (!(minutes > 0)) return { error: 'Focus needs a duration in minutes' };

  const focus = { category, endsAt: Date.now() + minutes * 60000, allowedHosts: [] };
  await chrome.storage.local.set({ [FOCUS_KEY]: focus });
  await chrome.alarms.create(FOCUS_END_ALARM, { when: focus.endsAt });
  await chrome.alarms.create(FOCUS_TICK_ALARM, { periodInMinutes: 1 });
  await showFocusBadge();
  await collapseOtherGroups(category);
  return { ok: true, focus };
}

async function endFocus() {
  await chrome.storage.local.remove(FOCUS_KEY);
  await chrome.alarms.clear(FOCUS_END_ALARM);
  await chrome.alarms.clear(FOCUS_TICK_ALARM);
  await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setTitle({ title: 'Threadline' });
  const groups = await chrome.tabGroups.query({});
  for (const group of groups) {
    if (KNOWN_GROUP_TITLES.has(group.title) && group.collapsed) {
      await editTabs(() => chrome.tabGroups.update(group.id, { collapsed: false })).catch(() => {});
    }
  }
  return { ok: true };
}

/** Holds a tab to the focused category, if one is running. */
async function enforceFocus(tabId) {
  const focus = await loadFocus();
  if (!focus) return;

  const placement = (await loadPlacements())[tabId];
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  if (!placement?.category || !/^https?:/.test(tab.url || '') || placement.url !== withoutHash(tab.url)) return;

  const onTask = placement.category === focus.category || placement.subcategory === 'Unsure'
    || focus.allowedHosts.includes(safeHostname(tab.url));
  if (onTask) {
    await showFocusBadge();
    return;
  }

  if (await isStrictFocusOn()) {
    const params = new URLSearchParams({ url: tab.url, category: placement.category });
    await chrome.tabs.update(tabId, { url: chrome.runtime.getURL(`blocked.html?${params}`) });
  } else {
    await chrome.action.setBadgeText({ text: '!' });
  }
}

async function allowSiteDuringFocus(url) {
  const focus = await loadFocus();
  if (focus) {
    focus.allowedHosts.push(safeHostname(url));
    await chrome.storage.local.set({ [FOCUS_KEY]: focus });
  }
  return { ok: true };
}

/** Leaves the blocked page for a tab in the focused category, or closes it. */
async function leaveBlockedPage(tabId) {
  const focus = await loadFocus();
  const placements = await loadPlacements();
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
  const onTask = tabs.find(tab => tab.id !== tabId && placements[tab.id]?.category === focus?.category);
  if (onTask) await chrome.tabs.update(onTask.id, { active: true });
  if (tabId !== undefined) await chrome.tabs.remove(tabId);
  return { ok: true };
}

chrome.alarms.onAlarm.addListener(async ({ name }) => {
  if (name === FOCUS_END_ALARM) await endFocus();
  if (name === FOCUS_TICK_ALARM) {
    if (await loadFocus()) await showFocusBadge();
    else await endFocus();
  }
});

// ─── Corrections ──────────────────────────────────────────────────────────
//
// Drag a tab into another category's group, or pick a category for it in the
// popup, and Threadline remembers that for the whole site (for YouTube, the
// channel). Every open tab from that site moves too, and later ones follow.

const CORRECTIONS_KEY = 'site_corrections';   // correctionKey → { category, subcategory?, at }
const NANO_KEY = 'use_gemini_nano';
const NANO_STATUS_KEY = 'gemini_nano_status';
const SEARCH_SITES = /^(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com)$/;

/** Same as correctionKey in src/ml/categories.js, which this file can't import. */
function correctionKey(tab) {
  const host = safeHostname(tab.url).replace(/^www\./, '');
  if (!host || !/^https?:/.test(tab.url || '') || SEARCH_SITES.test(host)) return null;
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    const channel = (tab.channel || '').trim().toLowerCase();
    return channel ? `youtube:${channel}` : null;
  }
  return host;
}

async function loadCorrections() {
  const { [CORRECTIONS_KEY]: corrections } = await chrome.storage.local.get(CORRECTIONS_KEY);
  return corrections || {};
}

async function isNanoOn() {
  const { [NANO_KEY]: enabled } = await chrome.storage.local.get(NANO_KEY);
  return enabled === true;
}

/**
 * Remembers a category for a tab's site, and re-sorts every open tab from it.
 * @returns {Promise<{ok:true, key:string}|{error:string}>}
 */
async function correctTab(tabId, category, subcategory = null) {
  if (!KNOWN_GROUP_TITLES.has(category)) return { error: `Unknown category: ${category}` };
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { error: 'That tab is closed' };
  }
  const store = await loadTabStore();
  const key = correctionKey({ url: tab.url, channel: savedDetails(store, tab).channel });
  if (!key) return { error: "Searches and YouTube pages without a channel can't be remembered" };

  await withStoreLock(async () => {
    const corrections = await loadCorrections();
    corrections[key] = { category, ...(subcategory && { subcategory }), at: Date.now() };
    await chrome.storage.local.set({ [CORRECTIONS_KEY]: corrections });

    // Sort again every open tab this applies to, including this one.
    const placements = await loadPlacements();
    for (const open of await chrome.tabs.query({})) {
      const openKey = correctionKey({ url: open.url, channel: savedDetails(store, open).channel });
      if (openKey === key && placements[open.id]) {
        placements[open.id] = { ...placements[open.id], basis: null, manual: false };
      }
    }
    await savePlacements(placements);
  });
  scheduleAutoSort();
  return { ok: true, key };
}

async function forgetCorrection(key) {
  await withStoreLock(async () => {
    const corrections = await loadCorrections();
    delete corrections[key];
    await chrome.storage.local.set({ [CORRECTIONS_KEY]: corrections });
  });
  return { ok: true };
}

/** A tab you dragged into another category's group is a correction. */
async function learnFromMove(tabId, groupId) {
  if (groupId === -1 || isOwnEditMoment()) return;
  let group;
  try {
    group = await chrome.tabGroups.get(groupId);
  } catch {
    return;
  }
  if (!KNOWN_GROUP_TITLES.has(group.title)) return; // your own group: just leave the tab there
  const placement = (await loadPlacements())[tabId];
  if (!placement?.category || placement.category === group.title) return;
  await correctTab(tabId, group.title);
}

// ─── Snapshots ────────────────────────────────────────────────────────────
//
// A snapshot keeps a window's tabs in their order, with their groups, so an
// arrangement made by hand can be brought back. Restoring reuses tabs that are
// still open, reopens the rest, and marks them so automatic sorting doesn't
// move them again until they navigate somewhere new. Undo reverses a restore.

const SNAPSHOTS_KEY = 'snapshots';
const MAX_SNAPSHOTS = 20;

async function loadSnapshots() {
  const { [SNAPSHOTS_KEY]: snapshots } = await chrome.storage.local.get(SNAPSHOTS_KEY);
  return snapshots || [];
}

function defaultSnapshotName(time) {
  return new Date(time).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

async function saveSnapshot(name) {
  const tabs = (await chrome.tabs.query({ currentWindow: true })).sort((a, b) => a.index - b.index);
  const groups = tabs.length ? await chrome.tabGroups.query({ windowId: tabs[0].windowId }) : [];
  const createdAt = Date.now();
  const snapshot = {
    id: createdAt,
    name: (name || '').trim() || defaultSnapshotName(createdAt),
    createdAt,
    tabs: tabs.map(tab => ({
      url: tab.url || tab.pendingUrl || '',
      title: tab.title || '',
      pinned: Boolean(tab.pinned),
      group: tab.groupId !== undefined && tab.groupId !== -1 ? tab.groupId : null,
    })),
    groups: groups.map(group => ({ id: group.id, title: group.title || '', color: group.color, collapsed: Boolean(group.collapsed) })),
  };
  await withStoreLock(async () => {
    const snapshots = await loadSnapshots();
    await chrome.storage.local.set({ [SNAPSHOTS_KEY]: [snapshot, ...snapshots].slice(0, MAX_SNAPSHOTS) });
  });
  return { ok: true, snapshot };
}

async function deleteSnapshot(id) {
  await withStoreLock(async () => {
    const snapshots = await loadSnapshots();
    await chrome.storage.local.set({ [SNAPSHOTS_KEY]: snapshots.filter(snapshot => snapshot.id !== id) });
  });
  return { ok: true };
}

/** Pages a tab can't be opened on by an extension. */
const canReopen = (url) => /^(https?|file|ftp):/.test(url || '') || url === 'chrome://newtab/';

async function restoreSnapshot(id) {
  const snapshot = (await loadSnapshots()).find(entry => entry.id === id);
  if (!snapshot) return { error: 'That snapshot no longer exists' };

  const windowTabs = await chrome.tabs.query({ currentWindow: true });
  const windowId = windowTabs[0]?.windowId;
  await saveUndoState([windowId]);

  // Match each saved tab to an open one with the same page, each used once.
  const unused = new Map();
  for (const tab of windowTabs) {
    const key = withoutHash(tab.url || tab.pendingUrl);
    if (!unused.has(key)) unused.set(key, []);
    unused.get(key).push(tab);
  }
  const restored = []; // { tabId, saved }
  let reopened = 0;
  let skipped = 0;
  for (const saved of snapshot.tabs) {
    const match = unused.get(withoutHash(saved.url))?.shift();
    if (match) {
      restored.push({ tabId: match.id, saved });
    } else if (canReopen(saved.url)) {
      const tab = await asOwnEdit(() => chrome.tabs.create({ url: saved.url, windowId, active: false, pinned: saved.pinned }));
      restored.push({ tabId: tab.id, saved });
      reopened++;
    } else {
      skipped++;
    }
  }

  const grouped = restored.map(entry => entry.tabId).filter(tabId => {
    const tab = windowTabs.find(open => open.id === tabId);
    return tab && tab.groupId !== undefined && tab.groupId !== -1;
  });
  if (grouped.length) await editTabs(() => chrome.tabs.ungroup(grouped));
  for (const { tabId, saved } of restored) {
    const tab = windowTabs.find(open => open.id === tabId);
    if (tab && Boolean(tab.pinned) !== saved.pinned) await editTabs(() => chrome.tabs.update(tabId, { pinned: saved.pinned }));
  }
  await applyTabOrder(restored.map(entry => entry.tabId));

  for (const group of snapshot.groups || []) {
    const tabIds = restored.filter(entry => entry.saved.group === group.id && !entry.saved.pinned).map(entry => entry.tabId);
    if (tabIds.length === 0) continue;
    const groupId = await editTabs(() => chrome.tabs.group({ tabIds, createProperties: { windowId } }));
    await editTabs(() => chrome.tabGroups.update(groupId, { title: group.title, color: group.color, collapsed: group.collapsed }));
  }

  // Keep the arrangement: automatic sorting still learns each tab's category,
  // for the badge and focus mode, but leaves the tab where it is.
  await withStoreLock(async () => {
    const placements = await loadPlacements();
    for (const { tabId, saved } of restored) {
      placements[tabId] = { ...placements[tabId], url: withoutHash(saved.url), manual: true };
    }
    await savePlacements(placements);
  });
  scheduleAutoSort();
  return { ok: true, restored: restored.length, reopened, skipped };
}

// Reachable from the service worker console as well as the popup.
globalThis.threadline = {
  startFocus,
  endFocus,
  setStrictFocus: (enabled) => chrome.storage.local.set({ [STRICT_FOCUS_KEY]: enabled }),
  getFocus: loadFocus,
  runAutoSort,
  undoLastSort,
  saveSnapshot,
  restoreSnapshot,
  correctTab,
  correctionKey,
};

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
  await asOwnEdit(async () => {
    for (const [id, index] of moves) {
      try {
        await chrome.tabs.move(id, { index: index - failed });
      } catch {
        failed++; // closed mid-loop: everything after it shifts left by one
      }
    }
  });
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
        scheduleAutoSort();
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

    case 'APPLY_SORT':
      return applySort(message.entries);

    case 'UNDO_SORT':
      return undoLastSort();

    case 'GET_SORT_STATE': {
      const { [UNDO_KEY]: undo } = await chrome.storage.session.get(UNDO_KEY);
      return { autoSort: await isAutoSortOn(), canUndo: !!undo, placements: await loadPlacements() };
    }

    case 'SET_AUTO_SORT':
      await chrome.storage.local.set({ [AUTO_SORT_KEY]: message.enabled });
      if (message.enabled) scheduleAutoSort();
      return { ok: true };

    case 'START_FOCUS':
      return startFocus(message.category, message.minutes);

    case 'END_FOCUS':
      return endFocus();

    case 'GET_FOCUS':
      return { focus: await loadFocus(), strict: await isStrictFocusOn() };

    case 'SET_STRICT_FOCUS':
      await chrome.storage.local.set({ [STRICT_FOCUS_KEY]: message.enabled });
      return { ok: true };

    case 'FOCUS_ALLOW':
      return allowSiteDuringFocus(message.url);

    case 'FOCUS_GO_BACK':
      return leaveBlockedPage(sender.tab?.id);

    case 'CORRECT_TAB':
      return correctTab(message.tabId, message.category, message.subcategory);

    case 'GET_CORRECTIONS':
      return { corrections: await loadCorrections() };

    case 'FORGET_CORRECTION':
      return forgetCorrection(message.key);

    case 'SET_NANO':
      await chrome.storage.local.set({ [NANO_KEY]: message.enabled === true });
      return { ok: true };

    case 'GET_NANO': {
      const { [NANO_STATUS_KEY]: status } = await chrome.storage.session.get(NANO_STATUS_KEY);
      return { enabled: await isNanoOn(), backgroundStatus: status || null };
    }

    case 'SAVE_SNAPSHOT':
      return saveSnapshot(message.name);

    case 'GET_SNAPSHOTS':
      return { snapshots: await loadSnapshots() };

    case 'RESTORE_SNAPSHOT':
      return restoreSnapshot(message.id);

    case 'DELETE_SNAPSHOT':
      return deleteSnapshot(message.id);

    default:
      return { error: `Unknown message type: ${message.type}` };
  }
}
