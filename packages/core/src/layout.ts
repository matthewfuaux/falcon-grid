import type { RowModel } from './rows';
import type { ColumnDef } from './types';

/**
 * Largest element height browsers reliably honour. Firefox caps near 17.9M px,
 * Chrome and Safari near 33.5M px; stay under all of them.
 */
export const MAX_SCROLL_SIZE = 15_000_000;

/** Prefix sums of column widths: offsets[i] is the left edge of column i, offsets[n] the total width. */
export function buildColumnOffsets(
  columns: readonly ColumnDef[],
  out?: Float64Array,
): Float64Array {
  const n = columns.length;
  const offsets = out && out.length === n + 1 ? out : new Float64Array(n + 1);
  let x = 0;
  offsets[0] = 0;
  for (let i = 0; i < n; i++) {
    x += Math.max(0, columns[i]!.width);
    offsets[i + 1] = x;
  }
  return offsets;
}

/**
 * Binary search: the index i in [0, n-1] whose span [offsets[i], offsets[i+1]) contains x.
 * Clamps to the first or last column outside the range. Returns -1 when there are no columns.
 * Zero-width columns are skipped in favour of the next column with width.
 */
export function indexAtOffset(offsets: Float64Array, x: number): number {
  const n = offsets.length - 1;
  if (n <= 0) return -1;
  if (x < 0) return 0;
  if (x >= offsets[n]!) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (offsets[mid]! <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The visible window, in screen (viewport) CSS pixels. Reused between frames to avoid allocation. */
export interface ViewportRange {
  width: number;
  height: number;
  headerHeight: number;
  scrollLeft: number;
  scrollTop: number;
  /** Frozen counts after clamping to the available columns and rows. */
  frozenColumns: number;
  frozenRows: number;
  /** Width of the frozen columns, clamped to the viewport. */
  frozenWidth: number;
  /** Height of the frozen rows, clamped to the space below the header. */
  frozenHeight: number;
  /** Top edge of the scrolling body (header plus frozen rows). */
  bodyTop: number;
  /** Scrolling body columns [colStart, colEnd). */
  colStart: number;
  colEnd: number;
  /** Scrolling body rows [rowStart, rowEnd). */
  rowStart: number;
  rowEnd: number;
}

export function createViewportRange(): ViewportRange {
  return {
    width: 0,
    height: 0,
    headerHeight: 0,
    scrollLeft: 0,
    scrollTop: 0,
    frozenColumns: 0,
    frozenRows: 0,
    frozenWidth: 0,
    frozenHeight: 0,
    bodyTop: 0,
    colStart: 0,
    colEnd: 0,
    rowStart: 0,
    rowEnd: 0,
  };
}

export interface ViewportInput {
  offsets: Float64Array;
  rows: RowModel;
  headerHeight: number;
  frozenColumns: number;
  frozenRows: number;
  scrollLeft: number;
  scrollTop: number;
  width: number;
  height: number;
  /** Extra rows and columns either side of the visible window. */
  overscan?: number;
}

/**
 * Computes the visible window. Layout in content space: column c spans offsets[c]..offsets[c+1];
 * row r spans rows.offsetOf(r)..rows.offsetOf(r + 1) below the header. Frozen columns and rows
 * never scroll; the rest scroll under them.
 */
export function computeViewport(input: ViewportInput, out: ViewportRange = createViewportRange()): ViewportRange {
  const { offsets, rows, headerHeight, width, height } = input;
  const rowCount = rows.count;
  const overscan = input.overscan ?? 0;
  const colCount = offsets.length - 1;
  const frozenColumns = clampInt(input.frozenColumns, 0, colCount);
  const frozenRows = clampInt(input.frozenRows, 0, rowCount);
  const scrollLeft = Math.max(0, input.scrollLeft);
  const scrollTop = Math.max(0, input.scrollTop);

  const frozenWidth = Math.min(offsets[frozenColumns]!, width);
  const frozenHeight = Math.min(rows.offsetOf(frozenRows), Math.max(0, height - headerHeight));
  const bodyTop = headerHeight + frozenHeight;

  out.width = width;
  out.height = height;
  out.headerHeight = headerHeight;
  out.scrollLeft = scrollLeft;
  out.scrollTop = scrollTop;
  out.frozenColumns = frozenColumns;
  out.frozenRows = frozenRows;
  out.frozenWidth = frozenWidth;
  out.frozenHeight = frozenHeight;
  out.bodyTop = bodyTop;

  // Columns: screen x of column c (c >= frozen) is offsets[c] - scrollLeft.
  if (colCount === 0 || width <= frozenWidth) {
    out.colStart = out.colEnd = frozenColumns;
  } else {
    const first = indexAtOffset(offsets, scrollLeft + frozenWidth);
    const last = indexAtOffset(offsets, scrollLeft + width - 1e-6);
    out.colStart = Math.max(frozenColumns, first - overscan);
    out.colEnd = Math.min(colCount, Math.max(out.colStart, last + 1 + overscan));
  }

  // Rows: screen y of row r (r >= frozen) is headerHeight + rows.offsetOf(r) - scrollTop.
  if (rowCount === 0 || height <= bodyTop || frozenRows >= rowCount) {
    out.rowStart = out.rowEnd = frozenRows;
  } else {
    const first = rows.rowAt(scrollTop + frozenHeight);
    const visibleBottom = scrollTop + height - headerHeight;
    let last = rows.rowAt(visibleBottom - 1e-6) + 1;
    // rowAt clamps to the last row; past the end of the content there is nothing more.
    if (rows.offsetOf(last - 1) >= visibleBottom) last--;
    out.rowStart = clampInt(first - overscan, frozenRows, rowCount);
    out.rowEnd = clampInt(last + overscan, out.rowStart, rowCount);
  }
  return out;
}

function clampInt(v: number, lo: number, hi: number): number {
  v = Math.floor(v);
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Scroll scaling past the browser's element size limit. The spacer is at most `max` px;
 * scroll positions map proportionally between DOM space and virtual content space.
 */
export function scrollExtent(contentSize: number, max = MAX_SCROLL_SIZE): number {
  return Math.min(contentSize, max);
}

export function domToVirtual(dom: number, contentSize: number, viewportSize: number, max = MAX_SCROLL_SIZE): number {
  const extent = scrollExtent(contentSize, max);
  if (extent >= contentSize) return dom;
  const domRange = extent - viewportSize;
  if (domRange <= 0) return 0;
  const v = (dom * (contentSize - viewportSize)) / domRange;
  return Math.min(Math.max(0, v), contentSize - viewportSize);
}

export function virtualToDom(virtual: number, contentSize: number, viewportSize: number, max = MAX_SCROLL_SIZE): number {
  const extent = scrollExtent(contentSize, max);
  if (extent >= contentSize) return virtual;
  const virtualRange = contentSize - viewportSize;
  if (virtualRange <= 0) return 0;
  const d = (virtual * (extent - viewportSize)) / virtualRange;
  return Math.min(Math.max(0, d), extent - viewportSize);
}
