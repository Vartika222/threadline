# Contributing to Threadline

## Project structure

```
threadline/
├── manifest.json          Chrome extension config (MV3)
├── background.js          Service worker — tab lifecycle, serialised storage writes, messages
├── content_script.js      Injected into every tab — extracts content + dwell time
├── popup.html             Popup entry point
├── vite.config.js         Build config
│
├── src/
│   ├── popup/             React UI (App.jsx, TabChain.jsx, SortButton.jsx, styles.css)
│   └── ml/
│       ├── embedder.js          Universal Sentence Encoder (TF.js) + cosine similarity
│       ├── graph.js             Similarity matrix + Kruskal max-spanning-tree + DFS
│       ├── clusterer.js         UMAP + seeded k-means topic clustering
│       ├── labeler.js           TF-IDF names for each cluster
│       ├── nn.js                Multimodal NN, training, persistence, retrain rule
│       ├── feedback.js          Drag reorders → training pairs
│       ├── implicitFeedback.js  Tab-switch bursts → training pairs (+ weak negatives)
│       ├── recency.js           Recency feature + idle-time formatting
│       └── pipeline.js          Orchestrator — runs the steps in order
│
├── tests/                 114 plain-Node tests; helpers/chromeMock.js fakes chrome.*
├── eval/                  Labelled tabs + chain-quality benchmark (npm run eval)
└── scripts/               Post-build copy + build verification
```

## Rules worth knowing

- **`background.js` and `content_script.js` are copied into `dist/` as-is**
  (see `scripts/copy-extension-files.js`), so they must not `import` anything.
- **All read-modify-write of `chrome.storage` in `background.js` goes through
  `updateTabStore` / `withStoreLock`.** Never load the store, await something,
  then save it — that's how updates get lost.
- **Anything random in the ML path must use a seeded generator**, so the same
  tabs always give the same result (see `tests/determinism.test.js`).

## Getting started

```bash
npm install
npm test             # all Node tests (no browser needed)
npm run build        # builds popup via Vite + copies extension files to dist/
npm run build:verify # build + check dist/ is complete (what CI runs)
npm run eval         # chain-quality benchmark with the offline embedder
npm run eval:use     # same, with the real Universal Sentence Encoder
```

## Running a single test file

```bash
node tests/graph.test.js
node tests/background.test.js
```

## Notes

- `embedder.js` needs TF.js and a model download, so it isn't exercised by the
  unit tests; the evaluation harness (`npm run eval:use`) is where it gets
  checked end to end.
- Tests use a tiny in-repo runner (no framework) and exit non-zero on failure.
