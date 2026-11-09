/**
 * tests/sorting.test.js — automatic sorting, tab groups, Undo and focus mode,
 * in background.js against a mocked chrome.* API.
 * Run with: node tests/sorting.test.js
 */
import { installChromeMock, makeRunner, assert } from './helpers/chromeMock.js';

const { test, section, done } = makeRunner();
let importCounter = 0;

const RULES = {
  study: { category: 'Study', subcategory: 'Courses & Lectures', color: 'blue', categoryRank: 0, subcategoryRank: 0 },
  reference: { category: 'Study', subcategory: 'Reference', color: 'blue', categoryRank: 0, subcategoryRank: 2 },
  shop: { category: 'Shopping & Art', subcategory: 'Clothing', color: 'pink', categoryRank: 5, subcategoryRank: 0 },
  unsure: { category: 'Life & Other', subcategory: 'Unsure', color: 'green', categoryRank: 7, subcategoryRank: 4 },
};
const NAMES = ['Study', 'Work', 'Entertainment', 'Games', 'Social', 'Shopping & Art', 'News', 'Life & Other'];
const classifier = (message) => ({
  placements: message.tabs.map(tab => (tab.youtubeCategory === 'Education' || tab.content === 'about studying'
    ? RULES.study
    : RULES[new URL(tab.url).hostname.split('.')[0]] || RULES.unsure)),
  categoryNames: NAMES,
});
const tab = (id, site, extra = {}) => ({ id, title: site, url: `https://${site}.test/`, ...extra });

async function boot(openTabs) {
  const mock = installChromeMock({ openTabs, classifier });
  await import(`../background.js?sorting=${++importCounter}`);
  return { ...mock, openTabs, api: globalThis.threadline };
}
const send = (listeners, message, sender = {}) => new Promise(resolve => listeners.onMessage[0](message, sender, resolve));
const groupTitles = ({ groups }) => groups.map(g => g.title).sort().join();
const order = (openTabs) => openTabs.map(t => t.id).join();

section('automatic sorting');

test('tabs go into named, coloured groups by category', async () => {
  const { api, groups, openTabs } = await boot([tab(1, 'study'), tab(2, 'shop'), tab(3, 'study')]);
  await api.runAutoSort();
  assert(groupTitles({ groups }) === 'Shopping & Art,Study', groupTitles({ groups }));
  assert(groups.find(g => g.title === 'Study').color === 'blue', 'colour');
  const studyId = groups.find(g => g.title === 'Study').id;
  assert(openTabs.filter(t => t.groupId === studyId).length === 2, 'both study tabs together');
});

test('a tab already sorted is not touched again', async () => {
  const { api, openTabs, groups } = await boot([tab(1, 'study')]);
  await api.runAutoSort();
  openTabs[0].groupId = -1; // the user dragged it out
  await api.runAutoSort();
  assert(openTabs[0].groupId === -1, 'a tab moved by hand should stay put');
  assert(groups.length >= 0, 'no error');
});

test('it is sorted again when it navigates somewhere new', async () => {
  const { api, openTabs, groups } = await boot([tab(1, 'study')]);
  await api.runAutoSort();
  openTabs[0].url = 'https://shop.test/';
  await api.runAutoSort();
  assert(openTabs[0].groupId === groups.find(g => g.title === 'Shopping & Art').id, 'moved to its new category');
});

test('groups the user made are left alone', async () => {
  const { api, openTabs, groups } = await boot([tab(1, 'study', { groupId: 50 })]);
  groups.push({ id: 50, windowId: 1, title: 'My project', color: 'red', collapsed: false });
  await api.runAutoSort();
  assert(openTabs[0].groupId === 50, 'stays in the user group');
});

test('pinned tabs and browser pages are skipped', async () => {
  const { api, openTabs, groups } = await boot([tab(1, 'study', { pinned: true }), { id: 2, title: 'Settings', url: 'chrome://settings' }]);
  await api.runAutoSort();
  assert(groups.length === 0, 'nothing grouped');
  assert(openTabs.every(t => (t.groupId ?? -1) === -1), 'nothing moved');
});

