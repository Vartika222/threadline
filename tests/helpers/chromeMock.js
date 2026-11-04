/**
 * tests/helpers/chromeMock.js
 *
 * A minimal in-memory stand-in for the chrome.* APIs Threadline uses, so
 * background.js and the storage-backed ML helpers can be tested in plain
 * Node. `latencyMs` adds random async delays to storage calls, which is
 * what makes lost-update races show up (real chrome.storage is async too).
 */
export function installChromeMock({ latencyMs = 0, openTabs = [], classifier = null } = {}) {
  const groups = [];
  const badges = [];
  const alarms = {};
  const updates = [];
  let nextGroupId = 100;
  let offscreenOpen = false;
  const injected = [];
  const local = {};
  const session = {};

  const delay = () =>
    latencyMs
      ? new Promise(r => setTimeout(r, Math.random() * latencyMs))
      : Promise.resolve();

  const area = (store) => ({
    async get(keys) {
      await delay();
      if (keys == null) return structuredClone(store);
      const list = typeof keys === 'string'
        ? [keys]
        : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in store) out[k] = structuredClone(store[k]);
      return out;
    },
    async set(obj) {
      await delay();
      for (const [k, v] of Object.entries(obj)) store[k] = structuredClone(v);
    },
    async remove(keys) {
      await delay();
      for (const k of [].concat(keys)) delete store[k];
    },
  });

  const listeners = { onCreated: [], onRemoved: [], onActivated: [], onUpdated: [], onMessage: [], onInstalled: [], onStartup: [], onAlarm: [] };
  const hook = (name) => ({ addListener: (fn) => listeners[name].push(fn) });

  globalThis.chrome = {
    storage: { local: area(local), session: area(session) },
    tabs: {
      onCreated: hook('onCreated'),
      onRemoved: hook('onRemoved'),
      onActivated: hook('onActivated'),
      onUpdated: hook('onUpdated'),
      sendMessage: async () => { throw new Error('no content script'); },
      query: async (filter = {}) => openTabs
        .map((t, index) => ({ windowId: 1, groupId: -1, status: 'complete', ...t, index }))
        .filter(t => (filter.groupId === undefined || t.groupId === filter.groupId)
          && (filter.windowId === undefined || t.windowId === filter.windowId)
          && (filter.active === undefined || !!t.active === filter.active)),
      get: async (id) => {
        const t = openTabs.find(x => x.id === id);
        if (!t) throw new Error('No tab with id: ' + id);
        return { windowId: 1, groupId: -1, status: 'complete', ...t };
      },
      // Like Chrome: unknown ids throw, and pinned tabs stay ahead of unpinned.
      group: async ({ tabIds, groupId, createProperties }) => {
        const id = groupId ?? nextGroupId++;
        if (groupId === undefined) groups.push({ id, windowId: createProperties?.windowId ?? 1, title: '', color: 'grey', collapsed: false });
        for (const tabId of tabIds) {
          const tab = openTabs.find(t => t.id === tabId);
          if (!tab) throw new Error('No tab with id: ' + tabId);
          tab.groupId = id;
          // Chrome keeps a group's tabs next to each other.
          openTabs.splice(openTabs.indexOf(tab), 1);
          const last = openTabs.map(t => t.groupId).lastIndexOf(id);
          openTabs.splice(last >= 0 ? last + 1 : openTabs.length, 0, tab);
        }
        return id;
      },
      ungroup: async (tabIds) => {
        for (const tab of openTabs) if ([].concat(tabIds).includes(tab.id)) tab.groupId = -1;
        for (let i = groups.length - 1; i >= 0; i--) {
          if (!openTabs.some(t => t.groupId === groups[i].id)) groups.splice(i, 1);
        }
      },
      update: async (id, props) => {
        updates.push({ id, ...props });
        const tab = openTabs.find(t => t.id === id);
        if (!tab) throw new Error('No tab with id: ' + id);
        if (props.active) for (const t of openTabs) t.active = false;
        Object.assign(tab, props);
        return { ...tab };
      },
      remove: async (id) => {
        const i = openTabs.findIndex(t => t.id === id);
        if (i >= 0) openTabs.splice(i, 1);
      },
      move: async (id, { index }) => {
        const from = openTabs.findIndex(t => t.id === id);
        if (from < 0) throw new Error('No tab with id: ' + id);
        const [tab] = openTabs.splice(from, 1);
        const pinnedCount = openTabs.filter(t => t.pinned).length;
        const clamped = tab.pinned ? Math.min(index, pinnedCount) : Math.max(index, pinnedCount);
        openTabs.splice(Math.min(clamped, openTabs.length), 0, tab);
      },
    },
    scripting: {
      executeScript: async ({ target, files }) => { injected.push({ tabId: target.tabId, files }); },
    },
    tabGroups: {
      query: async ({ windowId } = {}) => groups.filter(g => windowId === undefined || g.windowId === windowId).map(g => ({ ...g })),
      get: async (id) => {
        const g = groups.find(x => x.id === id);
        if (!g) throw new Error('No group with id: ' + id);
        return { ...g };
      },
      update: async (id, props) => { Object.assign(groups.find(g => g.id === id), props); },
    },
    action: {
      setBadgeText: async (details) => { badges.push(details); },
      setTitle: async () => {},
    },
    alarms: {
      create: async (name, info) => { alarms[name] = info; },
      clear: async (name) => { delete alarms[name]; },
      onAlarm: hook('onAlarm'),
    },
    offscreen: {
      hasDocument: async () => offscreenOpen,
      createDocument: async () => { offscreenOpen = true; },
    },
    runtime: {
      onMessage: hook('onMessage'), onInstalled: hook('onInstalled'), onStartup: hook('onStartup'),
      getURL: (path) => `chrome-extension://test/${path}`,
      sendMessage: async (message) => (classifier ? classifier(message) : { error: 'no classifier' }),
    },
  };

  return { local, session, listeners, injected, groups, badges, alarms, updates };
}

/**
 * Tiny test runner shared by the new test files (same output style as the old
 * ones). Tests run strictly one after another because they share the global
 * chrome mock.
 */
export function makeRunner() {
  let passed = 0;
  let failed = 0;
  let chain = Promise.resolve();
  return {
    test(name, fn) {
      chain = chain.then(async () => {
        try {
          await fn();
          console.log(`  ✓ ${name}`);
          passed++;
        } catch (e) {
          console.error(`  ✗ ${name}`);
          console.error(`    ${e.message}`);
          failed++;
        }
      });
    },
    section(title) {
      chain = chain.then(() => console.log(`\n── ${title} ${'─'.repeat(Math.max(3, 56 - title.length))}`));
    },
    async done() {
      await chain;
      console.log('\n─────────────────────────────────────────────────────────────');
      console.log(`Results: ${passed} passed, ${failed} failed\n`);
      if (failed > 0) process.exit(1);
    },
  };
}

export function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}
