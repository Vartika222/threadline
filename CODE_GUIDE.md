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
  ES module (`"type": "module"`). Vite bundles it, so it imports `correctionKey`,
  the category names and the student's `mergeExamples` from `src/ml/` instead of
  keeping copies.
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

### 4c. `categories.js` — a category and subcategory for each tab

`classifyTabs` decides in three steps. `classifyByRules` handles the first two, with no
model:

- **Mixed sites.** YouTube's homepage is Entertainment. A video on a channel in
  `STUDY_CHANNELS` is Study. Otherwise YouTube's own category decides
  (`YOUTUBE_CATEGORIES`: Education → Study, Music → Entertainment › Music, ...). Broad
  categories (People & Blogs, Science & Technology), and channel pages, go to the
  model, falling back to Entertainment if it isn't confident; a programming video it
  calls Developer Tools counts as Study. The content script reads the category from
  the page for the first video, and fetches the video's own youtube.com page after
  in-site navigation. A tab is re-sorted when its text, channel or category arrives
  after it was sorted (`sortBasis` in background.js). A search goes to the model using only the query.
- **`KNOWN_SITES`.** Host → category and subcategory, also trying parent domains. Block
  pages (`REFUSED_PAGE`) on unknown sites go to Unsure rather than being guessed from.
- **The model.** `closestDescription` compares the tab with every subcategory's written
  descriptions. Below `MIN_CONFIDENCE` it goes to Life & Other › Unsure.

**What this replaced**: agglomerative clustering, which grouped pages with similar
wording but had no idea what "streaming" or "shopping" meant. On real tabs the groups
looked random. A network trained on `dmoz.csv` scored 63% against 90% for the
descriptions, because dmoz has no social or streaming labels (`training/README.md`).

### 4d. Automatic sorting and focus mode, in `background.js`

- **`runAutoSort`** runs shortly after a tab loads or its text arrives. It takes tabs on
  a URL it hasn't placed yet, and asks the hidden page (`src/offscreen/main.js`) to
  classify them, because a service worker can't reliably run the model. Remembering the
  URL in `tab_placements` is what lets a tab you moved by hand stay put.
- **`placeTabInGroup`** finds or creates the category's group, skips groups the user
  made, and keeps subcategory order. `editTabs` retries while Chrome refuses edits during
  a tab drag.
- **`applySort`** handles **Sort now**, and **`undoLastSort`** restores from
  `saveUndoState`. Only Sort now and snapshot restores save Undo state; an automatic
  sort of a newly loaded tab doesn't, so it can't replace the Undo of a big sort.
  Sort now classifies in the popup with your corrections and the trusted student
  (`classifierOptions` in `pipeline.js`), but not Gemini Nano, which is too slow for
  a whole window.
- **`savePlacementUpdates`** saves what a sort decided under the store lock, reading
  placements again first: classifying can take seconds, and in that time a tab may
  close or a correction may ask for a tab to be sorted again. Both survive.
- **Focus mode** stores `{ category, endsAt, allowedHosts }`, so it survives a worker
  restart. `enforceFocus` runs on tab activation and after sorting. Strict focus is opt-in,
  Unsure tabs are never blocked, and the blocked page can always allow a site or end
  focus, because the classifier will be wrong sometimes.
  The popup's `FocusPanel.jsx` starts and ends it through `START_FOCUS`, `END_FOCUS`,
  `GET_FOCUS` and `SET_STRICT_FOCUS`; it never starts on its own.
- **Corrections** (`correctTab`, `learnFromMove`) are stored under `correctionKey`: the
  site, or `youtube:<channel>`; never for searches. `tabs.onUpdated` with a `groupId`
  into a category group other than the tab's placement is a correction, except while
  Threadline is moving tabs itself (`asOwnEdit`, plus 1.5 s after). A correction clears
  the `basis` of every open tab with the same key, so `runAutoSort` sorts them again.
  `classifyTabs` checks corrections before the rules; one without a subcategory picks the
  closest subcategory inside that category. Forgetting a correction also deletes the
  student examples it made (each example records its `site`, the correction key), and
  retrains.
- **Gemini Nano** (`src/ml/nano.js`) is passed to `classifyTabs` as `askModel` when it is
  switched on and `available`. It answers only with a `Category › Subcategory` label
  (`responseConstraint` enum), one tab per cloned session; anything it can't answer
  goes to the embedding model. Status checks give up after 3 s, prompts after 20 s.
