/**
 * copy-extension-files.js
 *
 * After Vite builds the popup, this script copies all the non-bundled
 * extension files into dist/ so the folder is a complete, loadable extension.
 *
 * Files Vite does NOT handle:
 *   - manifest.json      (copied as-is)
 *   - content_script.js  (content scripts can't be ES modules, so it stays one flat file)
 *   - icons/             (static assets)
 *
 * background.js is bundled by Vite: the manifest loads it as an ES module, so
 * it imports the shared code in src/ml/ instead of keeping copies.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.resolve(ROOT, 'dist');
const ORT_FILES = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];

function copyFile(src, dest) {
  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`  ✓ ${path.relative(ROOT, src)} → dist/${path.relative(DIST, dest)}`);
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const file of fs.readdirSync(src)) {
    const srcPath = path.join(src, file);
    const destPath = path.join(dest, file);
    if (fs.statSync(srcPath).isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFile(srcPath, destPath);
    }
  }
}

console.log('\nCopying extension files to dist/...');

copyFile(path.join(ROOT, 'manifest.json'),       path.join(DIST, 'manifest.json'));
copyFile(path.join(ROOT, 'content_script.js'),    path.join(DIST, 'content_script.js'));
copyFile(path.join(ROOT, 'blocked.html'),         path.join(DIST, 'blocked.html'));
copyFile(path.join(ROOT, 'blocked.js'),           path.join(DIST, 'blocked.js'));
copyDir( path.join(ROOT, 'icons'),                path.join(DIST, 'icons'));

// The WebAssembly runtime that runs the language model. Transformers.js would
// otherwise fetch these from a CDN.
const ORT_DIST = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
for (const file of ORT_FILES) {
  copyFile(path.join(ORT_DIST, file), path.join(DIST, 'ort', file));
}

// Vite also emits its own copy of the .wasm, which nothing loads because
// embedder.js points the runtime at ort/. Remove it to save about 21MB.
const ASSETS = path.join(DIST, 'assets');
for (const file of fs.readdirSync(ASSETS)) {
  if (file.endsWith('.wasm')) fs.rmSync(path.join(ASSETS, file));
}

console.log('\ndist/ is ready to load in Chrome.\n');