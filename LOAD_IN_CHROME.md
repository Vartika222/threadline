# Loading Threadline in Chrome — V2 Guide

## Step 1: Build

```bash
npm install          # first time only
npm run build:verify # builds + checks dist/ is complete
```

Expected output ends with:
```
✓  dist/ is ready to load in Chrome
```

If you see errors, fix them before continuing. The most common: missing icons (run `node scripts/generate-icons.js` if they're not there).

---

## Step 2: Load in Chrome

1. Open **chrome://extensions** in a new tab
2. Enable **Developer mode** — toggle in the top-right corner
3. Click **Load unpacked**
4. Navigate to and select the **`dist/`** folder (not the root of the project — specifically `dist/`)
5. Threadline should appear in the list with a purple hexagon icon

If you see a red error banner instead, read the error message — it's almost always one of:
- `Could not load manifest` → `manifest.json` is malformed or missing a field
- `Service worker registration failed` → `background.js` has a syntax error or bad import
- `Could not load javascript` → a file referenced in manifest.json doesn't exist in dist/

---

## Step 3: Verify the background service worker is running

1. On the chrome://extensions page, find Threadline
2. Click **Service Worker** (shown as a link next to "Inspect views")
3. A DevTools window opens for the service worker context
4. In the **Console** tab, you should see no red errors on load

Now open a few tabs (at least 5, mix of different topics), then come back to the service worker DevTools console and run:

```js
chrome.storage.local.get(null, data => console.log(data))
```

You should see a `tabStore` object with entries for each open tab, containing `title`, `url`, `dwellMs`, `revisitCount`, etc. If `tabStore` is empty or missing, the content script or tab lifecycle listeners aren't firing — check the background.js console for errors.

---

## Step 4: Verify the content script is injecting

1. Open any normal webpage (not chrome://, not a PDF — those don't support content scripts)
2. Open DevTools on that page (F12)
3. In the **Console**, check for any errors from content_script.js
4. In the **Application** tab → **Extension Storage** → find Threadline → check `tabStore`

The entry for the current tab should have a non-empty `content` field (the extracted title + headings).

---

## Step 5: Verify the popup opens

1. Click the Threadline icon in the Chrome toolbar (if it's not pinned, click the puzzle piece → pin Threadline)
2. The popup should open — you should see a list of your current tabs
3. Open the popup's own DevTools: right-click anywhere in the popup → **Inspect**
4. Check the Console for errors

---

## Step 6: Test the ML sort end-to-end

Open at least 8-10 tabs with clearly different topics — for example:
- 3 tabs about React/JavaScript
- 3 tabs about cooking or food
- 2-3 tabs about something unrelated (news, sports, whatever)

Then:
1. Open the popup
2. Click **Sort by relatability**
3. Watch the progress messages in the popup
4. After ~3-5 seconds (USE model loading on first run), the sorted chain should appear
5. Check that the React tabs are adjacent to each other and the food tabs are adjacent to each other

If the sort produces a visually random order, check the popup's DevTools console — the embeddings may have failed to load and the pipeline may have thrown an error silently.

---

## Common Problems

### `Failed to load TensorFlow.js`
USE loads its model weights from a CDN on first use (~25MB download). This requires internet access and may fail on corporate networks. You'll see a network error in the popup console. Fix for V3: bundle the model weights locally.

### `chrome is not defined` in popup
This happens if the popup JS runs outside the extension context (e.g. if you open `popup.html` directly as a file). Always open the popup by clicking the extension icon.

### Background service worker keeps dying
MV3 service workers are not persistent — Chrome kills them after ~30 seconds of inactivity. This is expected. The extension is designed to re-initialise from `chrome.storage` on every event. If state is being lost, check that every handler reads from storage at the start (not from an in-memory variable).

### Sort takes forever
First sort is slow (~3-5s) because USE loads. Subsequent sorts in the same popup session are fast (~0.5s) because the model is cached in the module-level `_model` variable in `embedder.js`. If it's slow every time, the model cache isn't persisting — check that the popup isn't being destroyed between clicks.

---

## What to check before calling V2 done

- [ ] `npm run build:verify` exits 0
- [ ] Extension loads in chrome://extensions without red errors
- [ ] `tabStore` in chrome.storage has real tab data after browsing
- [ ] Popup opens and shows current tab titles
- [ ] Clicking Sort on 8+ tabs produces a non-trivial chain (not just alphabetical or original order)
- [ ] React/JS tabs are adjacent in the output, unrelated topics are separated
- [ ] No errors in popup DevTools console during sort