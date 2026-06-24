/**
 * THREADLINE — TabChain.jsx
 *
 * Renders the sorted tab chain as a horizontal scrollable row.
 * Each tab card shows: favicon, truncated title, cluster colour.
 * Between cards: a connector line showing similarity strength.
 *
 * Props:
 *   chain    → array of tab objects in sorted order
 *   clusters → { tabId: clusterIndex } mapping
 */

import React from 'react';

// Cluster colours — one per topic group
const CLUSTER_COLORS = [
  '#7C3AED', // violet
  '#06B6D4', // cyan
  '#10B981', // emerald
  '#F59E0B', // amber
  '#EF4444', // red
  '#8B5CF6', // purple
  '#EC4899', // pink
  '#3B82F6', // blue
];

export default function TabChain({ chain, clusters }) {
  if (!chain || chain.length === 0) {
    return <div className="chain-empty">No tabs to display</div>;
  }

  return (
    <div className="chain-scroll">
      <div className="chain-row">
        {chain.map((tab, i) => {
          const clusterIdx = clusters[tab.tabId] ?? 0;
          const color = CLUSTER_COLORS[clusterIdx % CLUSTER_COLORS.length];
          const similarity = tab.similarityToNext; // 0-1, set by pipeline

          return (
            <React.Fragment key={tab.tabId}>
              {/* Tab Card */}
              <div className="chain-card" style={{ borderTopColor: color }}>
                <div className="chain-card-inner">
                  {tab.favIconUrl ? (
                    <img src={tab.favIconUrl} className="chain-favicon" alt="" />
                  ) : (
                    <div className="chain-favicon-placeholder" style={{ background: color }} />
                  )}
                  <span className="chain-title">
                    {truncate(tab.title || tab.url, 20)}
                  </span>
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