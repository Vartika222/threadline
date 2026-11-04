/**
 * tests/background.test.js
 *
 * Exercises background.js against a mocked chrome.* API.
 * Run with: node tests/background.test.js
 */
import { installChromeMock, makeRunner, assert } from './helpers/chromeMock.js';

const { test, section, done } = makeRunner();
let importCounter = 0;

/** Fresh mock + fresh copy of background.js (module state resets each time). */
async function boot(opts) { // opts: { latencyMs, openTabs }
  const mock = installChromeMock(opts);
  await import(`../background.js?run=${++importCounter}`);
  return mock;
}

section('background.js store writes');

test('20 concurrent onUpdated events lose no tab (write queue)', async () => {
  const { listeners, local } = await boot({ latencyMs: 8 });

  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      listeners.onUpdated[0](100 + i, { status: 'complete' }, {
        title: `Tab ${i}`, url: `https://example.com/${i}`,
      })
    )
  );

  const store = local.tabStore;
  const ids = Object.keys(store);
  assert(ids.length === 20, `expected 20 tabs in store, found ${ids.length} (lost updates)`);
  assert(store['105'].title === 'Tab 5', 'tab 105 should keep its own title');
});

test('mixed created/updated/removed events end in a consistent store', async () => {
  const { listeners, local } = await boot({ latencyMs: 5 });

  const ops = [];
  for (let i = 0; i < 10; i++) {
    ops.push(listeners.onCreated[0]({ id: i, title: `T${i}`, url: `https://a.com/${i}` }));
  }
  for (let i = 0; i < 5; i++) {
    ops.push(listeners.onRemoved[0](i));
  }
  await Promise.all(ops);
  // Removed events were queued after the creates for the same ids, so ids 0-4 must be gone.
  const ids = Object.keys(local.tabStore).map(Number).sort((a, b) => a - b);
  assert(ids.join(',') === '5,6,7,8,9', `expected tabs 5-9 to remain, got ${ids.join(',')}`);
});

test('onUpdated with an unparseable URL does not throw', async () => {
  const { listeners, local } = await boot();
  await listeners.onUpdated[0](7, { status: 'complete' }, { title: 'Weird', url: 'not a url at all' });
  assert(local.tabStore['7'].domain === '', 'domain should fall back to empty string');
  assert(local.tabStore['7'].title === 'Weird', 'title should still be stored');
});

test('onUpdated ignores non-complete status changes', async () => {
  const { listeners, local } = await boot();
  await listeners.onUpdated[0](9, { status: 'loading' }, { title: 'x', url: 'https://x.com' });
  assert(!local.tabStore || !local.tabStore['9'], 'loading event must not create an entry');
});

section('background.js activation + implicit pairs');

test('switching A→B counts as a transition and bumps revisitCount', async () => {
  const { listeners, local } = await boot();
  await listeners.onCreated[0]({ id: 1, title: 'A', url: 'https://a.com' });
  await listeners.onCreated[0]({ id: 2, title: 'B', url: 'https://b.com' });
  await listeners.onActivated[0]({ tabId: 1 });
  await listeners.onActivated[0]({ tabId: 2 });
  assert(local.tabStore['2'].transitionCount === 1, 'B should have 1 transition');
  assert(local.tabStore['2'].revisitCount === 1, 'B should have revisitCount 1');
  assert(!local.tabStore['1'].transitionCount, 'A was first activation, not a transition');
});

test('3 switches between the same pair queue exactly one implicit candidate', async () => {
  const { listeners, local } = await boot();
  await listeners.onCreated[0]({ id: 1, title: 'A', url: 'https://a.com' });
  await listeners.onCreated[0]({ id: 2, title: 'B', url: 'https://b.com' });
  // 1→2, 2→1, 1→2, 2→1  = 4 genuine transitions; third crosses the threshold.
  for (const id of [1, 2, 1, 2, 1]) await listeners.onActivated[0]({ tabId: id });
  const queued = JSON.parse(local.implicit_training_candidates);
  assert(queued.length === 1, `expected 1 queued candidate, got ${queued.length}`);
});

