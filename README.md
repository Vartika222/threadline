# ⬡ Threadline

> **An on-device Chrome extension that sorts your open tabs into a thread** — an
> order where each tab sits next to the one most related to it — and learns what
> "related" means to you.

Most tab managers sort tabs into buckets ("Work", "Shopping"). Threadline asks a
different question: *in what order do these tabs relate to each other?* Four
tabs in — React performance, V8 internals, a memory-management talk, a Rust
blog — you've lost the thread of what you were doing. Threadline lays the tabs
out along that thread and colour-codes the topics.

**Status:** working prototype, loaded unpacked in Chrome. Not published on the
Chrome Web Store.

---

## How it works

1. **Extract.** A content script reads each page's title, meta description,
   top headings and first paragraph, and tracks how long the tab is visible.
2. **Embed.** Universal Sentence Encoder (TensorFlow.js) turns each tab's text
   into a 512-dimensional vector.
3. **Compare.** Pairwise cosine similarity gives an N×N similarity matrix.
4. **Connect.** Kruskal's algorithm (with union-find) builds the *maximum*
   spanning tree: the strongest links that keep every tab connected.
5. **Order.** A depth-first traversal of that tree, starting from the most
   connected tab, produces the chain.
6. **Group.** UMAP reduces the embeddings to 2D, seeded k-means assigns topics
   (k, from 2 to 8, is the value with the best silhouette score), and TF-IDF
   names each topic. Same tabs in → same clusters out, whatever order they
   are in.
7. **Personalise.** A small two-tower-style network learns your idea of
   "related" from your behaviour:

```
Tab A embedding (512) → Dense(128) → Dense(32) ─┐   (content encoder,
Tab B embedding (512) → Dense(128) → Dense(32) ─┤    weights shared A/B)
                                                ├─ concat(80) → Dense(32) → Dropout(0.2) → Dense(1, sigmoid)
Tab A behaviour (6)   → Dense(16)  → Dense(8)  ─┤   (behaviour encoder,
Tab B behaviour (6)   → Dense(16)  → Dense(8)  ─┘    weights shared A/B)
```

   Behaviour features: dwell time, revisit count, hour of day (sin/cos),
   tab-switch count, and recency. Training labels come for free:

   - **Drag corrections.** A tab you drag next to another becomes a positive
     pair; an adjacency you break becomes a negative pair.
   - **Tab-switch bursts.** Bouncing between the same two tabs three times
     within five minutes queues a positive pair (an "attentional residue"
     signal). Each one is paired with one weak negative — the open tab least
     similar to it — so the training set isn't all positives.

   Once 15 examples exist the network's scores are blended 70/30 with plain
   cosine similarity (so cosine acts as a regulariser), and it retrains after
   every 5 new examples. Training uses each pair in both orders and scoring
   averages both orders, so a pair's score doesn't depend on which tab is
   listed first.

## Privacy — what is and isn't on-device

- Tab text, URLs, behaviour data and the trained network **never leave your
  browser**. They live in `chrome.storage.local`. No analytics, no telemetry.
- **Model download:** each time the popup first sorts, TensorFlow.js requests
  Universal Sentence Encoder from `tfhub.dev`, which redirects through
  `www.kaggle.com` to `storage.googleapis.com` (~25MB the first time, then mostly
  served from the browser cache). These requests carry no tab data, but **sorting
  needs internet access every time the popup is opened, even after the model has
  been downloaded**, and Google sees the requests. Bundling the weights locally
  would remove this (see Roadmap).
- **Favicons:** the popup shows each tab's icon, so the browser may also request
  it from that tab's own site.
- Permissions: `tabs` (list and reorder tabs), `storage` (local data), and a
  content script on all sites (to read the page text and dwell time that the
  ranking needs). `scripting` is used once, at install, to inject that content
  script into pages that were already open (Chrome only injects it into pages
  loaded afterwards). Without access to page text there is nothing to embed.

## Install and run

```bash
npm install
npm test               # 142 unit tests, no browser needed
npm run build:verify   # builds dist/ and checks it is complete
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select the **`dist/`** folder. A step-by-step check-list is in
[LOAD_IN_CHROME.md](LOAD_IN_CHROME.md).

After any code change, run `npm run build` again and click the reload icon on
the extension's card in `chrome://extensions`.

## Evaluation

Run it yourself:

```bash
npm run eval        # offline lexical stand-in: checks the harness itself
npm run eval:use    # real Universal Sentence Encoder (needs internet once)
```

