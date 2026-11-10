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

/** Joins records into groups of related ones (single link): each group's items in their original order. */
function groupRelated(items) {
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (related(items[i], items[j])) parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  items.forEach((item, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(item);
  });
  return [...groups.values()];
}

const STOP = new Set(('the and for with from your you this that what how why are was were has have its into about over more most our out new free best top '
  + 'home page login sign official site online watch video videos youtube google search wikipedia github reddit amazon linkedin '
  + 'com www http https part one two vs via using use guide tutorial').split(' '));

/** A short name for a group of pages, from the words their titles share: "Redis Persistence". */
export function nameFor(titles) {
  const counts = new Map();
  for (const title of titles) {
    for (const word of new Set(words(title))) {
      if (word.length < 3 || STOP.has(word) || /^\d+$/.test(word)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .filter(([, n], i) => i === 0 || n > 1)
    .slice(0, 2)
    .map(([w]) => w[0].toUpperCase() + w.slice(1));
  return top.join(' ') || (titles[0] || 'Untitled').slice(0, 40);
}

/**
 * Trails: within each session, the visits that belong together. A trail needs
 * at least two pages or five minutes, so one quick look isn't a trail.
 * `pages` maps url → page record (for vectors and categories).
 */
export function buildTrails(visits, pages) {
  const trails = [];
  for (const session of buildSessions(visits)) {
    const byUrl = new Map();
    for (const visit of session.visits) {
      const entry = byUrl.get(visit.url) || { url: visit.url, title: visit.title, ms: 0, first: visit.at, last: visit.at, ...pages.get(visit.url) };
      entry.ms += visit.ms;
      entry.last = visit.at;
      entry.title = pages.get(visit.url)?.title || visit.title || entry.title;
      byUrl.set(visit.url, entry);
    }
    for (const group of groupRelated([...byUrl.values()])) {
      const ms = group.reduce((s, p) => s + p.ms, 0);
      if (group.length < 2 && ms < 5 * 60 * 1000) continue;
      const ordered = [...group].sort((a, b) => a.first - b.first);
      const endsAt = [...group].sort((a, b) => b.last - a.last)[0];
      trails.push({
        name: nameFor(group.map(p => p.title)),
        start: ordered[0].first,
        end: endsAt.last,
        ms,
        pages: ordered.map(({ url, title, host, category }) => ({ url, title, host, category })),
        endsAt: { url: endsAt.url, title: endsAt.title },
        category: majority(group.map(p => p.category)),
      });
    }
  }
  return trails.sort((a, b) => b.start - a.start);
}

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
  const groups = [];
  const withVectors = pages.filter(p => p.vector).sort((a, b) => (a.firstSeen || 0) - (b.firstSeen || 0));
  for (const page of withVectors) {
    let best = null;
    let bestScore = -Infinity;
    for (const group of groups) {
      const centre = { vector: group.centre, category: group.category };
      const score = dot(page.vector, group.centre);
      if (related(page, centre) && score > bestScore) { best = group; bestScore = score; }
    }
    if (!best) groups.push(best = { pages: [], sum: new Array(page.vector.length).fill(0) });
    best.pages.push(page);
    for (let i = 0; i < page.vector.length; i++) best.sum[i] += page.vector[i];
    best.centre = normalise(best.sum);
    best.category = majority(best.pages.map(p => p.category));
  }
  return groups
    .map(group => {
      const days = new Set(group.pages.flatMap(p => p.days || [dayOf(p.lastSeen || p.firstSeen || 0)]));
      return {
        name: nameFor(group.pages.map(p => p.title)),
        category: group.category,
        days: days.size,
        lastSeen: Math.max(...group.pages.map(p => p.lastSeen || 0)),
        ms: group.pages.reduce((s, p) => s + (timeByUrl.get(p.url) || 0), 0),
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
