# Threadline — Concept Cluster

A learning path through every non-trivial concept the codebase uses, roughly
in the order you'd hit them reading the code top to bottom. Each entry says
*why it's here* before the link, so you know what to look for while reading.

---

## 1. Sentence embeddings & semantic similarity
**Where it's used:** `embedder.js`

- **Official USE tutorial (TensorFlow Hub)** — the exact model this project
  loads, with the same "embed sentences → compare via similarity" workflow:
  https://www.tensorflow.org/hub/tutorials/semantic_similarity_with_tf_hub_universal_encoder
- **TF.js package README** — API surface (`model.embed()`, output shape
  `[n, 512]`), useful as a reference while reading `embedder.js`:
  https://github.com/tensorflow/tfjs-models/blob/master/universal-sentence-encoder/README.md
- **Cosine similarity, explained with the "angle not distance" intuition** —
  worth understanding *why* cosine and not Euclidean distance for text:
  https://www.learndatasci.com/glossary/cosine-similarity/ (search this if
  link changes — the core idea is "angle between vectors, magnitude-invariant")

## 2. Graph algorithms — MST, Union-Find, DFS
**Where they're used:** `graph.js`

- **VisuAlgo — Minimum Spanning Tree (Kruskal's & Prim's)**, the canonical
  interactive visualizer computer science courses use. Step through it with
  play/pause; watch specifically how it uses Union-Find to reject
  cycle-forming edges:
  https://visualgo.net/en/mst
- **Union-Find (Disjoint Set) with path compression + union by rank** — read
  this after VisuAlgo to understand *why* the cycle-check is fast:
  https://cp-algorithms.com/data_structures/disjoint_set_union.html
  (cp-algorithms is the standard reference competitive programmers use —
  precise, includes the amortised complexity proof sketch)
- **DFS (depth-first search), if you want a refresher** —
  https://www.geeksforgeeks.org/dsa/depth-first-search-or-dfs-for-a-graph/

## 3. Dimensionality reduction — UMAP
**Where it's used:** `clusterer.js`

- **"Understanding UMAP" (Google PAIR)** — an *interactive* explorable
  explanation, not a static article. Lets you drag parameters and watch
  clusters reshape in real time. This is the best resource on the list for
  building real intuition:
  https://pair-code.github.io/understanding-umap/
- **DataCamp's UMAP guide** — more traditional written walkthrough if you
  want the algorithm steps spelled out linearly:
  https://www.datacamp.com/tutorial/understanding-umap-guide-to-dimensionality-reduction

## 4. Clustering — k-means, k-means++, silhouette score
**Where it's used:** `clusterer.js`

- **StatQuest: K-means clustering (YouTube)** — Josh Starmer's explanation is
  the standard first stop for this topic; walks through assignment,
  recomputing centroids, and picking K with the elbow method start to finish.
  Search "StatQuest K-means clustering" on YouTube.
