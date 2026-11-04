/**
 * THREADLINE — TabChain.jsx
 *
 * Renders the sorted tab chain as a horizontal scrollable row.
 * Each tab card shows: favicon, truncated title, cluster colour.
 * Between cards: a connector line showing similarity strength.
 *
 * Cards are drag-reorderable. Dragging a card to a new position is how
 * the user tells Threadline "you got this wrong" or "these two belong
 * together" — the reorder itself IS the training signal (see feedback.js
 * and App.jsx's handleReorder). No separate "rate this" UI needed: the
 * correction the user was already going to make doubles as supervision.
 *
 * Props:
 *   chain      → array of tab objects in sorted order
 *   clusters   → { tabId: clusterIndex } mapping
 *   onReorder  → (newChainArray) => void, called after a successful drag
 */

import React, { useState } from 'react';
import { computeRecencyNorm, formatIdleDuration } from '../ml/recency.js';

// Cluster colours — one per topic group. Exported so other components
// (e.g. App.jsx's cluster legend) stay visually consistent with the chain.
export const CLUSTER_COLORS = [
  '#7C3AED', // violet
  '#06B6D4', // cyan
  '#10B981', // emerald
  '#F59E0B', // amber
  '#EF4444', // red
  '#8B5CF6', // purple
  '#EC4899', // pink
  '#3B82F6', // blue
];

export default function TabChain({ chain, clusters, onReorder }) {
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);

  if (!chain || chain.length === 0) {
    return <div className="chain-empty">No tabs to display</div>;
  }

  function handleDragStart(i) {
    setDragIndex(i);
  }

  function handleDragOver(e, i) {
    e.preventDefault(); // required to allow dropping
    if (i !== overIndex) setOverIndex(i);
  }

  function handleDrop(i) {
    if (dragIndex === null || dragIndex === i) {
      reset();
      return;
    }

    const next = [...chain];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(i, 0, moved);

    reset();
    onReorder?.(next);
  }

  function reset() {
    setDragIndex(null);
    setOverIndex(null);
  }

  return (
    <div className="chain-scroll">
      <div className="chain-row">
        {chain.map((tab, i) => {
          const clusterIdx = clusters[tab.tabId] ?? 0;
          const color = CLUSTER_COLORS[clusterIdx % CLUSTER_COLORS.length];
          const similarity = tab.similarityToNext; // 0-1, set by pipeline

          const recency = computeRecencyNorm(tab.lastActive);
          const isStale = recency < 0.2; // untouched for most of the 30-min recency window

          const cardClass = [
            'chain-card',
            overIndex === i && dragIndex !== null && dragIndex !== i && 'chain-card-drop-target',
          ].filter(Boolean).join(' ');

          return (
            <React.Fragment key={tab.tabId}>
              {/* Tab Card */}
              <div
                className={cardClass}
                style={{
                  borderTopColor: color,
                  opacity: dragIndex === i ? 0.4 : 0.55 + recency * 0.45,
                }}
                draggable
                onDragStart={() => handleDragStart(i)}
                onDragOver={(e) => handleDragOver(e, i)}
                onDrop={() => handleDrop(i)}
                onDragEnd={reset}
                title={`Drag to correct the order — Threadline learns from it (${formatIdleDuration(tab.lastActive)})`}
              >
                <div className="chain-card-inner">
                  {tab.favIconUrl ? (
                    <img src={tab.favIconUrl} className="chain-favicon" alt="" />
                  ) : (
                    <div className="chain-favicon-placeholder" style={{ background: color }} />
                  )}
                  <span className="chain-title">
                    {truncate(tab.title || tab.url, 20)}
                  </span>
                  {isStale && <span className="chain-stale-badge">idle</span>}
                </div>
                <div className="chain-cluster-dot" style={{ background: color }} />
              </div>

              {/* Connector between cards */}
              {i < chain.length - 1 && (
                <div className="chain-connector">
                  <div
                    className="chain-connector-line"
                    style={{ opacity: 0.3 + (similarity || 0.5) * 0.7 }}
                  />
                  {similarity !== undefined && (
                    <div className="chain-similarity">
                      {Math.round((similarity || 0) * 100)}%
                    </div>
                  )}
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length <= maxLen ? str : str.slice(0, maxLen - 1) + '…';
}