`eval/tabs.json` holds 48 labelled tabs (8 topics × 6). Each trial draws a
random subset of 10, 20 or 30 tabs and scores:

- **Neighbour agreement** — share of adjacent tabs in the chain from the same
  topic. Compared against a greedy nearest-neighbour chain and a random order.
- **Runs per topic** — how fragmented each topic is along the chain.
- **Clustering ARI** — how well the UMAP + k-means clusters recover the true
  topics.

**Results with the real model** (100 trials per size, mean ± standard error):

| Tabs | Ordering | Neighbour agreement ↑ | Runs per topic ↓ |
| ---: | --- | ---: | ---: |
| 10 | mst-dfs | 0.324 ± 0.013 | 1.158 ± 0.016 |
| 10 | greedy-nn | 0.358 ± 0.012 | 1.107 ± 0.014 |
| 10 | random | 0.101 ± 0.010 | 1.498 ± 0.020 |
| 20 | mst-dfs | 0.476 ± 0.007 | 1.420 ± 0.018 |
| 20 | greedy-nn | 0.498 ± 0.007 | 1.364 ± 0.017 |
| 20 | random | 0.097 ± 0.006 | 2.355 ± 0.019 |
| 30 | mst-dfs | 0.543 ± 0.006 | 1.785 ± 0.023 |
| 30 | greedy-nn | 0.595 ± 0.005 | 1.598 ± 0.020 |
| 30 | random | 0.106 ± 0.005 | 3.377 ± 0.018 |

| Tabs | Clustering ARI ↑ |
| ---: | ---: |
| 10 | 0.228 ± 0.017 |
| 20 | 0.263 ± 0.012 |
| 30 | 0.252 ± 0.009 |

The chain is far better than random, but **the simple greedy walk scores slightly
higher than the MST chain** at every size. Clustering agreement is modest.
(The offline `hash` embedder exists only so the harness can run anywhere; its
numbers say nothing about Threadline's actual quality.)

**Personalisation has not been tested on real users, and a simulation suggests it
currently hurts.** A simulated user made consistent drags through the real
training code, and chains were scored on tabs left out of training (5 seeds, so
treat these as indicative). Neighbour agreement against that user's own grouping:

| Examples | Cosine only | Blended, same topics | Cosine only | Blended, user's merged groups |
| ---: | ---: | ---: | ---: | ---: |
| 15 | 0.548 | 0.557 | 0.696 | 0.670 |
| 30 | 0.548 | 0.435 | 0.696 | 0.565 |
| 60 | 0.548 | 0.235 | 0.696 | 0.443 |

A proper test would record each person's corrections, hold some out, and compare
cosine-only against the blended ordering on those held-out pairs.

## Project layout

```
background.js        MV3 service worker: tab lifecycle, serialised storage writes, messages
content_script.js    Page text extraction + dwell tracking (shipped as-is, no imports)
src/ml/              embedder, graph (MST/DFS), clusterer, labeler, nn, feedback,
                     implicitFeedback, recency, pipeline
src/popup/           React popup UI
tests/               142 plain-Node tests (+ chrome.* mock in tests/helpers)
eval/                labelled tabs + chain-quality benchmark
```

See [CODE_GUIDE.md](CODE_GUIDE.md) for a guided tour of the code and
[CONTRIBUTING.md](CONTRIBUTING.md) for the dev workflow.

## Known limitations / roadmap

- Model weights are downloaded, not bundled, so sorting needs internet access
  each time the popup is opened.
- `npm run dev` (watch mode) does not copy the manifest and scripts; use
  `npm run build` and reload the extension instead.
- With four or more tabs there are always at least two groups: silhouette
  scores can't reliably tell a single-topic set from a multi-topic one (measured
  on this project's data, their ranges overlap). Grouping tends to find too few
  topics: with 9 tabs across 3 topics it found exactly 3 groups only 24% of the
  time and 2 groups otherwise (adjusted Rand index about 0.23 to 0.26 overall,
  see Evaluation).
- Personalisation is untested on real users and got worse in simulation (see
  Evaluation). Moving one tab also labels pairs it isn't part of: the tabs it
  leaves behind become a positive pair, and the two it lands between become a
  negative pair.
- Chrome keeps pinned tabs first, so Apply Order sorts them among themselves at
  the front. `chrome://` tabs aren't sorted and end up after the sorted tabs.
- No Chrome Web Store listing yet.

## License

MIT — see [LICENSE](LICENSE).
