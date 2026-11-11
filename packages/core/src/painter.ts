import { indexAtOffset, type ViewportRange } from './layout';
import type { RowModel } from './rows';
import { ELLIPSIS, type TextMeasurer, type TextWrapper } from './text';
import type { ResolvedTheme } from './theme';
import type { ColumnAlign, ColumnDef, GetCell } from './types';

/** The subset of CanvasRenderingContext2D the base painter uses. Kept narrow so tests can record calls. */
export type PaintContext = Pick<
  CanvasRenderingContext2D,
  | 'setTransform'
  | 'fillRect'
  | 'beginPath'
  | 'rect'
  | 'fill'
  | 'save'
  | 'restore'
  | 'clip'
  | 'fillText'
  | 'drawImage'
  | 'imageSmoothingEnabled'
  | 'fillStyle'
  | 'font'
  | 'textAlign'
  | 'textBaseline'
> & { readonly canvas: CanvasImageSource };

export interface PaintInput {
  ctx: PaintContext;
  /** Device pixels per CSS pixel for the backing store. */
  dpr: number;
  columns: readonly ColumnDef[];
  offsets: Float64Array;
  rows: RowModel;
  vp: ViewportRange;
  theme: ResolvedTheme;
  getCell: GetCell;
  text: TextMeasurer;
  /** Wrapping engine for `wrap` columns; without one they truncate like other columns. */
  wrapper: TextWrapper | null;
  /** Auto-height rows: text blocks sit at the top of the row instead of being centred. */
  autoHeight: boolean;
}

/** Cells to repaint: [row, col] pairs. A col of -1 means the whole row. */
export interface DirtyCells {
  cells: Int32Array;
  count: number;
}

export type PaintMode = 'full' | 'incremental';

export interface PaintResult {
  mode: PaintMode;
  /** Cells whose text was drawn. */
  cells: number;
  /** Device pixels shifted by blitting (0 if none). */
  blitX: number;
  blitY: number;
  /** Areas painted. */
  areas: number;
}

/** A clipped rectangle of the viewport plus the rows and columns that paint into it. */
interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  colStart: number;
  colEnd: number;
  /** Screen x of column c is offsets[c] - colShift. */
  colShift: number;
  rowStart: number;
  rowEnd: number;
  /** Screen y of row r is rowOrigin + rows.offsetOf(r). */
  rowOrigin: number;
  /** The region's full bounds before narrowing to an area; decide which gridlines exist. */
  lx0: number;
  ly0: number;
  lx1: number;
  ly1: number;
  /** Screen y of rows rowStart..rowEnd (inclusive of the bottom edge), filled per area. */
  tops: Float64Array;
}

const region = (): Region => ({
  x0: 0, y0: 0, x1: 0, y1: 0, colStart: 0, colEnd: 0, colShift: 0, rowStart: 0, rowEnd: 0, rowOrigin: 0,
  lx0: 0, ly0: 0, lx1: 0, ly1: 0, tops: new Float64Array(64),
});

/** Above this many dirty cells in one frame a full repaint is cheaper than per-cell clips. */
export const MAX_DIRTY_AREAS = 256;

const EPS = 1e-3;
const isWhole = (v: number) => Math.abs(v - Math.round(v)) < EPS;

/**
 * Paints the base layer. Every paint is "paint this device-pixel-aligned area": the full
 * viewport, the strips exposed by a scroll blit, or the rectangles of dirty cells. Within an
 * area the order is always backgrounds, then all gridlines as one path, then cell text grouped
 * by font and colour, then header text, so an area repaint produces the same pixels as a full one.
 *
 * Holds its region objects and area list across frames, so a steady-state paint allocates
 * nothing beyond what `getCell` returns.
 */
