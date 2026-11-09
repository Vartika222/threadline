# Testing Threadline on your device

Takes about 20 minutes. You need **Node 18 or newer** and **Google Chrome**
(or another Chromium browser such as Edge or Brave).

## 1. Unzip, install, run the automated checks

```bash
cd threadline
npm install
npm test               # expect: every file prints "N passed, 0 failed" (all tests passing)
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

Don't click anything. Within a few seconds of each page loading, it should move into
a named, coloured tab group.

Expected result:
- Named groups in the tab strip. React and Wikipedia tabs land in **Study**, except
  any page the model places elsewhere.
- Click a tab and the toolbar icon shows its category, such as `ST`. Hover over it
  for the subcategory.
- Open the popup and press **Sort now**. It rearranges without asking for approval.
  Press **Undo** and everything goes back.
- Open `https://www.youtube.com/`, then a lecture and a music video. The homepage and
  music go to **Entertainment**, and the lecture to **Study**.
- Works with no internet, because the language model ships with the extension. To
  check, turn off your Wi-Fi and open a saved page or press **Sort now**.

Note down: which tabs landed in the wrong group? That's the most useful thing to send
back.

## 5. Test the learning loop

1. Press **Sort now**, tick **Personalise sorting (experimental)** under the chain,
   then **drag** a card to a new position.
2. A counter appears: `n/15 training examples`. Each drag usually adds 2 to 4
   examples (the pairs the dragged tab joined and left).
3. Keep dragging until it reaches 15. Expected: the message changes to "Your
   corrections will apply from the next sort".
4. In the service worker console (step 3), confirm the weights were saved:

```js
chrome.storage.local.get(['personal_weights','nn_trained_count'], d => console.log(!!d.personal_weights, d.nn_trained_count))
```

Expected: `true` and a number of 15 or more.

5. Close and reopen the popup, then sort. Expected: "✓ This sort used your
   corrections". Untick the box and sort again in a new popup, and the order and
   percentages go back to plain cosine.

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

- **Focus timer:** in the popup, open **Focus**, pick Study and 5 minutes, and click
  **Start focus**. Other groups collapse and the badge shows `5m`. Click a tab in
  another group and the badge shows `!`. End it, start again with **Strict** ticked,
  click another group's tab, and you get a "Back to Study" page. **End focus** asks
  for a second click in strict mode.
- **Automatic sorting off:** untick **Sort tabs automatically** in the popup, then open
  a tab. It should stay where it is.
- **Your own groups:** make a tab group yourself with another name. It should be left
  alone.
- **Snapshots:** arrange some tabs by hand (make a group of your own too), open
  **Snapshots** in the popup and click **Save**. Shuffle the tabs, ungroup them and
  close one, then click **Restore**: the order and groups come back and the closed tab
  reopens. Wait a few seconds: automatic sorting should not move them. **Undo**
  reverses the restore.
- **Service worker restart:** on `chrome://extensions` click the card's reload
  icon, switch between two tabs, and confirm nothing errors.
- **Reset everything:** in the service worker console, run
  `chrome.storage.local.clear()`.

## 8. Measure it (the part for your resume)

```bash
npm run eval:model
```

This runs the bundled model in Node, scores Threadline's chain against MST,
greedy and random orderings on 48 labelled tabs, and writes the table to
`eval/results-minilm.md`. Compare it with the table in the README's "Evaluation"
section. `npm run eval:categories` does the same for category accuracy.

## What to send back if something fails

- The text of any red error on `chrome://extensions` (click **Errors**).
- Anything red in the service worker console or in the popup (right-click the
  popup → **Inspect** → Console).
- The output of `npm test` or `npm run build:verify` if those fail.
