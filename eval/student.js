/**
 * eval/student.js — does the trained student generalise on real embeddings?
 *
 * Uses the 83 hand-labelled sites in eval/category_sites.json as a stand-in for
 * Gemini Nano's answers. Five-fold cross-validation: the student trains on four
 * fifths of the sites (plus every category description) and is tested on the
 * fifth it never saw, against the description-matching model on the same
 * sites. Scores are per category, since that's what the sites are labelled with.
 * Run with: npm run eval:student
 */
import fs from 'node:fs';
import { classifyTabs, descriptionExamples, classificationText, CATEGORIES } from '../src/ml/categories.js';
import { trainStudent, predictStudent, CONFIDENCE } from '../src/ml/student.js';
import { getEmbedder } from './embedders.js';

const sites = JSON.parse(fs.readFileSync(new URL('./category_sites.json', import.meta.url), 'utf8'));
const { embed } = await getEmbedder('minilm');

// The sites only say which category, so train on its first subcategory.
const firstSub = Object.fromEntries(CATEGORIES.map(c => [c.name, Object.keys(c.subcategories).find(s => s !== 'Unsure')]));
const vectors = await embed(sites.map(s => classificationText(s)));
const seeds = await descriptionExamples(embed);
const baseline = await classifyTabs(sites, embed, { useRules: false });

const FOLDS = 5;
let studentRight = 0, baselineRight = 0, sure = 0, sureRight = 0, predictMs = 0;
for (let fold = 0; fold < FOLDS; fold++) {
  const train = sites.flatMap((s, i) => (i % FOLDS !== fold
    ? [{ vector: vectors[i], label: `${s.category} › ${firstSub[s.category]}`, source: 'nano' }] : []));
  const model = trainStudent([...seeds, ...train]);
  sites.forEach((s, i) => {
    if (i % FOLDS !== fold) return;
    const started = performance.now();
    const answer = predictStudent(model, vectors[i]);
    predictMs += performance.now() - started;
    if (answer.category === s.category) studentRight++;
    if (answer.confidence >= CONFIDENCE) { sure++; if (answer.category === s.category) sureRight++; }
    if (baseline[i].category === s.category) baselineRight++;
  });
}
const pct = (a, b) => `${a}/${b} (${Math.round(100 * a / b)}%)`;
console.log(`Sites never trained on, ${FOLDS}-fold cross-validation:`);
console.log(`  description matching: ${pct(baselineRight, sites.length)}`);
console.log(`  trained student:      ${pct(studentRight, sites.length)}`);
console.log(`  student when sure (≥ ${CONFIDENCE}): ${pct(sureRight, sure)}, answering ${pct(sure, sites.length)} of sites`);
console.log(`  time to decide, after embedding: ${(predictMs / sites.length).toFixed(2)} ms per tab`);
