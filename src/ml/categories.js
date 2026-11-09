/**
 * THREADLINE — categories.js
 *
 * Decides which category and subcategory each tab belongs to, in three steps:
 *
 *   1. Mixed sites (YouTube, search engines) are judged by what's open in the
 *      tab, because the site alone says nothing about the content.
 *      A YouTube video goes by its channel, then by the category YouTube lists.
 *   2. Known sites come from a hand-made list. Fast, and needs no model.
 *   3. Anything else is compared with written descriptions of each subcategory,
 *      using the language model, and takes the closest match. If nothing is
 *      close, it goes to Life & Other › Unsure rather than guessing.
 *
 * WHY DESCRIPTIONS AND NOT A TRAINED CLASSIFIER: a small network trained on
 * dmoz.csv got 63% right on real sites, against 90% for this. dmoz has no social
 * or streaming labels, so it can't recognise them. See training/README.md.
 */

/** Order here is the order of the groups in the tab strip. */
export const CATEGORIES = [
  {
    name: 'Study', color: 'blue', hex: '#3B82F6',
    subcategories: {
      'Courses & Lectures': ['online courses and lectures for students', 'university course material, learning and education', 'lecture on a school or college subject, explained step by step'],
      'Practice & Coding Prep': ['coding practice problems and programming interview preparation', 'tutorial on learning to code, exam preparation and study resources'],
      'Reference': ['encyclopedia, dictionary and reference information', 'what is this concept, definition and explanation of how it works'],
      'Science': ['scientific research papers and journals'],
    },
  },
  {
    name: 'Work', color: 'grey', hex: '#6B7280',
    subcategories: {
      'Developer Tools': ['software development tools and code repositories'],
      'Business & Finance': ['business software for companies and sales teams', 'company finance, accounting and invoices'],
      'Productivity': ['project management and team collaboration software', 'email, calendar, documents and productivity tools', 'self-improvement, building good habits, motivation and personal productivity tips'],
      'AI Tools': ['AI chatbot and assistant that answers questions, writes and codes'],
      'Jobs': ['job search, careers and hiring'],
    },
  },
  {
    name: 'Entertainment', color: 'red', hex: '#EF4444',
    subcategories: {
      'Streaming': ['watch movies, TV shows and web series online', 'video streaming service', 'anime and live streams', 'celebrity gossip, comedy and funny videos'],
      'Music': ['listen to music, songs and podcasts', 'official music video and song'],
      'Sports': ['live sports scores, cricket and football'],
      'Reading': ['read stories, novels, fan fiction and webcomics online'],
    },
  },
  {
    name: 'Games', color: 'purple', hex: '#8B5CF6',
    subcategories: {
      'Browser Games': ['play free online games in your browser', 'chess, puzzles and multiplayer gaming'],
      'Game Stores': ['video game store, downloads and PC games'],
      'Gaming News': ['video game news, reviews and guides'],
    },
  },
  {
    name: 'Social', color: 'cyan', hex: '#06B6D4',
    subcategories: {
      'Messaging': ['messaging and chat app to talk with friends and communities'],
      'Feeds': ['social media network to share photos and posts with friends', 'log in to connect with people and follow friends'],
      'Forums': ['online forum and discussion community'],
      'Inspiration': ['share and discover pictures and ideas'],
    },
  },
  {
    name: 'Shopping & Art', color: 'pink', hex: '#EC4899',
    subcategories: {
      'Clothing': ['clothing, shoes and accessories to buy'],
      'Electronics': ['buy phones, laptops and electronics'],
      'Marketplaces': ['online shopping store, buy products with discounts and sale prices'],
      'Fashion & Beauty': ['fashion magazine, beauty trends and style', 'beauty products and makeup'],
      'Art & Design': ['art gallery, museum and artists', 'graphic design portfolio and illustration'],
      'Books & Culture': ['books, literature and culture'],
    },
  },
  {
    name: 'News', color: 'orange', hex: '#F59E0B',
    subcategories: {
      'General': ['breaking news and latest headlines', 'world news, politics and current affairs reporting', 'daily newspaper and journalism'],
      'Business & Tech': ['business and technology news reporting'],
      'Sports & Other': ['sports news and match reports'],
    },
  },
  {
    name: 'Life & Other', color: 'green', hex: '#10B981',
    subcategories: {
      'Health': ['health information, symptoms and medical advice'],
      'Home': ['recipes, cooking and home improvement', 'parenting, family and everyday life'],
      'Travel': ['travel guides, hotels and flights'],
      'Society': ['government services, law and society', 'religion and community organisations'],
      'Unsure': [],
    },
  },
];

