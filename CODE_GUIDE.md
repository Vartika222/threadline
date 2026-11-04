# Threadline — Code Guide

A file-by-file walkthrough of what exists, what each piece does, and why it's
built the way it is. Written so you can read the actual source alongside this
and understand every line, not just the vibe.

**How the pieces fit together, in one sentence each:**
`content_script.js` reads each page → `background.js` stores tab metadata and
watches for behavioural patterns → the popup (`App.jsx`) triggers
`pipeline.js`, which runs the ML pipeline and returns a sorted, labelled chain →
`TabChain.jsx` renders it and captures drag corrections → if personalisation is
on, those corrections train the weights in `personalise.js`.

---

## 1. `manifest.json`

The Chrome extension's config file (Manifest V3). Declares:
- **Permissions**: `tabs` (read/reorder tabs), `storage` (chrome.storage.local),
  `scripting`, `tabGroups`.
- **`background.service_worker`**: points to `background.js`, running as an
  ES module (`"type": "module"`) so it can use `import`/`export`.
- **`content_scripts`**: injects `content_script.js` into every page
  (`<all_urls>`) at `document_idle` (after the page's own scripts settle).
- **`action.default_popup`**: `popup.html`, the UI entry point.

Nothing clever here — it's the contract Chrome enforces between your code and
the browser's extension APIs.

---

## 2. `content_script.js`

Runs **inside every open tab's page**, isolated from that page's own JS
(can read the DOM, can't touch the page's variables).

**Two jobs:**

1. **Dwell time tracking.** Listens for `visibilitychange`, `focus`, `blur`.
   Each time the tab goes from visible→hidden, it adds the elapsed time to a
   running `totalDwell`. This is deliberately *not* "time tab was open" — a
   tab open in the background for 3 hours while you work elsewhere has near-
   zero dwell time, which is the correct signal (you weren't attending to it).

2. **Content extraction** (`extractContent()`). Pulls `title` → meta
   description → top `h1`/`h2` headings → first substantial `<p>`, and joins
   them into one string, **with the title repeated twice** — a cheap way to
   upweight the most reliable signal before it ever reaches the embedding
   model (which has no separate notion of "field importance", just one flat
   string).

Talks to `background.js` via `chrome.runtime.sendMessage` (fire-and-forget,
`.catch()`'d because the service worker might be asleep) and answers
`REQUEST_TAB_DATA` messages on demand.

---

## 3. `background.js`

The service worker — Manifest V3's replacement for a persistent background
page. **Critically, it is not persistent**: Chrome can kill and restart it at
any time, so every handler re-reads state from `chrome.storage.local` at the
top rather than trusting in-memory variables (the file's own comment says
this explicitly, and it's the right mental model for MV3).

**State it owns:** `tabStore` — a `{ tabId: tabMetadata }` map — persisted to
`chrome.storage.local`.

**Lifecycle listeners:**
- `onCreated` → initialises a tab's store entry (dwell=0, revisit=0, etc.)
- `onRemoved` → deletes it
- `onActivated` → increments `revisitCount`, updates `lastActive`, asks the
  content script for fresh data, and (new) increments `transitionCount` and
  runs implicit-pair detection (see below)
- `onUpdated` → refreshes title/URL/domain when a tab finishes loading

**Message handlers** (`chrome.runtime.onMessage`): `GET_ALL_TABS`,
`REQUEST_SORT` (hands raw tab data to the popup — the actual ML runs in the
popup, not here, because the model loads there), `APPLY_ORDER`
(moves tabs via `chrome.tabs.move`), `SAVE_SNAPSHOT`/`GET_SNAPSHOTS` (session
bookmarking, capped at 10).

**New in this pass — implicit pair detection.** A module-level
`previousActiveTabId` tracks the last tab you were on. On every genuine
switch (A→B, not just "still on A"), `recordTransitionForImplicitSignal`
looks up a `{pairKey: {count, lastSeen}}` map in storage. If you keep
bouncing between the *same two* tabs (3+ times within a 5-minute window), the
pair gets queued into `implicit_training_candidates` — tabIds only, no
embeddings (the service worker can't compute those). `pipeline.js` drains
this queue once it has embeddings available (see `implicitFeedback.js`).

**`transitionCount`** counts genuine tab switches. Nothing reads it for sorting
since the neural network was removed; it's still recorded locally.

---

## 4. ML pipeline (`src/ml/`)

### 4a. `embedder.js` — text → 384-dim vectors

Runs `all-MiniLM-L6-v2`, a pretrained sentence-embedding network, through
Transformers.js and ONNX Runtime on WebAssembly. Main exports:

- **`embedTexts(texts)`**: lazy-loads the model once (`_extractor` module cache)
  from the extension's own `model/` folder, using the runtime in `ort/`, with
  remote loading switched off. It averages the token vectors and normalises the
  result to unit length (`pooling: 'mean', normalize: true`).

- **`cosineSimilarity(a, b)`**: `dot(a,b) / (|a| * |b|)`. Cosine measures the
  *angle* between vectors, so a one-sentence title and a five-sentence description
  of the same topic still score as similar, where Euclidean distance would penalise
  the length difference.

**Why this model:** it replaced Universal Sentence Encoder because it tells close
topics apart far better. `training/` holds scripts to fine-tune it; so far neither
fine-tuned version has beaten the pretrained one on tabs.

### 4b. `graph.js` — similarity matrix → the chain

1. **`buildSimilarityMatrix`**: all-pairs cosine similarity, clamped to
   `[0,1]` (negative cosine values are treated as "no connection", not
   "anti-correlated").

2. **`buildMST` + `traverseMST`** give the first candidate. Kruskal's algorithm,
   inverted for a *maximum* spanning tree (sort edges descending, keep the
   strongest that don't create a cycle). Cycle detection uses a **Union-Find /
   Disjoint-Set** with *path compression* in `find()` and *union by rank* in
   `union()`, so each operation is amortised near-O(1) and the run is
   `O(E log E)`. A DFS from the highest-degree node, visiting neighbours in
   descending weight order, turns the tree into a line.

3. **`bestGreedyOrder`** gives the second candidate: a "go to the most similar
   unvisited tab" walk from every possible start, keeping the strongest.

4. **`improveChain`** is local search on either candidate. It keeps making small
   changes that raise the total similarity between neighbours until none is left:
   *2-opt* reverses a stretch to undo crossed connections, and *or-opt* moves a
   run of 1-3 tabs to rescue ones left stranded. A DFS jumps back up the tree when
   it finishes a branch, and greedy strands a few tabs for the end, so each has
   flaws this step repairs.

5. **`buildChainOrder`** runs both candidates through `improveChain` and keeps the
   higher total, which needs no topic labels. It beat both methods alone on
   neighbour agreement at every size in the README's Evaluation section.

`annotateChain` records the similarity to the *next* tab, which the UI uses for
the connector opacity and the `%` label. `reannotateChain` redoes that after a drag.

### 4c. `clusterer.js` — embeddings → topic colour groups

Pipeline: `embeddings → cosine similarities → agglomerative clustering →
best silhouette`.

- **`agglomerate`**: average-linkage clustering. Every tab starts alone, and the
  two groups most similar on average merge until one is left. The similarity
  between a merged group and the others is updated by a size-weighted average
  (Lance-Williams) rather than recomputed. Each step is a candidate clustering.
- **`silhouetteScore`**: how much closer each tab is to its own group than to the
  next-nearest one, using `1 - cosine` as distance. It picks among k =
  2..min(8, N/2).
- **`SAME_TOPIC_SIMILARITY`**: if even the final merge joins groups at least this
  alike, everything is one topic. It's tied to the model's scale and is a trade-off:
  at 0.3 close topics stay apart, but a broad single topic usually splits in two.
- **Three tabs or fewer** form one group.
- **No randomness**, and `canonicalTabOrder` in `pipeline.js` removes any
  dependence on tab order, so the same tabs always get the same groups.
- **What this replaced**: UMAP + seeded k-means, which usually found 2 or 3 groups
  however many topics were open. ARI on real page text at 20 tabs rose from about
  0.28 to 0.82, before the model change. `CONCEPT_CLUSTER.md` still covers UMAP and k-means as background.

### 4d. `labeler.js` — cluster index → human-readable name *(new)*

Turns "cluster 2" into "React Hooks" using **TF-IDF, computed per cluster
rather than per tab**.

- Each cluster's tabs are concatenated into one "document"; term frequency
  (TF) is counted within that document.
- **IDF** (inverse document frequency) is computed across *clusters*, not
  tabs: `idf(term) = log(numClusters / clustersContainingTerm) + 1`. A term
  that shows up in every cluster (generic web noise) gets driven toward a
  low but never-zero weight (the `+1` smoothing prevents it vanishing
  entirely and crashing the sort). A term unique to one cluster gets
  boosted — that's precisely "what makes this cluster different from the
  others," which is what you want in a label.
- A small hardcoded stopword list removes function words ("the", "and") and
  generic web noise ("page", "www", "html") that would otherwise dominate
  every cluster's word counts regardless of actual topic.
- **Honest limitation, stated in the file**: this is bag-of-words counting,
  not a language model. It doesn't know "hooks" and "useState" are related
  React concepts — it just counts co-occurring tokens. At small N (a handful
  of tabs per cluster) that's enough to produce a useful label; it is not a
  summarisation system, and you shouldn't expect it to synthesise a concept
  no single word in the corpus expresses.

### 4e. `recency.js` — "how long since this tab was touched" *(new)*

`computeRecencyNorm` returns 1 for a tab touched just now, falling to 0 at 30
minutes. The UI fades stale tabs with it. `formatIdleDuration` gives the "idle
12m" tooltip text. Both take an injectable `now`, so tests pass a fixed timestamp
and get deterministic results instead of depending on the clock.

### 4f. `personalise.js` — the optional learned weighting

Off unless the user ticks **Personalise sorting (experimental)**. For unit-length
vectors, cosine similarity is `Σ a[i] * b[i]`. This learns one weight per
dimension:

`score(a, b) = Σ (1 + adjustment[i]) * a[i] * b[i]`

- **It starts as cosine.** All adjustments start at 0, and regularisation pulls
  them back, so scant or inconsistent data can't wander far.
- **It compares tabs directly and is symmetric by construction**, so tab order
  can't matter.
- **Training** (`trainAdjustments`) is logistic loss with plain gradient descent:
  a few milliseconds, no random steps.
- **`shouldRetrain`**: train at 15 examples, then after every 5 new ones. It
  compares *lifetime* counts, because the stored count stops growing at the
  200-example cap.
- **`storeTrainingExample`**: embeddings are rounded to 4 decimals, roughly 6 KB
  per example, about 1.2 MB at the cap.

**The honest story, worth telling in an interview:** this file used to hold a
72,665-parameter two-tower network with behaviour features, trained on the user's
drags. Measuring it on tabs left out of training showed it made sorting worse as
it got more data (0.57 to 0.38 neighbour agreement at 60 examples), even after
cleaning up the labels. The neural network that now does the work is the pretrained
embedding model in `embedder.js`, and fine-tuning it is the next experiment
(`training/README.md`). A
smaller comparison network and a low-rank model also did damage when a simulated
user's corrections were inconsistent. This small model does no real harm, but stays
within about 0.02 of cosine, so it hasn't shown it learns much either. That's why
it's opt-in. The old network is in Git history.

### 4g. `feedback.js` — drag reorders → training pairs *(new)*

Pure function, `deriveTrainingPairs(beforeChain, afterChain)`. Compares the
*adjacency sets* of the chain before and after a drag:
- newly-adjacent pair → `label: 1` (user judged them related enough to put
  side by side)
- broken-adjacent pair → `label: 0` (user judged the model's pairing wrong)
- still-adjacent pair (untouched by the drag) → **no example generated at
  all** — the user didn't act on it, so it's not evidence either way.

Deliberately scoped to *neighbour* pairs only, not every pair whose relative
position shifted because of the move — one drag is weak evidence about one
relationship, and treating it as signal about every displaced pair would let
a single click overfit dozens of unrelated tabs.

### 4h. `implicitFeedback.js` — tab-switch bursts → training pairs *(new)*

The consumer side of the queue `background.js` fills. `consumeImplicitPairs`
reads `implicit_training_candidates` from storage, looks up each queued
`{aTabId, bTabId}` pair against the *current* pipeline run's tabs (which now
carry `.embedding`), and calls `storeTrainingExample(tabA, tabB, 1)` for each
survivor. Pairs referencing since-closed tabs are silently dropped. The
queue is cleared unconditionally afterward — candidates aren't retried, so a
closed tab's stale candidate doesn't linger forever.

This exists because `background.js` can *observe* which tabIds got bounced
between, but can't *embed* them (the language model loads in the popup) — so the tabId-only queue is the hand-off point
between "observed in the service worker" and "converted to a real training
example in the popup."

### 4i. `pipeline.js` — orchestrates all of the above

`runMLPipeline(tabs, onProgress)` first puts the tabs in `canonicalTabOrder`, so
tab-strip order can't affect anything. Then it runs, in order:
1. Embed all tabs (all-MiniLM-L6-v2)
2. Drain implicit tab-switch-burst candidates into training examples
3. Build the cosine similarity matrix
4. If personalisation is on and weights exist, use `scoreAllPairs` instead
5. `buildChainOrder`, then annotate similarities
6. Cluster (agglomerative)
7. Label each cluster (TF-IDF)

Returns `{ chain, clusters, clusterLabels, simMatrix, method, implicitExampleCount }`.
`method` is `'cosine'` or `'personalised'`, and the popup uses it to report what
the sort actually did. `simMatrix` lets it recalculate percentages after a drag.

---

## 5. Popup UI (`src/popup/`)

### 5a. `main.jsx`

Trivial: mounts `<App />` into `popup.html`'s `#root` div via
`createRoot().render()`. Standard React 18 entry point, nothing
extension-specific here.

### 5b. `App.jsx`

Top-level state machine with three views: `idle` (tab count + Sort button),
`sorting` (progress spinner), `sorted` (the chain + Apply/Cancel).

**New responsibilities added in this pass:**
- `handleReorder(reordered, movedTabId)`: called by `TabChain` after a drag.
  Recalculates the similarity shown between neighbours (`reannotateChain`), diffs
  old vs. new chain via `deriveTrainingPairs`, keeping only pairs that involve the
  dragged tab, stores them, and calls `maybeRetrain`. Examples are collected even
  with personalisation off.
- `maybeRetrain()`: does nothing unless personalisation is on, then asks
  `shouldRetrain(seen, nn_trained_count)` in `personalise.js`. `seen` is a lifetime
  count, because the stored count stops growing at the 200-example cap.
- `handleSort` also refreshes the example count and checks for a retrain *after*
  the pipeline runs, since implicit pairs can cross the threshold with zero drags.
- `LearningStatus` and `ClusterLegend` are small presentational components at the
  bottom of the file. The status reports the last sort's actual `method` ("✓ This
  sort used your corrections"), so it can't claim something that didn't happen.
- The idle tab list now fades each row by `computeRecencyNorm` and shows an
  "idle Nm/h" tooltip — the staleness cue applies before you even sort, not
  just in the chain view.

### 5c. `TabChain.jsx`

Renders the sorted chain as a horizontal scroll of cards + connector lines
(opacity = similarity strength, with the `%` value shown underneath).

**New: drag-and-drop reordering**, using native HTML5 DnD events
(`draggable`, `onDragStart`, `onDragOver` — must call `preventDefault()` to
even allow a drop — `onDrop`, `onDragEnd`), no external library. State is two
`useState` values: which index is being dragged, which index is currently
hovered (for the glow-highlight drop-target style). On drop, it splices the
array locally and calls `onReorder(newChain)` — the actual "is this a
positive or negative training example" logic lives in `feedback.js`, not
here; this component's job is purely to capture the gesture.

**Also new**: per-card opacity from `computeRecencyNorm` (stale tabs fade,
combined with the drag-opacity via a simple ternary rather than fighting CSS
class specificity), and a small "idle" badge under very stale cards
(`recency < 0.2`).

### 5d. `SortButton.jsx`

One button, no state. Takes `onClick`/`disabled`, renders the CTA. Nothing
more to say — this is intentionally the simplest file in the project.

### 5e. `styles.css`

Design tokens as CSS custom properties (`--accent`, `--bg-card`, etc.) —
dark, dense, "precision tool" aesthetic per the file's own header comment.
New rules added: `.chain-card-drop-target` (glow on hover-while-dragging),
`.learning-status` / `.learning-status-active` (the personalisation status
line), `.cluster-legend` / `.cluster-chip` (the colour+name chips), and
`.chain-stale-badge` (the small "idle" pill).

---

## 6. Tests (`tests/`)

All plain Node scripts (`node tests/x.test.js`), no test framework — each
file exits non-zero on failure, which is enough for a project this size and
keeps the dependency list short. `npm test` chains all the test files.
`tests/helpers/chromeMock.js` provides an in-memory fake of `chrome.storage`
and the `chrome.tabs` event hooks, plus the small runner the newer files use.

| File | What it proves |
|---|---|
| `graph.test.js` | MST has N-1 edges, DFS visits every node once, `buildChainOrder` returns every tab once and is at least as strong as MST or greedy alone, local search never lowers the total, 200 tabs finish in under a second |
| `clusterer.test.js` | One label per tab, distinct topics get distinct clusters, handles one or two tabs |
| `kselection.test.js` | The right number of groups for 1, 2, 3 and 5 separate topics; never above 8 or N/2; deterministic; silhouette scores behave on perfect, wrong and singleton clusterings |
| `retrain.test.js` | `shouldRetrain`: trains at 15, still triggers when the count jumps past a checkpoint (13 → 16), waits for 5 new examples between trainings, keeps training past the 200-example storage cap |
| `personalise.test.js` | Off by default; with no adjustment it equals cosine; always symmetric and on the 0-1 scale; training moves scores the right way, is deterministic and fast; inconsistent corrections stay near cosine |
| `embedder.test.js` | The real bundled model loads with no network, gives unit-length 384-dim vectors, ranks related text above unrelated, survives blank text |
| `determinism.test.js` | The same tabs always get identical cluster assignments (k-means is seeded), whatever order they arrive in (`canonicalTabOrder`) |
| `feedback.test.js` | Drag-to-pair derivation: new adjacency → positive, broken adjacency → negative, untouched pairs → no signal |
| `implicitFeedback.test.js` | Tab-switch pairs become one positive + one weak negative, closed tabs are dropped, embeddings are stored rounded and capped at 200 examples |
| `recency.test.js` | Recency bounds (1 at t=0, 0 at/past the cap, ~0.5 halfway), idle-duration formatting |
| `labeler.test.js` | Distinct clusters get distinct on-topic labels, stopwords never leak into a label, no crash on empty/single-cluster input |
| `background.test.js` | 20 concurrent tab events lose no data (storage write queue), bad URLs don't throw, transitions and implicit candidates are counted, previous-active tab survives a worker restart, tabs already open at install are registered, pruned and given the content script, navigating forgets the old page's text, Apply Order handles pinned and closed tabs |
| `contentScript.test.js` | Runs the real `content_script.js` on a fake page and clock: dwell time counts once in any order of blur, focus and visibility events; CSS and scripts stay out of the extracted text |
| `eval.test.js` | The evaluation metrics (neighbour agreement, runs per topic, adjusted Rand index) against hand-computed values |

`npm run build:verify` additionally checks that the production bundle compiles
and that `dist/` contains everything Chrome needs.

---

## 7. How a single "Sort" click actually flows through the code

1. `SortButton` → `App.handleSort` → `chrome.runtime.sendMessage({type:
   'REQUEST_SORT'})` → `background.js` returns raw tab data (title, url,
   dwell, revisit, transition, lastActive — everything accumulated since
   the tabs were opened).
2. `runMLPipeline(tabs, onProgress)`:
   - `embedTexts` → each tab gets a 384-dim vector
   - `consumeImplicitPairs` → any queued tab-switch-burst pairs become
     training examples right now, using the embeddings we just computed
   - `buildSimilarityMatrix` → cosine matrix
   - if personalisation is on and trained: `scoreAllPairs` replaces it
   - `buildChainOrder` → `annotateChain` → the final chain order
   - `clusterTabs` → `labelClusters` → colour + name per topic group
3. `App` renders `TabChain` (draggable cards) + `ClusterLegend` +
   `LearningStatus`.
4. If you drag a card: `handleReorder` → `deriveTrainingPairs` →
   `storeTrainingExample` (persisted to `chrome.storage.local`) →
   `maybeRetrain` (if personalisation is on, trains once 15 examples exist, then
   after every 5 new ones).
5. "Apply Order" → `chrome.tabs.move` puts your actual browser tabs in that
   order.

Meanwhile, **independent of any popup interaction**, `background.js` is
always watching `onActivated` events, incrementing `transitionCount`, and
quietly queuing implicit training candidates for step 2 to pick up next time
you open the popup.
