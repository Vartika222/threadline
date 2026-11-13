/**
 * THREADLINE — memory.js
 *
 * The thinking behind the memory page, with no storage or Chrome in it, so it
 * can be tested on its own. Everything here works on plain records:
 *
 *   page   { url, title, host, text, category, subcategory, vector, firstSeen, lastSeen, days }
 *   stash  { id, kind: 'page'|'quote'|'image', url, title, quote?, imageUrl?, text, category, vector, savedAt }
 *   visit  { url, title, at } or { away: true, at }   (one per tab switch or navigation)
 *
 * Vectors are unit-length MiniLM embeddings, so a dot product is the cosine.
 * The thresholds come from measuring MiniLM on real tab titles: pages on the same
 * topic score about 0.3 to 0.5, unrelated ones under 0.2, and a search that names
 * what it wants scores 0.45 or more on the right page.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_GAP_MS = 30 * 60 * 1000; // away this long and a new session starts
export const VISIT_CAP_MS = 30 * 60 * 1000;   // shortcut: no idle detection, so one visit counts at most 30 min; add chrome.idle if trails overcount
export const SEARCH_MIN = 0.25;
export const RESURFACE_MIN = 0.45;
const LINK_ALONE = 0.35;        // related whatever their categories
const LINK_SAME_CATEGORY = 0.2; // related when they also share a category

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** The calendar day of a time, in this computer's time zone: "2026-11-10". */
export function dayOf(time) {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Whether two records are about the same thing. */
export function related(a, b) {
  if (!a.vector || !b.vector) return Boolean(a.subcategory && a.category === b.category && a.subcategory === b.subcategory);
  const score = dot(a.vector, b.vector);
  return score >= LINK_ALONE || (score >= LINK_SAME_CATEGORY && Boolean(a.category) && a.category === b.category);
}

const words = (text) => (text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

/**
 * Ranks pages and stash items for a search, by meaning. A record containing every
 * word of the search (of three letters or more) is always found, and ranks higher.
 */
export function search(queryVector, query, records, { limit = 30 } = {}) {
  const terms = words(query).filter(w => w.length > 2);
  return records
    .map(record => {
      const meaning = record.vector && queryVector ? dot(queryVector, record.vector) : 0;
      const haystack = `${record.title || ''} ${record.quote || ''} ${record.text || ''}`.toLowerCase();
      const allWords = terms.length > 0 && terms.every(t => haystack.includes(t));
      return { record, score: meaning + (allWords ? 0.3 : 0) };
    })
    .filter(r => r.score >= SEARCH_MIN)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Splits visits into sessions and gives each visit its time: until the next
 * visit, at most VISIT_CAP_MS. Time spent away (the browser lost focus) isn't
 * counted, and being away for SESSION_GAP_MS or more starts a new session.
 */
export function buildSessions(visits) {
  const sorted = [...visits].sort((a, b) => a.at - b.at);
  const sessions = [];
  let current = null;
  for (let i = 0; i < sorted.length; i++) {
    const visit = sorted[i];
    const next = sorted[i + 1];
    const gap = next ? next.at - visit.at : 0;
    if (!visit.away) {
      if (!current) sessions.push(current = { start: visit.at, end: visit.at, visits: [] });
      const ms = Math.min(gap, VISIT_CAP_MS);
      current.visits.push({ ...visit, ms });
      current.end = visit.at + ms;
    }
    if (gap >= SESSION_GAP_MS) current = null;
  }
  return sessions;
}

/**
 * Groups related records. Each joins the group whose average it's most related to,
 * or starts its own; comparing with the whole group, not any one member, stops
 * a chain of loose links from pulling unrelated topics together.
 */
function cluster(items) {
  const groups = [];
  for (const item of items) {
    let best = null;
    let bestScore = -Infinity;
    for (const group of groups) {
      if (!item.vector || !group.centre) continue;
      const score = dot(item.vector, group.centre);
      if (related(item, { vector: group.centre, category: group.category }) && score > bestScore) { best = group; bestScore = score; }
    }
    if (!best) groups.push(best = { items: [], sum: item.vector ? new Array(item.vector.length).fill(0) : null });
    best.items.push(item);
    if (best.sum) {
      for (let i = 0; i < item.vector.length; i++) best.sum[i] += item.vector[i];
      best.centre = normalise(best.sum);
    }
    best.category = majority(best.items.map(p => p.category));
  }
  return groups.map(g => g.items);
}

/** A tab title without the repeats some sites pile up: "Branch • Branch • Chat" → "Branch • Chat". */
export function cleanTitle(title) {
  return [...new Set((title || '').split(' • ').map(t => t.trim()).filter(Boolean))].join(' • ').slice(0, 120);
}

const STOP = new Set(('the and for with from your you this that what how why are was were has have its into about over more most our out new free best top '
  + 'home page login sign official site online watch video videos youtube google search wikipedia github reddit amazon linkedin '
  + 'com www http https part one two vs via using use guide tutorial').split(' '));

/**
 * A short name for a group of pages: the words most of their titles share ("Redis Persistence"),
 * or, when they share none, the first title without its site name ("Grind 75").
 * Put the most important title first.
 */
export function nameFor(titles) {
  const counts = new Map();
  for (const title of titles) {
    for (const word of new Set(words(cleanTitle(title)))) {
      if (word.length < 3 || STOP.has(word) || /\d/.test(word)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  const need = Math.max(2, Math.ceil(titles.length / 2));
  const order = [...counts.keys()]; // first appearance, so ties read in title order
  const top = [...counts.entries()]
    .filter(([, n]) => n >= need)
    .sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))
    .slice(0, 2)
    .map(([w]) => w[0].toUpperCase() + w.slice(1));
  const first = cleanTitle(titles[0]).split(/\s+[-|–—•:]\s+/)[0];
  return top.join(' ') || first.slice(0, 40) || 'Untitled';
}

// Query values that name a different page (a search, a video, an item); everything else (tracking, sort, tab state) is ignored.
// shortcut: a fixed list, so a site that puts its page id in another parameter merges its pages; add the name here when one does.
const PAGE_PARAMS = ['q', 'query', 'search_query', 'k', 'v', 'list', 'id', 'p', 'page', 'currentJobId'];

/** One key per page: "site 1, then site 2, then site 1 again" is two pages, not three. */
export function pageKey(url) {
  try {
    const u = new URL(url);
    const kept = PAGE_PARAMS.filter(name => u.searchParams.has(name)).map(name => `${name}=${u.searchParams.get(name)}`);
    return `${u.host.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${kept.length ? `?${kept.join('&')}` : ''}`;
  } catch {
    return url;
  }
}

/**
 * Trails: within each session, the visits that belong together. A trail is a
 * move between at least two pages; sitting on one page isn't a trail.
 * `pages` maps url → page record (for vectors and categories).
 */
export function buildTrails(visits, pages) {
  const trails = [];
  for (const session of buildSessions(visits)) {
    const byKey = new Map();
    for (const visit of session.visits) {
      const key = pageKey(visit.url);
      const entry = byKey.get(key) || { key, urls: new Set(), ms: 0, first: visit.at };
      Object.assign(entry, pages.get(visit.url)); // the latest visit's page record wins, url included
      entry.url = visit.url;
      entry.urls.add(visit.url);
      entry.ms += visit.ms;
      entry.last = visit.at;
      entry.title = cleanTitle(pages.get(visit.url)?.title || visit.title || entry.title);
      byKey.set(key, entry);
    }
    for (const group of cluster([...byKey.values()])) {
      if (group.length < 2) continue;
      const ms = group.reduce((s, p) => s + p.ms, 0);
      const ordered = [...group].sort((a, b) => a.first - b.first);
      const endsAt = [...group].sort((a, b) => b.last - a.last)[0];
      // The path you took through these pages, in order, with going back to a page kept as a step.
      const inGroup = new Map(group.map(p => [p.key, p]));
      const steps = [];
      for (const visit of session.visits) {
        const page = inGroup.get(pageKey(visit.url));
        if (page && steps.at(-1)?.key !== page.key) steps.push({ key: page.key, title: page.title, url: page.url, at: visit.at, back: steps.some(s => s.key === page.key) });
      }
      trails.push({
        name: nameFor([...group].sort((a, b) => b.ms - a.ms).map(p => p.title)),
        start: ordered[0].first,
        end: endsAt.last,
        ms,
        pages: ordered.map(({ key, url, urls, title, host, category }) => ({ key, url, urls: [...urls], title, host, category })),
        steps,
        endsAt: { url: endsAt.url, title: endsAt.title },
        category: majority(group.map(p => p.category)),
      });
    }
  }
  return trails.sort((a, b) => b.start - a.start);
}

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

function majority(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function normalise(v) {
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}

/**
 * Projects: pages that keep coming up together over several days. Each page joins
 * the group whose average it's most related to, or starts its own; a group counts
 * as a project once it has `minPages` pages seen on `minDays` different days.
 * `timeByUrl` (optional) adds the time spent from visits.
 */
export function findProjects(pages, { minPages = 4, minDays = 2, timeByUrl = new Map() } = {}) {
  // One entry per page: the same address, or the same title on the same site ("Two Sum - LeetCode" at /two-sum and /two-sum/description).
  const merged = new Map();
  for (const page of [...pages].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))) {
    const title = cleanTitle(page.title);
    const keys = [pageKey(page.url), title && `${page.host || hostOf(page.url)}|${title.toLowerCase()}`].filter(Boolean);
    const same = keys.map(k => merged.get(k)).find(Boolean);
    if (same) {
      same.days = [...new Set([...(same.days || []), ...(page.days || [])])];
      same.firstSeen = Math.min(same.firstSeen || Infinity, page.firstSeen || Infinity);
      same.ms += timeByUrl.get(page.url) || 0;
      keys.forEach(k => merged.set(k, same));
    } else {
      const entry = { ...page, title, ms: timeByUrl.get(page.url) || 0 };
      keys.forEach(k => merged.set(k, entry));
    }
  }
  const unique = [...new Set(merged.values())].filter(p => p.vector).sort((a, b) => (a.firstSeen || 0) - (b.firstSeen || 0));
  const groups = cluster(unique).map(items => ({ pages: items, category: majority(items.map(p => p.category)) }));
  return groups
    .map(group => {
      const days = new Set(group.pages.flatMap(p => p.days || [dayOf(p.lastSeen || p.firstSeen || 0)]));
      return {
        name: nameFor([...group.pages].sort((a, b) => b.ms - a.ms).map(p => p.title)),
        category: group.category,
        days: days.size,
        lastSeen: Math.max(...group.pages.map(p => p.lastSeen || 0)),
        ms: group.pages.reduce((s, p) => s + p.ms, 0),
        pages: [...group.pages].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
          .map(({ url, title, host, category }) => ({ url, title, host, category })),
      };
    })
    .filter(p => p.pages.length >= minPages && p.days >= minDays)
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

/**
 * Stash items saved earlier that are about the same thing as a page just opened.
 * Items saved in the last `minAgeMs`, or from that same page, don't count: you
 * know about those already.
 */
export function resurface(page, stash, { now = Date.now(), minAgeMs = 60 * 60 * 1000 } = {}) {
  if (!page?.vector) return [];
  return stash
    .filter(item => item.vector && item.url !== page.url && now - item.savedAt >= minAgeMs
      && dot(page.vector, item.vector) >= RESURFACE_MIN)
    .sort((a, b) => a.savedAt - b.savedAt);
}

/** The text a page or stash item is embedded from. */
export function memoryText({ title, quote, text }) {
  return [quote, title, text].filter(Boolean).join('. ').slice(0, 400);
}
