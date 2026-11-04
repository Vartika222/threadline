/**
 * THREADLINE — labeler.js
 *
 * Turns a cluster INDEX (0, 1, 2...) into a cluster NAME ("React Hooks",
 * "Trip Planning") using TF-IDF over each cluster's combined tab content.
 *
 * ─── WHY CLUSTER-LEVEL TF-IDF, NOT TAB-LEVEL ─────────────────────────────
 * The usual TF-IDF setup treats each document (here, each tab) separately.
 * We instead treat each CLUSTER as one document — concatenate the content
 * of every tab assigned to it. Why: we don't want "the most distinctive
 * word in this ONE tab", we want "the most distinctive word for this GROUP
 * of tabs as a whole", so a single outlier tab's phrasing doesn't dominate
 * the label. With only 5-30 tabs split into 2-6 clusters, cluster-level
 * documents are also large enough for term frequency to mean something —
 * tab-level TF-IDF on a 6-word title is mostly noise.
 *
 * ─── WHY TF-IDF AND NOT JUST "MOST COMMON WORD" ──────────────────────────
 * Raw frequency would just surface generic words every cluster shares
 * ("tab", "page", "the"). TF-IDF's IDF term down-weights words that show
 * up across MOST clusters and up-weights words that are common in ONE
 * cluster but rare elsewhere — which is exactly "what makes this cluster
 * different from the others", i.e. a good label.
 *
 * ─── LIMITATIONS (be honest about these) ─────────────────────────────────
 * This is bag-of-words term statistics, not a language model — it has no
 * idea "hooks" and "useState" are related React concepts, it just counts.
 * At small N (a handful of tabs per cluster) it works fine as a label
 * generator; it is not a summarisation system.
 */

// A short, deliberately conservative stopword list: English function words
// plus generic web/document noise that would otherwise dominate every
// cluster's word counts regardless of topic.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for',
  'with', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'this',
  'that', 'these', 'those', 'it', 'its', 'as', 'at', 'by', 'from', 'has',
  'have', 'had', 'not', 'no', 'do', 'does', 'did', 'will', 'would',
  'can', 'could', 'should', 'you', 'your', 'we', 'our', 'i', 'he', 'she',
  'they', 'them', 'his', 'her', 'their', 'what', 'which', 'who', 'how',
  'why', 'when', 'where', 'all', 'more', 'most', 'some', 'other', 'into',
  'about', 'than', 'then', 'so', 'if', 'up', 'out', 'get', 'new', 'one',
  'home', 'page', 'welcome', 'search', 'results', 'untitled', 'www',
  'com', 'org', 'net', 'html', 'https', 'http',
]);

const MIN_TOKEN_LENGTH = 3;

/**
 * Splits text into lowercase word tokens, dropping stopwords, very short
 * tokens, and pure numbers.
 */
function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(tok =>
      tok.length >= MIN_TOKEN_LENGTH &&
      !STOPWORDS.has(tok) &&
      !/^\d+$/.test(tok)
    );
}

/**
 * Builds a { term: count } frequency map for a token list.
 */
function termFrequencies(tokens) {
  const freq = {};
  for (const tok of tokens) freq[tok] = (freq[tok] || 0) + 1;
  return freq;
}

/**
 * @param {object[]} tabs - tab objects with .content (falls back to title/url)
 * @param {number[]} clusterAssignments - cluster index per tab (from clusterer.js)
 * @param {object} [options]
 * @param {number} [options.topTermsPerCluster=2]
 * @returns {Object<number, string>} clusterIndex → human-readable label
 */
export function labelClusters(tabs, clusterAssignments, options = {}) {
  const { topTermsPerCluster = 2 } = options;

  // Group tabs' text by cluster, forming one "document" per cluster.
  const clusterTokens = {}; // clusterIdx -> string[]
  tabs.forEach((tab, i) => {
    const clusterIdx = clusterAssignments[i] ?? 0;
    const text = tab.content || tab.title || tab.url || '';
    if (!clusterTokens[clusterIdx]) clusterTokens[clusterIdx] = [];
    clusterTokens[clusterIdx].push(...tokenize(text));
  });

  const clusterIndices = Object.keys(clusterTokens).map(Number);
  const numClusters = clusterIndices.length;

  // Term frequency per cluster, and document frequency (how many CLUSTERS
  // a term appears in at all) for IDF.
  const clusterTF = {}; // clusterIdx -> { term: count }
  const docFreq = {};   // term -> number of clusters containing it

  for (const idx of clusterIndices) {
    const tf = termFrequencies(clusterTokens[idx]);
    clusterTF[idx] = tf;
    for (const term of Object.keys(tf)) {
      docFreq[term] = (docFreq[term] || 0) + 1;
    }
  }

  const labels = {};

  for (const idx of clusterIndices) {
    const tf = clusterTF[idx];
    const terms = Object.keys(tf);

    if (terms.length === 0) {
      labels[idx] = `Group ${idx + 1}`;
      continue;
    }

    const scored = terms.map(term => {
      // +1 smoothing so a term appearing in every cluster doesn't hit
      // idf=0 and vanish entirely — it's just heavily down-weighted.
      const idf = Math.log(numClusters / docFreq[term]) + 1;
      return { term, score: tf[term] * idf };
    });

    scored.sort((a, b) => b.score - a.score);

    const topTerms = scored.slice(0, topTermsPerCluster).map(s => titleCase(s.term));
    labels[idx] = topTerms.join(' & ');
  }

  return labels;
}

function titleCase(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
