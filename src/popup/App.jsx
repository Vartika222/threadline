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
import TabChain from './TabChain.jsx';
import SortButton from './SortButton.jsx';
import { runMLPipeline } from '../ml/pipeline.js';

export default function App() {
  const [view, setView] = useState('idle');
  const [tabs, setTabs] = useState([]);
  const [sortedChain, setSortedChain] = useState([]);
  const [clusters, setClusters] = useState({});
  const [progress, setProgress] = useState('');
  const [error, setError] = useState(null);

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
      setView('sorted');
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
              {tabs.map(tab => (
                <div key={tab.tabId} className="tab-item">
                  {tab.favIconUrl && (
                    <img src={tab.favIconUrl} className="favicon" alt="" />
                  )}
                  <span className="tab-title">{tab.title || 'Untitled'}</span>
                </div>
              ))}
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
            <TabChain chain={sortedChain} clusters={clusters} />
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