export const FALLBACK = { category: 'Life & Other', subcategory: 'Unsure' };

/**
 * Below this similarity to every description, a tab counts as unsure. Set low on
 * purpose: on the test sites, wrong answers were rare, and Unsure tabs lose the
 * benefit of a category.
 */
export const MIN_CONFIDENCE = 0.1;

/** host (without www.) → [category, subcategory]. Subdomains match too. */
export const KNOWN_SITES = {
  // Study
  'swayam.gov.in': ['Study', 'Courses & Lectures'], 'nptel.ac.in': ['Study', 'Courses & Lectures'],
  'coursera.org': ['Study', 'Courses & Lectures'], 'edx.org': ['Study', 'Courses & Lectures'],
  'khanacademy.org': ['Study', 'Courses & Lectures'], 'ocw.mit.edu': ['Study', 'Courses & Lectures'],
  'udemy.com': ['Study', 'Courses & Lectures'], 'byjus.com': ['Study', 'Courses & Lectures'],
  'unacademy.com': ['Study', 'Courses & Lectures'], 'classroom.google.com': ['Study', 'Courses & Lectures'],
  'hackerrank.com': ['Study', 'Practice & Coding Prep'], 'leetcode.com': ['Study', 'Practice & Coding Prep'],
  'geeksforgeeks.org': ['Study', 'Practice & Coding Prep'], 'codecademy.com': ['Study', 'Practice & Coding Prep'],
  'w3schools.com': ['Study', 'Practice & Coding Prep'], 'codechef.com': ['Study', 'Practice & Coding Prep'],
  'codeforces.com': ['Study', 'Practice & Coding Prep'], 'quizlet.com': ['Study', 'Practice & Coding Prep'],
  'codolio.com': ['Study', 'Practice & Coding Prep'], 'takeuforward.org': ['Study', 'Practice & Coding Prep'],
  'interviewbit.com': ['Study', 'Practice & Coding Prep'],
  'wikipedia.org': ['Study', 'Reference'], 'britannica.com': ['Study', 'Reference'],
  'arxiv.org': ['Study', 'Science'], 'nature.com': ['Study', 'Science'], 'scholar.google.com': ['Study', 'Science'],
  // Work
  'github.com': ['Work', 'Developer Tools'], 'gitlab.com': ['Work', 'Developer Tools'],
  'stackoverflow.com': ['Work', 'Developer Tools'], 'vercel.com': ['Work', 'Developer Tools'],
  'notion.so': ['Work', 'Productivity'], 'notion.com': ['Work', 'Productivity'], 'notion.site': ['Work', 'Productivity'],
  'todoist.com': ['Work', 'Productivity'], 'ticktick.com': ['Work', 'Productivity'], 'evernote.com': ['Work', 'Productivity'],
  'obsidian.md': ['Work', 'Productivity'], 'clickup.com': ['Work', 'Productivity'], 'monday.com': ['Work', 'Productivity'],
  'miro.com': ['Work', 'Productivity'], 'habitica.com': ['Work', 'Productivity'], 'keep.google.com': ['Work', 'Productivity'],
  'jamesclear.com': ['Work', 'Productivity'], 'markmanson.net': ['Work', 'Productivity'], 'zenhabits.net': ['Work', 'Productivity'],
  'lifehack.org': ['Work', 'Productivity'], 'calnewport.com': ['Work', 'Productivity'],
  'gemini.google.com': ['Work', 'AI Tools'], 'aistudio.google.com': ['Work', 'AI Tools'], 'notebooklm.google.com': ['Work', 'AI Tools'],
  'chatgpt.com': ['Work', 'AI Tools'], 'chat.openai.com': ['Work', 'AI Tools'], 'claude.ai': ['Work', 'AI Tools'],
  'perplexity.ai': ['Work', 'AI Tools'], 'copilot.microsoft.com': ['Work', 'AI Tools'], 'chat.deepseek.com': ['Work', 'AI Tools'],
  'grok.com': ['Work', 'AI Tools'], 'chat.mistral.ai': ['Work', 'AI Tools'], 'poe.com': ['Work', 'AI Tools'],
  'meta.ai': ['Work', 'AI Tools'], 'phind.com': ['Work', 'AI Tools'], 'slack.com': ['Work', 'Productivity'], 'trello.com': ['Work', 'Productivity'],
  'asana.com': ['Work', 'Productivity'], 'atlassian.com': ['Work', 'Productivity'], 'atlassian.net': ['Work', 'Productivity'],
  'zoom.us': ['Work', 'Productivity'], 'mail.google.com': ['Work', 'Productivity'], 'docs.google.com': ['Work', 'Productivity'],
  'drive.google.com': ['Work', 'Productivity'], 'calendar.google.com': ['Work', 'Productivity'],
  'meet.google.com': ['Work', 'Productivity'], 'outlook.com': ['Work', 'Productivity'], 'office.com': ['Work', 'Productivity'],
  'salesforce.com': ['Work', 'Business & Finance'], 'hubspot.com': ['Work', 'Business & Finance'],
  'naukri.com': ['Work', 'Jobs'], 'indeed.com': ['Work', 'Jobs'], 'internshala.com': ['Work', 'Jobs'],
  // Entertainment
  'hotstar.com': ['Entertainment', 'Streaming'], 'netflix.com': ['Entertainment', 'Streaming'],
  'primevideo.com': ['Entertainment', 'Streaming'], 'hulu.com': ['Entertainment', 'Streaming'],
  'disneyplus.com': ['Entertainment', 'Streaming'], 'sonyliv.com': ['Entertainment', 'Streaming'],
  'zee5.com': ['Entertainment', 'Streaming'], 'crunchyroll.com': ['Entertainment', 'Streaming'],
  'wattpad.com': ['Entertainment', 'Reading'], 'webtoons.com': ['Entertainment', 'Reading'],
  'archiveofourown.org': ['Entertainment', 'Reading'], 'fanfiction.net': ['Entertainment', 'Reading'],
  'royalroad.com': ['Entertainment', 'Reading'], 'pratilipi.com': ['Entertainment', 'Reading'],
  'twitch.tv': ['Entertainment', 'Streaming'], 'imdb.com': ['Entertainment', 'Streaming'],
  'spotify.com': ['Entertainment', 'Music'], 'gaana.com': ['Entertainment', 'Music'],
  'jiosaavn.com': ['Entertainment', 'Music'], 'music.youtube.com': ['Entertainment', 'Music'],
  'espn.com': ['Entertainment', 'Sports'], 'espncricinfo.com': ['Entertainment', 'Sports'], 'cricbuzz.com': ['Entertainment', 'Sports'],
  // Games
  'chess.com': ['Games', 'Browser Games'], 'lichess.org': ['Games', 'Browser Games'], 'poki.com': ['Games', 'Browser Games'],
  'miniclip.com': ['Games', 'Browser Games'], 'roblox.com': ['Games', 'Browser Games'],
  'steampowered.com': ['Games', 'Game Stores'], 'epicgames.com': ['Games', 'Game Stores'], 'itch.io': ['Games', 'Game Stores'],
  'ign.com': ['Games', 'Gaming News'], 'gamespot.com': ['Games', 'Gaming News'], 'polygon.com': ['Games', 'Gaming News'],
  // Social
  'discord.com': ['Social', 'Messaging'], 'whatsapp.com': ['Social', 'Messaging'], 'telegram.org': ['Social', 'Messaging'],
  'instagram.com': ['Social', 'Feeds'], 'facebook.com': ['Social', 'Feeds'], 'x.com': ['Social', 'Feeds'],
  'twitter.com': ['Social', 'Feeds'], 'threads.net': ['Social', 'Feeds'], 'tiktok.com': ['Social', 'Feeds'],
  'snapchat.com': ['Social', 'Feeds'], 'linkedin.com': ['Social', 'Feeds'], 'tumblr.com': ['Social', 'Feeds'],
  'reddit.com': ['Social', 'Forums'], 'quora.com': ['Social', 'Forums'],
  'pinterest.com': ['Social', 'Inspiration'], 'pinterest.co.uk': ['Social', 'Inspiration'], 'in.pinterest.com': ['Social', 'Inspiration'],
  // Shopping & Art
  'whistles.com': ['Shopping & Art', 'Clothing'], 'myntra.com': ['Shopping & Art', 'Clothing'], 'ajio.com': ['Shopping & Art', 'Clothing'],
  'zara.com': ['Shopping & Art', 'Clothing'], 'asos.com': ['Shopping & Art', 'Clothing'], 'hm.com': ['Shopping & Art', 'Clothing'],
  'amazon.in': ['Shopping & Art', 'Marketplaces'], 'amazon.com': ['Shopping & Art', 'Marketplaces'], 'flipkart.com': ['Shopping & Art', 'Marketplaces'],
  'ebay.com': ['Shopping & Art', 'Marketplaces'], 'etsy.com': ['Shopping & Art', 'Marketplaces'], 'meesho.com': ['Shopping & Art', 'Marketplaces'],
  'walmart.com': ['Shopping & Art', 'Marketplaces'], 'target.com': ['Shopping & Art', 'Marketplaces'],
  'nykaa.com': ['Shopping & Art', 'Fashion & Beauty'], 'vogue.com': ['Shopping & Art', 'Fashion & Beauty'], 'vogue.in': ['Shopping & Art', 'Fashion & Beauty'],
  'elle.com': ['Shopping & Art', 'Fashion & Beauty'], 'gq.com': ['Shopping & Art', 'Fashion & Beauty'], 'wwd.com': ['Shopping & Art', 'Fashion & Beauty'],
  'behance.net': ['Shopping & Art', 'Art & Design'], 'dribbble.com': ['Shopping & Art', 'Art & Design'], 'artstation.com': ['Shopping & Art', 'Art & Design'],
  'deviantart.com': ['Shopping & Art', 'Art & Design'], 'moma.org': ['Shopping & Art', 'Art & Design'],
  // News
  'pudding.cool': ['News', 'General'], 'bbc.com': ['News', 'General'], 'bbc.co.uk': ['News', 'General'], 'nytimes.com': ['News', 'General'], 'theguardian.com': ['News', 'General'],
  'reuters.com': ['News', 'General'], 'thehindu.com': ['News', 'General'], 'ndtv.com': ['News', 'General'],
  'indiatimes.com': ['News', 'General'], 'indianexpress.com': ['News', 'General'], 'cnn.com': ['News', 'General'], 'aljazeera.com': ['News', 'General'],
  // Life & Other
  'webmd.com': ['Life & Other', 'Health'], 'mayoclinic.org': ['Life & Other', 'Health'], 'healthline.com': ['Life & Other', 'Health'],
  'who.int': ['Life & Other', 'Health'], 'allrecipes.com': ['Life & Other', 'Home'],
  'booking.com': ['Life & Other', 'Travel'], 'airbnb.com': ['Life & Other', 'Travel'], 'tripadvisor.com': ['Life & Other', 'Travel'],
  'makemytrip.com': ['Life & Other', 'Travel'], 'irctc.co.in': ['Life & Other', 'Travel'],
  'usa.gov': ['Life & Other', 'Society'], 'india.gov.in': ['Life & Other', 'Society'],
};

