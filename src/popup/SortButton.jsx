/**
 * THREADLINE — SortButton.jsx
 *
 * Primary call-to-action in the idle view. Kicks off the ML pipeline.
 */

import React from 'react';

export default function SortButton({ onClick, disabled = false }) {
  return (
    <button className="sort-btn" onClick={onClick} disabled={disabled}>
      <span className="sort-btn-icon">⬡</span>
      Sort by relatability
    </button>
  );
}
