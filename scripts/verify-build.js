/**
 * THREADLINE — scripts/verify-build.js
 *
 * Checks that dist/ contains everything Chrome needs before you try to
 * load it as an unpacked extension. Run after `npm run build`.
 *
 * Usage: node scripts/verify-build.js
 * Exit code 0 = ready to load. Exit code 1 = missing files.
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const REQUIRED = [
  // Chrome reads these directly from manifest
  'manifest.json',
  'background.js',
  'content_script.js',
  'popup.html',
  // Icons referenced in manifest
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
  // The language model and its runtime, bundled so sorting works offline
  'model/all-MiniLM-L6-v2/config.json',
  'model/all-MiniLM-L6-v2/tokenizer.json',
  'model/all-MiniLM-L6-v2/tokenizer_config.json',
  'model/all-MiniLM-L6-v2/onnx/model_quantized.onnx',
  'ort/ort-wasm-simd-threaded.jsep.mjs',
  'ort/ort-wasm-simd-threaded.jsep.wasm',
];

let ok = true;
const errors = [];
const warnings = [];

console.log('\n── Checking dist/ ──────────────────────────────────────────\n');

// 1. dist/ exists at all
if (!fs.existsSync(DIST)) {
  console.error('✗  dist/ does not exist — run `npm run build` first\n');
  process.exit(1);
}

// 2. Required files present
for (const file of REQUIRED) {
  const full = path.join(DIST, file);
  if (fs.existsSync(full)) {
    const size = fs.statSync(full).size;
    console.log(`  ✓ ${file.padEnd(28)} ${formatBytes(size)}`);
  } else {
    console.error(`  ✗ ${file.padEnd(28)} MISSING`);
    errors.push(file);
    ok = false;
  }
}

// 3. manifest.json is valid JSON and has required MV3 fields
console.log('\n── Validating manifest.json ────────────────────────────────\n');
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));

  const checks = [
    ['manifest_version', manifest.manifest_version === 3, `manifest_version must be 3, got ${manifest.manifest_version}`],
    ['name',             !!manifest.name,                 'name is missing'],
    ['version',          !!manifest.version,              'version is missing'],
    ['background',       !!manifest.background,           'background is missing'],
    ['background.service_worker', !!manifest.background?.service_worker, 'background.service_worker is missing'],
    ['action.default_popup', !!manifest.action?.default_popup, 'action.default_popup is missing'],
    ['permissions includes tabs',    manifest.permissions?.includes('tabs'),    'tabs permission missing'],
    ['permissions includes storage', manifest.permissions?.includes('storage'), 'storage permission missing'],
    ['CSP allows WebAssembly', manifest.content_security_policy?.extension_pages?.includes('wasm-unsafe-eval'), 'the language model needs wasm-unsafe-eval'],
  ];

  for (const [label, passes, message] of checks) {
    if (passes) {
      console.log(`  ✓ ${label}`);
    } else {
      console.error(`  ✗ ${label}: ${message}`);
      errors.push(label);
      ok = false;
    }
  }
} catch (e) {
  console.error(`  ✗ manifest.json is invalid JSON: ${e.message}`);
  errors.push('manifest.json parse error');
  ok = false;
}

// 4. background.js is not empty (Vite sometimes outputs an empty file if imports fail)
const bgPath = path.join(DIST, 'background.js');
if (fs.existsSync(bgPath)) {
  const size = fs.statSync(bgPath).size;
  if (size < 500) {
    warnings.push(`background.js is only ${size} bytes — it may not have bundled correctly`);
  }
}

// 5. popup.html references an actual JS file that exists
console.log('\n── Checking popup.html references ──────────────────────────\n');
const popupHtml = fs.readFileSync(path.join(DIST, 'popup.html'), 'utf8');
const scriptMatches = [...popupHtml.matchAll(/src="([^"]+\.js)"/g)];
for (const [, src] of scriptMatches) {
  const scriptPath = path.join(DIST, src.startsWith('/') ? src.slice(1) : src);
  if (fs.existsSync(scriptPath)) {
    console.log(`  ✓ ${src}`);
  } else {
    console.error(`  ✗ ${src}  (referenced in popup.html but not found in dist/)`);
    errors.push(src);
    ok = false;
  }
}

// 6. Summary
console.log('\n─────────────────────────────────────────────────────────────\n');

if (warnings.length > 0) {
  console.warn('Warnings:');
  warnings.forEach(w => console.warn(`  ⚠  ${w}`));
  console.log('');
}

if (ok) {
  console.log('✓  dist/ is ready to load in Chrome\n');
  console.log('  1. Open chrome://extensions');
  console.log('  2. Enable Developer mode (top right toggle)');
  console.log('  3. Click "Load unpacked"');
  console.log('  4. Select the dist/ folder\n');
} else {
  console.error(`✗  ${errors.length} error(s) found — fix before loading in Chrome\n`);
  errors.forEach(e => console.error(`     • ${e}`));
  console.log('');
  process.exit(1);
}

function formatBytes(bytes) {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}