/** YouTube channels that always count as Study, lower-case. */
export const STUDY_CHANNELS = new Set([
  'nptel', 'nptel-noc iitm', 'nptel hrd', 'khan academy', 'freecodecamp.org', '3blue1brown', 'mit opencourseware',
  'crashcourse', 'stanford', 'stanford online', 'harvard university', 'cs50', 'neso academy', 'gate smashers',
  'apna college', 'code with harry', 'codewithharry', 'unacademy', 'physics wallah - alakh pandey', 'physicswallah',
  'abdul bari', 'statquest with josh starmer', 'sentdex', 'corey schafer', 'ted-ed', 'veritasium', 'organic chemistry tutor',
  'the organic chemistry tutor', 'professor leonard', 'traversy media', 'programming with mosh', 'fireship',
]);

/**
 * YouTube's own category for a video, as the uploader chose it, read from the
 * video's page. Categories missing here (People & Blogs, Science & Technology,
 * Howto & Style, ...) cover too many kinds of video, so the model decides those.
 */
export const YOUTUBE_CATEGORIES = {
  'Education': { category: 'Study', subcategory: 'Courses & Lectures' },
  'Music': { category: 'Entertainment', subcategory: 'Music' },
  'Gaming': { category: 'Games', subcategory: 'Gaming News' },
  'Sports': { category: 'Entertainment', subcategory: 'Sports' },
  'News & Politics': { category: 'News', subcategory: 'General' },
  'Film & Animation': { category: 'Entertainment', subcategory: 'Streaming' },
  'Comedy': { category: 'Entertainment', subcategory: 'Streaming' },
  'Entertainment': { category: 'Entertainment', subcategory: 'Streaming' },
  'Shows': { category: 'Entertainment', subcategory: 'Streaming' },
  'Trailers': { category: 'Entertainment', subcategory: 'Streaming' },
  'Movies': { category: 'Entertainment', subcategory: 'Streaming' },
};

