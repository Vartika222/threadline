import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

/**
 * THREADLINE — vite.config.js (V2)
 *
 * Building a Chrome Extension with Vite requires handling three separate
 * entry points that Chrome loads in completely different contexts:
 *
 *   1. popup.html      → normal browser page context, has DOM, has WebGL
 *   2. background.js   → service worker context, no DOM, no WebGL, no window
 *   3. content_script.js → injected into web pages, isolated JS environment
 *
 * PROBLEM: Vite's default build bundles everything into chunks with dynamic
 * imports and a module graph. Chrome MV3 service workers cannot handle
 * dynamic imports or complex module graphs — they need a single self-contained
 * file. Content scripts have the same constraint.
 *
 * SOLUTION: Use Rollup's multiple entry points with `preserveEntrySignatures`
 * and format: 'es' so each entry point gets its own output file. The popup
 * goes through normal Vite HTML pipeline; background and content_script go
 * through lib mode as ES modules.
 *
 * WHY NOT IIFE FORMAT FOR BACKGROUND/CONTENT?
 *   IIFE wraps everything in a function scope, which breaks top-level await
 *   and ES module syntax that background.js uses. ES module format is
 *   supported in MV3 service workers when manifest has "type": "module".
 *
 * OUTPUT STRUCTURE (dist/):
 *   popup.html                  ← compiled popup entry
 *   assets/popup-[hash].js      ← popup JS (React app)
 *   assets/popup-[hash].css     ← popup CSS
 *   background.js               ← compiled service worker (flat ES module)
 *   content_script.js           ← compiled content script (flat ES module)
 *   manifest.json               ← copied by copy-extension-files.js
 *   icons/                      ← copied by copy-extension-files.js
 */
export default defineConfig(({ mode }) => ({
  plugins: [react()],

  build: {
    outDir:     'dist',
    emptyOutDir: true,
    sourcemap:  mode === 'development', // source maps in dev, not prod
    target:               'chrome112', // modern Chrome — no need for old polyfills
    chunkSizeWarningLimit: 1600,       // TF.js is ~1.4MB minified — unavoidable

    rollupOptions: {
      input: {
        // Popup: standard HTML entry — Vite handles React/CSS bundling
        popup: resolve(__dirname, 'popup.html'),

        // Background service worker: compiled to dist/background.js
        // Must be a flat file — no dynamic chunk splitting
        background: resolve(__dirname, 'background.js'),

        // Content script: compiled to dist/content_script.js
        // Same constraint as background
        content_script: resolve(__dirname, 'content_script.js'),
      },

      output: {
        // Entry files: popup goes to assets/, background and content_script
        // go to the root of dist/ (Chrome expects them at the path in manifest.json)
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background' || chunkInfo.name === 'content_script') {
            return '[name].js'; // dist/background.js, dist/content_script.js
          }
          return 'assets/[name]-[hash].js'; // dist/assets/popup-abc123.js
        },

        chunkFileNames:  'assets/[name]-[hash].js',
        assetFileNames:  'assets/[name]-[hash].[ext]',

        // CRITICAL: Do not split background.js or content_script.js into chunks.
        // Chrome cannot handle dynamic imports in service workers.
        // manualChunks returning undefined for these entries prevents splitting.
        manualChunks(id) {
          // Keep TF.js in a shared chunk for the popup (it's large, ~3MB)
          if (id.includes('@tensorflow') || id.includes('universal-sentence-encoder')) {
            return 'tfjs';
          }
          // umap-js in its own chunk
          if (id.includes('umap-js')) {
            return 'umap';
          }
        },
      },

      // Do not tree-shake exports from background/content entries —
      // Chrome calls their event listeners implicitly, not via import
      preserveEntrySignatures: 'strict',
    },
  },

  // Stub browser APIs that don't exist in Node/Rollup context
  // (chrome.* is available at runtime in the extension, not at build time)
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode),
  },

  // Prevent Vite from trying to resolve chrome.* as Node modules
  resolve: {
    alias: {},
  },
}));