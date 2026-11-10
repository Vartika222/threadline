/**
 * tests/memory.test.js — the memory page's thinking (src/memory/memory.js):
 * search, sessions, trails, projects, names and resurfacing, on made-up vectors.
 * Run with: node tests/memory.test.js
 */
import { makeRunner, assert } from './helpers/chromeMock.js';
import {
  search, buildSessions, buildTrails, findProjects, nameFor, resurface, related, dayOf,
  DAY_MS, SESSION_GAP_MS, VISIT_CAP_MS,
} from '../src/memory/memory.js';

const { test, section, done } = makeRunner();

// One direction per topic; pages on a topic sit close to it (cosine about 0.8).
let seed = 3;
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
const unit = (v) => { const n = Math.hypot(...v); return v.map(x => x / n); };
const topics = { redis: unit(Array.from({ length: 64 }, rand)), jobs: unit(Array.from({ length: 64 }, rand)), music: unit(Array.from({ length: 64 }, rand)) };
const near = (topic) => unit(topics[topic].map(x => x + rand() * 0.12));
const page = (url, topic, extra = {}) => ({ url: `https://${url}`, title: url, vector: near(topic), ...extra });

const T0 = new Date(2026, 10, 10, 9, 0).getTime();
const MIN = 60 * 1000;

section('search');

test('finds pages by meaning, best first, and leaves out unrelated ones', () => {
  const records = [page('a.test/redis-aof', 'redis'), page('b.test/naukri', 'jobs'), page('c.test/redis-resp', 'redis')];
  const found = search(near('redis'), 'redis internals', records).map(r => r.record.url);
  assert(found.length === 2 && found.every(u => u.includes('redis')), found.join());
});

test('a page naming every word of the search gets a lift, so exact names win', () => {
  const a = { ...page('a.test', 'redis'), title: 'Redis persistence' };
  const b = { ...page('b.test', 'redis'), vector: a.vector, title: 'Something else' };
  const [first] = search(near('redis'), 'redis persistence', [b, a]);
  assert(first.record === a, first.record.title);
});

test('works on stash items with no page text, and on records with no vector yet', () => {
  const quote = { id: 1, quote: 'Squirrels forget many of their nuts', title: 'Blog' };
  assert(search(null, 'squirrels forget', [quote]).length === 1, 'found by its words');
});

section('sessions and trails');

test('a visit lasts until the next one, at most 30 minutes, and time away is not counted', () => {
  const [s] = buildSessions([
    { url: 'a', at: T0 }, { url: 'b', at: T0 + 10 * MIN }, { away: true, at: T0 + 12 * MIN }, { url: 'a', at: T0 + 20 * MIN },
  ]);
  assert(s.visits.map(v => v.ms / MIN).join() === '10,2,0', s.visits.map(v => v.ms / MIN).join());
});

test('30 minutes away, or on one page with no switch, starts a new session; the visit is capped', () => {
  const sessions = buildSessions([
    { url: 'a', at: T0 }, { away: true, at: T0 + MIN }, { url: 'b', at: T0 + MIN + SESSION_GAP_MS },
    { url: 'c', at: T0 + 2 * SESSION_GAP_MS + 5 * MIN },
  ]);
  assert(sessions.map(s => s.visits.length).join() === '1,1,1', sessions.map(s => s.visits.length).join());
  assert(sessions[1].visits[0].ms === VISIT_CAP_MS, 'capped');
});

test('interleaved topics in one session become separate trails, named from their titles', () => {
  const pages = new Map([
    ['r1', { url: 'r1', title: 'Redis persistence RDB', vector: near('redis'), category: 'Work' }],
    ['r2', { url: 'r2', title: 'Redis RESP protocol', vector: near('redis'), category: 'Work' }],
    ['j1', { url: 'j1', title: 'Stripe careers backend', vector: near('jobs'), category: 'Jobs & Hiring' }],
    ['j2', { url: 'j2', title: 'Greenhouse careers apply', vector: near('jobs'), category: 'Jobs & Hiring' }],
    ['m1', { url: 'm1', title: 'Lofi radio', vector: near('music'), category: 'Entertainment' }],
  ]);
  const visits = ['r1', 'j1', 'r2', 'j2', 'r1', 'm1'].map((url, i) => ({ url, title: url, at: T0 + i * 3 * MIN }));
  visits.push({ away: true, at: T0 + 18 * MIN + 30 * 1000 });
  const trails = buildTrails(visits, pages);
  const names = trails.map(t => t.name).sort();
  assert(names.join() === 'Careers,Redis', names.join()); // the 30 s look at lofi radio is not a trail
  const redis = trails.find(t => t.name === 'Redis');
  assert(redis.pages.length === 2 && redis.ms === 9 * MIN && redis.endsAt.url === 'r1', JSON.stringify(redis));
});

section('projects');

test('pages that keep coming back over several days become a project', () => {
  const pages = [
    ...['aof', 'resp', 'expiry', 'cluster'].map((p, i) => page(`redis.test/${p}`, 'redis', { title: `Redis ${p}`, days: [dayOf(T0 + i * DAY_MS)], lastSeen: T0 + i * DAY_MS })),
    ...['a', 'b', 'c', 'd'].map(p => page(`jobs.test/${p}`, 'jobs', { title: `Jobs ${p}`, days: [dayOf(T0)], lastSeen: T0 })),
  ];
  const projects = findProjects(pages);
  assert(projects.length === 1 && projects[0].name === 'Redis' && projects[0].days === 4, JSON.stringify(projects.map(p => [p.name, p.days])));
});

test('a topic with too few pages is not a project', () => {
  const pages = ['a', 'b', 'c'].map((p, i) => page(`r.test/${p}`, 'redis', { days: [dayOf(T0 + i * DAY_MS)] }));
  assert(findProjects(pages).length === 0, 'three pages');
});

section('names, links and resurfacing');

test('names use the words titles share and skip filler and site names', () => {
  assert(nameFor(['Redis persistence - YouTube', 'Redis persistence explained', 'How Redis works']) === 'Redis Persistence', nameFor(['Redis persistence - YouTube', 'Redis persistence explained', 'How Redis works']));
  assert(nameFor(['Home']) === 'Home', 'falls back to the title');
});

test('pages with no vector are related only by an identical subcategory', () => {
  assert(related({ category: 'Study', subcategory: 'Reference' }, { category: 'Study', subcategory: 'Reference' }), 'same');
  assert(!related({ category: 'Study', subcategory: 'Reference' }, { category: 'Study', subcategory: 'Courses & Lectures' }), 'different');
});

test('resurfaces older related stash items, not new ones, unrelated ones or the same page', () => {
  const now = T0 + 30 * DAY_MS;
  const opened = page('new.test/redis', 'redis');
  const stash = [
    { id: 1, url: 'https://old.test/redis', vector: near('redis'), savedAt: T0 },
    { id: 2, url: 'https://old.test/redis2', vector: near('redis'), savedAt: now - 5 * MIN },
    { id: 3, url: 'https://old.test/jobs', vector: near('jobs'), savedAt: T0 },
    { id: 4, url: opened.url, vector: opened.vector, savedAt: T0 },
  ];
  const found = resurface(opened, stash, { now }).map(i => i.id);
  assert(found.join() === '1', found.join());
});

await done();
