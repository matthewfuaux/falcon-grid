import { selectionToClipboard } from './clipboard';
import { EMPTY_LIST, contentTop, regionAt, type CellEnv, type CellRegion, type CellTarget, type DisplayList } from './display';
import { ImageCache } from './images';
import { SpriteAtlas } from './sprites';
import { colX, createHit, hitTest, rowY } from './hittest';
import { attachInteraction, type InteractionHost } from './interaction';
import { buildColumnOffsets, computeViewport, createViewportRange } from './layout';
import { paintOverlay, type DragIndicator } from './overlay';
import { BasePainter, MAX_DIRTY_AREAS, type CellPaint, type DirtyCells, type PaintInput } from './painter';
import { FixedRows, VariableRows, type RowModel } from './rows';
import { ScrollAxis } from './scroll';
import { Dirty, createScheduler, type FrameSource, type Scheduler } from './scheduler';
import { clampRange } from './selection';
import { createStore, type Store } from './store';
import { createSurface, type Surface } from './surface';
import { TextMeasurer, type TextWrapper } from './text';
import { defaultTheme, mergeTheme, resolveTheme, type ResolvedTheme } from './theme';
import type { CellRange, CellRef, ColumnDef, FrameInfo, GetCell, GridEvents, GridState, RowSizing, Theme } from './types';