export class BasePainter {
  // Cell regions: scrolling body, frozen columns, frozen rows, frozen corner.
  private readonly body = region();
  private readonly frozenCols = region();
  private readonly frozenRows = region();
  private readonly corner = region();
  // Header regions: scrolling and frozen.
  private readonly header = region();
  private readonly headerFrozen = region();
  private readonly cellRegions = [this.body, this.frozenCols, this.frozenRows, this.corner];
  private readonly headerRegions = [this.header, this.headerFrozen];
  /** Scratch region for merged blits. */
  private readonly merged = region();

  /** Areas to paint this frame, in device pixels: x0, y0, x1, y1 per entry. */
  private areas = new Float64Array(64 * 4);
  private areaCount = 0;

  // What is on the canvas now.
  private valid = false;
  private lastScrollLeft = 0;
  /** A body row and its screen y when last painted: vertical blits follow its movement. */
  private lastRefRow = -1;
  private lastRefY = 0;
  private lastRowStart = 0;
  private lastRowEnd = 0;
  private lastGeometry = '';

  private readonly result: PaintResult = { mode: 'full', cells: 0, blitX: 0, blitY: 0, areas: 0 };

  /** Forget the canvas contents; the next paint is a full repaint. */
  invalidate(): void {
    this.valid = false;
  }

  /** Full repaint of the viewport. */
  paint(input: PaintInput): PaintResult {
    const { vp, dpr } = input;
    this.areaCount = 0;
    this.pushArea(0, 0, Math.round(vp.width * dpr), Math.round(vp.height * dpr));
    const r = this.result;
    r.mode = 'full';
    r.blitX = r.blitY = 0;
    r.cells = this.paintAreas(input);
    r.areas = 1;
    this.remember(input);
    return r;
  }

  /**
   * Repaints only what changed: blits the scrolled regions and paints the exposed strips,
   * then repaints dirty cells. Falls back to a full repaint when the canvas is stale, the
   * geometry changed, rows on screen changed height, the scroll delta is not a whole number of
   * device pixels, or there is too much to do piecemeal.
   */
  update(input: PaintInput, dirty?: DirtyCells): PaintResult {
    const { vp, dpr, ctx, rows } = input;
    if (!this.valid || geometryKey(input) !== this.lastGeometry) return this.paint(input);
    if (dirty && dirty.count > MAX_DIRTY_AREAS) return this.paint(input);
    // Rows that were or are on screen changed height: what is painted no longer lines up.
    if (
      rows.changedIn(0, vp.frozenRows) ||
      rows.changedIn(Math.min(this.lastRowStart, vp.rowStart), Math.max(this.lastRowEnd, vp.rowEnd))
    ) {
      return this.paint(input);
    }

    const dx = (vp.scrollLeft - this.lastScrollLeft) * dpr;
    // Follow the reference row rather than scrollTop: when heights above the viewport change,
    // scroll anchoring moves scrollTop but the content on screen stays put.
    let dy = 0;
    if (this.lastRefRow >= 0) {
      if (this.lastRefRow >= rows.count) return this.paint(input);
      dy = (this.lastRefY - (vp.headerHeight + rows.offsetOf(this.lastRefRow) - vp.scrollTop)) * dpr;
    }
    if (!isWhole(dx) || !isWhole(dy)) return this.paint(input);
    const sx = Math.round(dx);
    const sy = Math.round(dy);

    this.areaCount = 0;
    if (sx !== 0 || sy !== 0) {
      this.layoutRegions(vp);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = false;
      // Each self-copy snapshots the canvas, so merge panes that move together into one blit.
      if (sy === 0) {
        // Horizontal only: header, frozen rows and body all shift; together they span the
        // full height to the right of the frozen columns.
        setBounds(this.merged, vp.frozenWidth, 0, vp.width, vp.height);
        this.blit(input, this.merged, sx, 0);
      } else if (sx === 0) {
        // Vertical only: frozen columns and body shift; together they span the full width below.
        setBounds(this.merged, 0, vp.bodyTop, vp.width, vp.height);
        this.blit(input, this.merged, 0, sy);
      } else {
        // Diagonal: panes move differently. Regions are disjoint, so each blit stays inside its own.
        this.blit(input, this.body, sx, sy);
        this.blit(input, this.frozenCols, 0, sy);
        this.blit(input, this.frozenRows, sx, 0);
        this.blit(input, this.header, sx, 0);
      }
    }
    if (dirty) this.addDirtyCells(input, dirty);

    const r = this.result;
    r.mode = 'incremental';
    r.blitX = sx;
    r.blitY = sy;
    r.areas = this.areaCount;
    r.cells = this.areaCount > 0 ? this.paintAreas(input) : 0;
    this.remember(input);
    return r;
  }

