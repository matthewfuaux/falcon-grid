import { createMirror, type Mirror } from './a11y';
import { selectionToClipboard } from './clipboard';
import { EMPTY_LIST, contentTop, regionAt, type CellEnv, type CellRegion, type CellTarget, type DisplayList } from './display';
import { ImageCache } from './images';
import { SpriteAtlas } from './sprites';
import { colX, createHit, hitTest, rowY } from './hittest';
import { attachInteraction, type InteractionHost } from './interaction';
import { buildColumnOffsets, computeViewport, createViewportRange } from './layout';
import { paintOverlay, type DragIndicator } from './overlay';
import type { GridPlugin, GridPluginFactory, GridPluginHost } from './plugin';
import { BasePainter, MAX_DIRTY_AREAS, type CellPaint, type DirtyCells, type PaintInput } from './painter';
import { FixedRows, VariableRows, type RowModel } from './rows';
import { ScrollAxis } from './scroll';
import { Dirty, createScheduler, type FrameSource, type Scheduler } from './scheduler';
import { clampRange, rangeOf } from './selection';
import { createStore, type Store } from './store';
import { createSurface, type Surface } from './surface';
import { TextMeasurer, type TextWrapper } from './text';
import { defaultTheme, forcedColorsTheme, highContrastTheme, mergeTheme, resolveTheme, scaleTheme, type ResolvedTheme } from './theme';
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
  /**
   * The owner applies selection changes: clicks and keys fire `onSelectionChange` but leave the
   * selection alone until `setSelection` is called (as a controlled React component does).
   */
  controlledSelection?: boolean;
  /**
   * The owner applies column changes: resizing and reordering fire `onColumnResize` and
   * `onColumnReorder` but leave the columns alone until `update({ columns })` is called.
   */
  controlledColumns?: boolean;
  /** Accessible name of the grid (its `aria-label`), or the id of an element naming it. */
  ariaLabel?: string;
  ariaLabelledBy?: string;
  /**
   * Follow the user's display settings (default true): `prefers-contrast: more` applies
   * `highContrastTheme` under your theme, and `forced-colors: active` paints with the system
   * colours over it.
   */
  respectUserPreferences?: boolean;
  /**
   * Scale theme sizes (font, padding, row and header height) with the root font size, so the
   * browser's text size setting applies (default true). Sizes are as at a 16px root.
   */
  scaleWithRootFont?: boolean;
  /**
   * Keep the view pinned to the bottom while it is scrolled to the bottom: new rows and growing
   * rows push the content up instead of extending below. For chat, logs and feeds.
   */
  stickToBottom?: boolean;
  /** Extensions such as the list's sticky headers and text selection. Fixed at creation. */
  plugins?: readonly GridPluginFactory[];
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
  update(options: Partial<Omit<GridOptions, 'frameSource' | 'plugins'>>): void;
  /** Read the latest state; `store.subscribe` to be told when it changes. */
  getState(): GridState;
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
  /**
   * `count` rows were inserted before `index` in the data (e.g. older messages prepended). Grows
   * the row count, moves measured heights and the selection with their rows, and keeps the
   * content on screen still.
   */
  insertRows(index: number, count: number): void;
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
  /**
   * The scrolling body: the visible area outside the header, frozen rows and frozen columns,
   * relative to the grid's top-left corner. Content over scrolling cells is clipped to it.
   */
  getBodyRect(): { x: number; y: number; width: number; height: number };
  /** A cell's rectangle relative to the grid's top-left corner, unclipped, or null if out of range. */
  getCellBounds(row: number, col: number): { x: number; y: number; width: number; height: number } | null;
  /** The selection as TSV and an HTML table (what Ctrl+C copies), or null if nothing is selected. */
  copySelection(): { text: string; html: string } | null;
  /** Give the grid keyboard focus (on the active cell). */
  focus(): void;
  /**
   * Whether a key event's target is the grid itself (its active cell) rather than something
   * inside it like an in-cell control or an editor. Handle grid keys only for these.
   */
  isKeyTarget(target: EventTarget | null): boolean;
  /**
   * Highlights cells whose text contains `query` (null clears). Browser find-in-page cannot see
   * canvas text, so this is the replacement: wire it to your own search box.
   */
  setSearch(query: string | null, options?: { caseSensitive?: boolean }): void;
  /**
   * Moves the active cell to the next match after it (or before, `backwards`), scanning in
   * slices so the page stays responsive. Resolves to the cell, or null if nothing matches or a
   * newer search replaced this one.
   */
  findNext(options?: { backwards?: boolean }): Promise<CellRef | null>;
  /** Says something through the grid's polite live region. */
  announce(message: string): void;
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

