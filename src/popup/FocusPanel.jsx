/**
 * THREADLINE — FocusPanel.jsx
 *
 * Starts and ends a focus session: one category for a set time. Gentle focus
 * marks the toolbar icon when you open another category's site; strict focus
 * sends that site to a blocked page instead. Nothing starts on its own.
 */
import React, { useEffect, useState } from 'react';
import { CATEGORIES } from '../ml/categories.js';

const PRESETS = [25, 50, 90];
const MAX_MINUTES = 8 * 60;

export default function FocusPanel() {
  const [focus, setFocus] = useState(null);
  const [strict, setStrict] = useState(false);
  const [category, setCategory] = useState('Study');
  const [minutes, setMinutes] = useState(25);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());

  async function refresh() {
    const state = await chrome.runtime.sendMessage({ type: 'GET_FOCUS' });
    setFocus(state.focus);
    setStrict(state.strict);
  }

  useEffect(() => {
    refresh();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // The session can end while the popup is open.
  useEffect(() => {
    if (focus && focus.endsAt <= now) refresh();
  }, [focus, now]);

  async function handleStart() {
    setError(null);
    const duration = Number(minutes);
    if (!(duration >= 1 && duration <= MAX_MINUTES)) {
      setError(`Pick between 1 and ${MAX_MINUTES} minutes`);
      return;
    }
    await chrome.runtime.sendMessage({ type: 'SET_STRICT_FOCUS', enabled: strict });
    const result = await chrome.runtime.sendMessage({ type: 'START_FOCUS', category, minutes: duration });
    if (result?.error) setError(result.error);
    else setFocus(result.focus);
  }

  async function handleEnd() {
    if (strict && !confirmingEnd) {
      setConfirmingEnd(true);
      return;
    }
    await chrome.runtime.sendMessage({ type: 'END_FOCUS' });
    setConfirmingEnd(false);
    refresh();
  }

  if (focus) {
    const left = Math.max(0, focus.endsAt - now);
    const mins = Math.floor(left / 60000);
    const secs = Math.floor((left % 60000) / 1000);
    const color = CATEGORIES.find(c => c.name === focus.category)?.hex;
    return (
      <div className="panel focus-running">
        <div className="focus-label">Focusing on</div>
        <div className="focus-category" style={{ color }}>{focus.category}</div>
        <div className="focus-clock">{mins}:{String(secs).padStart(2, '0')}</div>
        <div className="focus-sub">
          Ends at {new Date(focus.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {' · '}
          {strict ? 'Strict: other sites are blocked' : 'Gentle: the icon shows ! on other sites'}
        </div>
        {focus.allowedHosts?.length > 0 && (
          <div className="focus-sub">Allowed for this session: {focus.allowedHosts.join(', ')}</div>
        )}
        <button className="cancel-btn wide" onClick={handleEnd}>
          {confirmingEnd ? 'Click again to end early' : 'End focus'}
        </button>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-title">Focus timer</div>
      <div className="panel-hint">Stay in one category for a while. Other groups fold away until the timer ends.</div>

      <div className="field-label">Category</div>
      <div className="chip-row">
        {CATEGORIES.map(c => (
          <button
            key={c.name}
            className={`chip ${category === c.name ? 'chip-on' : ''}`}
            style={category === c.name ? { borderColor: c.hex, color: c.hex } : undefined}
            onClick={() => setCategory(c.name)}
          >
            {c.name}
          </button>
        ))}
      </div>

      <div className="field-label">Minutes</div>
      <div className="chip-row">
        {PRESETS.map(p => (
          <button key={p} className={`chip ${Number(minutes) === p ? 'chip-on' : ''}`} onClick={() => setMinutes(p)}>{p}</button>
        ))}
        <input
          className="minutes-input"
          type="number"
          min="1"
          max={MAX_MINUTES}
          value={minutes}
          onChange={e => setMinutes(e.target.value)}
          aria-label="Minutes"
        />
      </div>

      <label className="auto-sort-toggle strict-toggle">
        <input type="checkbox" checked={strict} onChange={e => setStrict(e.target.checked)} />
        Strict: block other categories' sites instead of just warning
      </label>

      {error && <div className="error">{error}</div>}
      <button className="apply-btn wide" onClick={handleStart}>Start focus</button>
    </div>
  );
}
