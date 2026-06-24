# Contributing to Threadline

## Project structure

```
threadline-extension/
├── manifest.json          Chrome extension config (MV3)
├── background.js          Service worker — tab lifecycle, storage, message routing
├── content_script.js      Injected into every tab — extracts content + dwell time
├── popup.html             Popup entry point
├── vite.config.js         Build config
│
├── src/
│   ├── popup/             React UI (App.jsx, TabChain.jsx, styles.css)
│   └── ml/
│       ├── embedder.js    Universal Sentence Encoder (TF.js)
│       ├── graph.js       Cosine similarity + Kruskal MST + DFS traversal
│       ├── clusterer.js   UMAP + k-means topic clustering
│       ├── nn.js          Multimodal NN + contrastive training
│       └── pipeline.js    Orchestrator — runs all 5 ML steps in order
│
├── tests/
│   ├── graph.test.js      13 tests — all pass in Node, no browser needed
│   ├── clusterer.test.js  Tests for UMAP + k-means
│   └── nn.test.js         8 tests — behaviour vector encoding
│
├── scripts/
│   └── copy-extension-files.js  Post-build copy script for non-Vite files
│
└── icons/                 Extension icons (16, 48, 128px)
```

## Getting started

```bash
npm install
npm run build       # builds popup via Vite + copies extension files to dist/
npm run dev         # watch mode for popup development
npm test            # run all Node-compatible tests
```

## Loading in Chrome

1. `npm run build`
2. Open `chrome://extensions`
3. Enable **Developer mode** (toggle, top right)
4. Click **Load unpacked** → select `dist/`
5. Click the extension icon in the toolbar

## Running tests

```bash
node tests/graph.test.js      # Graph module — no dependencies needed
node tests/nn.test.js         # NN behaviour vectors — no TF.js needed
node tests/clusterer.test.js  # Clusterer — requires umap-js (may be slow)
```

## What V0/V1 does NOT yet have

- `embedder.js` requires TF.js which loads async in browser — works in popup context, not in Node tests
- `clusterer.js` UMAP can be slow (~5s) for first run — acceptable for extension popup
- The NN won't personalise until 15+ training examples are collected (user reorderings)
- No UI for the envelope interaction (V3)
- No session restore UI (V3)

See README.md for the full versioned roadmap.