/**
 * tests/memory.test.js — the memory page's thinking (src/memory/memory.js):
 * search, sessions, trails, projects, names and resurfacing, on made-up vectors.
 * Run with: node tests/memory.test.js
 */
import { makeRunner, assert } from './helpers/chromeMock.js';
import {
  search, buildSessions, buildTrails, findProjects, nameFor, resurface, dayOf, pageKey, cleanTitle, pairKey,
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

test('going back to a page is one page to reopen, and a step in the path', () => {
  const a1 = 'https://www.redis.io/docs/persistence/?utm_source=x', a2 = 'https://redis.io/docs/persistence', b = 'https://redis.io/docs/resp';
  const pages = new Map([[a1, { title: 'Redis persistence', vector: near('redis') }], [a2, { title: 'Redis persistence', vector: near('redis') }], [b, { title: 'Redis RESP', vector: near('redis') }]]);
  const visits = [a1, b, a2].map((url, i) => ({ url, at: T0 + i * 3 * MIN }));
  visits.push({ away: true, at: T0 + 9 * MIN });
  const [trail] = buildTrails(visits, pages);
  assert(trail.pages.length === 2 && trail.pages[0].url === a2, trail.pages.map(p => p.url).join());
  assert(trail.pages[0].urls.length === 2, 'both addresses kept, so deleting forgets both');
  assert(trail.steps.map(s => s.back).join() === 'false,false,true', JSON.stringify(trail.steps));
});

test('page keys keep what names a page and drop tracking', () => {
  assert(pageKey('https://www.youtube.com/watch?v=abc&t=30') !== pageKey('https://www.youtube.com/watch?v=xyz'), 'different videos');
  assert(pageKey('https://example.com/a/?utm_source=x&ref=y') === pageKey('https://example.com/a'), 'tracking dropped');
  assert(pageKey('https://www.google.com/search?q=redis&sca=1') !== pageKey('https://www.google.com/search?q=kafka'), 'different searches');
});

test('one page, however long, is not a trail', () => {
  const pages = new Map([['g', { url: 'g', title: 'Branch • Branch • Chat - Google Gemini', vector: near('redis') }]]);
  assert(buildTrails([{ url: 'g', at: T0 }, { away: true, at: T0 + 25 * MIN }], pages).length === 0, 'no trail');
});

test('a loose chain of links does not pull different topics into one trail', () => {
  // The bridge page is linked to both topics on its own, so single-link grouping would chain them.
  const mix = (a, b) => { const v = near(a).map((x, i) => 0.6 * x + 0.4 * near(b)[i]); const n = Math.hypot(...v); return v.map(x => x / n); };
  const pages = new Map([
    ['r1', { title: 'Redis persistence', vector: near('redis') }], ['r2', { title: 'Redis protocol', vector: near('redis') }],
    ['x', { title: 'Bridge', vector: mix('redis', 'jobs') }],
    ['j1', { title: 'Stripe careers', vector: near('jobs') }], ['j2', { title: 'Greenhouse careers', vector: near('jobs') }],
  ]);
  const visits = ['r1', 'r2', 'x', 'j1', 'j2'].map((url, i) => ({ url, at: T0 + i * 3 * MIN }));
  visits.push({ away: true, at: T0 + 15 * MIN });
  const trails = buildTrails(visits, pages);
  assert(trails.map(t => t.pages.length).sort().join() === '2,3', trails.map(t => t.pages.length).join());
});

test('a followed link joins pages that are only loosely alike; without it they stay apart', () => {
  const loose = unit(near('redis').map((x, i) => 0.15 * x + 0.85 * near('jobs')[i])); // about 0.3 alike
  const pages = new Map([['https://a.test/x', { title: 'A', vector: near('redis') }], ['https://b.test/y', { title: 'B', vector: loose }]]);
  const visits = [{ url: 'https://a.test/x', at: T0 }, { url: 'https://b.test/y', at: T0 + 3 * MIN }, { away: true, at: T0 + 6 * MIN }];
  assert(buildTrails(visits, pages).length === 0, 'apart without a link');
  const linked = [...visits, { link: true, from: 'https://a.test/x', url: 'https://b.test/y', at: T0 + 3 * MIN }];
  const trails = buildTrails(linked, pages);
  assert(trails.length === 1 && trails[0].pages.length === 2, JSON.stringify(trails.map(t => t.pages.length)));
});

test('a launcher page linking to unrelated topics does not glue them together', () => {
  const pages = new Map([
    ['https://mail.test/inbox', { title: 'Inbox', vector: near('music') }],
    ['https://r.test/1', { title: 'Redis persistence', vector: near('redis') }], ['https://r.test/2', { title: 'Redis protocol', vector: near('redis') }],
    ['https://j.test/1', { title: 'Stripe careers', vector: near('jobs') }], ['https://j.test/2', { title: 'Greenhouse careers', vector: near('jobs') }],
  ]);
  const order = ['https://mail.test/inbox', 'https://r.test/1', 'https://r.test/2', 'https://mail.test/inbox', 'https://j.test/1', 'https://j.test/2'];
  const visits = order.map((url, i) => ({ url, at: T0 + i * 3 * MIN }));
  visits.push({ link: true, from: order[0], url: 'https://r.test/1', at: T0 + 3 * MIN }, { link: true, from: order[0], url: 'https://j.test/1', at: T0 + 12 * MIN });
  visits.push({ away: true, at: T0 + 18 * MIN });
  const trails = buildTrails(visits, pages);
  assert(trails.every(t => !(t.pages.some(p => p.url.includes('r.test')) && t.pages.some(p => p.url.includes('j.test')))), JSON.stringify(trails.map(t => t.pages.map(p => p.url))));
});

test('a page taken out of a trail is kept apart from the pages it was with', () => {
  const pages = new Map([['https://r.test/1', { title: 'Redis a', vector: near('redis') }], ['https://r.test/2', { title: 'Redis b', vector: near('redis') }]]);
  const visits = [{ url: 'https://r.test/1', at: T0 }, { url: 'https://r.test/2', at: T0 + 3 * MIN }, { away: true, at: T0 + 6 * MIN }];
  assert(buildTrails(visits, pages).length === 1, 'together first');
  const keptApart = new Set([pairKey(pageKey('https://r.test/1'), pageKey('https://r.test/2'))]);
  assert(buildTrails(visits, pages, { keptApart }).length === 0, 'apart after');
});

test('a followed link is not a visit and adds no time', () => {
  const [s] = buildSessions([{ url: 'a', at: T0 }, { link: true, from: 'a', url: 'b', at: T0 + MIN }, { url: 'b', at: T0 + 2 * MIN }]);
  assert(s.visits.map(v => v.ms / MIN).join() === '2,0', s.visits.map(v => v.ms / MIN).join());
});

section('projects');

// A trail as buildTrails makes it, on day `d`, with pages named by key.
const trail = (d, keys, topic, extra = {}) => ({
  start: T0 + d * DAY_MS, end: T0 + d * DAY_MS + 10 * MIN, ms: 10 * MIN, name: keys.join('+'), category: 'Work',
  pages: keys.map(k => ({ key: `site.test/${k}`, url: `https://site.test/${k}`, title: k, host: 'site.test', ms: 5 * MIN })),
  vector: near(topic), ...extra,
});

test('trails on the same topic on different days become a project, saying which trails', () => {
  const projects = findProjects([trail(0, ['a', 'b'], 'redis'), trail(2, ['c', 'd'], 'redis'), trail(1, ['x', 'y'], 'jobs')]);
  assert(projects.length === 1 && projects[0].days === 2 && projects[0].pages.length === 4, JSON.stringify(projects));
  assert(projects[0].trails.map(t => t.name).join() === 'c+d,a+b', projects[0].trails.map(t => t.name).join());
});

test('trails that share a page join whatever their topic', () => {
  const [project] = findProjects([trail(0, ['a', 'b'], 'redis'), trail(1, ['b', 'c'], 'jobs')]);
  assert(project?.pages.length === 3, JSON.stringify(project));
});

test('one day, or fewer than three pages, is not a project', () => {
  assert(findProjects([trail(0, ['a', 'b'], 'redis'), trail(0, ['c', 'd'], 'redis', { start: T0 + 60 * MIN })]).length === 0, 'one day');
  assert(findProjects([trail(0, ['a', 'b'], 'redis'), trail(1, ['a', 'b'], 'redis')]).length === 0, 'two pages');
});

test('pages kept apart keep their trails apart too', () => {
  const keptApart = new Set([pairKey('site.test/a', 'site.test/c')]);
  assert(findProjects([trail(0, ['a', 'b'], 'redis'), trail(1, ['c', 'd'], 'redis')], { keptApart }).length === 0, 'kept apart');
});

test('the same page at two addresses is one page in a project', () => {
  const t1 = trail(0, ['two-sum', 'three-sum'], 'redis');
  const t2 = trail(1, ['two-sum/description', 'valid-anagram'], 'redis');
  t2.pages[0].title = 'two-sum';
  const [project] = findProjects([t1, t2]);
  assert(project?.pages.length === 3, JSON.stringify(project?.pages.map(p => p.url)));
});

section('names, links and resurfacing');

test('names use the words titles share and skip filler and site names', () => {
  assert(nameFor(['Redis persistence - YouTube', 'Redis persistence explained', 'How Redis works']) === 'Redis Persistence', nameFor(['Redis persistence - YouTube', 'Redis persistence explained', 'How Redis works']));
  assert(nameFor(['Home']) === 'Home', 'falls back to the title');
  const grind = nameFor(['Grind 75 - A better Blind 75 you can customize, by the author of Blind 75']);
  assert(grind === 'Grind 75', grind);
});

test('repeats some sites pile into a title are dropped', () => {
  assert(cleanTitle('Branch • Branch • Branch • Casual Ties - Google Gemini') === 'Branch • Casual Ties - Google Gemini', cleanTitle('Branch • Branch • Branch • Casual Ties - Google Gemini'));
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