  private remember(input: PaintInput): void {
    const { vp, rows } = input;
    this.valid = true;
    this.lastScrollLeft = vp.scrollLeft;
    this.lastRowStart = vp.rowStart;
    this.lastRowEnd = vp.rowEnd;
    if (vp.rowEnd > vp.rowStart) {
      this.lastRefRow = vp.rowStart;
      this.lastRefY = vp.headerHeight + rows.offsetOf(vp.rowStart) - vp.scrollTop;
    } else {
      this.lastRefRow = -1;
    }
    this.lastGeometry = geometryKey(input);
  }

  private pushArea(x0: number, y0: number, x1: number, y1: number): void {
    if (x1 <= x0 || y1 <= y0) return;
    const i = this.areaCount * 4;
    if (i + 4 > this.areas.length) {
      const next = new Float64Array(this.areas.length * 2);
      next.set(this.areas);
      this.areas = next;
    }
    this.areas[i] = x0;
    this.areas[i + 1] = y0;
    this.areas[i + 2] = x1;
    this.areas[i + 3] = y1;
    this.areaCount++;
  }

  /** Pushes a CSS-pixel rectangle as the smallest enclosing device-pixel area. */
  private pushCssArea(x0: number, y0: number, x1: number, y1: number, dpr: number): void {
    this.pushArea(
      Math.floor(x0 * dpr + EPS),
      Math.floor(y0 * dpr + EPS),
      Math.ceil(x1 * dpr - EPS),
      Math.ceil(y1 * dpr - EPS),
    );
  }

  /**
   * Shifts a region's pixels by (sx, sy) device pixels (content moves the opposite way)
   * and queues the exposed strips. Only whole device pixels inside the region are copied;
   * partially covered edge pixels are queued for repaint.
   *
   * Exposed strips are widened to whole cells, so a cell's text is always drawn in one call
   * and never split between a copied part and a repainted part. Some rasterisers (Chrome on
   * Windows) skip a glyph that only overlaps the clip by a sliver, which left gaps in glyphs
   * along strip edges.
   */
  private blit(input: PaintInput, r: Region, sx: number, sy: number): void {
    const { ctx, dpr } = input;
    if (sx === 0 && sy === 0) return;
    if (r.x1 <= r.x0 || r.y1 <= r.y0) return;
    const ox0 = Math.floor(r.x0 * dpr + EPS);
    const oy0 = Math.floor(r.y0 * dpr + EPS);
    const ox1 = Math.ceil(r.x1 * dpr - EPS);
    const oy1 = Math.ceil(r.y1 * dpr - EPS);
    const X0 = Math.ceil(r.x0 * dpr - EPS);
    const Y0 = Math.ceil(r.y0 * dpr - EPS);
    const X1 = Math.floor(r.x1 * dpr + EPS);
    const Y1 = Math.floor(r.y1 * dpr + EPS);
    const W = X1 - X0;
    const H = Y1 - Y0;
    if (Math.abs(sx) >= W || Math.abs(sy) >= H) {
      this.pushArea(ox0, oy0, ox1, oy1);
      return;
    }
    const w = W - Math.abs(sx);
    const h = H - Math.abs(sy);
    const srcX = X0 + Math.max(sx, 0);
    const srcY = Y0 + Math.max(sy, 0);
    const dstX = X0 + Math.max(-sx, 0);
    const dstY = Y0 + Math.max(-sy, 0);
    ctx.drawImage(ctx.canvas, srcX, srcY, w, h, dstX, dstY, w, h);

    // Exposed strips, widened to whole columns or rows within the region.
    if (sx !== 0) {
      const [a, b] = sx > 0 ? [X1 - sx, X1] : [X0, X0 - sx];
      this.pushArea(this.cellLeft(input, a, ox0), Y0, this.cellRight(input, b, ox1), Y1);
    }
    if (sy !== 0) {
      const [a, b] = sy > 0 ? [Y1 - sy, Y1] : [Y0, Y0 - sy];
      this.pushArea(X0, this.cellTop(input, a, oy0), X1, this.cellBottom(input, b, oy1));
    }
    // Partially covered device pixels along fractional region edges.
    if (ox0 < X0) this.pushArea(ox0, oy0, X0, oy1);
    if (X1 < ox1) this.pushArea(X1, oy0, ox1, oy1);
    if (oy0 < Y0) this.pushArea(ox0, oy0, ox1, Y0);
    if (Y1 < oy1) this.pushArea(ox0, Y1, ox1, oy1);
  }