const YOUTUBE_DEFAULT = { category: 'Entertainment', subcategory: 'Streaming' };
const LEARNING_ON_YOUTUBE = new Set(['Developer Tools', 'AI Tools']);
const YOUTUBE_CODING = { category: 'Study', subcategory: 'Courses & Lectures' };

// A page that refused to load says nothing about the site, so don't guess from it.
const REFUSED_PAGE = /^(access (to this page has been )?denied|just a moment|attention required|are you a robot|verify you are human|403\b|404\b|page not found)/i;

// The search sites themselves, not every Google site: gemini.google.com isn't a search.
const SEARCH_ENGINES = /^(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com)$/;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Looks a host up in KNOWN_SITES, also trying its parent domains. */
function lookUpKnownSite(host) {
  const parts = host.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const match = KNOWN_SITES[parts.slice(i).join('.')];
    if (match) return { category: match[0], subcategory: match[1] };
  }
  return null;
}

/** Removes things like "(1157) " and " - YouTube" from a title. */
export function cleanTitle(title) {
  return (title || '')
    .replace(/^\(\d+\+?\)\s*/, '')
    .replace(/\s+[-–|]\s+(YouTube|Google Search|Bing|DuckDuckGo)\s*$/i, '')
    .trim();
}

/** The text to classify a tab by. */
export function classificationText(tab) {
  const title = cleanTitle(tab.title);
  const details = tab.description || (tab.content || '')
    .split(tab.title || '\0').join('')
    .replace(/^[.\s]+/, '');
  return [tab.channel, title, details].filter(Boolean).join('. ').slice(0, 400);
}