- **k-means++ initialisation, why it matters** —
  https://www.geeksforgeeks.org/machine-learning/ml-k-means-algorithm/
  (covers the "probability proportional to squared distance" seeding rule
  used in `clusterer.js`'s `kmeansppInit`)
- **Silhouette score (how `estimateK` picks k)** — scikit-learn's guide to
  silhouette analysis explains the a/b distances behind the score and shows
  plots for several k:
  https://scikit-learn.org/stable/auto_examples/cluster/plot_kmeans_silhouette_analysis.html
- **Elbow method, the heuristic this replaced** — worth reading for its real
  limitations, since it is a heuristic, not a proof:
  https://builtin.com/data-science/elbow-method

## 5. TF-IDF (keyword extraction for cluster labels)
**Where it's used:** `labeler.js`

- **Programming Historian: "Analyzing Documents with TF-IDF"** — unusually
  good because it's written for people analysing real, messy text corpora
  (historians), not toy datasets, and works through the reasoning behind
  each term instead of just giving the formula:
  https://doi.org/10.46430/phen0082 (via https://programminghistorian.org)
- **GeeksforGeeks TF-IDF walkthrough** — if you want the formula worked
  through on a tiny 3-document example by hand first:
  https://www.geeksforgeeks.org/machine-learning/understanding-tf-idf-term-frequency-inverse-document-frequency/

## 6. Neural network architecture — functional API, multi-input models
**Where it's used:** `nn.js`

- **Official TensorFlow.js guide: "Models and Layers"** — covers exactly the
  `tf.input()` / `.apply()` / `tf.model({inputs, outputs})` pattern
  `nn.js` uses, straight from the source:
  https://www.tensorflow.org/js/guide/models_and_layers
- **Keras functional API guide (concepts transfer directly to TF.js)** — best
  for understanding *why* you'd reach for the functional API instead of
  Sequential in the first place (multi-input, shared layers, non-linear
  topologies):
  https://www.tensorflow.org/guide/keras/functional_api

## 7. Siamese / twin-network architectures & contrastive learning
**Where it's used:** `nn.js` (the shared content/behaviour encoders), `feedback.js` + `implicitFeedback.js` (how the labels are generated)

- **GeeksforGeeks: "Siamese Neural Network in Deep Learning"** — clean
  explanation of weight sharing and why it forces a *consistent* similarity
  function rather than two independently-behaving encoders:
  https://www.geeksforgeeks.org/nlp/siamese-neural-network-in-deep-learning/
- **"Siamese Networks and Contrastive Loss Explained" (Medium, Raghavan)** —
  more narrative, good for building intuition about "pull similar pairs
  together, push dissimilar pairs apart" before you look at the loss
  function math:
  https://medium.com/@raghavan99o/siamese-networks-and-contrastive-loss-explained-a-practical-guide-for-engineers-a2a7c79bb556

## 8. Cyclical time encoding (sin/cos for hour-of-day)
**Where it's used:** `nn.js`'s `tabToBehaviourVector`

- No single canonical tutorial, but search **"cyclical encoding time features
  sin cos"** — this trick shows up constantly in time-series/forecasting
  work (e.g. encoding day-of-week, month-of-year) for the same reason it's
  used here: a plain integer hour makes 23 and 0 look maximally far apart,
  which is wrong on a 24-hour clock.

## 9. Chrome Extension architecture (Manifest V3)
**Where it's used:** `manifest.json`, `background.js`, `content_script.js`

- **Official Chrome docs: "Extension service worker basics"** — the
  authoritative source on why `background.js` can't rely on in-memory state
  (the exact reason every handler re-reads `chrome.storage.local`):
  https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/basics
- **"Extensions / Manifest V3" overview** — the bigger picture of *why* MV3
  exists (security motivations behind the service-worker model):
  https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3

---

## Suggested reading order

If you're going through this linearly rather than jumping around:

1. Cosine similarity → USE tutorial (§1) — get comfortable with "text as a
   vector" first, everything else builds on this.
2. VisuAlgo MST (§2) — watch it run a few times before reading `graph.js`.
   Then cp-algorithms Union-Find, since Kruskal's makes no sense without it.
3. PAIR's Understanding UMAP (§3), then StatQuest k-means (§4) — in that
   order, since `clusterer.js` runs UMAP *before* k-means for a reason
   explained in both.
4. TF.js Models and Layers (§6) → Siamese networks (§7) — read the
   architecture guide first so the *mechanism* (`tf.model`, `.apply()`)
   isn't new when you meet the *reason* (shared weights, contrastive pairs).
5. TF-IDF (§5) and MV3 service workers (§9) are self-contained — read
   whenever, no dependencies on the rest.

None of these are required reading to use or ship the extension — they're
here so that if you're asked "why MST instead of nearest-neighbour sort" or
"why does the model have two separate encoders" in a conversation about this
project, you have the real answer, not just what the code comment says.