test('previous-active tab survives a service-worker restart', async () => {
  const first = await boot();
  await first.listeners.onCreated[0]({ id: 1, title: 'A', url: 'https://a.com' });
  await first.listeners.onCreated[0]({ id: 2, title: 'B', url: 'https://b.com' });
  await first.listeners.onActivated[0]({ tabId: 1 });

  // Simulate the worker being killed and restarted: fresh module state, same storage.
  const savedLocal = structuredClone(first.local);
  const savedSession = structuredClone(first.session);
  const second = installChromeMock();
  Object.assign(second.local, savedLocal);
  Object.assign(second.session, savedSession);
  await import(`../background.js?run=${++importCounter}`);

  await second.listeners.onActivated[0]({ tabId: 2 });
  assert(second.local.tabStore['2'].transitionCount === 1,
    'switch 1→2 after restart should still count as a transition');
});


section('background.js already-open tabs');

test('onInstalled registers tabs that were open before install and prunes stale ids', async () => {
  const { listeners, local } = await boot({
    openTabs: [
      { id: 10, title: 'Docs', url: 'https://docs.example.com/a' },
      { id: 11, title: 'Mail', url: 'https://mail.example.com' },
      { id: 12, title: 'Settings', url: 'chrome://settings' },
    ],
  });
  local.tabStore = { 999: { tabId: 999, title: 'Closed long ago' } }; // stale id from a previous session
  await listeners.onInstalled[0]({ reason: 'install' });
  const ids = Object.keys(local.tabStore).sort();
  assert(ids.join() === '10,11,12', `expected live tabs 10,11,12 only, got ${ids.join()}`);
  assert(local.tabStore['10'].domain === 'docs.example.com', 'domain is filled in');
});

test('onInstalled injects the content script into http(s) tabs only', async () => {
  const { listeners, injected } = await boot({
    openTabs: [
      { id: 1, title: 'A', url: 'https://a.com' },
      { id: 2, title: 'B', url: 'http://localhost:3000/x' },
      { id: 3, title: 'C', url: 'chrome://extensions' },
      { id: 4, title: 'D', url: 'about:blank' },
    ],
  });
  await listeners.onInstalled[0]({ reason: 'install' });
  const ids = injected.map(i => i.tabId).sort().join();
  assert(ids === '1,2', `expected injection into tabs 1,2 only, got ${ids}`);
  assert(injected[0].files[0] === 'content_script.js', 'injects content_script.js');
});

test('onStartup also syncs the store with live tabs', async () => {
  const { listeners, local } = await boot({ openTabs: [{ id: 5, title: 'X', url: 'https://x.com' }] });
  await listeners.onStartup[0]();
  assert(local.tabStore['5'], 'tab 5 should be registered on startup');
});

test('activating a tab we never saw created still registers it', async () => {
  const { listeners, local } = await boot({ openTabs: [{ id: 21, title: 'Late', url: 'https://late.com' }] });
  await listeners.onActivated[0]({ tabId: 21 });
  assert(local.tabStore['21'], 'unknown tab should be added on activation');
  assert(local.tabStore['21'].revisitCount === 1, 'and counted as one activation');
});

section('background.js messages');

test('TAB_DATA_UPDATE merges payload into the sender tab only', async () => {
  const { listeners, local } = await boot();
  await listeners.onCreated[0]({ id: 4, title: 'Old', url: 'https://a.com' });
  const reply = await new Promise(resolve =>
    listeners.onMessage[0](
      { type: 'TAB_DATA_UPDATE', payload: { dwellMs: 4200, content: 'fresh text' } },
      { tab: { id: 4 } },
      resolve
    )
  );
  assert(reply.ok === true, 'should reply ok');
  assert(local.tabStore['4'].dwellMs === 4200, 'dwell should be merged');
  assert(local.tabStore['4'].title === 'Old', 'unrelated fields must be preserved');
});

test('unknown message types return an error, not a crash', async () => {
  const { listeners } = await boot();
  const reply = await new Promise(resolve =>
    listeners.onMessage[0]({ type: 'NOPE' }, {}, resolve)
  );
  assert(reply.error && reply.error.includes('Unknown'), 'should report unknown type');
});

await done();
