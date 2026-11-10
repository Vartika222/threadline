/**
 * THREADLINE — App.jsx
 *
 * The popup UI. Three views:
 *   'idle'    → default: pages for the tabs and Sort button, the focus timer,
 *               and snapshots
 *   'sorting' → ML pipeline running, shows progress
 *   'sorted'  → shows the relatability chain, apply button
 *
 * LEARNING NOTE:
 * Chrome extension popups are just normal web pages that happen to
 * open in a small window. They have access to the chrome.* APIs because
 * the extension context gives it. You write them exactly like a React app.
 *
 * The popup closes when the user clicks outside it. Any state not saved
 * to chrome.storage is lost. Keep UI state lightweight.
 */

import { squirrelSvg } from './squirrel.js';
import React, { useState, useEffect } from 'react';
import TabChain, { CLUSTER_COLORS } from './TabChain.jsx';
import SortButton from './SortButton.jsx';
import FocusPanel from './FocusPanel.jsx';
import SnapshotsPanel from './SnapshotsPanel.jsx';
import ModelPanel from './ModelPanel.jsx';
import { CATEGORY_NAMES } from '../ml/categories.js';
import { runMLPipeline } from '../ml/pipeline.js';
import { deriveTrainingPairs } from '../ml/feedback.js';
import { reannotateChain } from '../ml/graph.js';
import { computeRecencyNorm, formatIdleDuration } from '../ml/recency.js';
import {
  storeTrainingExample,
  loadTrainingExamples,
  loadExamplesSeen,
  trainAdjustments,
  saveAdjustments,
  shouldRetrain,
  isPersonalisationEnabled,
  setPersonalisationEnabled,
  ACTIVATION_THRESHOLD,
} from '../ml/personalise.js';

/** The pixel squirrel, drawn from squirrel.js. */
function Squirrel({ className }) {
  return <span className={className} aria-hidden="true" dangerouslySetInnerHTML={{ __html: squirrelSvg({ size: 32 }) }} />;
}

