/**
 * tests/categories.test.js — the rules that decide a tab's category, with no model.
 * Run with: node tests/categories.test.js
 */
import {
  CATEGORIES, KNOWN_SITES, classifyByRules, classifyTabs, cleanTitle, classificationText,
  closestDescription, placementFor, MIN_CONFIDENCE,
} from '../src/ml/categories.js';
import { makeRunner, assert } from './helpers/chromeMock.js';

const { test, section, done } = makeRunner();
const is = (result, category, subcategory) => {
  assert(result.category === category, `category: ${JSON.stringify(result)}`);
  if (subcategory) assert(result.subcategory === subcategory, `subcategory: ${JSON.stringify(result)}`);
};

section('your tabs');

for (const [url, category, subcategory] of [
  ['https://swayam.gov.in/explorer', 'Study', 'Courses & Lectures'],
  ['https://www.hackerrank.com/dashboard', 'Study', 'Practice & Coding Prep'],
  ['https://www.hotstar.com/in/home', 'Entertainment', 'Streaming'],
  ['https://in.pinterest.com/', 'Social', 'Inspiration'],
  ['https://discord.com/channels/@me', 'Social', 'Messaging'],
  ['https://www.whistles.com/', 'Shopping & Art', 'Clothing'],
]) {
  test(`${new URL(url).hostname} → ${category} › ${subcategory}`, () => is(classifyByRules({ url }), category, subcategory));
}

section('YouTube');

test('homepage goes to Entertainment', () => {
  is(classifyByRules({ url: 'https://www.youtube.com/', title: '(1157) YouTube' }), 'Entertainment', 'Streaming');
});

test('a video on a study channel goes to Study', () => {
  is(classifyByRules({ url: 'https://www.youtube.com/watch?v=a', channel: 'NPTEL' }), 'Study', 'Courses & Lectures');
  is(classifyByRules({ url: 'https://www.youtube.com/watch?v=a', channel: '  3Blue1Brown ' }), 'Study');
});

test('other videos are judged by the model, defaulting to Entertainment', () => {
  const decision = classifyByRules({ url: 'https://www.youtube.com/watch?v=a', channel: 'Some Vlogger' });
  assert(decision.useModel === true, 'should use the model');
  is(decision.defaultTo, 'Entertainment');
});

test('YouTube Music counts as Music', () => {
  is(classifyByRules({ url: 'https://music.youtube.com/watch?v=a' }), 'Entertainment', 'Music');
});

section('searches');

test('a Google search is judged by its query', () => {
  const decision = classifyByRules({ url: 'https://www.google.com/search?q=vogue' });
  assert(decision.useModel && decision.text === 'vogue', JSON.stringify(decision));
});

test('country Google domains count too', () => {
  assert(classifyByRules({ url: 'https://www.google.co.in/search?q=a' }).text === 'a', 'google.co.in');
});

test('a search homepage has no topic', () => {
  is(classifyByRules({ url: 'https://www.google.com/' }), 'Life & Other', 'Unsure');
});

test('Google apps are not searches', () => {
  is(classifyByRules({ url: 'https://mail.google.com/mail/u/0/' }), 'Work', 'Productivity');
  is(classifyByRules({ url: 'https://classroom.google.com/' }), 'Study');
});

section('pages that refused to load');

test('a block page goes to Unsure rather than being guessed', () => {
  for (const title of ['Access Denied', 'Access to this page has been denied.', 'Just a moment...', '404 Not Found']) {
    is(classifyByRules({ url: 'https://unknown.example/', title }), 'Life & Other', 'Unsure');
  }
});

test('a known site stays in its category even when blocked', () => {
  is(classifyByRules({ url: 'https://www.hackerrank.com/', title: 'Access Denied' }), 'Study');
});

test('Google\'s "unusual traffic" page is not a search', () => {
  is(classifyByRules({ url: 'https://www.google.com/sorry/index?q=EgQtoken' }), 'Life & Other', 'Unsure');
});

section('known sites');

test('subdomains and www match', () => {
  is(classifyByRules({ url: 'https://www.github.com/a/b' }), 'Work');
  is(classifyByRules({ url: 'https://gist.github.com/a' }), 'Work');
  is(classifyByRules({ url: 'https://en.wikipedia.org/wiki/Kyoto' }), 'Study', 'Reference');
});

test('a look-alike domain does not match', () => {
  assert(classifyByRules({ url: 'https://notgithub.com/' }).useModel === true, 'should fall through to the model');
});

test('every known site names a real category and subcategory', () => {
  for (const [site, [category, subcategory]] of Object.entries(KNOWN_SITES)) {
    const entry = CATEGORIES.find(c => c.name === category);
    assert(entry, `${site}: no category ${category}`);
    assert(subcategory in entry.subcategories, `${site}: no subcategory ${subcategory}`);
  }
});

test('there are exactly the 8 agreed categories', () => {
  assert(CATEGORIES.map(c => c.name).join() === 'Study,Work,Entertainment,Games,Social,Shopping & Art,News,Life & Other', 'category list changed');
});

section('text');

test('cleanTitle removes notification counts and site names', () => {
  assert(cleanTitle('(1157) YouTube') === 'YouTube', cleanTitle('(1157) YouTube'));
  assert(cleanTitle('(3) A lecture - YouTube') === 'A lecture', cleanTitle('(3) A lecture - YouTube'));
  assert(cleanTitle('vogue - Google Search') === 'vogue', cleanTitle('vogue - Google Search'));
});

test('classificationText uses the channel, and does not repeat the title', () => {
  const text = classificationText({ title: 'T', channel: 'C', content: 'T. T. More words' });
  assert(text === 'C. T. More words', text);
});

section('model step');

const unit = (a, b) => [a, b];
const fakeEmbed = async (texts) => texts.map(text => (/shop|buy/i.test(text) ? unit(0, 1) : /nothing/i.test(text) ? unit(-1, 0) : unit(1, 0)));

test('closestDescription picks the highest score', () => {
  const best = closestDescription([1, 0], [
    { category: 'A', subcategory: 'a', vector: [0, 1] },
    { category: 'B', subcategory: 'b', vector: [1, 0] },
  ]);
  assert(best.category === 'B' && best.score === 1, JSON.stringify(best));
});

test('sites on the list never load the model', async () => {
  let calls = 0;
  const results = await classifyTabs([{ url: 'https://github.com/' }], async () => { calls++; return []; });
  assert(calls === 0, 'embed should not run');
  is(results[0], 'Work');
});

test('a tab with no close description goes to Unsure, and a video to Entertainment', async () => {
  const embed = async (texts) => texts.map(t => (t === 'x' ? new Array(2).fill(0) : [1, 0]));
  const [site, video] = await classifyTabs(
    [{ url: 'https://unknown.example/', title: 'x' }, { url: 'https://www.youtube.com/watch?v=a', title: 'x' }], embed);
  is(site, 'Life & Other', 'Unsure');
  is(video, 'Entertainment', 'Streaming');
  assert(MIN_CONFIDENCE > 0, 'threshold must be positive');
});

section('placement');

test('gives colour and ranks for the tab strip', () => {
  const p = placementFor({ category: 'Study', subcategory: 'Reference' });
  assert(p.color === 'blue' && p.categoryRank === 0 && p.subcategoryRank === 2, JSON.stringify(p));
});

await done();
