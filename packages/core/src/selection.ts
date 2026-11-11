import type { CellRange, CellRef } from './types';

/** Grid dimensions for navigation; `page` is how many rows Page Up and Down move. */
export interface GridDims {
  rows: number;
  cols: number;
  page: number;
}

const clampInt = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** The range spanning two cells, in either order. */
export function rangeOf(a: CellRef, b: CellRef): CellRange {
  return {
    top: Math.min(a.row, b.row),
    left: Math.min(a.col, b.col),
    bottom: Math.max(a.row, b.row),
    right: Math.max(a.col, b.col),
  };
}

export function rangeContains(r: CellRange, row: number, col: number): boolean {
  return row >= r.top && row <= r.bottom && col >= r.left && col <= r.right;
}

export function selectionContains(ranges: readonly CellRange[], row: number, col: number): boolean {
  for (const r of ranges) if (rangeContains(r, row, col)) return true;
  return false;
}

/** Clips a range to the grid, or null if nothing of it is left. */
export function clampRange(r: CellRange, rows: number, cols: number): CellRange | null {
  const top = Math.max(0, r.top);
  const left = Math.max(0, r.left);
  const bottom = Math.min(rows - 1, r.bottom);
  const right = Math.min(cols - 1, r.right);
  return bottom < top || right < left ? null : { top, left, bottom, right };
}

export const allCells = (d: Pick<GridDims, 'rows' | 'cols'>): CellRange => ({
  top: 0,
  left: 0,
  bottom: d.rows - 1,
  right: d.cols - 1,
});

/** Whole rows a..b (either order). */
export const rowRange = (a: number, b: number, cols: number): CellRange => ({
  top: Math.min(a, b),
  bottom: Math.max(a, b),
  left: 0,
  right: cols - 1,
});

/** Whole columns a..b (either order). */
export const colRange = (a: number, b: number, rows: number): CellRange => ({
  top: 0,
  bottom: rows - 1,
  left: Math.min(a, b),
  right: Math.max(a, b),
});

/**
 * The corner of `range` that Shift moves: opposite the active cell on each axis. An axis the
 * range spans completely (a whole row or column selection) keeps the active cell's position.
 */
export function extentOf(range: CellRange, active: CellRef): CellRef {
  return {
    row: active.row === range.top ? range.bottom : active.row === range.bottom ? range.top : active.row,
    col: active.col === range.left ? range.right : active.col === range.right ? range.left : active.col,
  };
}

/**
 * Extends `range` so it spans from the active cell to `target`. Axes the range covers
 * completely stay complete, so Shift+Down on a whole-row selection adds whole rows.
 */
export function extendRange(range: CellRange, active: CellRef, target: CellRef, d: Pick<GridDims, 'rows' | 'cols'>): CellRange {
  const r = rangeOf(active, target);
  if (range.left === 0 && range.right === d.cols - 1 && d.cols > 1) {
    r.left = 0;
    r.right = d.cols - 1;
  }
  if (range.top === 0 && range.bottom === d.rows - 1 && d.rows > 1) {
    r.top = 0;
    r.bottom = d.rows - 1;
  }
  return r;
}

/**
 * Where a navigation key moves `from`, or null if the key is not a navigation key.
 * Ctrl (or Cmd) jumps to the edge: arrows to the first or last row or column, Home and End
 * to the first or last cell.
 */
export function moveCell(from: CellRef, key: string, ctrl: boolean, d: GridDims): CellRef | null {
  const last = { row: d.rows - 1, col: d.cols - 1 };
  let { row, col } = from;
  switch (key) {
    case 'ArrowUp':
      row = ctrl ? 0 : row - 1;
      break;
    case 'ArrowDown':
      row = ctrl ? last.row : row + 1;
      break;
    case 'ArrowLeft':
      col = ctrl ? 0 : col - 1;
      break;
    case 'ArrowRight':
      col = ctrl ? last.col : col + 1;
      break;
    case 'PageUp':
      row -= Math.max(1, d.page);
      break;
    case 'PageDown':
      row += Math.max(1, d.page);
      break;
    case 'Home':
      col = 0;
      if (ctrl) row = 0;
      break;
    case 'End':
      col = last.col;
      if (ctrl) row = last.row;
      break;
    default:
      return null;
  }
  return { row: clampInt(row, 0, last.row), col: clampInt(col, 0, last.col) };
}

/** Tab order: along the row, wrapping to the next row. Null past either end of the grid. */
export function tabCell(from: CellRef, back: boolean, d: Pick<GridDims, 'rows' | 'cols'>): CellRef | null {
  const i = from.row * d.cols + from.col + (back ? -1 : 1);
  if (i < 0 || i >= d.rows * d.cols) return null;
  return { row: Math.floor(i / d.cols), col: i % d.cols };
}

/** Index ranges [start, end] covered by any of the ranges along one axis, merged and sorted. */
export function coveredSpans(ranges: readonly CellRange[], axis: 'rows' | 'cols'): [number, number][] {
  const spans = ranges
    .map((r): [number, number] => (axis === 'rows' ? [r.top, r.bottom] : [r.left, r.right]))
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const s of spans) {
    const prev = out[out.length - 1];
    if (prev && s[0] <= prev[1] + 1) prev[1] = Math.max(prev[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}
