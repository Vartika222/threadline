/**
 * THREADLINE — SnapshotsPanel.jsx
 *
 * Saves this window's tabs, in their order and groups, and brings an
 * arrangement back later. Restored tabs stay where they are put: automatic
 * sorting leaves them alone until they navigate somewhere new.
 */
import React, { useEffect, useState } from 'react';

const GROUP_COLORS = {
  grey: '#6B7280', blue: '#3B82F6', red: '#EF4444', yellow: '#EAB308', green: '#10B981',
  pink: '#EC4899', purple: '#8B5CF6', cyan: '#06B6D4', orange: '#F59E0B',
};

export default function SnapshotsPanel({ onRestored }) {
  const [snapshots, setSnapshots] = useState([]);
  const [name, setName] = useState('');
  const [message, setMessage] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  async function refresh() {
    const { snapshots: list } = await chrome.runtime.sendMessage({ type: 'GET_SNAPSHOTS' });
    setSnapshots(list || []);
  }

  useEffect(() => { refresh(); }, []);

  async function handleSave() {
    const { snapshot } = await chrome.runtime.sendMessage({ type: 'SAVE_SNAPSHOT', name });
    setName('');
    setMessage(`Saved "${snapshot.name}"`);
    refresh();
  }

  async function handleRestore(id) {
    const result = await chrome.runtime.sendMessage({ type: 'RESTORE_SNAPSHOT', id });
    if (result?.error) {
      setMessage(result.error);
      return;
    }
    const parts = [`Restored ${result.restored} tabs`];
    if (result.reopened) parts.push(`reopened ${result.reopened}`);
    if (result.skipped) parts.push(`${result.skipped} browser pages couldn't be reopened`);
    setMessage(`${parts.join(', ')}. Undo puts things back.`);
    onRestored?.();
  }

  async function handleDelete(id) {
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      return;
    }
    await chrome.runtime.sendMessage({ type: 'DELETE_SNAPSHOT', id });
    setConfirmDelete(null);
    refresh();
  }

  return (
    <div className="panel">
      <div className="panel-title">Snapshots</div>
      <div className="panel-hint">Save this window's tabs in their current order and groups, including anything you arranged by hand.</div>

      <div className="save-row">
        <input
          className="text-input"
          placeholder="Name (optional)"
          value={name}
          maxLength={60}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
        />
        <button className="apply-btn" onClick={handleSave}>Save</button>
      </div>

      {message && <div className="notice">{message}</div>}

      {snapshots.length === 0 && <div className="chain-empty">No snapshots yet.</div>}
      <div className="snapshot-list">
        {snapshots.map(snapshot => {
          const groups = snapshot.groups || [];
          return (
            <div key={snapshot.id} className="snapshot-item">
              <div className="snapshot-info">
                <div className="snapshot-name">{snapshot.name}</div>
                <div className="snapshot-meta">
                  {snapshot.tabs.length} tabs
                  {groups.length > 0 && ` · ${groups.length} ${groups.length === 1 ? 'group' : 'groups'}`}
                  {' · '}
                  {new Date(snapshot.createdAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </div>
                {groups.length > 0 && (
                  <div className="snapshot-groups">
                    {groups.map(group => (
                      <span key={group.id} className="snapshot-group" style={{ borderColor: GROUP_COLORS[group.color] || '#6B7280' }}>
                        {group.title || 'Untitled'}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="snapshot-actions">
                <button className="small-btn" onClick={() => handleRestore(snapshot.id)}>Restore</button>
                <button className="small-btn danger" onClick={() => handleDelete(snapshot.id)}>
                  {confirmDelete === snapshot.id ? 'Sure?' : 'Delete'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
