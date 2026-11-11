import { indexAtOffset, type ViewportRange } from './layout';
import type { RowModel } from './rows';
import type { ColumnDef } from './types';

/** Half-width of the column resize handle around a header column edge, in CSS pixels. */
export const RESIZE_HANDLE = 4;

export type HitRegion = 'none' | 'header' | 'cell' | 'resize';

/**
 * What is under a point. Reused between calls, so copy what you keep.
 * `row` is -1 in the header; `col` is the resized column for 'resize'.
 */
export interface Hit {
  region: HitRegion;
  row: number;
  col: number;
  /** The cell's (or header cell's) bounds on screen, unclipped, in CSS pixels. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const createHit = (): Hit => ({ region: 'none', row: -1, col: -1, x0: 0, y0: 0, x1: 0, y1: 0 });

/** Screen x of column c's left edge, given the pane it is in. */
export const colX = (c: number, offsets: Float64Array, vp: ViewportRange) =>
  offsets[c]! - (c < vp.frozenColumns ? 0 : vp.scrollLeft);

/** Screen y of row r's top edge, given the pane it is in. */
export const rowY = (r: number, rows: RowModel, vp: ViewportRange) =>
  vp.headerHeight + rows.offsetOf(r) - (r < vp.frozenRows ? 0 : vp.scrollTop);

/** Column under screen x, or -1 past the last column. Frozen columns cover the scrolling ones. */
export function colAtX(x: number, offsets: Float64Array, vp: ViewportRange): number {
  const n = offsets.length - 1;
  if (n <= 0 || x < 0 || x >= vp.width) return -1;
  if (x < vp.frozenWidth) return indexAtOffset(offsets, x);
  const content = x + vp.scrollLeft;
  if (content >= offsets[n]!) return -1;
  return Math.max(vp.frozenColumns, indexAtOffset(offsets, content));
}

/** Row under screen y (below the header), or -1 past the last row. */
export function rowAtY(y: number, rows: RowModel, vp: ViewportRange): number {
  if (rows.count === 0 || y < vp.headerHeight || y >= vp.height) return -1;
  if (y < vp.bodyTop) return Math.min(rows.rowAt(y - vp.headerHeight), vp.frozenRows - 1);
  const content = y - vp.headerHeight + vp.scrollTop;
  if (content >= rows.total) return -1;
  return Math.max(vp.frozenRows, rows.rowAt(content));
}

/** Screen x of a column's right edge if that edge is visible, else NaN. */
function edgeX(c: number, offsets: Float64Array, vp: ViewportRange): number {
  if (c < 0 || c >= offsets.length - 1) return Number.NaN;
  if (c < vp.frozenColumns) return offsets[c + 1]!;
  const e = offsets[c + 1]! - vp.scrollLeft;
  return e > vp.frozenWidth && e <= vp.width + RESIZE_HANDLE ? e : Number.NaN;
}

export function hitTest(
  x: number,
  y: number,
  vp: ViewportRange,
  offsets: Float64Array,
  rows: RowModel,
  columns: readonly ColumnDef[],
  out: Hit = createHit(),
): Hit {
  out.region = 'none';
  out.row = out.col = -1;
  if (x < 0 || y < 0 || x >= vp.width || y >= vp.height) return out;
  const n = offsets.length - 1;
  const col = colAtX(x, offsets, vp);

  if (y < vp.headerHeight) {
    // The nearest visible column edge within the handle wins: the one under the pointer, the
    // one to its left, or the frozen pane's edge.
    let best = -1;
    let bestDist = RESIZE_HANDLE + 1;
    const under = col >= 0 ? col : n - 1;
    for (const c of [under, under - 1, vp.frozenColumns - 1]) {
      const d = Math.abs(x - edgeX(c, offsets, vp));
      if (d <= RESIZE_HANDLE && d < bestDist && columns[c]?.resizable !== false) {
        best = c;
        bestDist = d;
      }
    }
    if (best >= 0) {
      out.region = 'resize';
      out.col = best;
      setBounds(out, best, -1, offsets, rows, vp);
      return out;
    }
    if (col < 0) return out;
    out.region = 'header';
    out.col = col;
    setBounds(out, col, -1, offsets, rows, vp);
    return out;
  }

  const row = rowAtY(y, rows, vp);
  if (col < 0 || row < 0) return out;
  out.region = 'cell';
  out.row = row;
  out.col = col;
  setBounds(out, col, row, offsets, rows, vp);
  return out;
}

function setBounds(out: Hit, col: number, row: number, offsets: Float64Array, rows: RowModel, vp: ViewportRange) {
  out.x0 = colX(col, offsets, vp);
  out.x1 = out.x0 + offsets[col + 1]! - offsets[col]!;
  if (row < 0) {
    out.y0 = 0;
    out.y1 = vp.headerHeight;
  } else {
    out.y0 = rowY(row, rows, vp);
    out.y1 = out.y0 + rows.heightOf(row);
  }
}