test('turning it off stops it', async () => {
  const { api, listeners, groups } = await boot([tab(1, 'study')]);
  await send(listeners, { type: 'SET_AUTO_SORT', enabled: false });
  await api.runAutoSort();
  assert(groups.length === 0, 'should not sort');
  const state = await send(listeners, { type: 'GET_SORT_STATE' });
  assert(state.autoSort === false, 'reports off');
});

test('tabs within a group stay in subcategory order', async () => {
  const { api, openTabs, groups } = await boot([tab(1, 'reference')]);
  await api.runAutoSort();
  openTabs.push(tab(2, 'study'));
  await api.runAutoSort();
  assert(openTabs.map(t => t.id).join() === '2,1', `got ${order(openTabs)}`);
  assert(groups.length === 1, 'one group');
});

test('a page still loading waits until its text has arrived', async () => {
  const { api, listeners, openTabs, groups } = await boot([tab(1, 'study', { status: 'loading' })]);
  await api.runAutoSort();
  assert(groups.length === 0, 'no text yet, so not sorted');
  await listeners.onCreated[0](openTabs[0]);
  await new Promise(resolve => listeners.onMessage[0](
    { type: 'TAB_DATA_UPDATE', payload: { url: openTabs[0].url, content: 'page text' } }, { tab: { id: 1 } }, resolve));
  await api.runAutoSort();
  assert(groups.length === 1, 'sorted once the text arrived');
});

const pageData = (listeners, payload) => new Promise(resolve =>
  listeners.onMessage[0]({ type: 'TAB_DATA_UPDATE', payload }, { tab: { id: 1 } }, resolve));

test('a YouTube video waits for its channel and category, then goes by them', async () => {
  const video = { id: 1, title: 'A course - YouTube', url: 'https://www.youtube.com/watch?v=a', status: 'complete' };
  const { api, listeners, openTabs, groups } = await boot([video]);
  await api.runAutoSort();
  assert(groups.length === 0, 'not sorted before YouTube says what the video is');
  await listeners.onCreated[0](openTabs[0]);
  await pageData(listeners, { url: video.url, content: 'A course', channel: 'Someone', youtubeCategory: 'Education' });
  await api.runAutoSort();
  assert(openTabs[0].groupId === groups.find(g => g.title === 'Study')?.id, groupTitles({ groups }));
});

test('a tab is sorted again when its details arrive after it was sorted', async () => {
  const { api, listeners, openTabs, groups } = await boot([tab(1, 'other')]);
  await api.runAutoSort();
  assert(groupTitles({ groups }) === 'Life & Other', groupTitles({ groups }));
  await listeners.onCreated[0](openTabs[0]);
  await pageData(listeners, { url: openTabs[0].url, content: 'about studying' });
  await api.runAutoSort();
  assert(openTabs[0].groupId === groups.find(g => g.title === 'Study')?.id, 'moved once its text arrived');
});

test('details saved for a previous page are not used for the new one', async () => {
  const { api, listeners, openTabs, groups } = await boot([tab(1, 'other')]);
  await listeners.onCreated[0](openTabs[0]);
  await pageData(listeners, { url: 'https://earlier.test/', content: 'about studying' });
  await api.runAutoSort();
  assert(groupTitles({ groups }) === 'Life & Other', groupTitles({ groups }));
});

test('retries while the user is dragging a tab', async () => {
  const { api, groups } = await boot([tab(1, 'study')]);
  const realGroup = chrome.tabs.group;
  let tries = 0;
  chrome.tabs.group = async (args) => {
    if (++tries < 3) throw new Error('Tabs cannot be edited right now (user may be dragging a tab).');
    return realGroup(args);
  };
  await api.runAutoSort();
  assert(tries === 3 && groups.length === 1, `tries ${tries}`);
});