export interface GridOptions extends GridEvents {
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
  /**
   * Repaint the whole base layer, e.g. after the data was replaced. Auto row heights are
   * re-measured unless `remeasure` is false (only appearance changed), which also keeps the
   * scroll position exactly where it is.
   */
  invalidate(options?: { remeasure?: boolean }): void;
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
  /** Replace the selection. The active cell is left alone unless given. */
  setSelection(selection: readonly CellRange[], activeCell?: CellRef | null): void;
  /** Scroll the least distance that brings a cell fully into view (frozen axes don't scroll). */
  scrollToCell(row: number, col: number): void;
  /** A cell's rectangle relative to the grid's top-left corner, unclipped, or null if out of range. */
  getCellBounds(row: number, col: number): { x: number; y: number; width: number; height: number } | null;
  /** The selection as TSV and an HTML table (what Ctrl+C copies), or null if nothing is selected. */
  copySelection(): { text: string; html: string } | null;
  /** Give the grid keyboard focus. */
  focus(): void;
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
    selection: [],
    activeCell: null,
    hoverCell: null,
    focused: false,
    hoverTarget: null,
    pressedTarget: null,
  });
  const events: GridEvents = {};
  const EVENT_KEYS = [
    'onCellClick', 'onCellDoubleClick', 'onCellContextMenu', 'onHeaderClick',
    'onSelectionChange', 'onColumnResize', 'onColumnReorder',
  ] as const;
  const setEvents = (o: GridEvents) => {
    for (const k of EVENT_KEYS) if (k in o) (events as Record<string, unknown>)[k] = o[k];
  };
  setEvents(options);
  let drag: DragIndicator = { kind: 'none' };

  let offsets = buildColumnOffsets(options.columns);
  let offsetsFor: readonly ColumnDef[] = options.columns;
  let resolved: ResolvedTheme = resolveTheme(store.getSnapshot().theme);
  let resolvedFor: Theme = store.getSnapshot().theme;
  const vp = createViewportRange();
  const painter = new BasePainter();
  const text = new TextMeasurer();
  /** Layout environment for cell renderers; a new epoch makes their cached layouts stale. */
  const env: CellEnv = { theme: resolved, text, wrapper, epoch: 0 };
  const images = new ImageCache((cells) => {
    if (destroyed) return;
    if (!cells) scheduler.mark(Dirty.Base);
    else for (let i = 0; i + 1 < cells.length; i += 2) markCell(cells[i]!, cells[i + 1]!);
  });
  const sprites = new SpriteAtlas();
  const cellPaint: CellPaint = { env, images, sprites, hover: null, pressed: null };
  const info: FrameInfo = {
    frame: 0, flags: 0, durationMs: 0, cellsPainted: 0, paint: 'none', blitX: 0, blitY: 0, rowsMeasured: 0,
    overlay: false,
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
  /** Columns whose content decides row heights: wrapping text and cell renderers. */
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
    cells: cellPaint,
  };

  const contentWidth = () => offsets[offsets.length - 1]!;
  const contentHeight = (s: GridState) => s.theme.headerHeight + rows.total;
  const frozenRowsOf = (s: GridState) => Math.min(Math.max(0, s.frozenRows), rows.count);

  const viewportOf = (s: GridState, out: typeof vp) =>
    computeViewport(
      {
        offsets: currentOffsets(),
        rows,
        headerHeight: s.theme.headerHeight,
        frozenColumns: s.frozenColumns,
        frozenRows: s.frozenRows,
        scrollLeft: s.scrollLeft,
        scrollTop: s.scrollTop,
        width: s.viewportWidth,
        height: s.viewportHeight,
      },
      out,
    );

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
    let content = t.lineHeight;
    for (const c of wrapped) {
      const column = s.columns[c]!;
      const v = getCell(row, c, column);
      if (v == null || v === '') continue;
      const avail = offsets[c + 1]! - offsets[c]! - 2 * t.cellPaddingX;
      if (avail <= 0) continue;
      if (column.cell) {
        content = Math.max(content, column.cell.layout(v, avail, env).height);
      } else if (wrapper) {
        const n = wrapper.lineCount(typeof v === 'string' ? v : String(v), resolved.cellFont, avail);
        content = Math.max(content, n * t.lineHeight);
      }
    }
    return Math.max(t.rowHeight, Math.ceil(content - 1e-6) + 2 * t.cellPaddingY);
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
    s.columns.forEach((c, i) => (c.cell || c.wrap) && wrapped.push(i));
  };

  const wrappedWidthsChanged = (a: readonly ColumnDef[], b: readonly ColumnDef[]) => {
    if (a.length !== b.length) return true;
    for (let i = 0; i < a.length; i++) {
      const x = a[i]!;
      const y = b[i]!;
      const sized = x.wrap || y.wrap || x.cell || y.cell;
      if (sized && (x.wrap !== y.wrap || x.cell !== y.cell || x.width !== y.width || x.id !== y.id)) return true;
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
      env.theme = resolved;
      env.epoch++;
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
    info.overlay = false;
    const canPaint = s.viewportWidth > 0 && s.viewportHeight > 0 && surface.backingWidth > 0;
    if (canPaint && variable) {
      info.rowsMeasured = measureVisible();
      flags |= scheduler.consume();
      if (info.rowsMeasured > 0) flags |= Dirty.Scroll;
      s = store.getSnapshot();
    }
    if (canPaint && flags & (Dirty.Base | Dirty.Cells | Dirty.Scroll | Dirty.Overlay)) viewportOf(s, vp);
    if (canPaint && flags & (Dirty.Base | Dirty.Cells | Dirty.Scroll)) {
      input.ctx = surface.base;
      input.dpr = surface.backingWidth / s.viewportWidth;
      input.columns = s.columns;
      input.offsets = offsets;
      input.rows = rows;
      input.theme = resolved;
      input.getCell = getCell;
      input.wrapper = wrapper;
      input.autoHeight = variable !== null;
      cellPaint.hover = s.hoverTarget;
      cellPaint.pressed = s.pressedTarget;
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
      paintOverlay({
        ctx: surface.overlay,
        dpr: surface.backingWidth / s.viewportWidth,
        width: surface.overlayCanvas.width,
        height: surface.overlayCanvas.height,
        vp,
        offsets,
        rows,
        theme: s.theme,
        selection: s.selection,
        activeCell: s.activeCell,
        hoverCell: s.hoverCell,
        focused: s.focused,
        drag,
      });
      info.overlay = true;
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

  // ---- Interaction ----------------------------------------------------------------------------

  /** Column offsets for the columns in the store, even before the next layout. */
  const currentOffsets = () => {
    const s = store.getSnapshot();
    if (offsetsFor !== s.columns) {
      offsets = buildColumnOffsets(s.columns, offsets);
      offsetsFor = s.columns;
    }
    return offsets;
  };

  /** Viewport geometry from the store as it is now (pointer input runs between frames). */
  const liveVp = createViewportRange();
  const live = () => {
    viewportOf(store.getSnapshot(), liveVp);
    return liveVp;
  };
  const hit = createHit();

  const scrollToCell = (row: number, col: number) => {
    const s = store.getSnapshot();
    const v = live();
    const pos: { left?: number; top?: number } = {};
    if (col >= v.frozenColumns && col < s.columns.length) {
      const left = offsets[col]!;
      const right = offsets[col + 1]!;
      if (left - s.scrollLeft < v.frozenWidth) pos.left = left - v.frozenWidth;
      else if (right - s.scrollLeft > s.viewportWidth) pos.left = Math.min(left - v.frozenWidth, right - s.viewportWidth);
    }
    if (row >= v.frozenRows && row < rows.count) {
      const top = rows.offsetOf(row);
      const bottom = top + rows.heightOf(row);
      const frozenHeight = v.bodyTop - v.headerHeight;
      const visible = s.viewportHeight - s.theme.headerHeight;
      if (top - s.scrollTop < frozenHeight) pos.top = top - frozenHeight;
      else if (bottom - s.scrollTop > visible) pos.top = Math.min(top - frozenHeight, bottom - visible);
    }
    if (pos.left !== undefined || pos.top !== undefined) api.scrollTo(pos);
  };

  /** A cell's text as copied: its value, or its renderer's text for declarative cells. */
  const textOf = (row: number, col: number, column: ColumnDef): string => {
    const v = getCell(row, col, column);
    if (v == null) return '';
    return column.cell ? column.cell.text(v) : String(v);
  };

  /** A declarative cell's display list at its column's current width. */
  const listOf = (row: number, col: number, column: ColumnDef): DisplayList => {
    const v = getCell(row, col, column);
    if (v == null || !column.cell) return EMPTY_LIST;
    const avail = offsets[col + 1]! - offsets[col]! - 2 * resolved.cellPaddingX;
    return avail > 0 ? column.cell.layout(v, avail, env) : EMPTY_LIST;
  };

  /** The interactive region of a declarative cell under a viewport point, if any. */
  const targetAt = (row: number, col: number, x: number, y: number): { target: CellTarget; region: CellRegion } | null => {
    const column = store.getSnapshot().columns[col];
    if (!column?.cell || row < 0 || row >= rows.count) return null;
    const list = listOf(row, col, column);
    if (list.regions.length === 0) return null;
    const v = live();
    const left = colX(col, offsets, v) + resolved.cellPaddingX;
    const top = rowY(row, rows, v);
    const i = regionAt(list, x - left, y - top - contentTop(list.height, rows.heightOf(row), resolved, variable !== null));
    return i < 0 ? null : { target: { row, col, region: i }, region: list.regions[i]! };
  };

  const copySelection = () => {
    const s = store.getSnapshot();
    const a = s.activeCell;
    const source = s.selection.length > 0 ? s.selection : a ? [{ top: a.row, left: a.col, bottom: a.row, right: a.col }] : [];
    const ranges = source.map((r) => clampRange(r, s.rowCount, s.columns.length)).filter((r) => r !== null);
    return ranges.length > 0 ? selectionToClipboard(ranges, (r, c) => textOf(r, c, s.columns[c]!)) : null;
  };

  const host: InteractionHost = {
    element: surface.scroller,
    store,
    events,
    hitTest: (x, y) => hitTest(x, y, live(), offsets, rows, store.getSnapshot().columns, hit),
    viewport: () => ({ vp: live(), offsets, rows }),
    scrollBy(dx, dy) {
      const s = store.getSnapshot();
      api.scrollTo({ left: s.scrollLeft + dx, top: s.scrollTop + dy });
    },
    scrollCellIntoView: ({ row, col }) => scrollToCell(row, col),
    setDrag(d) {
      drag = d;
      scheduler.mark(Dirty.Overlay);
    },
    resizeColumn(col, width, event) {
      const columns = store.getSnapshot().columns.slice();
      const column = { ...columns[col]!, width };
      columns[col] = column;
      store.setState({ columns });
      events.onColumnResize?.({ col, column, width, event });
    },
    moveColumn(from, to, event) {
      const columns = store.getSnapshot().columns.slice();
      const [column] = columns.splice(from, 1);
      columns.splice(to, 0, column!);
      store.setState({ columns });
      events.onColumnReorder?.({ from, to, column: column!, event });
    },
    autoFitWidth(col) {
      const s = store.getSnapshot();
      const v = live();
      const column = s.columns[col]!;
      const t = resolveTheme(s.theme);
      let w = text.width(column.title ?? column.id, t.headerFont);
      const measure = (r: number) => {
        if (column.cell) {
          w = Math.max(w, listOf(r, col, column).width);
          return;
        }
        const val = getCell(r, col, column);
        if (val != null && val !== '') w = Math.max(w, text.width(String(val), t.cellFont));
      };
      for (let r = 0; r < v.frozenRows; r++) measure(r);
      for (let r = v.rowStart; r < v.rowEnd; r++) measure(r);
      return Math.ceil(w + 2 * t.cellPaddingX + 1);
    },
    copy: copySelection,
    targetAt,
    activate(target, event) {
      const column = store.getSnapshot().columns[target.col];
      if (!column) return;
      const region = listOf(target.row, target.col, column).regions[target.region];
      region?.onClick?.({ row: target.row, col: target.col, column, event });
    },
  };
  surface.scroller.tabIndex = 0;
  surface.scroller.style.outline = 'none';
  const detachInteraction = attachInteraction(host);

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
    } else if (
      next.selection !== prev.selection ||
      next.activeCell !== prev.activeCell ||
      next.hoverCell !== prev.hoverCell ||
      next.focused !== prev.focused
    ) {
      scheduler.mark(Dirty.Overlay);
    }
    // Hovered and pressed regions restyle their cell on the base layer.
    if (next.hoverTarget !== prev.hoverTarget || next.pressedTarget !== prev.pressedTarget) {
      const ts = [prev.hoverTarget, next.hoverTarget, prev.pressedTarget, next.pressedTarget];
      ts.forEach((t, i) => {
        // Once per cell: moving between two buttons in one cell repaints it once.
        if (t && !ts.slice(0, i).some((u) => u && u.row === t.row && u.col === t.col)) markCell(t.row, t.col);
      });
    }
  });

  /** The data of a cell (or, with col -1, a row) changed. */
  const addDirty = (row: number, col: number) => {
    // A changed wrapped cell can change its row's height.
    if (variable && row >= 0 && row < variable.count && (col < 0 || wrapped.includes(col))) variable.unset(row);
    // Values changed in place keep their identity: drop layouts cached for them.
    const columns = store.getSnapshot().columns;
    if (row >= 0 && row < rows.count) {
      for (let c = col < 0 ? 0 : col, end = col < 0 ? columns.length : col + 1; c < end; c++) {
        const column = columns[c];
        if (column?.cell?.forget) {
          const v = getCell(row, c, column);
          if (v != null) column.cell.forget(v);
        }
      }
    }
    markCell(row, col);
  };

  /** Repaint a cell (col -1: a row) on the next frame, without touching its data or height. */
  function markCell(row: number, col: number) {
    if (dirty.count >= MAX_DIRTY_AREAS) {
      // Too many to paint piecemeal; a full repaint is cheaper.
      scheduler.mark(Dirty.Base);
      return;
    }
    dirty.cells[dirty.count * 2] = row;
    dirty.cells[dirty.count * 2 + 1] = col;
    dirty.count++;
    scheduler.mark(Dirty.Cells);
  }

  scheduler.mark(Dirty.All);

  // Text painted before a web font (or a lazily resolved system font) finishes loading would
  // otherwise stay in the fallback font, since scroll blitting reuses those pixels. Measurements
  // and row heights made with the fallback font are stale too.
  const fonts = (container.ownerDocument as Document & { fonts?: FontFaceSet }).fonts;
  const onFontsLoaded = () => {
    text.clear();
    wrapper?.clear();
    env.epoch++;
    if (variable) heightsStale = true;
    painter.invalidate();
    scheduler.mark(Dirty.Base);
  };
  fonts?.addEventListener('loadingdone', onFontsLoaded);
  void fonts?.ready.then(() => {
    if (!destroyed) onFontsLoaded();
  });

  const api: Grid = {
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
        env.wrapper = wrapper;
        env.epoch++;
        if (variable) heightsStale = true;
        scheduler.mark(Dirty.Base);
      }
      if ('onFrame' in o) onFrame = o.onFrame;
      setEvents(o);
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
    invalidate(o) {
      if (variable && o?.remeasure !== false) heightsStale = true;
      env.epoch++;
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
    setSelection(selection, activeCell) {
      store.setState(activeCell === undefined ? { selection } : { selection, activeCell });
    },
    scrollToCell,
    getCellBounds(row, col) {
      const s = store.getSnapshot();
      if (row < 0 || row >= rows.count || col < 0 || col >= s.columns.length) return null;
      const v = live();
      return { x: colX(col, offsets, v), y: rowY(row, rows, v), width: offsets[col + 1]! - offsets[col]!, height: rows.heightOf(row) };
    },
    copySelection,
    focus() {
      surface.scroller.focus({ preventScroll: true });
    },
    flush() {
      scheduler.flush();
    },
    destroy() {
      destroyed = true;
      detachInteraction();
      fonts?.removeEventListener('loadingdone', onFontsLoaded);
      if (idleHandle) cancelRic(idleHandle);
      clearTimeout(resyncTimer);
      unsubscribe();
      images.destroy();
      sprites.clear();
      scheduler.destroy();
      surface.destroy();
    },
  };
  return api;
}
