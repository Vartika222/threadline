/**
 * tests/nano.test.js — the Gemini Nano classifier, against a fake Prompt API.
 * Run with: node tests/nano.test.js
 */
import { makeRunner, assert } from './helpers/chromeMock.js';

const { test, section, done } = makeRunner();
const nano = await import('../src/ml/nano.js');

section('Gemini Nano');

test('reports unsupported when Chrome has no Prompt API', async () => {
  delete globalThis.LanguageModel;
  assert((await nano.nanoStatus()) === 'unsupported', 'status');
});

test('only labels from our categories are accepted', () => {
  assert(nano.LABELS.includes('Work › AI Tools') && !nano.LABELS.some(l => l.endsWith('Unsure')), 'labels');
  const parsed = nano.parseLabel('"Study › Reference"');
  assert(parsed.category === 'Study' && parsed.subcategory === 'Reference', JSON.stringify(parsed));
  assert(nano.parseLabel('Study › Made up') === null && nano.parseLabel('not json') === null, 'rejects others');
});

test('the model sees the site, clean title, channel and some page text', () => {
  const text = nano.describeTab({ url: 'https://www.youtube.com/watch?v=a', title: '(3) A talk - YouTube', channel: 'TED', youtubeCategory: 'Education', content: 'x'.repeat(900) });
  assert(text.includes('Site: youtube.com') && text.includes('Title: A talk') && text.includes('YouTube channel: TED'), text);
  assert(text.length < 500, `kept short: ${text.length}`);
});

test('asks once per tab on a fresh copy of the session, with the labels enforced', async () => {
  const prompts = [];
  let destroyed = 0;
  let createOptions;
  globalThis.LanguageModel = {
    availability: async () => 'available',
    create: async (options) => {
      createOptions = options;
      return {
        clone: async () => ({
          prompt: async (text, { responseConstraint }) => {
            prompts.push({ text, enumSize: responseConstraint.enum.length });
            if (text.includes('broken')) throw new Error('too long');
            return JSON.stringify(text.includes('chatgpt') ? 'Work › AI Tools' : 'Entertainment › Streaming');
          },
          destroy: () => { destroyed++; },
        }),
      };
    },
  };
  assert((await nano.nanoStatus()) === 'available', 'status');
  const results = await nano.classifyWithNano([
    { url: 'https://chatgpt.com/', title: 'ChatGPT' },
    { url: 'https://broken.example/', title: 'broken' },
    { url: 'https://hotstar.com/', title: 'Hotstar' },
  ]);
  assert(results[0].subcategory === 'AI Tools' && results[1] === null && results[2].category === 'Entertainment', JSON.stringify(results));
  assert(prompts.length === 3 && prompts[0].enumSize === nano.LABELS.length && destroyed === 3, JSON.stringify(prompts));
  assert(createOptions.topK === 1 && createOptions.temperature === 0, 'most predictable answers');
  assert(createOptions.initialPrompts[0].content.includes('Work › AI Tools'), 'system prompt lists the labels');
});

test("gives up when Chrome never answers whether the model is there", async () => {
  globalThis.LanguageModel = { availability: () => new Promise(() => {}) };
  const started = Date.now();
  assert((await nano.nanoStatus()) === 'no-answer', 'status');
  assert(Date.now() - started < 5000, 'within a few seconds');
});

done();