/**
 * Answers from rules alone, without the model.
 *
 * @returns {{category:string, subcategory:string}|{useModel:true, defaultTo?:object}}
 */
export function classifyByRules(tab) {
  const host = hostOf(tab.url);

  if (host === 'youtube.com' || host === 'm.youtube.com') {
    const { pathname } = new URL(tab.url);
    const isVideo = /^\/(watch|shorts|live)\b/.test(pathname);
    const isChannel = /^\/(@|channel\/|c\/|user\/)/.test(pathname);
    if (!isVideo && !isChannel) return YOUTUBE_DEFAULT; // home, subscriptions, ...
    if (STUDY_CHANNELS.has((tab.channel || '').trim().toLowerCase())) {
      return { category: 'Study', subcategory: 'Courses & Lectures' };
    }
    if (isVideo && YOUTUBE_CATEGORIES[tab.youtubeCategory]) return YOUTUBE_CATEGORIES[tab.youtubeCategory];
    // A video or channel the model isn't sure about is still most likely entertainment.
    return { useModel: true, defaultTo: YOUTUBE_DEFAULT, onYouTube: true };
  }

  const known = lookUpKnownSite(host);
  if (known) return known;

  if (REFUSED_PAGE.test(cleanTitle(tab.title))) return FALLBACK;

  // A company's careers pages are about the job, whatever the company does.
  if (/^(careers|jobs)\./.test(host) || /\/(careers|jobs)(\/|$)/i.test(new URL(tab.url).pathname)) {
    return { category: 'Work', subcategory: 'Jobs' };
  }

  if (SEARCH_ENGINES.test(host)) {
    // Judge a search by what was searched for. A search homepage has no topic.
    const { pathname, searchParams } = new URL(tab.url);
    const query = pathname.startsWith('/search') ? searchParams.get('q') : null;
    return query ? { useModel: true, text: query } : FALLBACK;
  }

  return { useModel: true };
}

