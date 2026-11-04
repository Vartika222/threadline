# Threadline — Code Guide

A file-by-file walkthrough of what exists, what each piece does, and why it's
built the way it is. Written so you can read the actual source alongside this
and understand every line, not just the vibe.

**How the pieces fit together, in one sentence each:**
`content_script.js` reads each page → `background.js` stores tab metadata and
watches for behavioural patterns → the popup (`App.jsx`) triggers
`pipeline.js`, which runs the five-stage ML pipeline and returns a sorted,
labelled, personalised chain → `TabChain.jsx` renders it and captures drag
corrections → those corrections flow back into `nn.js`'s training loop.

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
popup, not here, because TF.js needs a WebGL-capable context), `APPLY_ORDER`
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

**Why `transitionCount` matters:** it used to be read by `nn.js`'s behaviour
vector but nothing ever wrote it — silently always 0. It's now incremented on
every genuine tab switch, so that NN input feature is finally alive.

---

## 4. ML pipeline (`src/ml/`)

### 4a. `embedder.js` — text → 512-dim vectors

Wraps `@tensorflow-models/universal-sentence-encoder` (USE). Two exports:

- **`embedTexts(texts)`**: lazy-loads the model once (`_model` module cache —
  loading takes 1-2s, so you don't want to repeat it), calls `model.embed()`,
  converts the resulting tensor to a plain JS array, and **disposes the
  tensor** immediately (`embeddingTensor.dispose()`). This last part matters:
  TF.js tensors live on the GPU and don't get garbage-collected by the JS
  engine — forgetting `.dispose()` is *the* classic TF.js memory leak.

- **`cosineSimilarity(a, b)`**: `dot(a,b) / (|a| * |b|)`. The code comment
  explains the choice well: cosine measures the *angle* between vectors, so a
  one-sentence title and a five-sentence description of the same topic still
  score as similar — Euclidean distance would incorrectly penalise the
  length difference.

### 4b. `graph.js` — similarity matrix → Maximum Spanning Tree → order

Three stages:

1. **`buildSimilarityMatrix`**: all-pairs cosine similarity, clamped to
   `[0,1]` (negative cosine values are treated as "no connection" for MST
   purposes, not "anti-correlated").

2. **`buildMST`**: Kruskal's algorithm, inverted for *maximum* spanning tree
   (sort edges descending, keep the strongest similarity edges that don't
   create a cycle). Cycle detection uses a **Union-Find / Disjoint-Set**
   structure with both optimisations that make it fast:
   - *path compression* in `find()` — flattens the tree on every lookup
   - *union by rank* in `union()` — always attaches the shorter tree under
     the taller one

   Together these make each operation amortised near-O(1), so the whole
   Kruskal's run is `O(E log E)` dominated by the initial sort.

3. **`traverseMST`**: DFS over the resulting tree, starting from the
   highest-degree node (the most "central" tab), visiting neighbours in
   descending edge-weight order. This is *why* MST+DFS beats naive
   "sort by similarity to previous tab": a greedy nearest-neighbour walk gets
   trapped inside one topic cluster and only escapes when it runs out of
   similar tabs, producing an order that revisits topics. MST considers
   global structure first, so bridging tabs (one about "React" that also
   touches "V8 internals") land where they actually belong — between both
   clusters — rather than being greedily assigned to whichever neighbour it
   happened to be compared against first.

`annotateChain` just walks the final order and records the similarity to the
*next* tab, which the UI uses to draw the connector-line opacity and the `%`
label between cards.

### 4c. `clusterer.js` — embeddings → topic colour groups

Pipeline: `512-dim embeddings → UMAP (→2D) → k-means → cluster labels`.

- **Why reduce to 2D first?** K-means in 512 dimensions suffers the "curse of
  dimensionality" — in high dimensions, all points end up roughly equidistant
  from each other, and Euclidean-distance-based clustering stops meaning
  anything. UMAP compresses to 2D while preserving *neighbourhood* structure
  (things close in 512D stay close in 2D), giving k-means something sane to
  work with.
- **`seededRandom` (Mulberry32 PRNG)**: UMAP needs a random number source
  internally (for its stochastic gradient descent-like layout optimisation),
  but a plain `Math.random()` would make the same tab set produce a
  *different* layout every time you sort. A seeded PRNG makes it
  deterministic — reproducible clusters for the same input.
- **`kmeans` + `kmeansppInit`**: standard Lloyd's-algorithm k-means, but with
  **k-means++ initialisation** — instead of picking k random starting
  centroids (which can accidentally clump two centroids together and produce
  an empty or garbage cluster), it picks each subsequent centroid with
  probability proportional to its squared distance from already-chosen ones,
  spreading the starting points across the data.
- **`estimateK` (silhouette)**: for k = 2..min(8, N/2) it runs seeded k-means
  and scores each result with the mean silhouette (how much closer each point
  is to its own cluster than to the next-nearest one), keeping the best k. Three
  tabs or fewer skip clustering. This replaced an elbow-method version whose
  second-difference search could only return 2 to maxK-1: exactly 2 clusters for
  up to 15 tabs, never more than 5 for any input. There is deliberately no
  "k = 1" fallback: measured here, the best silhouette of structureless scatter
  overlaps that of real multi-topic tab sets, so no threshold separates them.
- **Honest gap, documented in the file itself**: the README describes this
  step as HDBSCAN; the actual code is k-means. The comment explains why (no
  maintained browser-compatible HDBSCAN library existed as of the project's
  original research), and flags it as a real open question (OQ-02). See the
  HDBSCAN feasibility discussion at the end of this guide.

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

One function, shared by two consumers that need to agree with each other:
`nn.js`'s behaviour vector (a real training feature) and the UI's visual
fade (`TabChain.jsx`, `App.jsx`'s idle list).

`computeRecencyNorm(lastActive, now)` returns 1 if touched right now, 0 if
untouched for 30+ minutes (`RECENCY_CAP_MS`), linear in between. Deliberately
takes `now` as an injectable parameter (defaults to `Date.now()`) so tests can
pass a fixed timestamp and get deterministic results instead of depending on
wall-clock time.

### 4f. `nn.js` — the personalisation model (V3)

This is the most involved file, and the part most likely to come up in an
interview, so it's worth reading top to bottom in the source. Summary of the
key ideas:

**The behaviour vector** (`tabToBehaviourVector`) turns raw tab usage into 6
normalised numbers: `[dwellNorm, revisitNorm, hourSin, hourCos,
transitionNorm, recencyNorm]`.
- Dwell/revisit/transition are capped and linearly normalised to `[0,1]`
  (e.g. dwell caps at 10 minutes — beyond that, "more open" stops being
  informative).
- Hour-of-day uses **cyclical sin/cos encoding**: mapping the 24-hour clock
  onto a unit circle so that hour 23 and hour 0 end up numerically close
  (a plain integer 0-23 encoding would treat 23 and 0 as maximally far
  apart, which is wrong — they're one hour apart on a clock).
- `recencyNorm` (new) comes from `recency.js`.

**Why V1 (naive concatenation) was wrong, and V2/V3 fix it**: if you
concatenate two 512-dim content embeddings and two 5-dim behaviour vectors
into one 1034-element input and feed it to a single Dense layer, the content
features occupy ~99% of the input. With random weight initialisation, the
gradient signal from the tiny behavioural slice gets statistically swamped by
the much larger content slice before the network has any chance to learn that
dwell time matters at all.

**The fix — parallel encoder streams, built with TF.js's Functional API**
(not Sequential, which only supports one linear chain):
```
embA(512) ─┐ shared          ┐
embB(512) ─┤ content encoder ├─ 32-dim each ─┐
                                              ├─ concat(80) → fusion → score
behA(5)   ─┐ shared           ┐
behB(6)   ─┤ behaviour encoder├─ 8-dim each ──┘
```
Each modality gets its own small sub-network that compresses it to a fixed
size *before* the streams meet at a `concatenate` layer. By the time fusion
happens, all four streams contribute equal-sized representations — the
network can learn "what makes content similar" and "what makes behaviour
similar" somewhat independently, then combine those conclusions. This
stream-then-fuse pattern is the standard approach in multimodal research
(CLIP, ALIGN, and most vision-language models follow the same shape).

**Weight sharing**: the same `contentDense1`/`contentDense2` layer objects
are `.apply()`'d to both stream A and stream B (same for the behaviour
encoder). This halves the parameter count and means both tabs are encoded by
exactly the same function, whichever slot they land in.

**Symmetry is not automatic.** Sharing the encoders does not make the whole
network symmetric: the fusion layer sees `[encA, encB, behA, behB]` in a fixed
order, so `f(A, B)` and `f(B, A)` differ (`tests/symmetry.test.js` shows this
on a fresh model). Two measures remove the dependence on which tab is listed
first: `trainModel` adds a swapped copy `(B, A)` of every example, and
`scoreAllPairs` scores each pair in both orders and averages them. (An earlier
version of these notes claimed weight sharing alone guaranteed symmetry. It
doesn't.)

**Training — contrastive learning**: there's no ground-truth "tab A and tab B
are definitely related" label sitting around. Training examples come from
implicit signals — `label=1` for pairs the user placed adjacent (drags) or
kept switching between (implicit bursts), `label=0` for pairs the user broke
apart. `trainModel` fits with binary cross-entropy on this pairwise labelled
data (needs ≥4 examples to run at all; `NN_ACTIVATION_THRESHOLD = 15` before
the model's output actually gets *used* in sorting, to avoid personalising
off a statistically tiny sample).

**Inference** — `scoreTabPair` (one pair) and `scoreAllPairs` (batched: all
`N*(N-1)/2` pairs in a single `model.predict()` call instead of looping,
which matters because each individual `predict()` call has fixed overhead
that dominates at small batch sizes).

**Persistence** — `chrome.storage.local` can't store tensors directly, so
`saveModel` manually serialises each weight tensor's shape/data/name to
JSON, and `loadSavedModel` reconstructs tensors from that JSON and sets them
back onto a freshly-built model. A `nn_version` field guards against loading
incompatible weights — V1→V2 changed the input wiring, V2→V3 changed
`BEHAV_DIM` from 5→6; loading old weights into a differently-shaped model
would either crash or silently corrupt, so mismatched versions are discarded
and training starts fresh instead.

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
between, but can't *embed* them (Universal Sentence Encoder needs the
popup's WebGL context) — so the tabId-only queue is the hand-off point
between "observed in the service worker" and "converted to a real training
example in the popup."

### 4i. `pipeline.js` — orchestrates all of the above

`runMLPipeline(tabs, onProgress)` runs, in order:
1. Embed all tabs (USE)
2. **(new)** Drain implicit tab-switch-burst candidates into training examples
3. Build the baseline cosine similarity matrix
4. If ≥15 training examples exist, run the NN over all pairs and **blend**
   `0.7 * NN + 0.3 * cosine` — the cosine term acts as a regulariser so a
   still-sparse personalisation model can't produce wildly wrong orderings
5. Build the MST, traverse it, annotate similarities
6. Cluster (UMAP + k-means)
7. **(new)** Label each cluster (TF-IDF)

Returns `{ chain, clusters, clusterLabels, method, implicitExampleCount }`.
`method` is `'cosine'` or `'personalised'` depending on whether the NN was
active for that particular sort — useful for debugging *why* two sorts of
the same tabs came out differently.

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
- `handleReorder(newChain)`: called by `TabChain` after a drag. Diffs
  old vs. new chain via `deriveTrainingPairs`, stores each resulting pair as
  a training example, and calls `maybeRetrain`.
- `maybeRetrain(total)`: asks `shouldRetrain(total, nn_trained_count)` in
  `nn.js` — train once 15 examples exist, then again after every 5 new ones —
  so it does not retrain on every single drag (the popup would stutter and fit
  a fresh model to one noisy correction at a time). It compares against the
  count at the *last training run* rather than testing for exact counts: a
  drag adds 2–4 examples at once, and an exact-count check (the earlier
  version) skipped training whenever the total jumped past 15, 20, 25...
- `handleSort` now also refreshes the example count and checks for a retrain
  *after* the pipeline runs, since implicit pairs can cross the training
  threshold with zero drags involved.
- `LearningStatus` and `ClusterLegend` are small presentational components
  defined at the bottom of the file — status text ("7/15 corrections
  learned" → "✓ Sorting personalised to you") and colour-coded cluster name
  chips, respectively.
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
keeps the dependency list short. `npm test` chains all thirteen files (114 tests).
`tests/helpers/chromeMock.js` provides an in-memory fake of `chrome.storage`
and the `chrome.tabs` event hooks, plus the small runner the newer files use.

| File | What it proves |
|---|---|
| `graph.test.js` | MST has exactly N-1 edges, all nodes reachable, DFS visits every node once, clusters stay contiguous in the traversal |
| `nn.test.js` | Behaviour vector shape/ranges, dwell/revisit capping, cyclical hour encoding correctness, recencyNorm bounds |
| `clusterer.test.js` | Cluster count matches tab count, UMAP output is 2D and finite, distinct topics get distinct clusters |
| `kselection.test.js` | Silhouette-based k: 2, 3 and 5 separated blobs give k = 2, 3, 5; never above 8; deterministic; silhouette scores behave on perfect, wrong and singleton clusterings |
| `retrain.test.js` | `shouldRetrain`: trains at 15, still triggers when the count jumps past a checkpoint (13 → 16), waits for 5 new examples between trainings |
| `symmetry.test.js` | The network has 72,665 parameters; a raw prediction depends on tab order but `scoreAllPairs` does not; training works on swapped copies and rejects fewer than 4 examples |
| `determinism.test.js` | The same tabs always get identical cluster assignments (k-means is seeded) |
| `feedback.test.js` | Drag-to-pair derivation: new adjacency → positive, broken adjacency → negative, untouched pairs → no signal |
| `implicitFeedback.test.js` | Tab-switch pairs become one positive + one weak negative, closed tabs are dropped, embeddings are stored rounded and capped at 200 examples |
| `recency.test.js` | Recency bounds (1 at t=0, 0 at/past the cap, ~0.5 halfway), idle-duration formatting |
| `labeler.test.js` | Distinct clusters get distinct on-topic labels, stopwords never leak into a label, no crash on empty/single-cluster input |
| `background.test.js` | 20 concurrent tab events lose no data (storage write queue), bad URLs don't throw, transitions and implicit candidates are counted, previous-active tab survives a worker restart, tabs already open at install are registered, pruned and given the content script |
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
   - `embedTexts` → each tab gets a 512-dim vector
   - `consumeImplicitPairs` → any queued tab-switch-burst pairs become
     training examples right now, using the embeddings we just computed
   - `buildSimilarityMatrix` → baseline cosine matrix
   - if ≥15 stored examples: `scoreAllPairs` (NN) blended 70/30 with cosine
   - `buildMST` → `traverseMST` → `annotateChain` → the final chain order
   - `clusterTabs` → `labelClusters` → colour + name per topic group
3. `App` renders `TabChain` (draggable cards) + `ClusterLegend` +
   `LearningStatus`.
4. If you drag a card: `handleReorder` → `deriveTrainingPairs` →
   `storeTrainingExample` (persisted to `chrome.storage.local`) →
   `maybeRetrain` (trains once 15 examples exist, then after every 5 new ones).
5. "Apply Order" → `chrome.tabs.move` puts your actual browser tabs in that
   order.

Meanwhile, **independent of any popup interaction**, `background.js` is
always watching `onActivated` events, incrementing `transitionCount`, and
quietly queuing implicit training candidates for step 2 to pick up next time
you open the popup.
