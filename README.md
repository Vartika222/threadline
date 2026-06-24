# ⬡ Threadline

> **A semantic relatability engine for the ADHD browser.**  
> Sorts your tabs not into buckets — but into a *thread*. The order your thoughts actually follow.

![Threadline popup UI](assets/preview.png)

---

## The Problem

Every tab you open is a thought. Most tab managers treat your tabs like a pile. They sort them into categories — "Work", "Research", "Shopping" — and call it organisation.

But that's not how thinking works, especially with ADHD. You open a tab about React performance. That leads to V8 internals. That links to a memory management talk. That references a Rust blog. Four tabs in, you've lost the thread of what you were originally doing.

The browser offers no path back.

**Existing solutions fail because they answer the wrong question.**  
Chrome's AI tab organiser asks: *what bucket does this tab belong to?*  
Threadline asks: *in what order do these tabs relate to each other?*

---

## What Threadline Does

Threadline sorts your open tabs into a **relatability chain** — a sequence where each tab is semantically closest to its neighbours. Not categories. A traversal path through your own thinking.

It also learns. Over time, Threadline trains a small neural network on your behaviour — which tabs you place next to each other, how long you spend on each, when you revisit — and personalises the ordering to *your* definition of "related", not a generic one.

All processing runs **on-device**. No tab data leaves your browser.

---

## How It Works

### 1. Content Extraction
A content script runs in every tab, extracting title, meta description, and headings — the semantic signal, without the noise of full page content.

### 2. Embedding
Tab text is embedded using **Universal Sentence Encoder** (TF.js), producing a 512-dimensional vector per tab. Similar meaning → similar direction in vector space.

### 3. Similarity Graph
Pairwise **cosine similarity** is computed between all tab embeddings, producing an N×N matrix. This is the complete graph of inter-tab relationships.

### 4. Minimum Spanning Tree
**Kruskal's algorithm** finds the maximum spanning tree of the similarity graph — the set of connections that keeps all tabs linked using the highest-similarity edges.

### 5. Traversal Chain
**Depth-first search** on the MST produces the final linear ordering. Adjacent tabs in the chain share the most conceptual overlap.

### 6. Topic Clustering
**UMAP** reduces 512 dimensions to 2, then **HDBSCAN** identifies topic clusters. These are used for colour-coding — giving dual information: what cluster a tab belongs to, and where it sits in the chain.

### 7. Personalisation (Neural Network)

```
Tab A content embedding (512) → Dense(256) → Dense(64) ──┐
Tab A behaviour vector (5)    → Dense(32)  → Dense(16) ──┤
                                                          ├─ concat(160) → Dense(64) → Dense(1) → score
Tab B content embedding (512) → Dense(256) → Dense(64) ──┤
Tab B behaviour vector (5)    → Dense(32)  → Dense(16) ──┘
```

A **multimodal neural network** combines content embeddings with behavioural features (dwell time, revisit count, time of day, transition history). Trained via **contrastive learning** from implicit user feedback — when you reorder tabs, those pairs become training examples.

---

## Architecture

```
Chrome Extension (Manifest V3)
│
├── manifest.json          Extension config, permissions
├── content_script.js      Per-tab: extracts content, tracks dwell time
├── background.js          Service worker: coordinates state & events
│
└── src/
    ├── popup/
    │   ├── App.jsx        Three-state UI: idle → sorting → sorted
    │   ├── TabChain.jsx   Horizontal scrollable relatability chain
    │   ├── SortButton.jsx
    │   └── styles.css     Dark dense UI (MetaMask-inspired)
    │
    └── ml/
        ├── pipeline.js    Orchestrator: embed → graph → cluster → sort
        ├── embedder.js    Universal Sentence Encoder via TF.js
        ├── graph.js       Cosine similarity + MST + DFS traversal
        ├── clusterer.js   UMAP + HDBSCAN topic clustering
        └── nn.js          Multimodal NN + contrastive training loop
```

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Extension | Chrome MV3 | Required; service workers, tabs API |
| Frontend | React + Vite | Component model, fast HMR in dev |
| ML Runtime | TensorFlow.js | On-device inference, WebGL acceleration |
| Embeddings | Universal Sentence Encoder | 512-dim, strong semantic signal, lightweight |
| Graph | Custom (Kruskal's + DFS) | No library needed; core CS |
| Clustering | umap-js + hdbscan | Density clustering without specifying k |
| Neural Net | TF.js Sequential API | Contrastive training on implicit feedback |
| Storage | chrome.storage.local | Persistent, private, no server needed |

---

## Key Design Decisions

**Why cosine similarity and not Euclidean distance?**  
Cosine measures the angle between vectors, not their magnitude. This makes it robust to texts of different lengths — a one-sentence tab description and a five-sentence one about the same topic will still score high similarity.

**Why MST traversal and not just sorting by cluster centroid?**  
Centroid sorting loses inter-cluster bridges. If you have tabs about "React" and "JavaScript engines" and one tab bridges both topics, centroid sorting would randomly assign it — MST traversal naturally places it between both clusters where it belongs.

**Why on-device and not a cloud API?**  
Tab URLs contain sensitive information — work-in-progress code, credentials, private research. Sending them to a remote server is a non-starter for a trust-sensitive tool. TF.js on WebGL makes this viable without meaningful performance loss for the scale of data involved (5–50 tabs).

**Why contrastive learning for the NN?**  
We don't have labelled training data ("tab A and tab B are definitely related"). We have implicit signals. Contrastive learning uses pairs — similar pairs and dissimilar pairs — which maps naturally onto the implicit feedback available (user reorderings, tab group co-membership).

---

## Privacy

- ✅ All ML inference runs on-device (TF.js, WebGL)
- ✅ No tab data is sent to any server
- ✅ No analytics or telemetry
- ✅ All data stored in `chrome.storage.local` — your device only
- ✅ Extension source is fully auditable

---

## Getting Started

```bash
# Clone the repo
git clone https://github.com/yourusername/threadline
cd threadline

# Install dependencies
npm install

# Development build (watch mode)
npm run dev

# Production build
npm run build
```

Then in Chrome:
1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `dist/` folder

---

## Roadmap

- [x] Chrome Extension scaffold (MV3)
- [x] Content extraction + dwell time tracking
- [ ] TF.js USE embeddings
- [ ] Cosine similarity matrix
- [ ] MST + DFS traversal chain
- [ ] UMAP + HDBSCAN clustering
- [ ] Multimodal NN + contrastive training
- [ ] Envelope interaction (drag to focus)
- [ ] Session snapshots + restore
- [ ] Chrome Web Store release

---


**Core research questions this project explores:**
- How many implicit feedback examples does a contrastive NN need before it outperforms baseline cosine similarity?
- Does UMAP + HDBSCAN outperform k-means for tab clustering at small N (5–30)?
- Can hour-of-day behavioural signals improve personalisation within a single browsing session?

---

*Threadline is free and open source. Published on the Chrome Web Store.*