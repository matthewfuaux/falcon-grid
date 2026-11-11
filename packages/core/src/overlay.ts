import type { ViewportRange } from './layout';
import type { RowModel } from './rows';
import type { CellRange, CellRef, Theme } from './types';

/** The subset of CanvasRenderingContext2D the overlay painter uses. */
export type OverlayContext = Pick<
  CanvasRenderingContext2D,
  'setTransform' | 'clearRect' | 'fillRect' | 'save' | 'restore' | 'beginPath' | 'rect' | 'clip' | 'fillStyle'
>;

/** A drag in progress, drawn as an indicator. Screen x in CSS pixels. */
export type DragIndicator =
  | { kind: 'none' }
  /** Column resize: a line at the column's moving right edge. */
  | { kind: 'resize'; x: number }
  /** Column reorder: the dragged column is tinted and a line marks the drop position. */
  | { kind: 'reorder'; col: number; x: number };

export interface OverlayInput {
  ctx: OverlayContext;
  dpr: number;
  /** Backing store size in device pixels. */
  width: number;
  height: number;
  vp: ViewportRange;
  offsets: Float64Array;
  rows: RowModel;
  theme: Theme;
  selection: readonly CellRange[];
  activeCell: CellRef | null;
  hoverCell: CellRef | null;
  focused: boolean;
  drag: DragIndicator;
}

/** Keeps far off-screen coordinates in a range canvases handle well; the clip hides the rest. */
const lim = (v: number, max: number) => (v < -8 ? -8 : v > max + 8 ? max + 8 : v);

/**
 * Paints the overlay: hover, selection, the active cell ring and drag indicators. It is a
 * handful of rectangles, so every paint clears and redraws the whole layer. Each frozen pane
 * is painted under its own clip with its own scroll offset, so a range that crosses the frozen
 * boundary is drawn as one rectangle with no seam.
 */
export function paintOverlay(o: OverlayInput): void {
  const { ctx, dpr, vp, theme, selection, activeCell } = o;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, o.width, o.height);
  if (vp.width <= 0 || vp.height <= 0) return;
  const px = (v: number) => Math.round(v * dpr);
  const W = vp.width;
  const H = vp.height;
  const headerBottom = Math.min(vp.headerHeight, H);
  const colPanes: [number, number, number][] = [
    [0, vp.frozenWidth, 0],
    [vp.frozenWidth, W, vp.scrollLeft],
  ];
  const rowPanes: [number, number, number][] = [
    [headerBottom, vp.bodyTop, 0],
    [vp.bodyTop, H, vp.scrollTop],
  ];

  /** Fills a CSS-pixel rectangle snapped to device pixels. */
  const fill = (x0: number, y0: number, x1: number, y1: number) => {
    const X0 = px(lim(x0, W));
    const Y0 = px(lim(y0, H));
    const w = px(lim(x1, W)) - X0;
    const h = px(lim(y1, H)) - Y0;
    if (w > 0 && h > 0) ctx.fillRect(X0, Y0, w, h);
  };
  /**
   * A border `t` device pixels thick around a cell rectangle, starting one device pixel left of
   * and above it so it covers the gridlines on both sides.
   */
  const ring = (x0: number, y0: number, x1: number, y1: number, t: number) => {
    const X0 = px(lim(x0, W)) - 1;
    const Y0 = px(lim(y0, H)) - 1;
    const X1 = px(lim(x1, W));
    const Y1 = px(lim(y1, H));
    if (X1 - X0 <= 0 || Y1 - Y0 <= 0) return;
    ctx.fillRect(X0, Y0, X1 - X0, t);
    ctx.fillRect(X0, Y1 - t, X1 - X0, t);
    ctx.fillRect(X0, Y0 + t, t, Y1 - Y0 - 2 * t);
    ctx.fillRect(X1 - t, Y0 + t, t, Y1 - Y0 - 2 * t);
  };
  const clipTo = (x0: number, y0: number, x1: number, y1: number) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(px(x0), px(y0), px(x1) - px(x0), px(y1) - px(y0));
    ctx.clip();
  };

  const xOf = (c: number, shift: number) => o.offsets[c]! - shift;
  const yOf = (r: number, shift: number) => vp.headerHeight + o.rows.offsetOf(r) - shift;
  const thin = Math.max(1, Math.round(dpr));
  const thick = Math.max(2, Math.round(2 * dpr));
  const loneActive = (r: CellRange) =>
    activeCell !== null && r.top === r.bottom && r.left === r.right && r.top === activeCell.row && r.left === activeCell.col;

  for (const [cx0, cx1, sx] of colPanes) {
    if (cx1 <= cx0) continue;
    // Header tint over selected columns.
    if (selection.length > 0 && headerBottom > 0) {
      clipTo(cx0, 0, cx1, headerBottom);
      ctx.fillStyle = theme.selectionBackground;
      for (const r of selection) fill(xOf(r.left, sx), 0, xOf(r.right + 1, sx), headerBottom);
      ctx.restore();
    }
    for (const [ry0, ry1, sy] of rowPanes) {
      if (ry1 <= ry0) continue;
      clipTo(cx0, ry0, cx1, ry1);
      const hover = o.hoverCell;
      if (hover && hover.row >= 0 && hover.row < o.rows.count && o.drag.kind === 'none') {
        ctx.fillStyle = theme.hoverBackground;
        const y = yOf(hover.row, sy);
        fill(cx0, y, cx1, y + o.rows.heightOf(hover.row));
      }
      for (const r of selection) {
        if (loneActive(r)) continue;
        const x0 = xOf(r.left, sx);
        const x1 = xOf(r.right + 1, sx);
        const y0 = yOf(r.top, sy);
        const y1 = yOf(r.bottom + 1, sy);
        if (x1 <= cx0 || x0 >= cx1 || y1 <= ry0 || y0 >= ry1) continue;
        ctx.fillStyle = theme.selectionBackground;
        fill(x0, y0, x1, y1);
        ctx.fillStyle = theme.selectionBorder;
        ring(x0, y0, x1, y1, thin);
      }
      if (activeCell && activeCell.row < o.rows.count && activeCell.col < o.offsets.length - 1) {
        ctx.fillStyle = o.focused ? theme.focusRing : theme.selectionBorder;
        const { row, col } = activeCell;
        ring(xOf(col, sx), yOf(row, sy), xOf(col + 1, sx), yOf(row + 1, sy), o.focused ? thick : thin);
      }
      ctx.restore();
    }
  }

  const d = o.drag;
  if (d.kind !== 'none') {
    ctx.fillStyle = theme.focusRing;
    if (d.kind === 'reorder') {
      ctx.fillStyle = theme.selectionBackground;
      const x0 = d.col < vp.frozenColumns ? xOf(d.col, 0) : xOf(d.col, vp.scrollLeft);
      fill(x0, 0, x0 + o.offsets[d.col + 1]! - o.offsets[d.col]!, H);
      ctx.fillStyle = theme.focusRing;
    }
    const X = px(d.x);
    ctx.fillRect(X - Math.floor(thick / 2), 0, thick, px(H));
  }
}
