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
2. **Embed.** A pretrained neural network, `all-MiniLM-L6-v2` (a small BERT-style
   transformer, run with Transformers.js on WebAssembly), turns each tab's text
   into a 384-dimensional vector.
3. **Compare.** Pairwise cosine similarity gives an N×N similarity matrix.
4. **Chain.** Two candidate orders are built: a maximum spanning tree (Kruskal
   with union-find) walked depth-first, and the best greedy "go to the most
   similar tab" walk. Local search polishes both, reversing stretches and moving
   short runs of tabs, and the chain with the higher total similarity between
   neighbours wins.
5. **Group.** Agglomerative clustering merges the most similar tabs step by step,
   and the silhouette score picks where to stop (2 to 8 groups, or one group if
   everything is about the same thing). TF-IDF names each topic. Same tabs in →
   same result out, whatever order they are in.
6. **Personalise (optional, off by default).** Turn on **Personalise sorting
   (experimental)** in the popup and Threadline learns one weight per embedding
   dimension on top of cosine similarity:

   ```
   score(a, b) = Σ (1 + adjustment[i]) × a[i] × b[i]
   ```

   Training labels come for free:

   - **Drag corrections.** A tab you drag next to another becomes a positive
     pair; a neighbour it leaves becomes a negative pair.
   - **Tab-switch bursts.** Bouncing between the same two tabs three times, each
     switch within five minutes of the last, queues a positive pair (an
     "attentional residue" signal). Each one is paired with one weak negative
     (the open tab least similar to it), so the training set isn't all positives.

   It trains once 15 examples exist and again after every 5 new ones. So far it
   has not been shown to help (see Evaluation).

## Privacy — what is and isn't on-device

- Tab text, URLs, behaviour data and your corrections **never leave your
  browser**. They live in `chrome.storage.local`. No analytics, no telemetry.
- **The language model ships inside the extension** (`all-MiniLM-L6-v2`, about
  23 MB, plus a 21 MB WebAssembly runtime), so sorting works offline and makes no
  request for the model.
- **Favicons:** the popup shows each tab's icon, so the browser may request it
  from that tab's own site. This is the only network traffic the popup causes.
- Permissions: `tabs` (list and reorder tabs), `storage` (local data), and a
  content script on all sites (to read the page text and dwell time). `scripting`
  is used at install, to inject that content script into pages that were already
  open (Chrome only injects it into pages loaded afterwards). Without access to
  page text there is nothing to embed. The page security policy allows
  `wasm-unsafe-eval`, which WebAssembly needs to run.
- Dwell time, revisit and tab-switch counts are still recorded locally, but
  nothing uses them for sorting since the neural network was removed. Recency
  only fades idle tabs in the popup.

## Install and run

```bash
npm install
npm test               # all tests, no browser needed
npm run build:verify   # builds dist/ and checks it is complete
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select the **`dist/`** folder. A step-by-step check-list is in
[LOAD_IN_CHROME.md](LOAD_IN_CHROME.md).

After any code change, run `npm run build` again and click the reload icon on
the extension's card in `chrome://extensions`.

## Evaluation

Run it yourself (works offline):

```bash
npm run eval        # offline lexical stand-in: checks the harness itself
npm run eval:model  # the real model
```

`eval/tabs.json` holds 48 labelled tabs (8 topics × 6), with short descriptions
as their text. Each trial draws a random subset of tabs and scores:

- **Neighbour agreement** — share of adjacent tabs in the chain from the same
  topic.
- **Runs per topic** — how fragmented each topic is along the chain (1 is ideal).
- **Clustering ARI** — how well the groups recover the true topics (1 is perfect,
  0 is chance).

**Short descriptions, `eval/tabs.json`** (100 trials per size, mean ± standard error):

| Tabs | Ordering | Neighbour agreement ↑ | Runs per topic ↓ |
| ---: | --- | ---: | ---: |
| 10 | **threadline** | **0.392 ± 0.011** | **1.055 ± 0.010** |
| 10 | mst-dfs alone | 0.361 ± 0.011 | 1.102 ± 0.011 |
| 10 | greedy-nn alone | 0.373 ± 0.012 | 1.082 ± 0.011 |
| 10 | random | 0.101 ± 0.010 | 1.498 ± 0.020 |
| 20 | **threadline** | **0.584 ± 0.006** | **1.152 ± 0.012** |
| 20 | mst-dfs alone | 0.526 ± 0.007 | 1.294 ± 0.017 |
| 20 | greedy-nn alone | 0.539 ± 0.006 | 1.262 ± 0.014 |
| 20 | random | 0.097 ± 0.006 | 2.355 ± 0.019 |
| 30 | **threadline** | **0.696 ± 0.005** | **1.229 ± 0.016** |
| 30 | mst-dfs alone | 0.623 ± 0.006 | 1.495 ± 0.020 |
| 30 | greedy-nn alone | 0.653 ± 0.005 | 1.385 ± 0.020 |
| 30 | random | 0.106 ± 0.005 | 3.377 ± 0.018 |