  // Cell edges around a device-pixel coordinate, for scrolling panes, clamped to [lo, hi].
  // Every pane that blits horizontally is shifted by scrollLeft, and every pane that blits
  // vertically has its rows at headerHeight - scrollTop.
  private cellLeft({ offsets, vp, dpr }: PaintInput, x: number, lo: number): number {
    const c = indexAtOffset(offsets, x / dpr + vp.scrollLeft);
    return Math.max(lo, Math.min(x, Math.floor((offsets[c]! - vp.scrollLeft) * dpr + EPS)));
  }

  private cellRight({ offsets, vp, dpr }: PaintInput, x: number, hi: number): number {
    const c = indexAtOffset(offsets, x / dpr + vp.scrollLeft - 1e-6);
    const edge = offsets[Math.min(c + 1, offsets.length - 1)]! - vp.scrollLeft;
    return Math.min(hi, Math.max(x, Math.ceil(edge * dpr - EPS)));
  }

  private cellTop({ rows, vp, dpr }: PaintInput, y: number, lo: number): number {
    if (rows.count === 0) return y;
    const origin = vp.headerHeight - vp.scrollTop;
    const r = rows.rowAt(y / dpr - origin);
    return Math.max(lo, Math.min(y, Math.floor((origin + rows.offsetOf(r)) * dpr + EPS)));
  }

  private cellBottom({ rows, vp, dpr }: PaintInput, y: number, hi: number): number {
    if (rows.count === 0) return y;
    const origin = vp.headerHeight - vp.scrollTop;
    const r = rows.rowAt(y / dpr - origin - 1e-6);
    return Math.min(hi, Math.max(y, Math.ceil((origin + rows.offsetOf(r + 1)) * dpr - EPS)));
  }

