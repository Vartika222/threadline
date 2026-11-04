/**
 * tests/helpers/chromeMock.js
 *
 * A minimal in-memory stand-in for the chrome.* APIs Threadline uses, so
 * background.js and the storage-backed ML helpers can be tested in plain
 * Node. `latencyMs` adds random async delays to storage calls, which is
 * what makes lost-update races show up (real chrome.storage is async too).
 */
export function installChromeMock({ latencyMs = 0, openTabs = [] } = {}) {
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

  const listeners = { onCreated: [], onRemoved: [], onActivated: [], onUpdated: [], onMessage: [], onInstalled: [], onStartup: [] };
  const hook = (name) => ({ addListener: (fn) => listeners[name].push(fn) });

  globalThis.chrome = {
    storage: { local: area(local), session: area(session) },
    tabs: {
      onCreated: hook('onCreated'),
      onRemoved: hook('onRemoved'),
      onActivated: hook('onActivated'),
      onUpdated: hook('onUpdated'),
      sendMessage: async () => { throw new Error('no content script'); },
      query: async () => openTabs.map((t, index) => ({ ...t, index })),
      get: async (id) => {
        const t = openTabs.find(x => x.id === id);
        if (!t) throw new Error('No tab with id: ' + id);
        return { ...t };
      },
      // Like Chrome: unknown ids throw, and pinned tabs stay ahead of unpinned.
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
    runtime: { onMessage: hook('onMessage'), onInstalled: hook('onInstalled'), onStartup: hook('onStartup') },
  };

  return { local, session, listeners, injected };
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
