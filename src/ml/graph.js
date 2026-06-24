/**
 * THREADLINE — graph.js
 *
 * Three things happen here, in order:
 *   1. Build an N×N similarity matrix from embedding vectors
 *   2. Find the Maximum Spanning Tree (Kruskal's algorithm + Union-Find)
 *   3. Traverse the MST with DFS to produce the final tab order
 *
 * ─── WHY A GRAPH? ────────────────────────────────────────────────────────
 *
 * Naively you might sort tabs by "most similar to the previous tab".
 * That's a greedy nearest-neighbour approach — and it fails badly when
 * there are clusters. It gets trapped inside one cluster and only jumps
 * to another when it runs out of similar options.
 *
 * The MST approach considers the GLOBAL structure of all tab relationships
 * at once. It finds the minimal set of connections that keeps all tabs
 * reachable, using the strongest similarity edges — so it naturally
 * groups related tabs together while finding the best bridges between
 * different topics.
 *
 * ─── KRUSKAL'S ALGORITHM ─────────────────────────────────────────────────
 *
 * Standard Kruskal's builds a MINIMUM spanning tree (cheapest edges).
 * We want MAXIMUM (strongest similarity edges), so we sort descending.
 *
 * Steps:
 *   1. Collect all N*(N-1)/2 edges with their similarity weights
 *   2. Sort edges by weight, highest first
 *   3. For each edge (u, v):
 *      - If u and v are in DIFFERENT components → add edge to MST
 *      - If same component → skip (would create a cycle)
 *   4. Stop when MST has N-1 edges
 *
 * Union-Find makes step 3 nearly O(1) with path compression.
 *
 * ─── DFS TRAVERSAL ───────────────────────────────────────────────────────
 *
 * The MST is a tree — no cycles. We walk it with DFS starting from the
 * node with the highest degree (most connections = most "central" tab).
 * DFS visit order naturally keeps related subtrees together in the output.
 */

// ─── SIMILARITY MATRIX ────────────────────────────────────────────────────

/**
 * Computes pairwise cosine similarity for all embedding vectors.
 *
 * @param {number[][]} embeddings - Array of 512-dim vectors
 * @param {Function} cosineSim - The cosineSimilarity function from embedder.js
 * @returns {number[][]} N×N symmetric matrix, matrix[i][j] = sim(tab_i, tab_j)
 */
export function buildSimilarityMatrix(embeddings, cosineSim) {
  const n = embeddings.length;
  // Pre-allocate the matrix for performance
  const matrix = Array.from({ length: n }, () => new Float32Array(n));

  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1.0; // A tab is perfectly similar to itself

    for (let j = i + 1; j < n; j++) {
      const sim = cosineSim(embeddings[i], embeddings[j]);
      // Clamp to [0, 1] — cosine can return slightly negative values for
      // unrelated texts; for MST purposes we treat these as "no connection"
      const clamped = Math.max(0, sim);
      matrix[i][j] = clamped;
      matrix[j][i] = clamped; // Symmetric
    }
  }

  return matrix;
}

// ─── UNION-FIND ────────────────────────────────────────────────────────────

/**
 * Union-Find (Disjoint Set Union) data structure.
 *
 * Tracks which nodes are in the same "component" (connected group).
 * Used by Kruskal's to detect if adding an edge would create a cycle.
 *
 * Two optimisations that make it nearly O(1) per operation:
 *   - Path compression: flatten the tree on every find()
 *   - Union by rank: always attach smaller tree under larger tree
 */
class UnionFind {
  constructor(n) {
    // parent[i] = i initially (each node is its own root)
    this.parent = Array.from({ length: n }, (_, i) => i);
    // rank[i] = approximate depth of subtree rooted at i
    this.rank   = new Array(n).fill(0);
  }

  /**
   * Find the root of x's component.
   * Path compression: make every node on the path point directly to root.
   */
  find(x) {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]); // Recursive path compression
    }
    return this.parent[x];
  }

  /**
   * Merge the components containing x and y.
   * @returns {boolean} true if they were in different components (edge is useful)
   */
  union(x, y) {
    const rootX = this.find(x);
    const rootY = this.find(y);

    if (rootX === rootY) return false; // Already in same component — skip

    // Union by rank: attach shorter tree under taller tree
    if (this.rank[rootX] < this.rank[rootY]) {
      this.parent[rootX] = rootY;
    } else if (this.rank[rootX] > this.rank[rootY]) {
      this.parent[rootY] = rootX;
    } else {
      this.parent[rootY] = rootX;
      this.rank[rootX]++;
    }

    return true; // Components were merged — this edge belongs in the MST
  }
}

