import { buildColumnOffsets, computeViewport, createViewportRange } from './layout';
import { BasePainter, MAX_DIRTY_AREAS, type DirtyCells, type PaintInput } from './painter';
import { FixedRows, VariableRows, type RowModel } from './rows';
import { ScrollAxis } from './scroll';
import { Dirty, createScheduler, type FrameSource, type Scheduler } from './scheduler';
import { createStore, type Store } from './store';
import { createSurface, type Surface } from './surface';
import { TextMeasurer, type TextWrapper } from './text';
import { defaultTheme, mergeTheme, resolveTheme, type ResolvedTheme } from './theme';
import type { ColumnDef, FrameInfo, GetCell, GridState, RowSizing, Theme } from './types';

export interface GridOptions {
  columns: readonly ColumnDef[];
  rowCount: number;
  getCell: GetCell;
  frozenColumns?: number;
  frozenRows?: number;
  /** 'fixed' (default): every row is `theme.rowHeight`. 'auto': rows grow to fit wrapped text. */
  rowSizing?: RowSizing;
  /** Wrapping engine for `wrap` columns, e.g. `createPretextWrapper()` from `@falcon-grid/text`. */
  textWrapper?: TextWrapper;
  /** Merged over the default theme. Use `themeFromCSSVariables` to read it from CSS. */
  theme?: Partial<Theme>;
  /** Called after every frame. For instrumentation; keep it cheap. */
  onFrame?: (info: Readonly<FrameInfo>) => void;
  /** Override the frame source (tests). */
  frameSource?: FrameSource;
}

export interface Grid {
  readonly store: Store<GridState>;
  /** Positioned container above the canvases for editors, tooltips and the accessibility mirror. */
  readonly domLayer: HTMLDivElement;
  readonly element: HTMLDivElement;
  update(options: Partial<Omit<GridOptions, 'frameSource'>>): void;
  /** Repaint the whole base layer, e.g. after the data was replaced. Auto row heights are re-measured. */
  invalidate(): void;
  /** Repaint one cell on the next frame. Cheap: only that cell's rectangle is painted. */
  invalidateCell(row: number, col: number): void;
  /** Repaint several cells, given as [row, col] pairs (`count` pairs, default all). */
  invalidateCells(cells: ArrayLike<number>, count?: number): void;
  /** Repaint rows [start, end). Auto row heights for them are re-measured. */
  invalidateRows(start: number, end: number): void;
  /** Scroll to virtual content offsets in CSS pixels. */
  scrollTo(position: { left?: number; top?: number }): void;
  /** Scroll so `row` is the first row below the header and frozen rows. */
  scrollToRow(row: number): void;
  /** The first and last (exclusive) scrolling rows currently on screen. */
  visibleRows(): { start: number; end: number };
  /** Screen position of a row relative to the grid's top edge, or null if it is not on screen. */
  getRowBounds(row: number): { top: number; height: number } | null;
  /** Run pending work now instead of on the next frame. */
  flush(): void;
  destroy(): void;
}

/** Rows measured beyond each edge of the viewport, so they are ready before they scroll in. */
const MEASURE_OVERSCAN = 12;
/** Rows measured ahead in the scroll direction while the browser is idle. */
const IDLE_AHEAD = 2000;
/** Longest idle slice, so input arriving meanwhile is not held up. */
const IDLE_SLICE_MS = 4;

