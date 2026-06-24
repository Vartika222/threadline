/**
 * copy-extension-files.js
 *
 * After Vite builds the popup, this script copies all the non-bundled
 * extension files into dist/ so the folder is a complete, loadable extension.
 *
 * Files Vite does NOT handle:
 *   - manifest.json      (copied as-is)
 *   - background.js      (MV3 service worker — must be a flat file, not a module bundle)
 *   - content_script.js  (injected into pages — same constraint)
 *   - icons/             (static assets)
 *
 * WHY background.js and content_script.js aren't bundled by Vite:
 * Chrome MV3 service workers have strict constraints on how they're loaded.
 * For V0/V1, keeping them as plain JS files is the simplest approach.
 * For V2+, you'd add them as separate Rollup entry points.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.resolve(ROOT, 'dist');

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
copyFile(path.join(ROOT, 'background.js'),        path.join(DIST, 'background.js'));
copyFile(path.join(ROOT, 'content_script.js'),    path.join(DIST, 'content_script.js'));
copyDir( path.join(ROOT, 'icons'),                path.join(DIST, 'icons'));

console.log('\ndist/ is ready to load in Chrome.\n');