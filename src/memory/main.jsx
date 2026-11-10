/** THREADLINE — the memory page's entry point (memory.html). */
import React from 'react';
import { createRoot } from 'react-dom/client';
import MemoryApp from './MemoryApp.jsx';
import './memory.css';

createRoot(document.getElementById('root')).render(<MemoryApp />);