// ─── MAXIMUM SPANNING TREE (KRUSKAL'S) ────────────────────────────────────

/**
 * Builds the Maximum Spanning Tree from the similarity matrix.
 *
 * @param {number[][]} simMatrix - N×N similarity matrix
 * @param {number} n - Number of nodes (tabs)
 * @returns {Array<{u: number, v: number, weight: number}>} MST edges
 */
export function buildMST(simMatrix, n) {
  if (n <= 1) return [];

  // Step 1: Collect all edges (upper triangle only — matrix is symmetric)
  const edges = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      edges.push({ u: i, v: j, weight: simMatrix[i][j] });
    }
  }

  // Step 2: Sort by weight DESCENDING (we want maximum spanning tree)
  edges.sort((a, b) => b.weight - a.weight);

  // Step 3: Kruskal's — greedily add edges that connect different components
  const uf  = new UnionFind(n);
  const mst = [];

  for (const edge of edges) {
    if (mst.length === n - 1) break; // MST is complete (N-1 edges)

    if (uf.union(edge.u, edge.v)) {
      // This edge connects two previously disconnected components
      mst.push(edge);
    }
    // If union() returned false, the nodes were already connected —
    // adding this edge would create a cycle, so we skip it.
  }

  return mst;
}

// ─── DFS TRAVERSAL ────────────────────────────────────────────────────────

/**
 * Traverses the MST with DFS to produce a linear tab ordering.
 *
 * Start node: the node with the highest degree in the MST.
 * This is the most "central" tab — the one most connected to others.
 * Starting from it means the chain radiates outward naturally.
 *
 * @param {Array<{u: number, v: number, weight: number}>} mst - MST edges
 * @param {number} n - Number of nodes
 * @returns {number[]} Ordered array of tab indices (the relatability chain)
 */
export function traverseMST(mst, n) {
  if (n === 0) return [];
  if (n === 1) return [0];

  // Build adjacency list from MST edges
  // adjacency[i] = [{node: j, weight: w}, ...] for all edges (i,j) in MST
  const adjacency = Array.from({ length: n }, () => []);
  for (const { u, v, weight } of mst) {
    adjacency[u].push({ node: v, weight });
    adjacency[v].push({ node: u, weight });
  }

  // Find the start node: highest degree (most MST connections)
  // Ties broken by index — consistent output for same input
  let startNode = 0;
  let maxDegree = 0;
  for (let i = 0; i < n; i++) {
    if (adjacency[i].length > maxDegree) {
      maxDegree = adjacency[i].length;
      startNode = i;
    }
  }

  // DFS traversal
  // Visit neighbours in order of DESCENDING edge weight —
  // this means we follow the strongest connections first
  const visited = new Set();
  const order   = [];

  function dfs(node) {
    visited.add(node);
    order.push(node);

    // Sort neighbours by weight descending before visiting
    const neighbours = adjacency[node]
      .filter(nb => !visited.has(nb.node))
      .sort((a, b) => b.weight - a.weight);

    for (const { node: neighbour } of neighbours) {
      dfs(neighbour);
    }
  }

  dfs(startNode);

  // Handle disconnected nodes (shouldn't happen with a valid MST,
  // but guard against edge cases with <2 tabs or identical embeddings)
  for (let i = 0; i < n; i++) {
    if (!visited.has(i)) order.push(i);
  }

  return order;
}

// ─── SIMILARITY ANNOTATION ────────────────────────────────────────────────

/**
 * Annotates each tab in the ordered chain with its similarity to the next tab.
 * Used by the UI to render the connection strength between chain cards.
 *
 * @param {number[]} orderedIndices - DFS traversal order
 * @param {number[][]} simMatrix - Full similarity matrix
 * @returns {Array<{index: number, similarityToNext: number|null}>}
 */
export function annotateChain(orderedIndices, simMatrix) {
  return orderedIndices.map((tabIndex, pos) => {
    const nextIndex = orderedIndices[pos + 1];
    return {
      index: tabIndex,
      similarityToNext: nextIndex !== undefined
        ? simMatrix[tabIndex][nextIndex]
        : null,
    };
  });
}

// Self-test lives in tests/graph.test.js — not here.
// Production modules should not contain test code.