export function createGrid(container: HTMLElement, options: GridOptions): Grid {
  let getCell = options.getCell;
  let onFrame = options.onFrame;
  let themePatch = options.theme;
  let wrapper: TextWrapper | null = options.textWrapper ?? null;

  const store = createStore<GridState>({
    columns: options.columns,
    rowCount: options.rowCount,
    frozenColumns: options.frozenColumns ?? 0,
    frozenRows: options.frozenRows ?? 0,
    rowSizing: options.rowSizing ?? 'fixed',
    scrollLeft: 0,
    scrollTop: 0,
    viewportWidth: 0,
    viewportHeight: 0,
    pixelRatio: 1,
    theme: mergeTheme(defaultTheme, options.theme),
  });

  let offsets = buildColumnOffsets(options.columns);
  let offsetsFor: readonly ColumnDef[] = options.columns;
  let resolved: ResolvedTheme = resolveTheme(store.getSnapshot().theme);
  let resolvedFor: Theme = store.getSnapshot().theme;
  const vp = createViewportRange();
  const painter = new BasePainter();
  const text = new TextMeasurer();
  const info: FrameInfo = {
    frame: 0, flags: 0, durationMs: 0, cellsPainted: 0, paint: 'none', blitX: 0, blitY: 0, rowsMeasured: 0,
  };
  const dirty: DirtyCells = { cells: new Int32Array(MAX_DIRTY_AREAS * 2), count: 0 };
  const axisX = new ScrollAxis();
  const axisY = new ScrollAxis();
  let lastRelativeInput = -Infinity;
  let resyncTimer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  // Row geometry. Fixed sizing is arithmetic; auto sizing keeps a VariableRows across layouts.
  let rows: RowModel = new FixedRows(options.rowCount, store.getSnapshot().theme.rowHeight);
  let variable: VariableRows | null = null;
  /** Columns that wrap (auto sizing measures only these). */
  let wrapped: number[] = [];
  /** Every measurement is stale (data, widths, theme or fonts changed). */
  let heightsStale = false;
  let scrollDir = 1;

  const input: PaintInput = {
    ctx: null as unknown as PaintInput['ctx'],
    dpr: 1,
    columns: options.columns,
    offsets,
    rows,
    vp,
    theme: resolved,
    getCell,
    text,
    wrapper,
    autoHeight: false,
  };

  const contentWidth = () => offsets[offsets.length - 1]!;
  const contentHeight = (s: GridState) => s.theme.headerHeight + rows.total;
  const frozenRowsOf = (s: GridState) => Math.min(Math.max(0, s.frozenRows), rows.count);

  const publishScroll = () => store.setState({ scrollLeft: axisX.virtual, scrollTop: axisY.virtual });

  /** Moves scaled scrollbar thumbs to match the content, without moving the content. */
  const resyncThumbs = () => {
    clearTimeout(resyncTimer);
    resyncTimer = undefined;
    const x = axisX.thumbTarget();
    const y = axisY.thumbTarget();
    if (x !== null) {
      axisX.expect(x);
      surface.scroller.scrollLeft = x;
    }
    if (y !== null) {
      axisY.expect(y);
      surface.scroller.scrollTop = y;
    }
  };

  const surface: Surface = createSurface(container, {
    onScroll(left, top) {
      const relative = performance.now() - lastRelativeInput < 250;
      const before = axisY.virtual;
      axisX.onScroll(left, relative);
      axisY.onScroll(top, relative);
      if (axisY.virtual !== before) scrollDir = axisY.virtual > before ? 1 : -1;
      publishScroll();
      if (axisX.stuck || axisY.stuck) resyncThumbs();
      else if (relative && (axisX.scaled || axisY.scaled)) {
        clearTimeout(resyncTimer);
        resyncTimer = setTimeout(resyncThumbs, 150);
      }
    },
    onRelativeInput() {
      lastRelativeInput = performance.now();
    },
    onViewport(width, height) {
      store.setState({ viewportWidth: width, viewportHeight: height });
    },
    onPixels(pixelRatio) {
      store.setState({ pixelRatio });
      scheduler.mark(Dirty.All);
    },
  });

  /** Pushes the content size to the scroll container and axes. */
  const applyContentSize = () => {
    const s = store.getSnapshot();
    axisX.configure(contentWidth(), s.viewportWidth);
    axisY.configure(contentHeight(s), s.viewportHeight);
    surface.setScrollSize(axisX.extent, axisY.extent);
  };

  // ---- Auto row heights -------------------------------------------------------------------

  /** Height of one row: the tallest wrapped cell, at least theme.rowHeight. */
  const measureRow = (row: number, s: GridState): number => {
    const t = s.theme;
    let lines = 1;
    if (wrapper) {
      for (const c of wrapped) {
        const v = getCell(row, c);
        if (v == null || v === '') continue;
        const avail = offsets[c + 1]! - offsets[c]! - 2 * t.cellPaddingX;
        if (avail <= 0) continue;
        const n = wrapper.lineCount(typeof v === 'string' ? v : String(v), resolved.cellFont, avail);
        if (n > lines) lines = n;
      }
    }
    return Math.max(t.rowHeight, lines * t.lineHeight + 2 * t.cellPaddingY);
  };

  /**
   * Scroll anchor: the row at the top of the scrolling body and how far into it we are.
   * Restoring it after heights change keeps the content on screen still.
   */
  const anchor = { row: 0, delta: 0, atTop: true };
  const captureAnchor = (s: GridState) => {
    anchor.atTop = s.scrollTop <= 0;
    if (anchor.atTop || rows.count === 0) return;
    const p = s.scrollTop + rows.offsetOf(frozenRowsOf(s));
    anchor.row = rows.rowAt(p);
    anchor.delta = p - rows.offsetOf(anchor.row);
  };
  const restoreAnchor = () => {
    const s = store.getSnapshot();
    applyContentSize();
    let target = 0;
    if (!anchor.atTop && rows.count > 0) {
      const row = Math.min(anchor.row, rows.count - 1);
      target = rows.offsetOf(row) + Math.min(anchor.delta, rows.heightOf(row)) - rows.offsetOf(frozenRowsOf(s));
    }
    if (Math.abs(target - axisY.virtual) > 1e-6 || Math.abs(s.scrollTop - axisY.virtual) > 1e-6) {
      const dom = axisY.adjust(target);
      if (dom !== null) {
        surface.scroller.scrollTop = dom;
        // The browser quantises scroll positions; take the stored value as the truth now, or
        // the scroll event that follows would move the content by a fraction of a pixel.
        axisY.observeDom(surface.scroller.scrollTop);
      }
      publishScroll();
    }
  };

  /**
   * Lets the estimate for unmeasured rows learn from measured ones. Kept to whole pixels so
   * row offsets stay integers and anchored scroll positions are ones the browser can store.
   */
  const learnEstimate = () => {
    if (!variable || variable.measuredCount < 16) return;
    const mean = Math.round(variable.measuredMean);
    if (mean !== variable.estimate) variable.estimate = mean;
  };

  /**
   * Measures unmeasured rows in and around the viewport, keeping the anchor row still.
   * Repeats because new heights move the viewport over different rows. Returns rows measured.
   */
  const measureVisible = (): number => {
    if (!variable) return 0;
    const v = variable;
    let total = 0;
    for (let pass = 0; pass < 4; pass++) {
      const s = store.getSnapshot();
      if (pass === 0 && heightsStale) {
        captureAnchor(s);
        v.clear();
        heightsStale = false;
      } else {
        captureAnchor(s);
      }
      const frozen = frozenRowsOf(s);
      let measured = 0;
      for (let r = 0; r < frozen; r++) {
        if (!v.isMeasured(r)) {
          v.setHeight(r, measureRow(r, s));
          measured++;
        }
      }
      if (v.count > frozen) {
        const fh = v.offsetOf(frozen);
        const start = Math.max(frozen, v.rowAt(s.scrollTop + fh) - MEASURE_OVERSCAN);
        const end = Math.min(v.count, v.rowAt(s.scrollTop + s.viewportHeight - s.theme.headerHeight) + 1 + MEASURE_OVERSCAN);
        for (let r = start; r < end; r++) {
          if (!v.isMeasured(r)) {
            v.setHeight(r, measureRow(r, s));
            measured++;
          }
        }
      }
      if (measured === 0 && pass > 0) break;
      total += measured;
      learnEstimate();
      restoreAnchor();
      if (measured === 0) break;
    }
    return total;
  };

  // Idle measurement ahead in the scroll direction.
  type Deadline = { timeRemaining(): number };
  const ric: (cb: (d: Deadline) => void) => number =
    typeof requestIdleCallback === 'function'
      ? (cb) => requestIdleCallback(cb, { timeout: 500 })
      : (cb) => setTimeout(() => cb({ timeRemaining: () => 8 }), 50) as unknown as number;
  const cancelRic: (h: number) => void =
    typeof cancelIdleCallback === 'function' ? cancelIdleCallback : (h) => clearTimeout(h);
  let idleHandle = 0;

  const scheduleIdle = () => {
    if (idleHandle || destroyed || !variable || variable.measuredCount >= variable.count) return;
    idleHandle = ric(idleMeasure);
  };

  const idleMeasure = (deadline: Deadline) => {
    idleHandle = 0;
    const v = variable;
    if (!v || destroyed || heightsStale) return;
    const s = store.getSnapshot();
    if (s.viewportHeight <= 0) return;
    captureAnchor(s);
    const frozen = frozenRowsOf(s);
    const first = Math.max(frozen, v.rowAt(s.scrollTop + v.offsetOf(frozen)));
    const last = v.rowAt(s.scrollTop + s.viewportHeight - s.theme.headerHeight) + 1;
    let measured = 0;
    let more = false;
    const sliceEnd = performance.now() + IDLE_SLICE_MS;
    // Ahead in the scroll direction first, then behind.
    const sweep = (from: number, to: number, step: number) => {
      for (let r = from; r !== to; r += step) {
        if (deadline.timeRemaining() < 1 || performance.now() > sliceEnd) {
          more = true;
          return;
        }
        if (!v.isMeasured(r)) {
          v.setHeight(r, measureRow(r, s));
          measured++;
        }
      }
    };
    const down = () => sweep(Math.min(v.count, last), Math.min(v.count, last + IDLE_AHEAD), 1);
    const up = () => sweep(first - 1, Math.max(frozen, first - IDLE_AHEAD) - 1, -1);
    if (scrollDir >= 0) {
      down();
      if (!more) up();
    } else {
      up();
      if (!more) down();
    }
    if (measured > 0) {
      learnEstimate();
      restoreAnchor();
      // Only rows off screen were measured: nothing visible moves, but repaint in case the
      // estimate changed the height of an unmeasured row on screen.
      scheduler.mark(Dirty.Scroll);
    }
    if (more) scheduleIdle();
  };

  /** Rebuilds the row model for the current sizing, count and theme. */
  const syncRowModel = (s: GridState, prev: GridState | null) => {
    if (s.rowSizing === 'auto') {
      const needsNew = !variable;
      if (needsNew) {
        variable = new VariableRows(
          s.rowCount,
          Math.round(Math.max(s.theme.rowHeight, s.theme.lineHeight + 2 * s.theme.cellPaddingY)),
        );
        heightsStale = true;
      } else if (variable!.count !== s.rowCount) {
        variable!.resize(s.rowCount);
      }
      if (prev && (prev.theme !== s.theme || prev.rowSizing !== s.rowSizing)) heightsStale = true;
      if (prev && prev.columns !== s.columns && wrappedWidthsChanged(prev.columns, s.columns)) heightsStale = true;
      rows = variable!;
    } else {
      variable = null;
      if (!(rows instanceof FixedRows) || rows.count !== s.rowCount || rows.height !== s.theme.rowHeight) {
        rows = new FixedRows(s.rowCount, s.theme.rowHeight);
      }
    }
    wrapped = [];
    s.columns.forEach((c, i) => c.wrap && wrapped.push(i));
  };

  const wrappedWidthsChanged = (a: readonly ColumnDef[], b: readonly ColumnDef[]) => {
    if (a.length !== b.length) return true;
    for (let i = 0; i < a.length; i++) {
      const x = a[i]!;
      const y = b[i]!;
      if ((x.wrap || y.wrap) && (x.wrap !== y.wrap || x.width !== y.width || x.id !== y.id)) return true;
    }
    return false;
  };

  // ---- Frame ------------------------------------------------------------------------------

  let laidOut: GridState | null = null;

  const layout = () => {
    const s = store.getSnapshot();
    if (offsetsFor !== s.columns) {
      offsets = buildColumnOffsets(s.columns, offsets);
      offsetsFor = s.columns;
    }
    if (resolvedFor !== s.theme) {
      resolved = resolveTheme(s.theme);
      resolvedFor = s.theme;
    }
    // Capture the anchor under the old geometry, before the row model changes.
    captureAnchor(s);
    syncRowModel(s, laidOut);
    laidOut = s;
    surface.setViewportSize(s.viewportWidth, s.viewportHeight);
    surface.applyBackingSize();
    applyContentSize();
    // The browser may have clamped scroll, or the scale may have changed.
    axisX.observeDom(surface.scroller.scrollLeft);
    axisY.observeDom(surface.scroller.scrollTop);
    if (variable) restoreAnchor();
    resyncThumbs();
    publishScroll();
  };

  const run = (initialFlags: number) => {
    const t0 = performance.now();
    let flags = initialFlags;
    if (flags & Dirty.Layout) {
      layout();
      flags |= scheduler.consume();
      painter.invalidate();
    }
    let s = store.getSnapshot();
    info.cellsPainted = 0;
    info.paint = 'none';
    info.blitX = info.blitY = 0;
    info.rowsMeasured = 0;
    const canPaint = s.viewportWidth > 0 && s.viewportHeight > 0 && surface.backingWidth > 0;
    if (canPaint && variable) {
      info.rowsMeasured = measureVisible();
      flags |= scheduler.consume();
      if (info.rowsMeasured > 0) flags |= Dirty.Scroll;
      s = store.getSnapshot();
    }
    if (canPaint && flags & (Dirty.Base | Dirty.Cells | Dirty.Scroll)) {
      computeViewport(
        {
          offsets,
          rows,
          headerHeight: s.theme.headerHeight,
          frozenColumns: s.frozenColumns,
          frozenRows: s.frozenRows,
          scrollLeft: s.scrollLeft,
          scrollTop: s.scrollTop,
          width: s.viewportWidth,
          height: s.viewportHeight,
        },
        vp,
      );
      input.ctx = surface.base;
      input.dpr = surface.backingWidth / s.viewportWidth;
      input.columns = s.columns;
      input.offsets = offsets;
      input.rows = rows;
      input.theme = resolved;
      input.getCell = getCell;
      input.wrapper = wrapper;
      input.autoHeight = variable !== null;
      const result =
        flags & Dirty.Base ? painter.paint(input) : painter.update(input, dirty.count > 0 ? dirty : undefined);
      dirty.count = 0;
      rows.commit();
      info.cellsPainted = result.cells;
      info.paint = result.mode;
      info.blitX = result.blitX;
      info.blitY = result.blitY;
    }
    if (canPaint && flags & Dirty.Overlay) {
      // Nothing to draw on the overlay yet; keep the layer clear.
      const o = surface.overlay;
      o.setTransform(1, 0, 0, 1, 0, 0);
      o.clearRect(0, 0, surface.overlayCanvas.width, surface.overlayCanvas.height);
    }
    if (variable) scheduleIdle();
    if (onFrame) {
      info.frame++;
      info.flags = flags;
      info.durationMs = performance.now() - t0;
      onFrame(info);
    }
  };

  const scheduler: Scheduler = createScheduler(run, options.frameSource);

  const unsubscribe = store.subscribe((next, prev) => {
    if (
      next.columns !== prev.columns ||
      next.rowCount !== prev.rowCount ||
      next.frozenColumns !== prev.frozenColumns ||
      next.frozenRows !== prev.frozenRows ||
      next.rowSizing !== prev.rowSizing ||
      next.theme !== prev.theme ||
      next.viewportWidth !== prev.viewportWidth ||
      next.viewportHeight !== prev.viewportHeight ||
      next.pixelRatio !== prev.pixelRatio
    ) {
      scheduler.mark(Dirty.All);
    } else if (next.scrollLeft !== prev.scrollLeft || next.scrollTop !== prev.scrollTop) {
      scheduler.mark(Dirty.Scroll | Dirty.Overlay);
    }
  });

  const addDirty = (row: number, col: number) => {
    // A changed wrapped cell can change its row's height.
    if (variable && row >= 0 && row < variable.count && (col < 0 || wrapped.includes(col))) variable.unset(row);
    if (dirty.count >= MAX_DIRTY_AREAS) {
      // Too many to paint piecemeal; a full repaint is cheaper.
      scheduler.mark(Dirty.Base);
      return;
    }
    dirty.cells[dirty.count * 2] = row;
    dirty.cells[dirty.count * 2 + 1] = col;
    dirty.count++;
    scheduler.mark(Dirty.Cells);
  };

  scheduler.mark(Dirty.All);

  // Text painted before a web font (or a lazily resolved system font) finishes loading would
  // otherwise stay in the fallback font, since scroll blitting reuses those pixels. Measurements
  // and row heights made with the fallback font are stale too.
  const fonts = (container.ownerDocument as Document & { fonts?: FontFaceSet }).fonts;
  const onFontsLoaded = () => {
    text.clear();
    wrapper?.clear();
    if (variable) heightsStale = true;
    painter.invalidate();
    scheduler.mark(Dirty.Base);
  };
  fonts?.addEventListener('loadingdone', onFontsLoaded);
  void fonts?.ready.then(() => {
    if (!destroyed) onFontsLoaded();
  });

  return {
    store,
    domLayer: surface.domLayer,
    element: surface.scroller,
    update(o) {
      if (o.getCell && o.getCell !== getCell) {
        getCell = o.getCell;
        if (variable) heightsStale = true;
        scheduler.mark(Dirty.Base);
      }
      if ('textWrapper' in o && (o.textWrapper ?? null) !== wrapper) {
        wrapper = o.textWrapper ?? null;
        if (variable) heightsStale = true;
        scheduler.mark(Dirty.Base);
      }
      if ('onFrame' in o) onFrame = o.onFrame;
      const patch: Partial<GridState> = {};
      if (o.columns) patch.columns = o.columns;
      if (o.rowCount !== undefined) patch.rowCount = o.rowCount;
      if (o.frozenColumns !== undefined) patch.frozenColumns = o.frozenColumns;
      if (o.frozenRows !== undefined) patch.frozenRows = o.frozenRows;
      if (o.rowSizing !== undefined) patch.rowSizing = o.rowSizing;
      if (o.theme && o.theme !== themePatch) {
        themePatch = o.theme;
        patch.theme = mergeTheme(defaultTheme, o.theme);
      }
      store.setState(patch);
    },
    invalidate() {
      if (variable) heightsStale = true;
      scheduler.mark(Dirty.Base);
    },
    invalidateCell(row, col) {
      addDirty(row, col);
    },
    invalidateCells(cells, count = Math.floor(cells.length / 2)) {
      for (let i = 0; i < count; i++) addDirty(cells[i * 2]!, cells[i * 2 + 1]!);
    },
    invalidateRows(start, end) {
      if (end - start > MAX_DIRTY_AREAS) {
        if (variable) for (let r = Math.max(0, start); r < Math.min(end, variable.count); r++) variable.unset(r);
        scheduler.mark(Dirty.Base);
        return;
      }
      for (let r = start; r < end; r++) addDirty(r, -1);
    },
    scrollTo({ left, top }) {
      if (left !== undefined) surface.scroller.scrollLeft = axisX.scrollTo(left);
      if (top !== undefined) surface.scroller.scrollTop = axisY.scrollTo(top);
      publishScroll();
    },
    scrollToRow(row) {
      const s = store.getSnapshot();
      const r = Math.max(0, Math.min(row, rows.count - 1));
      const top = rows.offsetOf(r) - rows.offsetOf(frozenRowsOf(s));
      surface.scroller.scrollTop = axisY.scrollTo(top);
      publishScroll();
    },
    visibleRows() {
      return { start: vp.rowStart, end: vp.rowEnd };
    },
    getRowBounds(row) {
      const s = store.getSnapshot();
      if (row < 0 || row >= rows.count) return null;
      const frozen = row < frozenRowsOf(s);
      const top = s.theme.headerHeight + rows.offsetOf(row) - (frozen ? 0 : s.scrollTop);
      const height = rows.heightOf(row);
      if (top + height <= (frozen ? s.theme.headerHeight : vp.bodyTop) || top >= s.viewportHeight) return null;
      return { top, height };
    },
    flush() {
      scheduler.flush();
    },
    destroy() {
      destroyed = true;
      fonts?.removeEventListener('loadingdone', onFontsLoaded);
      if (idleHandle) cancelRic(idleHandle);
      clearTimeout(resyncTimer);
      unsubscribe();
      scheduler.destroy();
      surface.destroy();
    },
  };
}