// ─── The model step ───────────────────────────────────────────────────────

let descriptionVectors = null;

/** Embeds every subcategory description once. */
async function loadDescriptionVectors(embed) {
  if (descriptionVectors) return descriptionVectors;
  const entries = CATEGORIES.flatMap(c => Object.entries(c.subcategories).flatMap(([subcategory, descriptions]) =>
    descriptions.map(text => ({ category: c.name, subcategory, text }))));
  const vectors = await embed(entries.map(e => e.text));
  descriptionVectors = entries.map((e, i) => ({ ...e, vector: vectors[i] }));
  return descriptionVectors;
}

/** The closest description to a unit-length vector. */
export function closestDescription(vector, descriptions) {
  let best = null;
  let bestScore = -Infinity;
  for (const d of descriptions) {
    let score = 0;
    for (let i = 0; i < vector.length; i++) score += vector[i] * d.vector[i];
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return { category: best.category, subcategory: best.subcategory, score: bestScore };
}

/**
 * Classifies tabs, using the model only for those the rules can't settle.
 *
 * @param {Array<{url:string, title?:string, description?:string, content?:string, channel?:string, youtubeCategory?:string}>} tabs
 * @param {(texts:string[]) => Promise<number[][]>} embed - function name kept
 *        out of this module so sites on the list never load the model
 * @param {{useRules?:boolean}} [options] - useRules:false measures the model alone
 * @returns {Promise<Array<{category:string, subcategory:string}>>} one per tab
 */
export async function classifyTabs(tabs, embed, { useRules = true } = {}) {
  const decisions = tabs.map(tab => (useRules ? classifyByRules(tab) : { useModel: true }));
  const needModel = decisions.flatMap((d, i) => (d.useModel ? [i] : []));

  if (needModel.length > 0) {
    const descriptions = await loadDescriptionVectors(embed);
    const vectors = await embed(needModel.map(i => decisions[i].text || classificationText(tabs[i])));
    needModel.forEach((tabIndex, n) => {
      const closest = closestDescription(vectors[n], descriptions);
      const decision = decisions[tabIndex];
      decisions[tabIndex] = closest.score >= MIN_CONFIDENCE ? closest : (decision.defaultTo || FALLBACK);
      // A video about programming or an AI tool is for learning, not the tool itself.
      if (decision.onYouTube && LEARNING_ON_YOUTUBE.has(decisions[tabIndex].subcategory)) decisions[tabIndex] = YOUTUBE_CODING;
    });
  }
  return decisions.map(({ category, subcategory }) => ({ category, subcategory }));
}

/** Everything the service worker needs to place a tab in the tab strip. */
export function placementFor({ category, subcategory }) {
  const categoryIndex = CATEGORIES.findIndex(c => c.name === category);
  const entry = CATEGORIES[categoryIndex];
  return {
    category,
    subcategory,
    color: entry.color,
    categoryRank: categoryIndex,
    subcategoryRank: Object.keys(entry.subcategories).indexOf(subcategory),
  };
}

export const CATEGORY_NAMES = CATEGORIES.map(c => c.name);
