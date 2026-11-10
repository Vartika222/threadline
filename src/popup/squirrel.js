/**
 * THREADLINE — squirrel.js
 *
 * Threadline's pixel squirrel on a 16×16 grid, holding a red acorn: the tab
 * being filed. brand/squirrel.mjs writes the SVG and the icons from this.
 *
 *   W bone white   A pebble (shading)   I iron (outline)
 *   K eye          R arterial red (acorn)   B acorn cap
 */
export const GRID = [
  '..IIIII.........',
  '.IWWWWWI........',
  'IWWWWWWWI...I...',
  'IWWWAAWWI..IWI..',
  'IWWA..IWWI.IWWI.',
  'IWA....IWIIWWWWI',
  '.IA....IWWWWWKWW',
  '..I...IWWWWWWWWI',
  '.....IWWWWAWWII.',
  '....IWWWWWAWBBI.',
  '...IWWWWWWAIRRRI',
  '...IAWWWWWAIRRRI',
  '....IAWWWWAIIRI.',
  '.....IAAAAAWI...',
  '.....IWWI.IWWI..',
  '.....IIII.IIII..',
];

export const COLORS = { W: '#fcfcfc', A: '#b5b2b2', I: '#525252', K: '#080808', R: '#fe1e34', B: '#8a6a4a' };

/** The squirrel as SVG, one rect per pixel, crisp at any whole-number size. */
export function squirrelSvg({ size = 16, colors = COLORS } = {}) {
  const rects = [];
  GRID.forEach((row, y) => [...row].forEach((c, x) => {
    if (colors[c]) rects.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${colors[c]}"/>`);
  }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="${size}" height="${size}" shape-rendering="crispEdges">${rects.join('')}</svg>`;
}