- **The fast model** (`src/ml/student.js`) is passed to `classifyTabs` as `student`,
  and asked before Gemini Nano. It answers only tabs it gives a probability of at
  least 0.6 (`CONFIDENCE`), and only once its last test passed (`trusted`). It's
  softmax regression on the tab's embedding, trained by full-batch gradient descent
  with momentum and L2, from zero weights, so the same examples give the same model.
  The flow:
  1. `runAutoSort` sends the stored model with `CLASSIFY_TABS`.
  2. The offscreen page answers, then embeds the tabs answered by Gemini Nano, the
     site list or a correction and sends them back as `STUDENT_EXAMPLES`. Answers
     from the student or the description model are never learned from.
  3. background.js merges them with `mergeExamples`: newest 400, one per page, and a
     guess never replaces your correction.
  4. After 3 new examples it sends `TRAIN_STUDENT`. `buildStudent` trains on the
     pages not held back (`isHeldOut`, a hash, about 1 in 5), tests on the held-back
     Gemini Nano examples, then trains on everything. Category descriptions are
     always included, at weight 1; corrections weigh 3, Gemini Nano 1, the site
     list 0.5.
  5. `trusted` needs at least 6 held-back pages it was sure about, with 85% agreeing.

  The popup reads a summary with `GET_STUDENT` (no weights) and can send
  `RETRAIN_STUDENT` and `FORGET_STUDENT`.
- **Snapshots** (`saveSnapshot`, `restoreSnapshot`) keep a window's tabs in order with
  their groups. Restoring matches saved tabs to open ones by address, reopens the rest,
  regroups them, and marks their placements `manual: true`: `runAutoSort` still learns
  their category but doesn't move them until they navigate elsewhere. It saves Undo
  state first. The popup's `SnapshotsPanel.jsx` lists, restores and deletes them.

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
5. `classifyTabs` gives each tab a category and subcategory
6. `orderWithinCategories` orders by category, then subcategory, then `buildChainOrder`

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
| `categories.test.js` | The rules with no model: your tabs, YouTube homepage vs video vs study channel, searches by query, block pages, known sites naming real categories |
| `sorting.test.js` | Automatic grouping, tabs moved by hand staying put, user groups left alone, retries during drags, Sort now, Undo, focus mode in gentle and strict form, snapshots: save, restore (order, groups, reopening), kept out of automatic sorting, Undo, delete |
| `retrain.test.js` | `shouldRetrain`: trains at 15, still triggers when the count jumps past a checkpoint (13 → 16), waits for 5 new examples between trainings, keeps training past the 200-example storage cap |
| `personalise.test.js` | Off by default; with no adjustment it equals cosine; always symmetric and on the 0-1 scale; training moves scores the right way, is deterministic and fast; inconsistent corrections stay near cosine |
| `embedder.test.js` | The real bundled model loads with no network, gives unit-length 384-dim vectors, ranks related text above unrelated, survives blank text |
| `determinism.test.js` | The same tabs always give the same chain, whatever order they arrive in (`canonicalTabOrder`) |
| `feedback.test.js` | Drag-to-pair derivation: new adjacency → positive, broken adjacency → negative, untouched pairs → no signal |
| `implicitFeedback.test.js` | Tab-switch pairs become one positive + one weak negative, closed tabs are dropped, embeddings are stored rounded and capped at 200 examples |
| `recency.test.js` | Recency bounds (1 at t=0, 0 at/past the cap, ~0.5 halfway), idle-duration formatting |
| `background.test.js` | 20 concurrent tab events lose no data (storage write queue), bad URLs don't throw, transitions and implicit candidates are counted, previous-active tab survives a worker restart, tabs already open at install are registered, pruned and given the content script, navigating forgets the old page's text, Apply Order handles pinned and closed tabs |
| `contentScript.test.js` | Runs the real `content_script.js` on a fake page and clock: dwell time counts once in any order of blur, focus and visibility events; CSS and scripts stay out of the extracted text |
| `nano.test.js` | Gemini Nano against a fake Prompt API: status, labels limited to ours, one cloned session per tab, time limits |
| `student.test.js` | The fast model: learns and generalises on made-up embeddings, is deterministic, trains 400 examples in under 8 s, stores rounded without changing answers, merges examples (corrections kept), held-back split, trust rules, answers only tabs it's sure about with Gemini Nano getting the rest, and background.js storing examples, retraining, sending the model with each sort, and forgetting |
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
   - `classifyTabs` → category and subcategory per tab
   - `orderWithinCategories` → the final chain order
3. `App` renders `TabChain` (draggable cards) + `ClusterLegend` +
   `LearningStatus`.
4. If you drag a card: `handleReorder` → `deriveTrainingPairs` →
   `storeTrainingExample` (persisted to `chrome.storage.local`) →
   `maybeRetrain` (if personalisation is on, trains once 15 examples exist, then
   after every 5 new ones).
5. `applyToTabStrip` → `APPLY_SORT` moves your actual browser tabs straight away, into
   named groups. There is no approval step.

Meanwhile, **independent of any popup interaction**, `background.js` is
always watching `onActivated` events, incrementing `transitionCount`, and
quietly queuing implicit training candidates for step 2 to pick up next time
you open the popup.
