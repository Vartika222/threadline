/**
 * THREADLINE — squirrel.js
 *
 * Threadline's pixel squirrel on a 32×32 grid, holding a red acorn: the tab
 * being filed. brand/squirrel.mjs writes the SVG from this. Show it at a
 * multiple of 32px so every pixel stays square.
 *
 *   W bone white   A pebble (shade)   I iron (outline)   K eye   H eye light
 *   R arterial red (acorn)   r acorn shade   B acorn cap   b cap shade
 */
export const GRID = [
  '................................',
  '.........IIIIII.................',
  '.......IIWWWWWWI................',
  '......IWWWWWWWWWI...............',
  '.....IWWWWWWWWWWI...............',
  '....IWWWWWWWWWWWWI..II..........',
  '...IWWWWWWWWWWAWI..IAAI.........',
  '..IAWWWWWWWWWIAAI..IAAI.........',
  '..IAWWWWWWWWI.III..IWWWII.......',
  '..IWWWWWWWWWI.....IAWWWWWII.....',
  '.IAWWWWWWWWWI.....IWWWWWWWI.....',
  '.IAWWWWWWWWWI....IAWWWWWKHWI....',
  '.IWWWWWWWWWI.....IAWWWWWKKWWI...',
  'IAWWWWWWWWWI.....IAAWWWWWWWWII..',
  'IAAWWWWWWWWWI.....IAAWWWWWAAI...',
  '.IAWWWWWWWWWI....IAAAAAAAIII....',
  '.IAWWWWWWWWWI...IWWWAAAAII......',
  '.IAWWWWWWWWWI..IWWWWWWWIBBB.....',
  '.IAAWWWWWWWWI.IAWWWWWWWBBBBB....',
  '..IAWWWWWWWWWIAAWWWWWWIbbbbbI...',
  '..IAWWWWWWWWWIAAWWWWWAIrRRRIA...',
  '..IAAWWWWWWWWIAWWWWWWAIrRRRIA...',
  '...IAWWWWWWWIAWWWWWWWWIrRRRI....',
  '...IAAWWWWWIAAWWWWWWWWWIrRrI....',
  '....IAAWWWWIAWWWWWWWWWWWIII.....',
  '.....IAAWWIAAAWWWWWWWWWWI.......',
  '......IAAWWIAAAAAWWWAAAAI.......',
  '.......IAAAIAAAAAAWAAAAI........',
  '........IIIAIAWWAAAAAWWI........',
  '...........IIAAAIIIIAAAII.......',
  '.............III....III.........',
  '................................',
];

export const COLORS = {
  W: '#fcfcfc', A: '#b5b2b2', I: '#525252', K: '#080808', H: '#fcfcfc',
  R: '#fe1e34', r: '#c8102a', B: '#8a6a4a', b: '#5e4630',
};

/** The squirrel as SVG, one rect per pixel, crisp at any whole-number size. */
export function squirrelSvg({ size = GRID.length, colors = COLORS } = {}) {
  const rects = [];
  GRID.forEach((row, y) => [...row].forEach((c, x) => {
    if (colors[c]) rects.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${colors[c]}"/>`);
  }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID.length} ${GRID.length}" width="${size}" height="${size}" shape-rendering="crispEdges">${rects.join('')}</svg>`;
}
