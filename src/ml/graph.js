/**
 * THREADLINE — graph.js
 *
 * Three things happen here, in order:
 *   1. Build an N×N similarity matrix from embedding vectors
 *   2. Build two candidate chains: MST + DFS, and the best greedy walk
 *   3. Polish both with local search and keep the stronger chain
 *
 * ─── WHY A GRAPH? ────────────────────────────────────────────────────────
 *
 * The simple alternative is a greedy walk: always go to the tab most similar
 * to the previous one. The MST approach instead considers the GLOBAL structure
 * of all tab relationships at once, finding the strongest set of connections
 * that keeps all tabs reachable.
 *
 * Neither wins alone. Greedy tends to strand a few tabs for the end of the
 * walk, and a DFS jumps back up the tree when it finishes a branch. So
 * buildChainOrder repairs both with local search and keeps whichever chain has
 * the higher total similarity between neighbours. That choice uses no topic
 * labels, so it works on any tabs. See the README's Evaluation section.
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
 * @param {number[][]} embeddings - One vector per tab
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

// ─── THE FINAL CHAIN ──────────────────────────────────────────────────────

/** Total similarity between neighbours: the number a good chain maximises. */
export function chainSimilarity(order, simMatrix) {
  let total = 0;
  for (let i = 0; i < order.length - 1; i++) total += simMatrix[order[i]][order[i + 1]];
  return total;
}

/** Walks from `start`, always going to the most similar unvisited tab. */
function greedyChainFrom(start, simMatrix) {
  const n = simMatrix.length;
  const visited = new Array(n).fill(false);
  const order = [start];
  visited[start] = true;
  while (order.length < n) {
    const last = order[order.length - 1];
    let next = -1;
    let nextSim = -Infinity;
    for (let j = 0; j < n; j++) {
      if (!visited[j] && simMatrix[last][j] > nextSim) { nextSim = simMatrix[last][j]; next = j; }
    }
    visited[next] = true;
    order.push(next);
  }
  return order;
}

/** Tries a greedy walk from every tab and keeps the strongest. */
export function bestGreedyOrder(simMatrix) {
  let best = [];
  let bestTotal = -Infinity;
  for (let start = 0; start < simMatrix.length; start++) {
    const order = greedyChainFrom(start, simMatrix);
    const total = chainSimilarity(order, simMatrix);
    if (total > bestTotal) { bestTotal = total; best = order; }
  }
  return best;
}

/**
 * Local search: keeps making small changes that raise the chain's total
 * similarity, until none is left.
 *   - Reverse a stretch of the chain (2-opt), which undoes crossed connections.
 *   - Move a run of 1 to 3 tabs elsewhere (or-opt), which rescues stranded tabs.
 *
 * Every accepted change strictly raises the total, so this always finishes.
 */
export function improveChain(startOrder, simMatrix) {
  const order = [...startOrder];
  const n = order.length;
  const MIN_GAIN = 1e-9; // ignore floating-point noise
  // A chain has open ends, so a missing neighbour contributes nothing.
  const sim = (a, b) => (a === undefined || b === undefined ? 0 : simMatrix[a][b]);

  let improved = true;
  while (improved) {
    improved = false;

    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const gain = sim(order[i - 1], order[j]) + sim(order[i], order[j + 1])
          - sim(order[i - 1], order[i]) - sim(order[j], order[j + 1]);
        if (gain > MIN_GAIN) {
          for (let a = i, b = j; a < b; a++, b--) [order[a], order[b]] = [order[b], order[a]];
          improved = true;
        }
      }
    }

    for (let length = 1; length <= 3; length++) {
      for (let i = 0; i + length <= n; i++) {
        const run = order.slice(i, i + length);
        const rest = [...order.slice(0, i), ...order.slice(i + length)];
        const removalGain = sim(order[i - 1], order[i + length])
          - sim(order[i - 1], run[0]) - sim(run[length - 1], order[i + length]);

        let bestGain = MIN_GAIN;
        let bestPosition = -1;
        let bestReversed = false;
        for (let p = 0; p <= rest.length; p++) {
          if (p === i) continue;
          for (const reversed of [false, true]) {
            const first = reversed ? run[length - 1] : run[0];
            const last = reversed ? run[0] : run[length - 1];
            const gain = removalGain + sim(rest[p - 1], first) + sim(last, rest[p]) - sim(rest[p - 1], rest[p]);
            if (gain > bestGain) { bestGain = gain; bestPosition = p; bestReversed = reversed; }
          }
        }

        if (bestPosition >= 0) {
          const placed = bestReversed ? [...run].reverse() : run;
          rest.splice(bestPosition, 0, ...placed);
          rest.forEach((tab, k) => { order[k] = tab; });
          improved = true;
        }
      }
    }
  }
  return order;
}

/**
 * The tab order Threadline uses: MST + DFS and the best greedy walk, each
 * polished by local search, keeping the stronger of the two.
 *
 * @param {ArrayLike<ArrayLike<number>>} simMatrix - N×N similarity matrix
 * @returns {number[]} Ordered array of tab indices
 */
export function buildChainOrder(simMatrix) {
  const n = simMatrix.length;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);

  const fromTree = improveChain(traverseMST(buildMST(simMatrix, n), n), simMatrix);
  const fromGreedy = improveChain(bestGreedyOrder(simMatrix), simMatrix);
  return chainSimilarity(fromTree, simMatrix) >= chainSimilarity(fromGreedy, simMatrix)
    ? fromTree
    : fromGreedy;
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

/**
 * Recomputes every tab's similarityToNext after the user reorders the chain,
 * so each connector describes the two tabs now on either side of it.
 *
 * @param {Array<{originalIndex:number}>} chain - tabs in their new order
 * @param {ArrayLike<ArrayLike<number>>} simMatrix - matrix from the same sort
 * @returns {Array} new tab objects with similarityToNext updated
 */
export function reannotateChain(chain, simMatrix) {
  return chain.map((tab, pos) => {
    const next = chain[pos + 1];
    return {
      ...tab,
      similarityToNext: next ? simMatrix[tab.originalIndex][next.originalIndex] : null,
    };
  });
}

// Self-test lives in tests/graph.test.js — not here.
// Production modules should not contain test code.