  private addDirtyCells(input: PaintInput, dirty: DirtyCells): void {
    const { vp, offsets, dpr, rows } = input;
    const { cells, count } = dirty;
    const headerBottom = Math.min(vp.headerHeight, vp.height);
    for (let i = 0; i < count; i++) {
      const row = cells[i * 2]!;
      const col = cells[i * 2 + 1]!;
      if (row < 0 || row >= rows.count) continue;
      let y0: number;
      let ry0: number;
      let ry1: number;
      if (row < vp.frozenRows) {
        y0 = vp.headerHeight + rows.offsetOf(row);
        ry0 = headerBottom;
        ry1 = vp.bodyTop;
      } else {
        if (row < vp.rowStart || row >= vp.rowEnd) continue;
        y0 = vp.headerHeight + rows.offsetOf(row) - vp.scrollTop;
        ry0 = vp.bodyTop;
        ry1 = vp.height;
      }
      const top = Math.max(y0, ry0);
      const bottom = Math.min(y0 + rows.heightOf(row), ry1);
      if (bottom <= top) continue;
      if (col < 0) {
        this.pushCssArea(0, top, vp.width, bottom, dpr);
        continue;
      }
      if (col >= offsets.length - 1) continue;
      let x0: number;
      let rx0: number;
      let rx1: number;
      if (col < vp.frozenColumns) {
        x0 = offsets[col]!;
        rx0 = 0;
        rx1 = vp.frozenWidth;
      } else {
        if (col < vp.colStart || col >= vp.colEnd) continue;
        x0 = offsets[col]! - vp.scrollLeft;
        rx0 = vp.frozenWidth;
        rx1 = vp.width;
      }
      const left = Math.max(x0, rx0);
      const right = Math.min(x0 + (offsets[col + 1]! - offsets[col]!), rx1);
      if (right <= left) continue;
      this.pushCssArea(left, top, right, bottom, dpr);
    }
  }

  private paintAreas(input: PaintInput): number {
    const { ctx, dpr } = input;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let cells = 0;
    for (let i = 0; i < this.areaCount; i++) {
      const j = i * 4;
      cells += this.paintArea(
        input,
        this.areas[j]! / dpr,
        this.areas[j + 1]! / dpr,
        this.areas[j + 2]! / dpr,
        this.areas[j + 3]! / dpr,
      );
    }
    return cells;
  }

  /**
   * Paints everything that falls inside the area, clipped to it. Returns cells painted.
   * Geometry (gridlines, stripes, dividers) is always emitted at its full extent and trimmed
   * by the clip, so an area repaint rasterises exactly like a full repaint.
   */
  private paintArea(input: PaintInput, ax0: number, ay0: number, ax1: number, ay1: number): number {
    const { ctx, dpr, vp, theme, offsets, rows } = input;
    const { height, headerHeight } = vp;
    this.layoutRegions(vp);
    for (const r of this.cellRegions) {
      narrow(r, ax0, ay0, ax1, ay1, offsets, rows);
      fillTops(r, rows);
    }
    for (const r of this.headerRegions) narrow(r, ax0, ay0, ax1, ay1, offsets, rows);

    ctx.save();
    ctx.beginPath();
    ctx.rect(ax0, ay0, ax1 - ax0, ay1 - ay0);
    ctx.clip();

    // 1. Backgrounds.
    ctx.fillStyle = theme.background;
    ctx.fillRect(ax0, ay0, ax1 - ax0, ay1 - ay0);
    if (theme.rowAltBackground) {
      ctx.fillStyle = theme.rowAltBackground;
      ctx.beginPath();
      for (const r of this.cellRegions) {
        if (r.x1 <= r.x0) continue;
        const first = r.rowStart + ((r.rowStart & 1) ^ 1);
        for (let row = first; row < r.rowEnd; row += 2) {
          const i = row - r.rowStart;
          const top = Math.max(r.ly0, r.tops[i]!);
          const bottom = Math.min(r.ly1, r.tops[i + 1]!);
          if (bottom > top) ctx.rect(r.lx0, top, r.lx1 - r.lx0, bottom - top);
        }
      }
      ctx.fill();
    }
    const headerBottom = Math.min(headerHeight, height);
    if (headerBottom > ay0) {
      ctx.fillStyle = theme.headerBackground;
      ctx.fillRect(ax0, ay0, ax1 - ax0, headerBottom - ay0);
    }

    // 2. Gridlines: every region's lines in one path, filled as 1-device-pixel rectangles.
    ctx.beginPath();
    for (const r of this.cellRegions) addGridLines(ctx, r, offsets, dpr, true);
    for (const r of this.headerRegions) addGridLines(ctx, r, offsets, dpr, false);
    if (headerHeight > 0 && headerHeight <= height) hLine(ctx, headerHeight, 0, vp.width, dpr);
    ctx.fillStyle = theme.gridLine;
    ctx.fill();

    // 3. Cell text, one font and colour.
    ctx.font = theme.cellFont;
    ctx.fillStyle = theme.foreground;
    ctx.textBaseline = 'middle';
    let cells = 0;
    for (const r of this.cellRegions) cells += this.paintRegionText(input, r);

    // 4. Header text.
    if (headerHeight > 0 && ay0 < headerBottom) {
      ctx.font = theme.headerFont;
      ctx.fillStyle = theme.headerForeground;
      for (const r of this.headerRegions) this.paintHeaderText(input, r);
    }

    // 5. Frozen pane dividers.
    if (vp.frozenWidth > 0 || vp.frozenHeight > 0) {
      ctx.beginPath();
      if (vp.frozenWidth > 0) vLine(ctx, vp.frozenWidth, 0, height, dpr);
      if (vp.frozenHeight > 0) hLine(ctx, vp.bodyTop, 0, vp.width, dpr);
      ctx.fillStyle = theme.frozenDivider;
      ctx.fill();
    }
    ctx.restore();
    return cells;
  }

