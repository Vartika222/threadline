/**
 * THREADLINE — App.jsx
 *
 * The popup UI. Three views:
 *   'idle'    → default, shows current tabs + Sort button
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

import React, { useState, useEffect } from 'react';
import TabChain, { CLUSTER_COLORS } from './TabChain.jsx';
import SortButton from './SortButton.jsx';
import { runMLPipeline } from '../ml/pipeline.js';
import { deriveTrainingPairs } from '../ml/feedback.js';
import { computeRecencyNorm, formatIdleDuration } from '../ml/recency.js';
import {
  storeTrainingExample,
  loadTrainingExamples,
  loadSavedModel,
  buildModel,
  trainModel,
  saveModel,
  shouldRetrain,
  NN_ACTIVATION_THRESHOLD,
} from '../ml/nn.js';

// Once past the activation threshold the model retrains every RETRAIN_EVERY
// new examples (see shouldRetrain in nn.js) rather than on every single drag.
// Retraining is a few hundred ms of blocking work — batching it keeps the
// popup responsive and avoids fitting a fresh model on a single noisy
// correction.

export default function App() {
  const [view, setView] = useState('idle');
  const [tabs, setTabs] = useState([]);
  const [sortedChain, setSortedChain] = useState([]);
  const [clusters, setClusters] = useState({});
  const [clusterLabels, setClusterLabels] = useState({});
  const [progress, setProgress] = useState('');
  const [error, setError] = useState(null);

  // Personalisation status, surfaced in the UI so the learning loop isn't
  // invisible — people repeat an interaction more when they can see it's
  // building toward something (a "3/15 examples" counter vs. silent logging).
  const [exampleCount, setExampleCount] = useState(0);
  const [trainingStatus, setTrainingStatus] = useState('idle'); // idle | training | trained

  useEffect(() => {
    loadTrainingExamples().then(examples => setExampleCount(examples.length));
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
      // This runs in the popup context where TF.js can access WebGL
      const result = await runMLPipeline(tabData, setProgress);

      setSortedChain(result.chain);
      setClusters(result.clusters);
      setClusterLabels(result.clusterLabels || {});
      setView('sorted');

      // The pipeline may have just drained the implicit tab-switch-burst
      // queue (see implicitFeedback.js) and stored new training examples
      // on its own, with no drag involved. Refresh our count and check
      // whether that alone crossed the retrain threshold.
      const examples = await loadTrainingExamples();
      setExampleCount(examples.length);
      maybeRetrain(examples.length);
    } catch (err) {
      setError(err.message);
      setView('idle');
    }
  }

  async function handleApply() {
    const orderedTabIds = sortedChain.map(t => t.tabId);
    await chrome.runtime.sendMessage({ type: 'APPLY_ORDER', orderedTabIds });
    window.close(); // Close the popup after applying
  }

  /**
   * Called by TabChain whenever the user drags a card to a new position.
   * The drag itself is the label: see feedback.js for how "before" vs.
   * "after" adjacency turns into (aId, bId, label) contrastive pairs.
   */
  async function handleReorder(newChain) {
    const pairs = deriveTrainingPairs(sortedChain, newChain);
    setSortedChain(newChain); // update the UI immediately, don't block on storage

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
    maybeRetrain(total);
  }

  /**
   * Retrains the personalisation model once enough examples exist, and again
   * every RETRAIN_EVERY new examples after that. Runs in the background of
   * the popup — doesn't block the UI, since the user has already moved on to
   * looking at their (now-updated) chain.
   *
   * The decision compares the example count with the count at the last
   * training run (stored as nn_trained_count) — see shouldRetrain in nn.js.
   */
  async function maybeRetrain(total) {
    const { nn_trained_count } = await chrome.storage.local.get('nn_trained_count');
    if (!shouldRetrain(total, nn_trained_count)) return;

    setTrainingStatus('training');
    try {
      const examples = await loadTrainingExamples();
      const model = (await loadSavedModel()) || (await buildModel());
      await trainModel(examples, model, { epochs: 15 });
      await saveModel(model);
      await chrome.storage.local.set({ nn_trained_count: examples.length });
      setTrainingStatus('trained');
    } catch (err) {
      console.error('[Threadline] Training failed:', err);
      setTrainingStatus('idle');
    }
  }

  async function handleSnapshot() {
    await chrome.runtime.sendMessage({ type: 'SAVE_SNAPSHOT', name: null });
    // Show brief confirmation (TODO: toast notification)
  }

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="logo">
          <span className="logo-mark">⬡</span>
          <span className="logo-text">Threadline</span>
        </div>
        <button className="snapshot-btn" onClick={handleSnapshot} title="Save session snapshot">
          ↓ Save
        </button>
      </header>

      {/* Main content */}
      <main className="main">

        {view === 'idle' && (
          <div className="idle-view">
            <div className="tab-count">
              {tabs.length} tabs open
            </div>
            <SortButton onClick={handleSort} />
            {error && <div className="error">{error}</div>}
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
            <div className="chain-hint">Drag a tab to fix the order — Threadline learns from every correction</div>
            <ClusterLegend clusterLabels={clusterLabels} />
            <TabChain chain={sortedChain} clusters={clusters} onReorder={handleReorder} />
            <LearningStatus exampleCount={exampleCount} trainingStatus={trainingStatus} />
            <div className="action-row">
              <button className="apply-btn" onClick={handleApply}>
                Apply Order
              </button>
              <button className="cancel-btn" onClick={() => setView('idle')}>
                Cancel
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
 * Small status line under the chain. Makes the (otherwise invisible)
 * personalisation loop visible: how many corrections have been collected,
 * and whether personalised sorting is active yet.
 */
function LearningStatus({ exampleCount, trainingStatus }) {
  if (trainingStatus === 'training') {
    return <div className="learning-status">Learning from your corrections…</div>;
  }

  if (exampleCount >= NN_ACTIVATION_THRESHOLD) {
    return <div className="learning-status learning-status-active">✓ Sorting personalised to you</div>;
  }

  if (exampleCount > 0) {
    return (
      <div className="learning-status">
        {exampleCount}/{NN_ACTIVATION_THRESHOLD} corrections learned — drag more tabs to personalise sorting
      </div>
    );
  }

  return null;
}