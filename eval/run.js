/**
 * eval/run.js — does Threadline's chain beat simple baselines?
 *
 * For each tab-count N (default 10, 20, 30) it draws many random subsets of
 * the labelled tabs in eval/tabs.json (8 topics x 6 tabs), orders each subset
 * four ways, and scores how well each ordering keeps same-topic tabs together:
 *
 *   threadline best of MST + DFS and greedy, with local search (buildChainOrder)
 *   mst-dfs    maximum spanning tree + DFS traversal alone
 *   greedy-nn  greedy "go to the most similar unvisited tab" chain
 *   random     a random order (the floor)
 *
 * Usage:
 *   npm run eval                       # offline lexical stand-in (checks the harness)
 *   npm run eval:model                 # real model (all-MiniLM-L6-v2, bundled)
 *   node eval/run.js --trials=200 --sizes=10,20
 *
 * WHAT THIS DOES NOT MEASURE: personalisation. Whether the learned network
 * beats plain cosine similarity needs your own drag corrections as labels,
 * which can't be shipped as a fixed dataset. See README, "Evaluation".
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cosineSimilarity } from '../src/ml/embedder.js';
import { buildSimilarityMatrix, buildMST, traverseMST, buildChainOrder } from '../src/ml/graph.js';
import { getEmbedder } from './embedders.js';
import {
  mulberry32, shuffled, adjacentSameGroupRate, runsPerGroup,
  mean, stdErr,
} from './metrics.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// ─── Orderings ─────────────────────────────────────────────────────────────

export function mstDfsOrder(sim) {
  const n = sim.length;
  return traverseMST(buildMST(sim, n), n);
}

export function greedyNearestNeighbourOrder(sim) {
  const n = sim.length;
  const visited = new Array(n).fill(false);
  const order = [0];
  visited[0] = true;
  while (order.length < n) {
    const last = order[order.length - 1];
    let best = -1;
    let bestSim = -Infinity;
    for (let j = 0; j < n; j++) {
      if (!visited[j] && sim[last][j] > bestSim) { bestSim = sim[last][j]; best = j; }
    }
    visited[best] = true;
    order.push(best);
  }
  return order;
}

// ─── Main ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { embedder: 'hash', trials: 100, sizes: [10, 20, 30], seed: 7 };
  for (const a of argv) {
    const [k, v] = a.replace(/^--/, '').split('=');
    if (k === 'embedder') args.embedder = v;
    else if (k === 'trials') args.trials = Number(v);
    else if (k === 'sizes') args.sizes = v.split(',').map(Number);
    else if (k === 'seed') args.seed = Number(v);
  }
  return args;
}

export async function runEvaluation({ embedder: embedderName, trials, sizes, seed }) {
  const tabs = JSON.parse(fs.readFileSync(path.join(here, 'tabs.json'), 'utf8'));
  const groups = tabs.map(t => t.group);
  const embedder = await getEmbedder(embedderName);

  console.log(`Embedding ${tabs.length} labelled tabs with "${embedderName}"...`);
  const embeddings = await embedder.embed(tabs.map(t => t.content));

  const rand = mulberry32(seed);
  const rows = [];

  for (const size of sizes) {
    const scores = {
      'threadline': { adj: [], runs: [] },
      'mst-dfs':   { adj: [], runs: [] },
      'greedy-nn': { adj: [], runs: [] },
      'random':    { adj: [], runs: [] },
    };

    for (let t = 0; t < trials; t++) {
      const subset = shuffled(tabs.map((_, i) => i), rand).slice(0, size);
      const subEmb = subset.map(i => embeddings[i]);
      const subGroups = subset.map(i => groups[i]);
      const sim = buildSimilarityMatrix(subEmb, cosineSimilarity);

      const orders = {
        'threadline': buildChainOrder(sim),
        'mst-dfs':   mstDfsOrder(sim),
        'greedy-nn': greedyNearestNeighbourOrder(sim),
        'random':    shuffled(subGroups.map((_, i) => i), rand),
      };
      for (const [name, order] of Object.entries(orders)) {
        scores[name].adj.push(adjacentSameGroupRate(order, subGroups));
        scores[name].runs.push(runsPerGroup(order, subGroups));
      }

    }

    rows.push({ size, scores });
  }
  return { embedderName, trials, rows };
}

function fmt(xs) {
  return `${mean(xs).toFixed(3)} ± ${stdErr(xs).toFixed(3)}`;
}

export function renderMarkdown({ embedderName, trials, rows }) {
  const lines = [];
  lines.push(`# Threadline chain-quality evaluation`);
  lines.push('');
  lines.push(`Embedder: **${embedderName}**${embedderName === 'hash'
    ? ' (offline lexical stand-in, NOT the real model — numbers only validate the harness)'
    : ' (all-MiniLM-L6-v2)'}`);
  lines.push(`Trials per size: ${trials}. Values are mean ± standard error. Data: eval/tabs.json (8 topics × 6 tabs).`);
  lines.push('');
  lines.push('**Neighbour agreement** = share of adjacent tabs in the chain from the same topic (higher is better).');
  lines.push('**Runs per topic** = contiguous stretches per topic (1.0 is ideal; lower is better).');
  lines.push('');
  lines.push('| Tabs | Ordering | Neighbour agreement ↑ | Runs per topic ↓ |');
  lines.push('| ---: | --- | ---: | ---: |');
  for (const { size, scores } of rows) {
    for (const name of ['threadline', 'mst-dfs', 'greedy-nn', 'random']) {
      lines.push(`| ${size} | ${name} | ${fmt(scores[name].adj)} | ${fmt(scores[name].runs)} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

// Only run when invoked directly (so tests can import the helpers above).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  const result = await runEvaluation(args);
  const md = renderMarkdown(result);
  console.log('\n' + md);
  const outFile = path.join(here, `results-${args.embedder}.md`);
  fs.writeFileSync(outFile, md);
  console.log(`Saved ${path.relative(process.cwd(), outFile)}`);
}
