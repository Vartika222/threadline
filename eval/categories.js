/**
 * eval/categories.js — how often does a tab land in the right category?
 *
 * eval/category_sites.json holds real websites with hand-assigned categories,
 * captured from their homepages. YOUTUBE_TITLES and SEARCHES below test the
 * content-based rules. Run with: npm run eval:categories
 */
import fs from 'node:fs';
import { classifyTabs } from '../src/ml/categories.js';
import { getEmbedder } from './embedders.js';

const sites = JSON.parse(fs.readFileSync(new URL('./category_sites.json', import.meta.url), 'utf8'));
const { embed } = await getEmbedder('minilm');

// Written by hand: not sampled from real YouTube, so treat as a sanity check.
const YOUTUBE_TITLES = [
  ['Study', 'But what is a neural network? | Deep learning chapter 1'], ['Study', 'Binary search algorithm explained with examples'],
  ['Study', 'Lecture 12: Thermodynamics second law, NPTEL course'], ['Study', 'Organic chemistry full course for beginners'],
  ['Study', 'Python tutorial for beginners, full course'], ['Study', 'Calculus 1 lecture: limits and continuity'],
  ['Study', 'Operating systems: process scheduling lecture'], ['Study', 'How to solve linear equations, class 10 maths'],
  ['Entertainment', 'Funniest moments compilation, try not to laugh'], ['Entertainment', 'Official trailer, new Netflix series 2026'],
  ['Entertainment', 'Taylor Swift official music video'], ['Entertainment', 'India vs Australia cricket match highlights'],
  ['Entertainment', 'Arijit Singh best songs jukebox'], ['Entertainment', 'Celebrity interview: late night talk show'],
  ['Games', 'Minecraft survival gameplay part 1'], ['Games', 'GTA 6 gameplay walkthrough'],
  ['Shopping & Art', 'Fall fashion haul and outfit ideas'], ['Shopping & Art', 'Makeup tutorial for beginners, everyday look'],
  ['Life & Other', 'Easy chicken curry recipe at home'], ['Life & Other', '10 minute yoga for back pain'],
  ['News', 'Breaking news: election results live coverage'], ['Work', 'How to run a project kickoff meeting at your company'],
];
const SEARCHES = [
  ['Shopping & Art', 'vogue'], ['Shopping & Art', 'buy running shoes online'], ['Study', 'what is photosynthesis'],
  ['Study', 'dijkstra algorithm explained'], ['Entertainment', 'best movies on netflix'], ['Games', 'best pc games 2026'],
  ['News', 'latest election news'], ['Life & Other', 'flights to delhi'], ['Life & Other', 'symptoms of flu'],
];

function score(name, cases, results) {
  const perCategory = {};
  let right = 0;
  const wrong = [];
  cases.forEach((c, i) => {
    const ok = results[i].category === c.category;
    right += ok;
    perCategory[c.category] = perCategory[c.category] || [0, 0];
    perCategory[c.category][0] += ok;
    perCategory[c.category][1] += 1;
    if (!ok) wrong.push(`${c.label} (${c.category} → ${results[i].category} › ${results[i].subcategory})`);
  });
  console.log(`\n${name}: ${right}/${cases.length} (${Math.round(100 * right / cases.length)}%)`);
  console.log('  ' + Object.entries(perCategory).map(([k, [a, b]]) => `${k} ${a}/${b}`).join(' · '));
  if (wrong.length) console.log('  wrong: ' + wrong.join('; '));
}

const siteCases = sites.map(s => ({ ...s, label: s.site }));
score('Sites, model only (no known sites list)', siteCases, await classifyTabs(siteCases, embed, { useRules: false }));
score('Sites, full classifier', siteCases, await classifyTabs(siteCases, embed));

const videos = YOUTUBE_TITLES.map(([category, title]) => ({
  category, label: title, title: `${title} - YouTube`, url: 'https://www.youtube.com/watch?v=x',
}));
score('YouTube videos by title', videos, await classifyTabs(videos, embed));

const searches = SEARCHES.map(([category, q]) => ({
  category, label: q, title: `${q} - Google Search`, url: `https://www.google.com/search?q=${encodeURIComponent(q)}`,
}));
score('Google searches', searches, await classifyTabs(searches, embed));