test('the badge shows the active tab\'s category', async () => {
  const { api, listeners, badges } = await boot([tab(1, 'study', { active: true })]);
  await api.runAutoSort();
  await listeners.onActivated[0]({ tabId: 1 });
  assert(badges.some(b => b.text === 'ST' && b.tabId === 1), JSON.stringify(badges));
});

test('the group names in background.js match categories.js', async () => {
  const { CATEGORY_NAMES } = await import('../src/ml/categories.js');
  const source = (await import('node:fs')).readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  for (const name of CATEGORY_NAMES) assert(source.includes(`'${name}'`), `${name} missing from background.js`);
});

section('sort now and Undo');

const entry = (tabId, key) => ({ tabId, placement: RULES[key] });

test('Sort now orders tabs and groups them', async () => {
  const { listeners, openTabs, groups } = await boot([tab(1, 'shop'), tab(2, 'study'), tab(3, 'study')]);
  await send(listeners, { type: 'APPLY_SORT', entries: [entry(3, 'study'), entry(2, 'study'), entry(1, 'shop')] });
  assert(order(openTabs) === '3,2,1', order(openTabs));
  assert(groupTitles({ groups }) === 'Shopping & Art,Study', groupTitles({ groups }));
});

test('Undo restores the order and removes the groups', async () => {
  const { listeners, openTabs, groups } = await boot([tab(1, 'shop'), tab(2, 'study'), tab(3, 'study')]);
  await send(listeners, { type: 'APPLY_SORT', entries: [entry(3, 'study'), entry(2, 'study'), entry(1, 'shop')] });
  const reply = await send(listeners, { type: 'UNDO_SORT' });
  assert(reply.ok === true, 'ok');
  assert(order(openTabs) === '1,2,3', order(openTabs));
  assert(groups.length === 0, 'groups gone');
  const again = await send(listeners, { type: 'UNDO_SORT' });
  assert(again.ok === false, 'nothing left to undo');
});

test('Undo brings back a group the user had', async () => {
  const { listeners, openTabs, groups } = await boot([tab(1, 'shop', { groupId: 50 }), tab(2, 'study')]);
  groups.push({ id: 50, windowId: 1, title: 'Mine', color: 'red', collapsed: false });
  await send(listeners, { type: 'APPLY_SORT', entries: [entry(2, 'study')] });
  await send(listeners, { type: 'UNDO_SORT' });
  assert(groups.some(g => g.title === 'Mine' && g.color === 'red'), groupTitles({ groups }));
  assert(openTabs.find(t => t.id === 1).groupId !== -1, 'tab back in a group');
});

test('Undo does not re-sort tabs it just restored', async () => {
  const { api, listeners, groups } = await boot([tab(1, 'study')]);
  await api.runAutoSort();
  await send(listeners, { type: 'UNDO_SORT' });
  await api.runAutoSort();
  assert(groups.length === 0, 'should stay undone');
});

test('Undo puts back the previous category details', async () => {
  const { api, listeners } = await boot([tab(1, 'study')]);
  await api.runAutoSort();
  await send(listeners, { type: 'APPLY_SORT', entries: [entry(1, 'reference')] });
  await send(listeners, { type: 'UNDO_SORT' });
  const { placements } = await send(listeners, { type: 'GET_SORT_STATE' });
  assert(placements[1].subcategory === 'Courses & Lectures', JSON.stringify(placements[1]));
});

test('a tab closed before Sort now is skipped', async () => {
  const { listeners, groups } = await boot([tab(1, 'study')]);
  const reply = await send(listeners, { type: 'APPLY_SORT', entries: [entry(99, 'shop'), entry(1, 'study')] });
  assert(!reply.error, JSON.stringify(reply));
  assert(groupTitles({ groups }) === 'Study', groupTitles({ groups }));
});

section('focus mode');