  private layoutRegions(vp: ViewportRange): void {
    const { width, height, headerHeight, frozenWidth, bodyTop } = vp;
    const headerBottom = Math.min(headerHeight, height);
    set(this.body, frozenWidth, bodyTop, width, height, vp.colStart, vp.colEnd, vp.scrollLeft,
      vp.rowStart, vp.rowEnd, headerHeight - vp.scrollTop);
    set(this.frozenCols, 0, bodyTop, frozenWidth, height, 0, vp.frozenColumns, 0,
      vp.rowStart, vp.rowEnd, headerHeight - vp.scrollTop);
    set(this.frozenRows, frozenWidth, headerBottom, width, bodyTop, vp.colStart, vp.colEnd, vp.scrollLeft,
      0, vp.frozenRows, headerHeight);
    set(this.corner, 0, headerBottom, frozenWidth, bodyTop, 0, vp.frozenColumns, 0,
      0, vp.frozenRows, headerHeight);
    set(this.header, frozenWidth, 0, width, headerBottom, vp.colStart, vp.colEnd, vp.scrollLeft, 0, 0, 0);
    set(this.headerFrozen, 0, 0, frozenWidth, headerBottom, 0, vp.frozenColumns, 0, 0, 0, 0);
  }

  private paintRegionText(input: PaintInput, r: Region): number {
    const { ctx, dpr, offsets, columns, getCell, theme, text, wrapper, autoHeight } = input;
    if (r.x1 <= r.x0 || r.y1 <= r.y0 || r.rowEnd <= r.rowStart) return 0;
    const pad = theme.cellPaddingX;
    const lh = theme.lineHeight;
    const font = theme.cellFont;
    let cells = 0;
    for (let c = r.colStart; c < r.colEnd; c++) {
      const left = offsets[c]! - r.colShift;
      const right = offsets[c + 1]! - r.colShift;
      const clipLeft = Math.max(left, r.x0);
      const clipRight = Math.min(right, r.x1);
      const avail = right - left - 2 * pad;
      if (clipRight <= clipLeft || avail <= 0) continue;
      const col = columns[c]!;
      const align = col.align ?? 'left';
      const wrap = col.wrap === true && wrapper !== null;
      ctx.textAlign = align;
      const x = snap(textX(align, left, right, pad), dpr);
      ctx.save();
      ctx.beginPath();
      ctx.rect(clipLeft, r.y0, clipRight - clipLeft, r.y1 - r.y0);
      ctx.clip();
      for (let row = r.rowStart; row < r.rowEnd; row++) {
        const v = getCell(row, c, columns[c]!);
        if (v == null || v === '') continue;
        const str = typeof v === 'string' ? v : String(v);
        const i = row - r.rowStart;
        const top = r.tops[i]!;
        const h = r.tops[i + 1]! - top;
        if (wrap) {
          const lines = wrapper.lines(str, font, avail);
          const room = Math.max(1, Math.floor((h - 2 * theme.cellPaddingY) / lh + 1e-6));
          const n = Math.min(lines.length, room);
          let y = autoHeight ? top + theme.cellPaddingY + lh / 2 : top + (h - n * lh) / 2 + lh / 2;
          for (let k = 0; k < n; k++, y += lh) {
            let line = lines[k]!;
            // Clamp: the last line that fits carries an ellipsis if text continues.
            if (k === n - 1 && n < lines.length) line = text.fit(line + ELLIPSIS, font, avail);
            ctx.fillText(line, x, snap(y, dpr));
          }
        } else {
          const y = autoHeight ? top + theme.cellPaddingY + lh / 2 : top + h / 2;
          ctx.fillText(text.fit(str, font, avail), x, snap(y, dpr));
        }
        cells++;
      }
      ctx.restore();
    }
    return cells;
  }

