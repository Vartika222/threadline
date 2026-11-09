# ⬡ Threadline

> **An on-device Chrome extension that sorts your tabs by itself** into named groups
> like Study, Social and Shopping & Art, as soon as they load.

Most tabs pile up in the order you opened them. Threadline moves each one into a
named, coloured Chrome tab group for its category, with no clicking, and keeps
related tabs next to each other inside the group.

**Status:** working prototype, loaded unpacked in Chrome. Not published on the
Chrome Web Store.

---

## How it works

1. **Read.** A content script reads each page's title, meta description, top
   headings and first paragraph, plus the channel and YouTube's own category
   (Education, Music, Gaming, ...) on YouTube videos.
2. **Categorise.** Each tab gets one of 8 categories and a subcategory:

   | Category | Subcategories |
   | --- | --- |
   | Study | Courses & Lectures, Practice & Coding Prep, Reference, Science |
   | Work | Developer Tools, Business & Finance, Productivity, Jobs |
   | Entertainment | Streaming, Music, Sports |
   | Games | Browser Games, Game Stores, Gaming News |
   | Social | Messaging, Feeds, Forums, Inspiration |
   | Shopping & Art | Clothing, Electronics, Marketplaces, Fashion & Beauty, Art & Design, Books & Culture |
   | News | General, Business & Tech, Sports & Other |
   | Life & Other | Health, Home, Travel, Society, Unsure |

   Three steps decide it:
   - **Content on mixed sites.** A YouTube video is judged by its channel, then the
     category YouTube lists for it, then its title, so a lecture lands in Study and
     the homepage in Entertainment. Switching video inside YouTube re-sorts the tab. A Google search
     is judged by what was searched for.
   - **A known sites list** for common sites. This needs no model.
   - **The language model** for everything else. A pretrained neural network,
     `all-MiniLM-L6-v2` (run with Transformers.js on WebAssembly), compares the page
     with written descriptions of each subcategory and takes the closest match.
3. **Group.** The tab moves into a named, coloured tab group, in subcategory order.
   Only tabs on a new URL are touched. Tabs you moved by hand stay put until they
   navigate, and groups you made yourself are never changed. The toolbar badge shows
   the active tab's category.
4. **Chain (Sort now).** The **Sort now** button in the popup rearranges everything:
   categories in a fixed order, and within each subcategory the strongest chain of
   related tabs. That chain is built from the best of a maximum spanning tree walked
   depth-first and a greedy walk, polished by local search. **Undo** restores the
   previous arrangement.
5. **Focus timer.** In the popup's **Focus** page, pick a category and a duration
   (25, 50, 90 or any number of minutes) and click **Start focus**. It never starts on
   its own. The other groups collapse and the icon counts down the minutes. Opening
   another category shows `!` on the icon, or, with **Strict** ticked, a "Back to
   Study" page offering **Allow this site** and **End focus**. Tabs marked Unsure are
   never blocked. Ending a strict session early takes two clicks.
6. **Snapshots.** In the popup's **Snapshots** page, **Save** keeps this window's tabs
   in their order and groups, including anything arranged by hand (**↓ Save** in the
   header does the same without a name). **Restore** puts the tabs back, reopens any
   that were closed, and recreates the groups; automatic sorting then leaves those
   tabs where they are until they navigate somewhere new. **Undo** reverses a
   restore. The last 20 snapshots are kept.
7. **Personalise (optional, off by default).** Tick **Personalise sorting
   (experimental)** in the popup and Threadline learns from your drags and from
   switching back and forth between two tabs. This only affects the order inside a
   subcategory, and it hasn't been shown to help (see Evaluation).

## Privacy — what is and isn't on-device

- Tab text, URLs, behaviour data and your corrections **never leave your
  browser**. They live in `chrome.storage.local`. No analytics, no telemetry.
- **The language model ships inside the extension** (`all-MiniLM-L6-v2`, about
  23 MB, plus a 21 MB WebAssembly runtime), so sorting works offline and makes no
  request for the model.
- **Favicons:** the popup shows each tab's icon, so the browser may request it
  from that tab's own site. This is the only network traffic the popup causes.
- Permissions: `tabs` (list and reorder tabs), `storage` (local data), and a
  content script on all sites (to read the page text and dwell time). `scripting`
  is used at install, to inject that content script into pages that were already
  open (Chrome only injects it into pages loaded afterwards). Without access to
  page text there is nothing to embed. The page security policy allows
  `wasm-unsafe-eval`, which WebAssembly needs to run.
- `tabGroups` creates the named groups, `offscreen` runs the model in a hidden page
  so sorting can happen with the popup closed, and `alarms` runs the focus timer.
- Dwell time, revisit and tab-switch counts are still recorded locally, but
  nothing uses them for sorting. Recency only fades idle tabs in the popup.

## Install and run

```bash
npm install
npm test               # all tests, no browser needed
npm run build:verify   # builds dist/ and checks it is complete
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select the **`dist/`** folder. A step-by-step check-list is in
[LOAD_IN_CHROME.md](LOAD_IN_CHROME.md).

After any code change, run `npm run build` again and click the reload icon on
the extension's card in `chrome://extensions`.

## Evaluation

Run it yourself (works offline):

```bash
npm run eval        # offline lexical stand-in: checks the harness itself
npm run eval:model  # chain quality, with the real model
npm run eval:categories  # category accuracy, with the real model
```

**Categories.** `eval/category_sites.json` holds 83 real sites with hand-assigned
categories, captured from their homepages:

| Test | Correct |
| --- | ---: |
| Sites, language model alone (no known sites list) | **78 of 83 (94%)** |
| YouTube videos by title | 22 of 22 |
| Google searches | 8 of 9 |

