/**
 * brand/squirrel.mjs — writes brand/squirrel.svg from the squirrel drawn in
 * src/popup/squirrel.js. Run with: node brand/squirrel.mjs
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { GRID, COLORS, squirrelSvg } from '../src/popup/squirrel.js';

export { GRID, COLORS, squirrelSvg };

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  fs.writeFileSync(new URL('./squirrel.svg', import.meta.url), squirrelSvg({ size: 160 }));
  console.log('wrote brand/squirrel.svg');
}