  private paintHeaderText(input: PaintInput, r: Region): void {
    const { ctx, dpr, offsets, columns, theme, vp, text } = input;
    if (r.x1 <= r.x0 || r.y1 <= r.y0) return;
    const y = snap(vp.headerHeight / 2, dpr);
    for (let c = r.colStart; c < r.colEnd; c++) {
      const col = columns[c]!;
      const title = col.title ?? col.id;
      if (!title) continue;
      const left = offsets[c]! - r.colShift;
      const right = offsets[c + 1]! - r.colShift;
      const clipLeft = Math.max(left, r.x0);
      const clipRight = Math.min(right, r.x1);
      const avail = right - left - 2 * theme.cellPaddingX;
      if (clipRight <= clipLeft || avail <= 0) continue;
      const align = col.align ?? 'left';
      ctx.textAlign = align;
      ctx.save();
      ctx.beginPath();
      ctx.rect(clipLeft, r.y0, clipRight - clipLeft, r.y1 - r.y0);
      ctx.clip();
      ctx.fillText(text.fit(title, theme.headerFont, avail), snap(textX(align, left, right, theme.cellPaddingX), dpr), y);
      ctx.restore();
    }
  }
}

/** Everything other than scroll position that decides where pixels land. */
function geometryKey({ vp, dpr, columns, theme, offsets, autoHeight }: PaintInput): string {
  return `${vp.width},${vp.height},${vp.headerHeight},${vp.frozenColumns},${vp.frozenRows},${dpr},${offsets.length},${offsets[offsets.length - 1]},${columns.length},${theme.cellFont},${theme.lineHeight},${autoHeight}`;
}

/** Shrinks a region to an area, narrowing its row and column ranges to match. */
function narrow(
  r: Region,
  ax0: number, ay0: number, ax1: number, ay1: number,
  offsets: Float64Array,
  rows: RowModel,
): void {
  r.x0 = Math.max(r.x0, ax0);
  r.y0 = Math.max(r.y0, ay0);
  r.x1 = Math.min(r.x1, ax1);
  r.y1 = Math.min(r.y1, ay1);
  if (r.x1 <= r.x0 || r.y1 <= r.y0) {
    r.colEnd = r.colStart;
    r.rowEnd = r.rowStart;
    return;
  }
  if (r.colEnd > r.colStart) {
    const lo = indexAtOffset(offsets, r.x0 + r.colShift);
    const hi = indexAtOffset(offsets, r.x1 + r.colShift - 1e-6) + 1;
    r.colStart = Math.max(r.colStart, lo);
    r.colEnd = Math.max(r.colStart, Math.min(r.colEnd, hi));
  }
  if (r.rowEnd > r.rowStart) {
    const lo = rows.rowAt(r.y0 - r.rowOrigin);
    const hi = rows.rowAt(r.y1 - r.rowOrigin - 1e-6) + 1;
    r.rowStart = Math.max(r.rowStart, lo);
    r.rowEnd = Math.max(r.rowStart, Math.min(r.rowEnd, hi));
  }
}