Treat these as optimistic. I chose the test sites, they're homepages, and I adjusted
a description after seeing the search and video tests, which I also wrote by hand.
Those two tests are small. With the known sites list the site score reaches 100%,
but most of those sites are on the list, so that number says nothing. Mistakes on the
sites were art sites going to Social and government or health sites going to News.

A small neural network trained on `dmoz.csv` (1.2M website descriptions) got only
63% on held-out real sites, against 90% for the descriptions on the same sites, so it
isn't used. See [training/README.md](training/README.md).

**Chain quality.** `eval/tabs.json` holds 48 labelled tabs (8 topics × 6), with short
descriptions as their text. Each trial draws a random subset of tabs and scores:

**Short descriptions, `eval/tabs.json`** (100 trials per size, mean ± standard error):

| Tabs | Ordering | Neighbour agreement ↑ | Runs per topic ↓ |
| ---: | --- | ---: | ---: |
| 10 | **threadline** | **0.392 ± 0.011** | **1.055 ± 0.010** |
| 10 | mst-dfs alone | 0.361 ± 0.011 | 1.102 ± 0.011 |
| 10 | greedy-nn alone | 0.373 ± 0.012 | 1.082 ± 0.011 |
| 10 | random | 0.101 ± 0.010 | 1.498 ± 0.020 |
| 20 | **threadline** | **0.584 ± 0.006** | **1.152 ± 0.012** |
| 20 | mst-dfs alone | 0.526 ± 0.007 | 1.294 ± 0.017 |
| 20 | greedy-nn alone | 0.539 ± 0.006 | 1.262 ± 0.014 |
| 20 | random | 0.097 ± 0.006 | 2.355 ± 0.019 |
| 30 | **threadline** | **0.696 ± 0.005** | **1.229 ± 0.016** |
| 30 | mst-dfs alone | 0.623 ± 0.006 | 1.495 ± 0.020 |
| 30 | greedy-nn alone | 0.653 ± 0.005 | 1.385 ± 0.020 |
| 30 | random | 0.106 ± 0.005 | 3.377 ± 0.018 |

**Real page text** (100 trials per size). A separate check on 40 real pages (8 topics
× 5, from Wikipedia, react.dev, MDN and Python docs). This dataset isn't in the repo.

| Tabs | Threadline | MST alone | Greedy alone | Runs per topic (Threadline / MST) |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 0.404 | 0.372 | 0.392 | 1.01 / 1.06 |
| 20 | 0.632 | 0.595 | 0.624 | 1.02 / 1.11 |
| 30 | 0.750 | 0.715 | 0.737 | 1.03 / 1.16 |

(The offline `hash` embedder exists only so the harness can run anywhere; its
numbers say nothing about Threadline's actual quality.)

**Fine-tuning hasn't beaten the pretrained model on tabs.** See
[training/README.md](training/README.md) for how to run it and the results.

**Personalisation has not been shown to help.** A simulated user made consistent
drags through the real training code, and chains were scored on tabs left out of
training (20 seeds). Neighbour agreement against that user's own grouping:

| Examples | Plain cosine | Shipped model |
| ---: | ---: | ---: |
| 15 | 0.641 | 0.639 |
| 30 | 0.641 | 0.628 |
| 60 | 0.641 | 0.641 |

The shipped model stayed within about 0.02 of plain cosine in every scenario,
including random drags, so it does no real harm but learns little. An earlier
72,665-parameter network trained on the drags did clear damage (0.565 to 0.383 at
60 examples, 5 seeds, with the previous embedding model), so it was removed. That's
why this feature is off by default. A proper test would record real people's
corrections, hold some out, and compare.

## Project layout

```
background.js        MV3 service worker: tab lifecycle, serialised storage writes, messages
content_script.js    Page text extraction + dwell tracking (shipped as-is, no imports)
src/ml/              categories, embedder, graph (chain), personalise, feedback,
                     implicitFeedback, recency, pipeline
src/offscreen/       Hidden page that classifies tabs for the service worker
blocked.html/.js     The page strict focus shows
public/model/        The language model, bundled (see THIRD_PARTY_NOTICES.md)
training/            Scripts to fine-tune the language model and train a category network
src/popup/           React popup UI
tests/               Plain-Node tests (+ chrome.* mock in tests/helpers)
eval/                labelled tabs + chain-quality benchmark
```

See [CODE_GUIDE.md](CODE_GUIDE.md) for a guided tour of the code and
[CONTRIBUTING.md](CONTRIBUTING.md) for the dev workflow.

## Known limitations / roadmap

- Personalisation is off by default and hasn't been shown to help (see
  Evaluation).
- Snapshots restore into the current window only, and a restored tab that redirects
  to a different address loses its protection from automatic sorting.
- **Categories will sometimes be wrong**, especially for sites that aren't on the known
  list, and there's no way yet to correct one and have it remembered.
- Short searches give the model little to go on: "what is photosynthesis" lands in
  Social.
- YouTube's category for a video is whatever the uploader picked, and is read from
  YouTube's page data, so a redesign could stop that working. Video titles would
  still be used.
- The model only understands English: a lecture titled in another language can land
  in the wrong category.
- Tab groups can't be nested in Chrome, so subcategories only show as the order inside
  a group, in the popup, and in the badge's tooltip.
- **Sort now** takes a few seconds, because WebAssembly runs on one thread in an
  extension popup. Sites on the known list sort instantly.
- The extension is about 45 MB once built, because of the model and its runtime.
- Pinned tabs and `chrome://` tabs aren't sorted.
- No Chrome Web Store listing yet.

## License

MIT — see [LICENSE](LICENSE).
