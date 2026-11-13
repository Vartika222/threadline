/**
 * THREADLINE — db.js
 *
 * The memory lives in IndexedDB, which the service worker, the hidden
 * classifier page and the memory page can all open (they share the extension's
 * origin). chrome.storage is too small for it: about 10 MB in all.
 *
 * Stores:
 *   pages   keyed by url (without #fragment): what each page is about
 *   stash   keyed by id: what you saved
 *   visits  auto-numbered, indexed by time: each tab switch or navigation, time away, and each link you followed
 *
 * Nothing here leaves the computer.
 */

const NAME = 'threadline-memory';
const STORES = ['pages', 'stash', 'visits'];
let opening = null;

/** The database, or null where IndexedDB doesn't exist (tests under Node). */
export function openMemory() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('pages', { keyPath: 'url' }).createIndex('lastSeen', 'lastSeen');
      db.createObjectStore('stash', { keyPath: 'id' });
      db.createObjectStore('visits', { autoIncrement: true }).createIndex('at', 'at');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opening = null; reject(request.error); };
  });
  return opening;
}

/** Runs `work(stores)` in one transaction and resolves when it has committed. */
async function transact(names, mode, work) {
  const db = await openMemory();
  if (!db) return undefined;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    const stores = Object.fromEntries(names.map(n => [n, tx.objectStore(n)]));
    work(stores, (value) => { result = value; });
  });
}

export const getAll = (store) => transact([store], 'readonly', (s, done) => {
  s[store].getAll().onsuccess = (e) => done(e.target.result);
});

export const get = (store, key) => transact([store], 'readonly', (s, done) => {
  s[store].get(key).onsuccess = (e) => done(e.target.result);
});

export const put = (store, value) => transact([store], 'readwrite', (s) => { s[store].put(value); });

export const remove = (store, key) => transact([store], 'readwrite', (s) => { s[store].delete(key); });

/**
 * Reads a record, passes it to `change`, and saves what comes back, all in one
 * transaction, so two updates to the same record can't overwrite each other.
 * Returning null leaves it as it was.
 */
export const update = (store, key, change) => transact([store], 'readwrite', (s, done) => {
  s[store].get(key).onsuccess = (e) => {
    const next = change(e.target.result);
    if (next) s[store].put(next);
    done(next);
  };
});

/** Visits since `from` (a time), oldest first. */
export const visitsSince = (from) => transact(['visits'], 'readonly', (s, done) => {
  s.visits.index('at').getAll(IDBKeyRange.lowerBound(from)).onsuccess = (e) => done(e.target.result);
});

/** Deletes pages and visits not seen since `before`. Stash items are kept until you delete them. */
export const forgetBefore = (before) => transact(['pages', 'visits'], 'readwrite', (s) => {
  const range = IDBKeyRange.upperBound(before, true);
  s.pages.index('lastSeen').openCursor(range).onsuccess = (e) => { const c = e.target.result; if (c) { c.delete(); c.continue(); } };
  s.visits.index('at').openCursor(range).onsuccess = (e) => { const c = e.target.result; if (c) { c.delete(); c.continue(); } };
});

/** Deletes the visits to `urls` between two times (inclusive): how a trail, or one page of it, is deleted. Pages stay searchable. */
export const forgetVisits = (urls, from, to) => transact(['visits'], 'readwrite', (s) => {
  const wanted = new Set(urls);
  s.visits.index('at').openCursor(IDBKeyRange.bound(from, to)).onsuccess = (e) => {
    const c = e.target.result;
    if (!c) return;
    if (c.value.link) { if (wanted.has(c.value.url) || wanted.has(c.value.from)) c.delete(); }
    // Left as a gap, so the page visited before it isn't credited with this time.
    else if (wanted.has(c.value.url)) c.update({ away: true, at: c.value.at });
    c.continue();
  };
});

/** Deletes every page and visit from one site (stash items too, if `withStash`). */
export const forgetSite = (host, { withStash = false } = {}) => transact(STORES, 'readwrite', (s) => {
  const names = withStash ? STORES : ['pages', 'visits'];
  for (const name of names) {
    s[name].openCursor().onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return;
      let h = '';
      try { h = new URL(c.value.url).hostname; } catch { /* an away marker */ }
      if (h === host) c.delete();
      c.continue();
    };
  }
});

export const eraseAll = () => transact(STORES, 'readwrite', (s) => { for (const n of STORES) s[n].clear(); });
