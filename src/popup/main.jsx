/**
 * THREADLINE — main.jsx
 *
 * Popup entry point. Mounts the React App into popup.html's #root div.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

const container = document.getElementById('root');
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