async function focusing(strict = false) {
  const mock = await boot([tab(1, 'study', { active: true }), tab(2, 'shop'), tab(3, 'other')]);
  await mock.api.runAutoSort();
  if (strict) await send(mock.listeners, { type: 'SET_STRICT_FOCUS', enabled: true });
  await send(mock.listeners, { type: 'START_FOCUS', category: 'Study', minutes: 50 });
  return mock;
}

test('strict focus is off by default', async () => {
  const { listeners } = await boot([]);
  const { strict, focus } = await send(listeners, { type: 'GET_FOCUS' });
  assert(strict === false && focus === null, 'off, with no focus running');
});

test('starting collapses other groups, sets a timer and shows minutes', async () => {
  const { groups, alarms, badges } = await focusing();
  assert(groups.find(g => g.title === 'Shopping & Art').collapsed === true, 'other group collapsed');
  assert(groups.find(g => g.title === 'Study').collapsed === false, 'focus group open');
  assert(alarms['focus-end'], 'timer set');
  assert(badges.some(b => b.text === '50m'), JSON.stringify(badges));
});

test('rejects an unknown category and a bad duration', async () => {
  const { listeners } = await boot([]);
  assert((await send(listeners, { type: 'START_FOCUS', category: 'Nope', minutes: 5 })).error, 'category');
  assert((await send(listeners, { type: 'START_FOCUS', category: 'Study', minutes: 0 })).error, 'duration');
});

test('gentle focus warns on another category and does not block', async () => {
  const { listeners, badges, updates } = await focusing();
  await listeners.onActivated[0]({ tabId: 2 });
  assert(badges.at(-1).text === '!', JSON.stringify(badges.at(-1)));
  assert(!updates.some(u => u.url), 'should not redirect');
});

test('strict focus sends another category to the blocked page', async () => {
  const { listeners, openTabs } = await focusing(true);
  await listeners.onActivated[0]({ tabId: 2 });
  const shop = openTabs.find(t => t.id === 2);
  assert(shop.url.startsWith('chrome-extension://test/blocked.html?'), shop.url);
  assert(decodeURIComponent(shop.url).includes('https://shop.test/'), 'keeps the original address');
});

test('strict focus never blocks the focused category or Unsure', async () => {
  const { listeners, openTabs } = await focusing(true);
  await listeners.onActivated[0]({ tabId: 1 });
  await listeners.onActivated[0]({ tabId: 3 });
  assert(openTabs.find(t => t.id === 1).url === 'https://study.test/', 'study stays');
  assert(openTabs.find(t => t.id === 3).url === 'https://other.test/', 'unsure stays');
});

test('an allowed site is no longer blocked', async () => {
  const { listeners, openTabs } = await focusing(true);
  await send(listeners, { type: 'FOCUS_ALLOW', url: 'https://shop.test/' });
  await listeners.onActivated[0]({ tabId: 2 });
  assert(openTabs.find(t => t.id === 2).url === 'https://shop.test/', 'allowed');
});

test('ending focus reopens groups and stops blocking', async () => {
  const { listeners, openTabs, groups, alarms } = await focusing(true);
  await send(listeners, { type: 'END_FOCUS' });
  assert(groups.every(g => g.collapsed === false), 'groups reopened');
  assert(!alarms['focus-end'], 'timer cleared');
  await listeners.onActivated[0]({ tabId: 2 });
  assert(openTabs.find(t => t.id === 2).url === 'https://shop.test/', 'no longer blocked');
});

test('the timer running out ends focus', async () => {
  const { listeners } = await focusing();
  await listeners.onAlarm[0]({ name: 'focus-end' });
  const { focus } = await send(listeners, { type: 'GET_FOCUS' });
  assert(focus === null, 'ended');
});

test('Go back leaves the blocked page for a tab on task', async () => {
  const { listeners, openTabs } = await focusing(true);
  await send(listeners, { type: 'FOCUS_GO_BACK' }, { tab: { id: 2 } });
  assert(!openTabs.some(t => t.id === 2), 'blocked tab closed');
  assert(openTabs.find(t => t.id === 1).active === true, 'back on the focus tab');
});

await done();