export default function App() {
  const [view, setView] = useState('idle');
  const [page, setPage] = useState('tabs'); // inside the idle view
  const [savedNote, setSavedNote] = useState(false);
  const [tabs, setTabs] = useState([]);
  const [sortedChain, setSortedChain] = useState([]);
  const [clusters, setClusters] = useState({});
  const [clusterLabels, setClusterLabels] = useState({});
  const [simMatrix, setSimMatrix] = useState(null);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState(null);

  // Personalisation status, surfaced in the UI so the learning loop isn't
  // invisible. `sortMethod` says what the last sort actually used, so the UI
  // can't claim personalisation that didn't happen.
  const [exampleCount, setExampleCount] = useState(0);
  const [personalising, setPersonalising] = useState(false);
  const [sortMethod, setSortMethod] = useState('cosine');
  const [autoSort, setAutoSort] = useState(true);
  const [canUndo, setCanUndo] = useState(false);
  const [placements, setPlacements] = useState({});
  const [correctionNote, setCorrectionNote] = useState(null);

  useEffect(() => {
    loadTrainingExamples().then(examples => setExampleCount(examples.length));
    isPersonalisationEnabled().then(setPersonalising);
    chrome.runtime.sendMessage({ type: 'GET_SORT_STATE' }).then(state => {
      setAutoSort(state.autoSort);
      setCanUndo(state.canUndo);
      setPlacements(state.placements || {});
    });
  }, []);

  // Load tabs on mount
  useEffect(() => {
    loadTabs();
  }, []);

  async function loadTabs() {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ALL_TABS' });
    setTabs(response.tabs || []);
  }

  async function handleSort() {
    setView('sorting');
    setError(null);

    try {
      // Get raw tab data from background
      const { tabs: tabData } = await chrome.runtime.sendMessage({ type: 'REQUEST_SORT' });

      // Run the ML pipeline (embeddings → graph → chain → clusters)
      // This runs in the popup, where the model has a page context to run in
      const result = await runMLPipeline(tabData, setProgress);

      setSortedChain(result.chain);
      setClusters(result.clusters);
      setClusterLabels(result.clusterLabels || {});
      setSimMatrix(result.simMatrix);
      setSortMethod(result.method);
      setView('sorted');
      await applyToTabStrip(result.chain);

      // The pipeline may have just drained the implicit tab-switch-burst
      // queue (see implicitFeedback.js) and stored new training examples
      // on its own, with no drag involved. Refresh our count and check
      // whether that alone crossed the retrain threshold.
      const examples = await loadTrainingExamples();
      setExampleCount(examples.length);
      maybeRetrain();
    } catch (err) {
      setError(err.message);
      setView('idle');
    }
  }

  /** Moves the real tabs to match the chain, in named groups. */
  async function applyToTabStrip(chain) {
    const entries = chain.filter(tab => tab.placement).map(tab => ({ tabId: tab.tabId, placement: tab.placement }));
    const response = await chrome.runtime.sendMessage({ type: 'APPLY_SORT', entries });
    if (response?.error) {
      setError(`Could not reorder the tabs: ${response.error}`);
      setView('idle');
      return;
    }
    setCanUndo(true);
  }

  async function handleUndo() {
    await chrome.runtime.sendMessage({ type: 'UNDO_SORT' });
    setCanUndo(false);
    setView('idle');
    loadTabs();
  }

  async function handleToggleAutoSort(event) {
    setAutoSort(event.target.checked);
    await chrome.runtime.sendMessage({ type: 'SET_AUTO_SORT', enabled: event.target.checked });
  }

  /**
   * Called by TabChain whenever the user drags a card to a new position.
   * The drag itself is the label: see feedback.js for how "before" vs.
   * "after" adjacency turns into (aId, bId, label) contrastive pairs.
   */
  async function handleReorder(reordered, movedTabId) {
    const newChain = reannotateChain(reordered, simMatrix);
    const pairs = deriveTrainingPairs(sortedChain, newChain, movedTabId);
    setSortedChain(newChain); // update the UI immediately, don't block on storage
    await applyToTabStrip(newChain);

    if (pairs.length === 0) return;

    const tabById = Object.fromEntries(sortedChain.map(t => [t.tabId, t]));
    let total = exampleCount;

    for (const { aId, bId, label } of pairs) {
      const tabA = tabById[aId];
      const tabB = tabById[bId];
      // Embeddings are set on tab objects during runMLPipeline (pipeline.js).
      // Guard in case a tab somehow lacks one (e.g. chrome:// pages skipped).
      if (!tabA?.embedding || !tabB?.embedding) continue;
      total = await storeTrainingExample(tabA, tabB, label);
    }

    setExampleCount(total);
    maybeRetrain();
  }

  /**
   * Retrains once enough examples exist, and again every RETRAIN_EVERY new
   * examples after that. Examples are collected either way, so turning
   * personalisation on later has something to learn from. See shouldRetrain.
   */
  async function maybeRetrain() {
    if (!(await isPersonalisationEnabled())) return;
    const seen = await loadExamplesSeen();
    const { nn_trained_count } = await chrome.storage.local.get('nn_trained_count');
    if (!shouldRetrain(seen, nn_trained_count)) return;

    await saveAdjustments(trainAdjustments(await loadTrainingExamples()));
    await chrome.storage.local.set({ nn_trained_count: seen });
  }

  async function handleTogglePersonalising(event) {
    const enabled = event.target.checked;
    setPersonalising(enabled);
    await setPersonalisationEnabled(enabled);
    maybeRetrain();
  }

  async function handleSnapshot() {
    await chrome.runtime.sendMessage({ type: 'SAVE_SNAPSHOT', name: null });
    setSavedNote(true);
    setTimeout(() => setSavedNote(false), 1500);
  }

  /** Remembers a category for this tab's site; Threadline moves it and its siblings. */
  async function handleCorrect(tabId, category) {
    const result = await chrome.runtime.sendMessage({ type: 'CORRECT_TAB', tabId, category });
    if (result?.error) {
      setCorrectionNote(result.error);
      return;
    }
    setPlacements(p => ({ ...p, [tabId]: { ...p[tabId], category } }));
    setCorrectionNote(`Remembered: ${result.key.replace(/^youtube:/, 'YouTube channel ')} → ${category}`);
  }

  function handleRestored() {
    setCanUndo(true);
    loadTabs();
  }

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="logo">
          <Squirrel className="logo-mark" />
          <span className="logo-text">Threadline</span>
        </div>
        <button className="snapshot-btn" onClick={handleSnapshot} title="Save this window's tabs, order and groups">
          {savedNote ? 'Saved ✓' : '↓ Save'}
        </button>
      </header>

      {/* Main content */}
      <main className="main">

        {view === 'idle' && (
          <nav className="page-tabs">
            {[['tabs', 'Tabs'], ['focus', 'Focus'], ['snapshots', 'Snapshots'], ['model', 'Model']].map(([id, label]) => (
              <button key={id} className={`page-tab ${page === id ? 'page-tab-on' : ''}`} onClick={() => setPage(id)}>
                {label}
              </button>
            ))}
          </nav>
        )}

        {view === 'idle' && page === 'focus' && <FocusPanel />}

        {view === 'idle' && page === 'model' && <ModelPanel />}

        {view === 'idle' && page === 'snapshots' && (
          <>
            <SnapshotsPanel onRestored={handleRestored} />
            {canUndo && <button className="cancel-btn wide" onClick={handleUndo}>Undo</button>}
          </>
        )}

        {view === 'idle' && page === 'tabs' && (
          <div className="idle-view">
            <div className="tab-count">
              {tabs.length} tabs open
            </div>
            <SortButton onClick={handleSort} />
            <label className="auto-sort-toggle">
              <input type="checkbox" checked={autoSort} onChange={handleToggleAutoSort} />
              Sort tabs automatically
            </label>
            {canUndo && <button className="cancel-btn" onClick={handleUndo}>Undo last sort</button>}
            {error && <div className="error">{error}</div>}
            {correctionNote && <div className="notice">{correctionNote}</div>}
            <div className="tab-list">
              {tabs.map(tab => {
                const recency = computeRecencyNorm(tab.lastActive);
                return (
                  <div
                    key={tab.tabId}
                    className="tab-item"
                    style={{ opacity: 0.55 + recency * 0.45 }}
                    title={formatIdleDuration(tab.lastActive)}
                  >
                    {tab.favIconUrl && (
                      <img src={tab.favIconUrl} className="favicon" alt="" />
                    )}
                    <span className="tab-title">{tab.title || 'Untitled'}</span>
                    {/^https?:/.test(tab.url || '') && (
                      <select
                        className="category-select"
                        value={placements[tab.tabId]?.category || ''}
                        onChange={e => handleCorrect(tab.tabId, e.target.value)}
                        title="Wrong category? Pick the right one and Threadline remembers it for this site"
                      >
                        {!placements[tab.tabId]?.category && <option value="">—</option>}
                        {CATEGORY_NAMES.map(name => <option key={name} value={name}>{name}</option>)}
                      </select>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {view === 'sorting' && (
          <div className="sorting-view">
            <div className="spinner" />
            <div className="progress-text">{progress || 'Initialising...'}</div>
            <div className="progress-sub">Running on-device — no data leaves your browser</div>
          </div>
        )}

        {view === 'sorted' && (
          <div className="sorted-view">
            <div className="chain-label">Your relatability chain</div>
            <div className="chain-hint">
              {personalising
                ? 'Drag a tab to fix the order — Threadline learns from every correction'
                : 'Drag a tab to fix the order'}
            </div>
            <ClusterLegend clusterLabels={clusterLabels} />
            <TabChain chain={sortedChain} clusters={clusters} onReorder={handleReorder} />
            <label className="personalise-toggle">
              <input type="checkbox" checked={personalising} onChange={handleTogglePersonalising} />
              Personalise sorting (experimental)
            </label>
            {personalising && <LearningStatus exampleCount={exampleCount} sortMethod={sortMethod} />}
            <div className="action-row">
              <button className="apply-btn" onClick={() => setView('idle')}>
                Done
              </button>
              <button className="cancel-btn" onClick={handleUndo}>
                Undo
              </button>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}

/**
 * Row of colour + name chips, one per topic cluster — turns "purple dot"
 * into "React Hooks", so the colour-coding in TabChain actually means
 * something at a glance instead of requiring the user to infer it.
 */
function ClusterLegend({ clusterLabels }) {
  const entries = Object.entries(clusterLabels || {});
  if (entries.length === 0) return null;

  return (
    <div className="cluster-legend">
      {entries.map(([idx, label]) => (
        <div key={idx} className="cluster-chip">
          <span
            className="cluster-chip-dot"
            style={{ background: CLUSTER_COLORS[Number(idx) % CLUSTER_COLORS.length] }}
          />
          {label}
        </div>
      ))}
    </div>
  );
}

/**
 * Small status line under the chain, shown when personalisation is on. It
 * reports what the last sort actually did.
 */
function LearningStatus({ exampleCount, sortMethod }) {
  if (sortMethod === 'personalised') {
    return <div className="learning-status learning-status-active">✓ This sort used your corrections</div>;
  }
  if (exampleCount >= ACTIVATION_THRESHOLD) {
    return <div className="learning-status">Your corrections will apply from the next sort</div>;
  }
  return (
    <div className="learning-status">
      {exampleCount}/{ACTIVATION_THRESHOLD} training examples — drag tabs to teach Threadline
    </div>
  );
}