/** The state a grid starts in, before it is laid out. Also a stand-in until a grid exists. */
export function initialGridState(o: Partial<Pick<GridOptions, 'columns' | 'rowCount' | 'frozenColumns' | 'frozenRows' | 'rowSizing' | 'theme'>> = {}): GridState {
  return {
    columns: o.columns ?? [],
    rowCount: o.rowCount ?? 0,
    frozenColumns: o.frozenColumns ?? 0,
    frozenRows: o.frozenRows ?? 0,
    rowSizing: o.rowSizing ?? 'fixed',
    scrollLeft: 0,
    scrollTop: 0,
    viewportWidth: 0,
    viewportHeight: 0,
    pixelRatio: 1,
    theme: mergeTheme(defaultTheme, o.theme),
    selection: [],
    activeCell: null,
    hoverCell: null,
    focused: false,
    hoverTarget: null,
    pressedTarget: null,
    focusTarget: null,
  };
}

export function createGrid(container: HTMLElement, options: GridOptions): Grid {
  let getCell = options.getCell;
  let onFrame = options.onFrame;
  let themePatch = options.theme;
  let wrapper: TextWrapper | null = options.textWrapper ?? null;

  const doc = container.ownerDocument;
  const win = doc.defaultView;
  let prefs = options.respectUserPreferences !== false;
  let scaleFont = options.scaleWithRootFont !== false;
  const media = (q: string) => win?.matchMedia?.(q) ?? null;
  const contrastMQ = media('(prefers-contrast: more)');
  const forcedMQ = media('(forced-colors: active)');
  const rootScale = () => (win ? parseFloat(win.getComputedStyle(doc.documentElement).fontSize) / 16 || 1 : 1);
  let scale = rootScale();
  /** Default, high contrast, your theme, forced colours, then root font scaling. */
  const effectiveTheme = (): Theme => {
    let t = prefs && contrastMQ?.matches ? mergeTheme(defaultTheme, highContrastTheme) : defaultTheme;
    t = mergeTheme(t, themePatch);
    if (prefs && forcedMQ?.matches) t = mergeTheme(t, forcedColorsTheme(doc));
    return scaleTheme(t, scaleFont ? scale : 1);
  };

  const initial = initialGridState(options);
  initial.theme = effectiveTheme();
  const store = createStore<GridState>(initial);
  const applyTheme = () => store.setState({ theme: effectiveTheme() });
  contrastMQ?.addEventListener?.('change', applyTheme);
  forcedMQ?.addEventListener?.('change', applyTheme);
  const events: GridEvents = {};
  const controlled = { selection: options.controlledSelection === true, columns: options.controlledColumns === true };
  const EVENT_KEYS = [
    'onCellClick', 'onCellDoubleClick', 'onCellContextMenu', 'onHeaderClick',
    'onSelectionChange', 'onColumnResize', 'onColumnReorder',
  ] as const;
  const setEvents = (o: GridEvents) => {
    for (const k of EVENT_KEYS) if (k in o) (events as Record<string, unknown>)[k] = o[k];
  };
  setEvents(options);
  let drag: DragIndicator = { kind: 'none' };
  let plugins: GridPlugin[] = [];

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

  /**
   * Whether the scroller is at its bottom. Read from the DOM, which is the truth even while the
   * axes still hold an older viewport size (the first layout runs before the scroller is sized).
   */
  const atBottom = () => {
    const el = surface.scroller;
    return el.scrollTop >= el.scrollHeight - el.clientHeight - 1;
  };

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
      if (stick) pinned = atBottom();
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
  /** Captured ahead of a change that moves rows (an insert); the next layout keeps it. */
  let anchorHeld = false;
  let stick = options.stickToBottom === true;
  /** Scrolled to the bottom with `stickToBottom`: the view follows the bottom. */
  let pinned = stick;
  const captureAnchor = (s: GridState) => {
    if (anchorHeld) return;
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
    if (pinned) target = axisY.virtualMax;
    else if (!anchor.atTop && rows.count > 0) {
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
    if (variable || pinned || anchorHeld) restoreAnchor();
    anchorHeld = false;
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
    // Matches depend on what is on screen and on the data.
    if (search && flags & (Dirty.Base | Dirty.Cells | Dirty.Scroll)) {
      flags |= Dirty.Overlay;
      if (canPaint) viewportOf(s, vp);
    }
    if (canPaint && flags & Dirty.Overlay) {
      collectMatches(s);
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
        matches,
        focusRect: focusRectOf(s),
      });
      const o = surface.overlay;
      for (const p of plugins) {
        if (!p.paintOverlay) continue;
        o.setTransform(input.dpr, 0, 0, input.dpr, 0, 0);
        o.save();
        p.paintOverlay(o);
        o.restore();
      }
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

  /** What a screen reader reads for a cell. */
  const accessibleText = (row: number, col: number, column: ColumnDef): string => {
    const v = getCell(row, col, column);
    if (v == null) return '';
    const c = column.cell;
    return c ? (c.accessibleText ? c.accessibleText(v) : c.text(v)) : String(v);
  };

  const cellBounds = (row: number, col: number) => {
    const s = store.getSnapshot();
    if (row < 0 || row >= rows.count || col < 0 || col >= s.columns.length) return null;
    const v = live();
    return { x: colX(col, offsets, v), y: rowY(row, rows, v), width: offsets[col + 1]! - offsets[col]!, height: rows.heightOf(row) };
  };

  /** A user's selection change: applied unless controlled, and reported. */
  const userSelect = (selection: readonly CellRange[], activeCell: CellRef | null, event: Event) => {
    if (!controlled.selection) store.setState({ selection, activeCell });
    events.onSelectionChange?.({ selection, activeCell, event });
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
    for (const p of plugins) {
      const d = p.copy?.();
      if (d) return d;
    }
    const s = store.getSnapshot();
    const a = s.activeCell;
    const source = s.selection.length > 0 ? s.selection : a ? [{ top: a.row, left: a.col, bottom: a.row, right: a.col }] : [];
    const ranges = source.map((r) => clampRange(r, s.rowCount, s.columns.length)).filter((r) => r !== null);
    return ranges.length > 0 ? selectionToClipboard(ranges, (r, c) => textOf(r, c, s.columns[c]!)) : null;
  };

  const host: InteractionHost = {
    element: surface.scroller,
    domLayer: surface.domLayer,
    controlledSelection: () => controlled.selection,
    store,
    events,
    hitTest(x, y) {
      hitTest(x, y, live(), offsets, rows, store.getSnapshot().columns, hit);
      for (const p of plugins) p.hitTest?.(x, y, hit);
      return hit;
    },
    plugins: [],
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
      if (!controlled.columns) store.setState({ columns });
      events.onColumnResize?.({ col, column, width, event });
    },
    moveColumn(from, to, event) {
      const columns = store.getSnapshot().columns.slice();
      const [column] = columns.splice(from, 1);
      columns.splice(to, 0, column!);
      if (!controlled.columns) store.setState({ columns });
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
    isKeyTarget: (t) => mirror.isKeyTarget(t),
    ownsFocus: (t) => mirror.owns(t),
    focus: () => mirror.focus(),
    controls: (cell) => mirror.controls(cell),
    focusControl: (cell) => mirror.focusControl(cell),
    announce: (m) => mirror.announce(m),
  };
  // A tab stop until the mirror's first sync hands it to the active cell; focus that lands here
  // moves on to the cell (see `onFocusIn`).
  surface.scroller.tabIndex = 0;
  surface.scroller.style.outline = 'none';
  const mirror: Mirror = createMirror({
    element: surface.scroller,
    layer: surface.domLayer,
    store,
    window: live,
    text: (r, c) => accessibleText(r, c, store.getSnapshot().columns[c]!),
    regions: (r, c) => listOf(r, c, store.getSnapshot().columns[c]!).regions,
    bounds: cellBounds,
    activate: (t, e) => host.activate(t, e),
    select: (cell, event) => userSelect([rangeOf(cell, cell)], cell, event),
    headerClick: (col, event) => events.onHeaderClick?.({ col, column: store.getSnapshot().columns[col]!, event }),
    contextMenu: (cell, event) =>
      events.onCellContextMenu?.({ ...cell, column: store.getSnapshot().columns[cell.col]!, event }),
  });
  mirror.setLabel(options.ariaLabel, options.ariaLabelledBy);

  // ---- Plugins ------------------------------------------------------------------------------

  const bandVp = createViewportRange();
  const bandInput: PaintInput = { ...input, vp: bandVp };
  const pluginHost: GridPluginHost = {
    store,
    element: surface.scroller,
    viewport: host.viewport,
    getCell: (r, c) => getCell(r, c, store.getSnapshot().columns[c]!),
    theme: () => resolved,
    text,
    wrapper: () => wrapper,
    autoHeight: () => variable !== null,
    displayList: (r, c) => listOf(r, c, store.getSnapshot().columns[c]!),
    paintRow(ctx, row, top, clipTop) {
      const s = store.getSnapshot();
      if (row < 0 || row >= rows.count || surface.backingWidth <= 0) return;
      computeViewport(
        {
          offsets, rows, headerHeight: s.theme.headerHeight, frozenColumns: s.frozenColumns, frozenRows: s.frozenRows,
          scrollLeft: s.scrollLeft, scrollTop: s.theme.headerHeight + rows.offsetOf(row) - top,
          width: s.viewportWidth, height: s.viewportHeight,
        },
        bandVp,
      );
      Object.assign(bandInput, input, { ctx, vp: bandVp });
      painter.paintBand(bandInput, Math.max(top, clipTop), top + rows.heightOf(row));
    },
    invalidateOverlay: () => scheduler.mark(Dirty.Overlay),
    scrollBy: host.scrollBy,
  };
  plugins = (options.plugins ?? []).map((f) => f(pluginHost));
  host.plugins = plugins;
  const detachInteraction = attachInteraction(host);

  // The browser's text size setting changes the root font size; a 1rem probe notices.
  const remProbe = doc.createElement('div');
  remProbe.style.cssText = 'position:absolute;width:1rem;height:0;visibility:hidden;';
  surface.domLayer.append(remProbe);
  const remObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    const next = rootScale();
    if (next !== scale) {
      scale = next;
      applyTheme();
    }
  });
  remObserver?.observe(remProbe);

  // ---- Search -----------------------------------------------------------------------------------

  let search: { q: string; cs: boolean } | null = null;
  let findToken = 0;
  /** Matching visible cells as [row, col] pairs, rebuilt with the overlay. */
  const matches: number[] = [];
  const isMatch = (row: number, col: number, column: ColumnDef) => {
    const t = textOf(row, col, column);
    return search!.cs ? t.includes(search!.q) : t.toLowerCase().includes(search!.q);
  };
  const collectMatches = (s: GridState) => {
    matches.length = 0;
    if (!search) return;
    const n = Math.min(vp.frozenColumns, s.columns.length);
    const visit = (r: number) => {
      for (let c = 0; c < n; c++) if (isMatch(r, c, s.columns[c]!)) matches.push(r, c);
      for (let c = Math.max(vp.colStart, n); c < vp.colEnd; c++) if (isMatch(r, c, s.columns[c]!)) matches.push(r, c);
    };
    for (let r = 0; r < vp.frozenRows; r++) visit(r);
    for (let r = Math.max(vp.rowStart, vp.frozenRows); r < vp.rowEnd; r++) visit(r);
  };

  /** The rectangle of the in-cell control with keyboard focus, in viewport CSS pixels. */
  const focusRectOf = (s: GridState) => {
    const t = s.focusTarget;
    const column = t && s.columns[t.col];
    if (!t || !column || t.row >= rows.count) return null;
    const list = listOf(t.row, t.col, column);
    const r = list.regions[t.region];
    if (!r) return null;
    const x = colX(t.col, offsets, vp) + resolved.cellPaddingX + r.x;
    const y = rowY(t.row, rows, vp) + contentTop(list.height, rows.heightOf(t.row), resolved, variable !== null) + r.y;
    return { x, y, w: r.w, h: r.h };
  };

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
      next.focused !== prev.focused ||
      next.focusTarget !== prev.focusTarget
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
    scheduler.mark(plugins.length > 0 ? Dirty.Cells | Dirty.Overlay : Dirty.Cells);
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
    getState: () => store.getSnapshot(),
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
      if (o.stickToBottom !== undefined && o.stickToBottom !== stick) {
        stick = o.stickToBottom;
        pinned = stick && atBottom();
      }
      if (o.controlledSelection !== undefined) controlled.selection = o.controlledSelection;
      if (o.controlledColumns !== undefined) controlled.columns = o.controlledColumns;
      setEvents(o);
      const patch: Partial<GridState> = {};
      if (o.columns) patch.columns = o.columns;
      if (o.rowCount !== undefined) patch.rowCount = o.rowCount;
      if (o.frozenColumns !== undefined) patch.frozenColumns = o.frozenColumns;
      if (o.frozenRows !== undefined) patch.frozenRows = o.frozenRows;
      if (o.rowSizing !== undefined) patch.rowSizing = o.rowSizing;
      let themeChanged = false;
      if (o.theme && o.theme !== themePatch) {
        themePatch = o.theme;
        themeChanged = true;
      }
      if (o.respectUserPreferences !== undefined && o.respectUserPreferences !== prefs) {
        prefs = o.respectUserPreferences;
        themeChanged = true;
      }
      if (o.scaleWithRootFont !== undefined && o.scaleWithRootFont !== scaleFont) {
        scaleFont = o.scaleWithRootFont;
        themeChanged = true;
      }
      if (themeChanged) patch.theme = effectiveTheme();
      if ('ariaLabel' in o || 'ariaLabelledBy' in o) mirror.setLabel(o.ariaLabel, o.ariaLabelledBy);
      store.setState(patch);
    },
    invalidate(o) {
      if (variable && o?.remeasure !== false) heightsStale = true;
      env.epoch++;
      scheduler.mark(Dirty.Base);
      mirror.schedule();
    },
    invalidateCell(row, col) {
      addDirty(row, col);
      mirror.schedule();
    },
    invalidateCells(cells, count = Math.floor(cells.length / 2)) {
      for (let i = 0; i < count; i++) addDirty(cells[i * 2]!, cells[i * 2 + 1]!);
      mirror.schedule();
    },
    invalidateRows(start, end) {
      mirror.schedule();
      if (end - start > MAX_DIRTY_AREAS) {
        if (variable) for (let r = Math.max(0, start); r < Math.min(end, variable.count); r++) variable.unset(r);
        scheduler.mark(Dirty.Base);
        return;
      }
      for (let r = start; r < end; r++) addDirty(r, -1);
    },
    insertRows(index, count) {
      const s = store.getSnapshot();
      if (count <= 0 || index < 0 || index > s.rowCount) return;
      // Keep the content on screen: anchor before the rows move (even at the top, so prepended
      // rows appear above), then shift the anchor with its row.
      if (anchorHeld) {
        // A second insert before the next layout: the anchor is already taken.
        if (!anchor.atTop && anchor.row >= index) anchor.row += count;
      } else if (rows.count > 0) {
        const p = s.scrollTop + rows.offsetOf(frozenRowsOf(s));
        anchor.atTop = false;
        anchor.row = rows.rowAt(p);
        anchor.delta = p - rows.offsetOf(anchor.row);
        if (anchor.row >= index) anchor.row += count;
      } else anchor.atTop = true;
      anchorHeld = true;
      variable?.insert(index, count);
      const shift = (r: number) => (r >= index ? r + count : r);
      const selection = s.selection.map((r) =>
        r.bottom < index ? r : { ...r, top: shift(r.top), bottom: r.bottom + count },
      );
      const a = s.activeCell;
      store.setState({
        rowCount: s.rowCount + count,
        selection,
        activeCell: a && a.row >= index ? { row: a.row + count, col: a.col } : a,
        hoverCell: null,
        hoverTarget: null,
      });
      mirror.schedule();
    },
    scrollTo({ left, top }) {
      if (left !== undefined) surface.scroller.scrollLeft = axisX.scrollTo(left);
      if (top !== undefined) surface.scroller.scrollTop = axisY.scrollTo(top);
      if (stick) pinned = atBottom();
      publishScroll();
    },
    scrollToRow(row) {
      const s = store.getSnapshot();
      const r = Math.max(0, Math.min(row, rows.count - 1));
      const top = rows.offsetOf(r) - rows.offsetOf(frozenRowsOf(s));
      surface.scroller.scrollTop = axisY.scrollTo(top);
      if (stick) pinned = atBottom();
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
    getBodyRect() {
      const v = live();
      return { x: v.frozenWidth, y: v.bodyTop, width: Math.max(0, v.width - v.frozenWidth), height: Math.max(0, v.height - v.bodyTop) };
    },
    getCellBounds: cellBounds,
    copySelection,
    focus() {
      mirror.focus();
    },
    isKeyTarget: (t) => mirror.isKeyTarget(t),
    setSearch(query, o) {
      search = query ? { q: o?.caseSensitive ? query : query.toLowerCase(), cs: o?.caseSensitive === true } : null;
      findToken++;
      scheduler.mark(Dirty.Overlay);
    },
    findNext(o) {
      const token = ++findToken;
      const s0 = store.getSnapshot();
      const cols = s0.columns.length;
      const total = s0.rowCount * cols;
      if (!search || total === 0) return Promise.resolve(null);
      const back = o?.backwards === true;
      const a = s0.activeCell;
      const start = a ? a.row * cols + a.col : back ? 0 : -1;
      let i = 1;
      return new Promise((resolve) => {
        const step = () => {
          if (token !== findToken || destroyed || !search) return resolve(null);
          const t0 = performance.now();
          const columns = store.getSnapshot().columns;
          while (i <= total) {
            const idx = (((start + (back ? -i : i)) % total) + total) % total;
            i++;
            const row = Math.floor(idx / cols);
            const col = idx % cols;
            const column = columns[col];
            if (column && isMatch(row, col, column)) {
              const cell = { row, col };
              userSelect([rangeOf(cell, cell)], cell, new Event('find'));
              scrollToCell(row, col);
              return resolve(cell);
            }
            if ((i & 1023) === 0 && performance.now() - t0 > 8) {
              setTimeout(step, 0);
              return;
            }
          }
          resolve(null);
        };
        step();
      });
    },
    announce: (m) => mirror.announce(m),
    flush() {
      scheduler.flush();
    },
    destroy() {
      destroyed = true;
      findToken++;
      detachInteraction();
      for (const p of plugins) p.destroy?.();
      mirror.destroy();
      remObserver?.disconnect();
      contrastMQ?.removeEventListener?.('change', applyTheme);
      forcedMQ?.removeEventListener?.('change', applyTheme);
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