/** Screen y of each row edge in the region: one offset lookup, then running heights. */
function fillTops(r: Region, rows: RowModel): void {
  const n = r.rowEnd - r.rowStart;
  if (n <= 0) return;
  if (r.tops.length < n + 1) r.tops = new Float64Array(Math.max(n + 1, r.tops.length * 2));
  let y = r.rowOrigin + rows.offsetOf(r.rowStart);
  for (let i = 0; i < n; i++) {
    r.tops[i] = y;
    y += rows.heightOf(r.rowStart + i);
  }
  r.tops[n] = y;
}

function addGridLines(ctx: PaintContext, r: Region, offsets: Float64Array, dpr: number, rows: boolean): void {
  if (r.x1 <= r.x0 || r.y1 <= r.y0) return;
  for (let c = r.colStart; c < r.colEnd; c++) {
    const right = offsets[c + 1]! - r.colShift;
    if (right <= r.lx0 || right > r.lx1) continue;
    vLine(ctx, right, r.ly0, r.ly1, dpr);
  }
  if (!rows) return;
  for (let i = 1; i <= r.rowEnd - r.rowStart; i++) {
    const bottom = r.tops[i]!;
    if (bottom <= r.ly0 || bottom > r.ly1) continue;
    hLine(ctx, bottom, r.lx0, r.lx1, dpr);
  }
}

/**
 * Lines are filled rectangles one device pixel thick, in the last device pixel before the edge,
 * with ends snapped to device pixels. Unlike strokes, these rasterise exactly in every backend,
 * so an area repaint matches a full repaint pixel for pixel.
 */
function vLine(ctx: PaintContext, edge: number, y0: number, y1: number, dpr: number): void {
  const x = Math.round(edge * dpr) - 1;
  const top = Math.round(y0 * dpr);
  const bottom = Math.round(y1 * dpr);
  if (bottom > top) ctx.rect(x / dpr, top / dpr, 1 / dpr, (bottom - top) / dpr);
}

function hLine(ctx: PaintContext, edge: number, x0: number, x1: number, dpr: number): void {
  const y = Math.round(edge * dpr) - 1;
  const left = Math.round(x0 * dpr);
  const right = Math.round(x1 * dpr);
  if (right > left) ctx.rect(left / dpr, y / dpr, (right - left) / dpr, 1 / dpr);
}

function set(
  r: Region,
  x0: number, y0: number, x1: number, y1: number,
  colStart: number, colEnd: number, colShift: number,
  rowStart: number, rowEnd: number, rowOrigin: number,
): void {
  r.x0 = r.lx0 = x0; r.y0 = r.ly0 = y0; r.x1 = r.lx1 = x1; r.y1 = r.ly1 = y1;
  r.colStart = colStart; r.colEnd = colEnd; r.colShift = colShift;
  r.rowStart = rowStart; r.rowEnd = rowEnd; r.rowOrigin = rowOrigin;
}

function setBounds(r: Region, x0: number, y0: number, x1: number, y1: number): void {
  set(r, x0, y0, x1, y1, 0, 0, 0, 0, 0, 0);
}

function textX(align: ColumnAlign, left: number, right: number, pad: number): number {
  return align === 'right' ? right - pad : align === 'center' ? (left + right) / 2 : left + pad;
}

/** Snaps a CSS coordinate to the nearest device pixel boundary. */
export function snap(v: number, dpr: number): number {
  return Math.round(v * dpr) / dpr;
}

/** Centre of the last device pixel before edge `v`. */
export function snapLine(v: number, dpr: number): number {
  return (Math.round(v * dpr) - 0.5) / dpr;
}
