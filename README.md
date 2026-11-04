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
   names each topic. Same tabs in →
   same clusters out.
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
- The one network request is the **model download**: the first time you sort,
  TensorFlow.js fetches Universal Sentence Encoder's weights (~25MB) from
  Google-hosted URLs (TF Hub / `storage.googleapis.com`). That request carries
  no tab data, but it means the first sort needs internet access, and Google
  sees that the download happened. Bundling the weights locally would remove
  this (see Roadmap).
- Permissions: `tabs` (list and reorder tabs), `storage` (local data), and a
  content script on all sites (to read the page text and dwell time that the
  ranking needs). `scripting` is used once, at install, to inject that content
  script into pages that were already open (Chrome only injects it into pages
  loaded afterwards). Without access to page text there is nothing to embed.

## Install and run

```bash
npm install
npm test               # 114 unit tests, no browser needed
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

**Results with the real model: not yet recorded.** Run `npm run eval:use` and
paste the table here. (The offline `hash` embedder exists only so the harness
can run anywhere; its numbers say nothing about Threadline's actual quality.)

**Not yet measured: personalisation.** Whether the learned network beats plain
cosine similarity needs *your* drag corrections as labels, so it cannot be
shipped as a fixed dataset. A proper test would record each user's corrections,
hold some out, and compare cosine-only against the blended ordering on those
held-out pairs. That experiment is still to do.

## Project layout

```
background.js        MV3 service worker: tab lifecycle, serialised storage writes, messages
content_script.js    Page text extraction + dwell tracking (shipped as-is, no imports)
src/ml/              embedder, graph (MST/DFS), clusterer, labeler, nn, feedback,
                     implicitFeedback, recency, pipeline
src/popup/           React popup UI
tests/               114 plain-Node tests (+ chrome.* mock in tests/helpers)
eval/                labelled tabs + chain-quality benchmark
```

See [CODE_GUIDE.md](CODE_GUIDE.md) for a guided tour of the code and
[CONTRIBUTING.md](CONTRIBUTING.md) for the dev workflow.

## Known limitations / roadmap

- Model weights are downloaded, not bundled (first sort needs internet).
- `npm run dev` (watch mode) does not copy the manifest and scripts; use
  `npm run build` and reload the extension instead.
- With four or more tabs there are always at least two groups: silhouette
  scores can't reliably tell a single-topic set from a multi-topic one (measured
  on this project's data, their ranges overlap). Agreement with the true topics
  is still modest on the offline stand-in embedder (adjusted Rand index about
  0.11 to 0.15, up from 0.06 to 0.11 with the earlier elbow heuristic, which
  returned exactly 2 clusters for up to 15 tabs); real numbers need
  `npm run eval:use`.
- Personalisation is untested against held-out data (see Evaluation).
- No Chrome Web Store listing yet.

## License

MIT — see [LICENSE](LICENSE).
