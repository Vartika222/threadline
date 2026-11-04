# Testing Threadline on your device

Takes about 20 minutes. You need **Node 18 or newer** and **Google Chrome**
(or another Chromium browser such as Edge or Brave).

## 1. Unzip, install, run the automated checks

```bash
cd threadline
npm install
npm test               # expect: every file prints "N passed, 0 failed" (142 tests in total)
npm run build:verify   # expect the last line: "✓  dist/ is ready to load in Chrome"
```

If either fails, stop and send me the output.

## 2. Load it into Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the **`dist`** folder inside `threadline`
   (not the project root).
4. Click the puzzle-piece icon in the toolbar and **pin** Threadline.

Expected: Threadline appears with no red "Errors" button on its card.

## 3. Check the background worker

1. On its card in `chrome://extensions`, click **service worker** to open its DevTools.
2. In the Console, run:

```js
chrome.storage.local.get('tabStore', d => console.table(Object.values(d.tabStore).map(t => ({ title: t.title, domain: t.domain, chars: (t.content||'').length }))))
```

Expected: one row per open tab, with a domain and, for normal web pages, a
non-zero `chars` value. (Pages already open when you installed get their
content read automatically; if a row shows 0 chars, reload that page.)

## 4. The main test: does it sort by topic?

Open these nine tabs **in this mixed-up order** (so there is real work to do):

| # | Topic | URL |
| --- | --- | --- |
| 1 | React | https://react.dev/reference/react/useEffect |
| 2 | Food | https://en.wikipedia.org/wiki/Carbonara |
| 3 | Japan | https://en.wikipedia.org/wiki/Kyoto |
| 4 | React | https://react.dev/reference/react/useState |
| 5 | Food | https://en.wikipedia.org/wiki/Sourdough |
| 6 | Japan | https://en.wikipedia.org/wiki/Shinkansen |
| 7 | React | https://react.dev/reference/react/useMemo |
| 8 | Food | https://en.wikipedia.org/wiki/Curry |
| 9 | Japan | https://en.wikipedia.org/wiki/Tokyo |

Then click the Threadline icon and press **Sort by relatability**.

**Needs internet every time the popup is opened:** it requests the language model
(~25MB the first time, then mostly from the browser cache). Expect about 15
seconds with an empty cache, about 4 seconds for each new popup, and under a
second for another sort in the same popup (measured on an M4 Mac). With no
connection you should see the message "Could not load the language model…"
instead of a crash.

Expected result:
- A chain where the three React tabs sit together, the three food tabs together
  and the three Japan tabs together (the order of the groups can vary).
- Two or three colours, with a legend of names (the most distinctive words in
  each group). Grouping tends to find too few topics: in a test run food and
  Japan shared one colour, with the legend "React & Useeffect" / "Wikipedia &
  Contents". Sorting the same tabs again gives the same colours and names, even
  after their order changes.
- Press **Apply Order** and check Chrome's tab strip rearranges to match.

Note down: did the three groups come out contiguous? How many seconds did the
first sort take, and the second?

## 5. Test the learning loop

1. Sort again, then **drag** a card to a new position in the popup list.
2. Under the chain, a counter appears: `n/15 training examples`. Each drag
   usually adds 4 to 6 examples (2 if it moves a tab from one end to the other),
   counting the pairs you created and the pairs you broke.
3. Keep dragging until it reaches 15. Expected: the message changes to
   "Learning from your corrections…" and then "✓ Sorting personalised to you".
4. In the service worker console (step 3), confirm a trained model was saved:

```js
chrome.storage.local.get(['nn_weights','nn_version','nn_saved_at'], d => console.log(!!d.nn_weights, d.nn_version, new Date(d.nn_saved_at)))
```

Expected: `true 3 <recent date>`.

## 6. Test tab-switch learning (no dragging)

1. Pick any two tabs, A and B. Click A, B, A, B, A, B (at least three switches
   between them) within five minutes.
2. In the service worker console:

```js
chrome.storage.local.get('implicit_training_candidates', d => console.log(d))
```

   Expected: one queued pair.
3. Open the popup and sort. The example counter should jump by 2 (one pair that
   was related, plus one unrelated "weak negative").

## 7. Other checks

- **Save snapshot:** click **↓ Save** in the popup, then run in the service
  worker console: `chrome.storage.local.get('snapshots', console.log)`. Expect
  one snapshot with your tab list. (There is no screen to view snapshots yet.)
- **Service worker restart:** on `chrome://extensions` click the card's reload
  icon, switch between two tabs, and confirm nothing errors.
- **Reset everything:** in the service worker console, run
  `chrome.storage.local.clear()`.

## 8. Measure it (the part for your resume)

```bash
npm run eval:use
```

This downloads the same model in Node, scores Threadline's chain against a
greedy and a random ordering on 48 labelled tabs, and writes the table to
`eval/results-use.md`. Compare it with the table in the README's "Evaluation"
section.
If the Node run cannot download the model on your network, run the offline
version (`npm run eval`) just to check the harness, and tell me.

## What to send back if something fails

- The text of any red error on `chrome://extensions` (click **Errors**).
- Anything red in the service worker console or in the popup (right-click the
  popup → **Inspect** → Console).
- The output of `npm test` or `npm run build:verify` if those fail.
