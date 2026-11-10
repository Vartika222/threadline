/**
 * THREADLINE — SortButton.jsx
 *
 * Primary call-to-action in the idle view. Kicks off the ML pipeline.
 */

import React from 'react';

export default function SortButton({ onClick, disabled = false }) {
  return (
    <button className="sort-btn" onClick={onClick} disabled={disabled}>
      Sort now
      <svg className="sort-btn-icon" width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2 10 10 2M4 2h6v6" fill="none" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    </button>
  );
}
