/**
 * THREADLINE — ModelPanel.jsx
 *
 * Gemini Nano: its status, the one-time download, switching it on, and a
 * side-by-side test against the current model on your open tabs. Also the
 * corrections Threadline has remembered.
 */
import React, { useEffect, useState } from 'react';
import { classifyTabs } from '../ml/categories.js';
import { nanoStatus, startNano, classifyWithNano } from '../ml/nano.js';

const embed = async (texts) => (await import('../ml/embedder.js')).embedTexts(texts);

const STATUS_TEXT = {
  unsupported: "This version of Chrome doesn't offer Gemini Nano to extensions.",
  unavailable: "This computer can't run Gemini Nano. Chrome needs 22 GB of free disk space, and 16 GB of memory or a graphics card with more than 4 GB.",
  downloadable: 'Gemini Nano is free and runs on this computer. Chrome downloads it once (several GB).',
  downloading: 'Chrome is downloading Gemini Nano…',
  available: 'Gemini Nano is ready on this computer.',
  'no-answer': "Chrome didn't say whether Gemini Nano is available. Make sure Chrome is up to date, then open this page again.",
};

const label = (r) => (r ? `${r.category} › ${r.subcategory}` : '—');

export default function ModelPanel() {
  const [status, setStatus] = useState('checking');
  const [progress, setProgress] = useState(null);
  const [enabled, setEnabled] = useState(false);
  const [backgroundStatus, setBackgroundStatus] = useState(null);
  const [corrections, setCorrections] = useState({});
  const [comparison, setComparison] = useState(null);
  const [running, setRunning] = useState('');
  const [votes, setVotes] = useState({});
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  async function refresh() {
    setStatus(await nanoStatus());
    const state = await chrome.runtime.sendMessage({ type: 'GET_NANO' });
    setEnabled(state.enabled);
    setBackgroundStatus(state.backgroundStatus);
    setCorrections((await chrome.runtime.sendMessage({ type: 'GET_CORRECTIONS' })).corrections || {});
  }

  useEffect(() => { refresh(); }, []);

  async function handleDownload() {
    setError(null);
    setStatus('downloading');
    try {
      await startNano({ onProgress: setProgress });
      setStatus(await nanoStatus());
    } catch (err) {
      setError(`Couldn't start Gemini Nano: ${err.message}`);
      setStatus(await nanoStatus());
    }
  }

  async function handleToggle(event) {
    setEnabled(event.target.checked);
    await chrome.runtime.sendMessage({ type: 'SET_NANO', enabled: event.target.checked });
  }

  async function handleForget(key) {
    await chrome.runtime.sendMessage({ type: 'FORGET_CORRECTION', key });
    refresh();
  }

  /** Classifies the open tabs both ways. Tabs the site list settles are left out. */
  async function handleCompare() {
    setError(null);
    setVotes({});
    setComparison(null);
    try {
      setRunning('Reading your tabs…');
      const { tabs } = await chrome.runtime.sendMessage({ type: 'REQUEST_SORT' });
      setRunning('Asking the current model…');
      const current = await classifyTabs(tabs, embed);
      setRunning('Asking Gemini Nano…');
      const started = performance.now();
      let asked = 0;
      const nano = await classifyTabs(tabs, embed, {
        askModel: async (list) => { asked = list.length; return classifyWithNano(list); },
      });
      const msPerTab = asked ? Math.round((performance.now() - started) / asked) : 0;
      const rows = tabs.map((tab, i) => ({ tab, current: current[i], nano: nano[i] }))
        .filter(row => row.current.source === 'model' || row.nano.source === 'nano');
      setComparison({ rows, msPerTab, settled: tabs.length - rows.length });
    } catch (err) {
      setError(`The comparison failed: ${err.message}`);
    } finally {
      setRunning('');
    }
  }

  const vote = (i, choice) => setVotes(v => ({ ...v, [i]: choice }));
  const tally = Object.values(votes).reduce((t, v) => ({ ...t, [v]: (t[v] || 0) + 1 }), {});

  async function handleCopy() {
    const lines = comparison.rows.map((row, i) => [
      (row.tab.title || '').slice(0, 60), row.tab.url, label(row.current), label(row.nano), votes[i] || '',
    ].join('\t'));
    const text = [`Gemini Nano test: ${comparison.msPerTab} ms per tab, current right ${tally.current || 0}, Nano right ${tally.nano || 0}, both ${tally.both || 0}, neither ${tally.neither || 0}`,
      'Title\tURL\tCurrent model\tGemini Nano\tWhich was right', ...lines].join('\n');
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const correctionList = Object.entries(corrections).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));

  return (
    <div className="panel">
      <div className="panel-title">Gemini Nano (experimental)</div>
      <div className="panel-hint">{STATUS_TEXT[status] || 'Checking…'}</div>

      {status === 'downloadable' && (
        <button className="apply-btn wide" onClick={handleDownload}>Download Gemini Nano</button>
      )}
      {status === 'downloading' && progress !== null && (
        <div className="progress-bar"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
      )}

      {status === 'available' && (
        <>
          <label className="auto-sort-toggle">
            <input type="checkbox" checked={enabled} onChange={handleToggle} />
            Use Gemini Nano for automatic sorting
          </label>
          {enabled && backgroundStatus && backgroundStatus !== 'available' && backgroundStatus !== 'off' && (
            <div className="error">
              Chrome doesn't give Gemini Nano to Threadline's background page ({backgroundStatus}), so automatic
              sorting still uses the current model. The comparison below still works.
            </div>
          )}
          <button className="cancel-btn wide" onClick={handleCompare} disabled={Boolean(running)}>
            {running || 'Compare with the current model on my tabs'}
          </button>
        </>
      )}

      {error && <div className="error">{error}</div>}

      {comparison && (
        <div className="compare">
          <div className="snapshot-meta">
            {comparison.rows.length} tabs needed a model ({comparison.settled} were settled by the site list
            or your corrections). Gemini Nano took {comparison.msPerTab} ms per tab. Mark which answer is right:
          </div>
          {comparison.rows.map((row, i) => {
            const same = label(row.current) === label(row.nano);
            return (
              <div key={row.tab.tabId} className={`compare-row ${same ? 'compare-same' : ''}`}>
                <div className="snapshot-name">{row.tab.title || row.tab.url}</div>
                <div className="compare-answers">
                  <button className={`chip ${votes[i] === 'current' || (same && votes[i] === 'both') ? 'chip-on' : ''}`}
                    onClick={() => vote(i, same ? 'both' : 'current')}>
                    Current: {label(row.current)}
                  </button>
                  {!same && (
                    <button className={`chip ${votes[i] === 'nano' ? 'chip-on' : ''}`} onClick={() => vote(i, 'nano')}>
                      Nano: {label(row.nano)}
                    </button>
                  )}
                  <button className={`chip ${votes[i] === 'neither' ? 'chip-on' : ''}`} onClick={() => vote(i, 'neither')}>
                    {same ? 'Wrong' : 'Neither'}
                  </button>
                </div>
              </div>
            );
          })}
          <div className="snapshot-meta">
            Current right: {(tally.current || 0) + (tally.both || 0)} · Nano right: {(tally.nano || 0) + (tally.both || 0)} · Neither: {tally.neither || 0}
          </div>
          <button className="cancel-btn wide" onClick={handleCopy}>{copied ? 'Copied ✓' : 'Copy results'}</button>
        </div>
      )}

      <div className="panel-title" style={{ marginTop: 8 }}>Remembered corrections</div>
      <div className="panel-hint">
        Drag a tab into another category's group, or pick a category for it on the Tabs page, and every tab
        from that site (for YouTube, that channel) goes there from now on.
      </div>
      {correctionList.length === 0 && <div className="chain-empty">None yet.</div>}
      <div className="snapshot-list">
        {correctionList.map(([key, c]) => (
          <div key={key} className="snapshot-item">
            <div className="snapshot-info">
              <div className="snapshot-name">{key.replace(/^youtube:/, 'YouTube channel: ')}</div>
              <div className="snapshot-meta">{c.category}{c.subcategory ? ` › ${c.subcategory}` : ''}</div>
            </div>
            <button className="small-btn danger" onClick={() => handleForget(key)}>Forget</button>
          </div>
        ))}
      </div>
    </div>
  );
}