| Tabs | Clustering ARI ↑ |
| ---: | ---: |
| 10 | 0.514 ± 0.026 |
| 20 | 0.690 ± 0.017 |
| 30 | 0.722 ± 0.012 |

**Real page text** (100 trials per size). Those descriptions are also what the
methods were first compared on, so as a separate check I loaded 40 real pages
(8 topics × 5, from Wikipedia, react.dev, MDN and Python docs) and extracted their
text with the content script. This dataset isn't in the repo.

| Tabs | Threadline | MST alone | Greedy alone | Runs per topic (Threadline / MST) | ARI |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 0.404 | 0.372 | 0.392 | 1.01 / 1.06 | 0.595 |
| 20 | 0.632 | 0.595 | 0.624 | 1.02 / 1.11 | 0.902 |
| 30 | 0.750 | 0.715 | 0.737 | 1.03 / 1.16 | 0.929 |

**Close topics** are where the model choice matters most. This uses 49 real pages
on 5 pairs such as WWI vs WWII and planets vs stars, with 5 tabs from each topic
(300 trials), comparing the model this project used before:

| Model | Neighbour agreement | Chain keeps both topics unbroken | Topics given separate colours | ARI |
| --- | ---: | ---: | ---: | ---: |
| Universal Sentence Encoder (old) | 0.775 | 60% | 0% | 0.000 |
| **all-MiniLM-L6-v2** | **0.797** | **80%** | **100%** | **0.697** |

These numbers can't all be taken at face value: the single-topic cut-off and the
choice of model were made after looking at these test sets, so a fresh test set
might score somewhat lower.

**A broad single topic is usually split.** With 5 tabs on one broad topic such as
cooking, the groups came out right only 17% of the time, nearly always as 2 groups.
Lowering the cut-off fixes that but merges close topics. See
`SAME_TOPIC_SIMILARITY` in `src/ml/clusterer.js`. The chain order isn't affected.

(The offline `hash` embedder exists only so the harness can run anywhere; its
numbers say nothing about Threadline's actual quality.)

**Fine-tuning hasn't beaten the pretrained model on tabs.** See
[training/README.md](training/README.md) for how to run it and the results.

**Personalisation has not been shown to help.** A simulated user made consistent
drags through the real training code, and chains were scored on tabs left out of
training (20 seeds). Neighbour agreement against that user's own grouping:

| Examples | Plain cosine | Shipped model |
| ---: | ---: | ---: |
| 15 | 0.641 | 0.639 |
| 30 | 0.641 | 0.628 |
| 60 | 0.641 | 0.641 |

The shipped model stayed within about 0.02 of plain cosine in every scenario,
including random drags, so it does no real harm but learns little. An earlier
72,665-parameter network trained on the drags did clear damage (0.565 to 0.383 at
60 examples, 5 seeds, with the previous embedding model), so it was removed. That's
why this feature is off by default. A proper test would record real people's
corrections, hold some out, and compare.

## Project layout

```
background.js        MV3 service worker: tab lifecycle, serialised storage writes, messages
content_script.js    Page text extraction + dwell tracking (shipped as-is, no imports)
src/ml/              embedder, graph (chain), clusterer, labeler, personalise, feedback,
                     implicitFeedback, recency, pipeline
public/model/        The language model, bundled (see THIRD_PARTY_NOTICES.md)
training/            Scripts to fine-tune and convert the language model
src/popup/           React popup UI
tests/               Plain-Node tests (+ chrome.* mock in tests/helpers)
eval/                labelled tabs + chain-quality benchmark
```

See [CODE_GUIDE.md](CODE_GUIDE.md) for a guided tour of the code and
[CONTRIBUTING.md](CONTRIBUTING.md) for the dev workflow.

## Known limitations / roadmap

- Personalisation is off by default and hasn't been shown to help (see
  Evaluation).
- A broad single topic is usually split into two groups, and tabs can end up alone
  in a group (the 9-tab demo gives Shinkansen its own colour). The chain order isn't
  affected.
- The single-topic rule is one fixed similarity cut-off, tied to this model's scale.
- A sort takes about 2 seconds in a new popup and about 1 second again in the same
  popup, because WebAssembly runs on one thread in an extension popup.
- The extension is about 45 MB once built, because of the model and its runtime.
- Chrome keeps pinned tabs first, so Apply Order sorts them among themselves at
  the front. `chrome://` tabs aren't sorted and end up after the sorted tabs.
- No Chrome Web Store listing yet.

## License

MIT — see [LICENSE](LICENSE).
