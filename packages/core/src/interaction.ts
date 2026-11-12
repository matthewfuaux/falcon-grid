import { colX, type Hit } from './hittest';
import type { ViewportRange } from './layout';
import type { RowModel } from './rows';
import type { DragIndicator } from './overlay';
import {
  allCells,
  colRange,
  extendRange,
  extentOf,
  moveCell,
  rangeOf,
  rowRange,
  selectionContains,
  tabCell,
  type GridDims,
} from './selection';
import type { CellRegion, CellTarget } from './display';
import type { Store } from './store';
import type { CellRange, CellRef, ColumnDef, GridEvents, GridState } from './types';

/** What the interaction layer needs from the grid. */
export interface InteractionHost {
  element: HTMLElement;
  store: Store<GridState>;
  events: GridEvents;
  /** Hit-tests a point in viewport CSS pixels against the current geometry. */
  hitTest(x: number, y: number): Hit;
  /** The current viewport geometry, recomputed from the store. */
  viewport(): { vp: ViewportRange; offsets: Float64Array; rows: RowModel };
  scrollBy(dx: number, dy: number): void;
  scrollCellIntoView(cell: CellRef): void;
  setDrag(d: DragIndicator): void;
  resizeColumn(col: number, width: number, event: Event): void;
  moveColumn(from: number, to: number, event: Event): void;
  /** Width that fits the column's header and the cells on screen. */
  autoFitWidth(col: number): number;
  copy(): { text: string; html: string } | null;
  /** The interactive region of a declarative cell under a viewport point. */
  targetAt(row: number, col: number, x: number, y: number): { target: CellTarget; region: CellRegion } | null;
  /** Runs a region's click handler. */
  activate(target: CellTarget, event: Event): void;
}

/** Pointer travel before a header press becomes a column drag, in CSS pixels. */
const DRAG_THRESHOLD = 5;
/** Distance from an edge, in CSS pixels, where dragging starts to auto-scroll. */
const EDGE = 24;

type Mode =
  | { kind: 'none' }
  | { kind: 'select' }
  | { kind: 'resize'; col: number; startX: number; startWidth: number }
  | { kind: 'header'; col: number; startX: number }
  | { kind: 'reorder'; col: number; drop: number }
  /** A clickable cell region is held down. */
  | { kind: 'press'; target: CellTarget };

const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']);

const sameRanges = (a: readonly CellRange[], b: readonly CellRange[]) =>
  a.length === b.length &&
  a.every((r, i) => r.top === b[i]!.top && r.left === b[i]!.left && r.bottom === b[i]!.bottom && r.right === b[i]!.right);

const sameTarget = (a: CellTarget | null, b: CellTarget | null) =>
  a === b || (a !== null && b !== null && a.row === b.row && a.col === b.col && a.region === b.region);

const clampWidth = (c: ColumnDef, w: number) => Math.round(Math.min(c.maxWidth ?? 2000, Math.max(c.minWidth ?? 32, w)));

/**
 * Pointer, keyboard and clipboard handling. Everything it changes goes through the store
 * (selection, active cell, hover, focus) or the host (columns, scrolling, drag indicators),
 * so the overlay repaints and the base layer is left alone.
 */
export function attachInteraction(host: InteractionHost): () => void {
  const el = host.element;
  const { store } = host;
  const doc = el.ownerDocument;
  const win = doc.defaultView ?? window;
  let mode: Mode = { kind: 'none' };
  let pointerType = 'mouse';
  let dragged = false;
  let lastX = 0;
  let lastY = 0;
  let inside = false;
  let autoScroll = 0;

  const point = (e: MouseEvent) => {
    const r = el.getBoundingClientRect();
    lastX = e.clientX - r.left - el.clientLeft;
    lastY = e.clientY - r.top - el.clientTop;
  };

  const dims = (): GridDims => {
    const s = store.getSnapshot();
    const { vp } = host.viewport();
    return { rows: s.rowCount, cols: s.columns.length, page: Math.max(1, vp.rowEnd - vp.rowStart - 2) };
  };

  /** Applies a user selection change and notifies. */
  const select = (selection: readonly CellRange[], activeCell: CellRef | null, event: Event) => {
    const s = store.getSnapshot();
    const sameActive =
      s.activeCell === activeCell ||
      (s.activeCell && activeCell && s.activeCell.row === activeCell.row && s.activeCell.col === activeCell.col);
    if (sameActive && sameRanges(s.selection, selection)) return;
    store.setState({ selection, activeCell });
    host.events.onSelectionChange?.({ selection, activeCell, event });
  };

  const setHover = (cell: CellRef | null) => {
    const h = store.getSnapshot().hoverCell;
    if (h === cell || (h && cell && h.row === cell.row && h.col === cell.col)) return;
    store.setState({ hoverCell: cell });
  };

  const setCursor = (c: string) => {
    if (el.style.cursor !== c) el.style.cursor = c;
  };

  const setTitle = (t: string) => {
    if (el.title !== t) el.title = t;
  };

  /** Hovers the interactive region under a point (or none); returns it. */
  const hoverTargetAt = (x: number, y: number, hit: Hit) => {
    const t = hit.region === 'cell' ? host.targetAt(hit.row, hit.col, x, y) : null;
    if (!sameTarget(store.getSnapshot().hoverTarget, t?.target ?? null)) store.setState({ hoverTarget: t?.target ?? null });
    return t;
  };

  const hoverAt = (x: number, y: number) => {
    const hit = host.hitTest(x, y);
    const t = hoverTargetAt(x, y, hit);
    const r = t?.region;
    setCursor(hit.region === 'resize' ? 'col-resize' : r ? (r.cursor ?? (r.onClick ? 'pointer' : '')) : '');
    setTitle(r?.tooltip ?? '');
    setHover(hit.region === 'cell' ? { row: hit.row, col: hit.col } : hit.region === 'header' ? { row: -1, col: hit.col } : null);
  };

  // ---- Selection by pointer ------------------------------------------------------------------

  const pressCell = (cell: CellRef, e: PointerEvent | MouseEvent) => {
    const s = store.getSnapshot();
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.shiftKey && s.activeCell && s.selection.length > 0) {
      const ranges = s.selection.slice();
      ranges[ranges.length - 1] = extendRange(ranges[ranges.length - 1]!, s.activeCell, cell, dims());
      select(ranges, s.activeCell, e);
    } else if (ctrl) {
      select([...s.selection, rangeOf(cell, cell)], cell, e);
    } else {
      select([rangeOf(cell, cell)], cell, e);
    }
  };

  const pressHeader = (col: number, e: PointerEvent) => {
    const s = store.getSnapshot();
    const d = dims();
    if (d.rows === 0) return;
    if (e.shiftKey && s.activeCell && s.selection.length > 0) {
      const ranges = s.selection.slice();
      ranges[ranges.length - 1] = colRange(s.activeCell.col, col, d.rows);
      select(ranges, s.activeCell, e);
    } else {
      const active = { row: 0, col };
      select(e.ctrlKey || e.metaKey ? [...s.selection, colRange(col, col, d.rows)] : [colRange(col, col, d.rows)], active, e);
    }
  };

  /** Extends the last range to the cell nearest the pointer, clamped into the grid. */
  const dragSelect = (e: Event) => {
    const { vp, offsets, rows } = host.viewport();
    // Clamp into the viewport and onto the content, so dragging past the last row or column
    // selects up to it.
    const right = offsets[offsets.length - 1]! - vp.scrollLeft;
    const bottom = vp.headerHeight + rows.total - vp.scrollTop;
    const x = Math.max(0, Math.min(lastX, vp.width - 1, right - 1));
    const y = Math.max(vp.headerHeight, Math.min(lastY, vp.height - 1, bottom - 1));
    const hit = host.hitTest(x, y);
    if (hit.region !== 'cell') return;
    const s = store.getSnapshot();
    if (!s.activeCell || s.selection.length === 0) return;
    const ranges = s.selection.slice();
    ranges[ranges.length - 1] = extendRange(ranges[ranges.length - 1]!, s.activeCell, { row: hit.row, col: hit.col }, dims());
    select(ranges, s.activeCell, e);
  };

  // ---- Column reorder --------------------------------------------------------------------------

  /** Insertion index (0..n) nearest the pointer, and its screen x. */
  const dropAt = (x: number): { index: number; x: number } => {
    const { vp, offsets } = host.viewport();
    const n = offsets.length - 1;
    const hit = host.hitTest(Math.min(Math.max(x, 0), vp.width - 1), vp.headerHeight / 2);
    let index = n;
    if (hit.region === 'header' || hit.region === 'resize') index = x > (hit.x0 + hit.x1) / 2 ? hit.col + 1 : hit.col;
    if (hit.region === 'none' && x < vp.frozenWidth) index = 0;
    const edge = index < n ? colX(index, offsets, vp) : colX(n - 1, offsets, vp) + offsets[n]! - offsets[n - 1]!;
    return { index, x: index >= vp.frozenColumns ? Math.max(edge, vp.frozenWidth) : edge };
  };

  // ---- Auto-scroll while dragging --------------------------------------------------------------

  const edgeVelocity = (v: number, lo: number, hi: number) =>
    v < lo + EDGE ? -Math.min(60, (lo + EDGE - v) / 2) : v > hi - EDGE ? Math.min(60, (v - hi + EDGE) / 2) : 0;

  const tickAutoScroll = () => {
    autoScroll = 0;
    if (mode.kind !== 'select' && mode.kind !== 'reorder') return;
    const { vp } = host.viewport();
    const vx = edgeVelocity(lastX, vp.frozenWidth, vp.width);
    const vy = mode.kind === 'select' ? edgeVelocity(lastY, vp.bodyTop, vp.height) : 0;
    if (vx === 0 && vy === 0) return;
    host.scrollBy(vx, vy);
    move(null);
    autoScroll = win.requestAnimationFrame(tickAutoScroll);
  };
  const startAutoScroll = () => {
    if (!autoScroll) autoScroll = win.requestAnimationFrame(tickAutoScroll);
  };

  // ---- Pointer events -------------------------------------------------------------------------

  const onPointerDown = (e: PointerEvent) => {
    pointerType = e.pointerType;
    dragged = false;
    // Touch scrolls natively; a tap selects in the click handler.
    if (e.pointerType === 'touch' || (e.button !== 0 && e.button !== 2)) return;
    point(e);
    const hit = host.hitTest(lastX, lastY);
    if (hit.region === 'none') return;
    el.focus({ preventScroll: true });
    if (e.button === 0 && hit.region === 'cell') {
      // Pressing a clickable region of a declarative cell: no selection, a click on release.
      const t = host.targetAt(hit.row, hit.col, lastX, lastY);
      if (t?.region.onClick) {
        e.preventDefault();
        mode = { kind: 'press', target: t.target };
        store.setState({ hoverTarget: t.target, pressedTarget: t.target });
        el.setPointerCapture?.(e.pointerId);
        return;
      }
    }
    if (e.button === 2) {
      if (hit.region === 'cell' && !selectionContains(store.getSnapshot().selection, hit.row, hit.col)) {
        pressCell({ row: hit.row, col: hit.col }, e);
      }
      return;
    }
    e.preventDefault(); // no text selection or native drag
    const s = store.getSnapshot();
    if (hit.region === 'resize') {
      mode = { kind: 'resize', col: hit.col, startX: lastX, startWidth: s.columns[hit.col]!.width };
      host.setDrag({ kind: 'resize', x: hit.x1 });
    } else if (hit.region === 'header') {
      pressHeader(hit.col, e);
      mode = { kind: 'header', col: hit.col, startX: lastX };
    } else {
      pressCell({ row: hit.row, col: hit.col }, e);
      mode = { kind: 'select' };
    }
    el.setPointerCapture?.(e.pointerId);
  };

  const reorderTo = (m: Extract<Mode, { kind: 'reorder' }>) => {
    const d = dropAt(lastX);
    m.drop = d.index;
    host.setDrag({ kind: 'reorder', col: m.col, x: d.x });
    startAutoScroll();
  };

  const move = (e: PointerEvent | null) => {
    const ev = e ?? new Event('autoscroll');
    switch (mode.kind) {
      case 'none':
        if (e && e.buttons === 0) hoverAt(lastX, lastY);
        return;
      case 'press':
        // The pressed look shows only while the pointer is over the pressed region.
        hoverTargetAt(lastX, lastY, host.hitTest(lastX, lastY));
        return;
      case 'resize': {
        const s = store.getSnapshot();
        const col = s.columns[mode.col]!;
        const width = clampWidth(col, mode.startWidth + lastX - mode.startX);
        dragged = true;
        if (width !== col.width) host.resizeColumn(mode.col, width, ev);
        const { vp, offsets } = host.viewport();
        host.setDrag({ kind: 'resize', x: colX(mode.col, offsets, vp) + width });
        return;
      }
      case 'header': {
        if (Math.abs(lastX - mode.startX) < DRAG_THRESHOLD) return;
        if (store.getSnapshot().columns[mode.col]?.reorderable === false) return;
        dragged = true;
        mode = { kind: 'reorder', col: mode.col, drop: mode.col };
        setCursor('grabbing');
        setHover(null);
        reorderTo(mode);
        return;
      }
      case 'reorder':
        reorderTo(mode);
        return;
      case 'select':
        dragged = true;
        dragSelect(ev);
        startAutoScroll();
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    inside = true;
    point(e);
    move(e);
  };

  const endDrag = (e: Event, commit: boolean) => {
    const m = mode;
    mode = { kind: 'none' };
    if (autoScroll) win.cancelAnimationFrame(autoScroll);
    autoScroll = 0;
    if (m.kind === 'resize' && !commit) host.resizeColumn(m.col, m.startWidth, e);
    if (m.kind === 'reorder' && commit) {
      const to = m.drop > m.col ? m.drop - 1 : m.drop;
      if (to !== m.col) {
        host.moveColumn(m.col, to, e);
        const s = store.getSnapshot();
        if (s.rowCount > 0) select([colRange(to, to, s.rowCount)], { row: s.activeCell?.row ?? 0, col: to }, e);
      }
    }
    if (m.kind === 'resize' || m.kind === 'reorder') host.setDrag({ kind: 'none' });
    if (m.kind === 'press') {
      const over = sameTarget(store.getSnapshot().hoverTarget, m.target);
      store.setState({ pressedTarget: null });
      dragged = true; // the click that follows is the region's, not the cell's
      if (commit && over) host.activate(m.target, e);
    }
    setCursor('');
  };

  const onPointerUp = (e: PointerEvent) => {
    if (mode.kind === 'none') return;
    point(e);
    endDrag(e, true);
    el.releasePointerCapture?.(e.pointerId);
    if (inside) hoverAt(lastX, lastY);
  };

  const onPointerCancel = (e: PointerEvent) => {
    if (mode.kind !== 'none') endDrag(e, false);
  };

  const onPointerLeave = () => {
    inside = false;
    if (mode.kind === 'none') {
      setHover(null);
      setCursor('');
      setTitle('');
      if (store.getSnapshot().hoverTarget) store.setState({ hoverTarget: null });
    }
  };

  const cellEvent = (e: MouseEvent) => {
    point(e);
    const hit = host.hitTest(lastX, lastY);
    const columns = store.getSnapshot().columns;
    return { hit, column: columns[hit.col]! };
  };

  const onClick = (e: MouseEvent) => {
    if (dragged) return;
    const { hit, column } = cellEvent(e);
    if (hit.region === 'cell') {
      if (pointerType === 'touch') {
        const t = host.targetAt(hit.row, hit.col, lastX, lastY);
        if (t?.region.onClick) {
          host.activate(t.target, e);
          return;
        }
        pressCell({ row: hit.row, col: hit.col }, e);
      }
      host.events.onCellClick?.({ row: hit.row, col: hit.col, column, event: e });
    } else if (hit.region === 'header') {
      host.events.onHeaderClick?.({ col: hit.col, column, event: e });
    }
  };

  const onDoubleClick = (e: MouseEvent) => {
    const { hit, column } = cellEvent(e);
    if (hit.region === 'resize') {
      const width = clampWidth(column, host.autoFitWidth(hit.col));
      if (width !== column.width) host.resizeColumn(hit.col, width, e);
    } else if (hit.region === 'cell') {
      host.events.onCellDoubleClick?.({ row: hit.row, col: hit.col, column, event: e });
    }
  };

  const onContextMenu = (e: MouseEvent) => {
    const { hit, column } = cellEvent(e);
    if (hit.region === 'cell') host.events.onCellContextMenu?.({ row: hit.row, col: hit.col, column, event: e });
  };

  // Content moved under a still pointer: the hovered cell changed.
  const onScroll = () => {
    if (inside && mode.kind === 'none') hoverAt(lastX, lastY);
  };

  // ---- Keyboard -------------------------------------------------------------------------------

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== el || e.altKey) return;
    if (mode.kind !== 'none') {
      if (e.key === 'Escape') {
        e.preventDefault();
        endDrag(e, false);
      }
      return;
    }
    const s = store.getSnapshot();
    const d = dims();
    if (d.rows === 0 || d.cols === 0) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const { vp } = host.viewport();
    const active = s.activeCell ?? {
      row: vp.frozenRows > 0 ? 0 : vp.rowStart,
      col: vp.frozenColumns > 0 ? 0 : vp.colStart,
    };
    const last = s.selection[s.selection.length - 1] ?? rangeOf(active, active);

    if (ctrl && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      select([allCells(d)], active, e);
      return;
    }
    if (e.key === ' ' && (ctrl || e.shiftKey)) {
      e.preventDefault();
      // Ctrl+Space: whole columns; Shift+Space: whole rows, spanning the current range.
      const r = ctrl ? colRange(last.left, last.right, d.rows) : rowRange(last.top, last.bottom, d.cols);
      select([...s.selection.slice(0, -1), r], active, e);
      return;
    }
    if (e.key === 'Tab') {
      const next = tabCell(active, e.shiftKey, d);
      if (!next) return; // let focus leave the grid
      e.preventDefault();
      select([rangeOf(next, next)], next, e);
      host.scrollCellIntoView(next);
      return;
    }
    if (e.key === 'Escape') {
      const lone = s.selection.length === 1 && last.top === last.bottom && last.left === last.right &&
        last.top === active.row && last.left === active.col;
      if (lone) return;
      e.preventDefault();
      select([rangeOf(active, active)], active, e);
      return;
    }
    if (!NAV_KEYS.has(e.key)) return;
    e.preventDefault();
    if (e.shiftKey) {
      const target = moveCell(extentOf(last, active), e.key, ctrl, d)!;
      select([...s.selection.slice(0, -1), extendRange(last, active, target, d)], active, e);
      host.scrollCellIntoView(target);
    } else {
      const next = moveCell(active, e.key, ctrl, d)!;
      select([rangeOf(next, next)], next, e);
      host.scrollCellIntoView(next);
    }
  };

  const onCopy = (e: ClipboardEvent) => {
    if (doc.activeElement !== el || !e.clipboardData) return;
    const data = host.copy();
    if (!data) return;
    e.clipboardData.setData('text/plain', data.text);
    e.clipboardData.setData('text/html', data.html);
    e.preventDefault();
  };

  const onFocus = () => store.setState({ focused: true });
  const onBlur = () => {
    if (mode.kind !== 'none') endDrag(new Event('blur'), false);
    store.setState({ focused: false });
  };

  const listeners: [EventTarget, string, EventListener][] = [
    [el, 'pointerdown', onPointerDown as EventListener],
    [el, 'pointermove', onPointerMove as EventListener],
    [el, 'pointerup', onPointerUp as EventListener],
    [el, 'pointercancel', onPointerCancel as EventListener],
    [el, 'pointerleave', onPointerLeave],
    [el, 'click', onClick as EventListener],
    [el, 'dblclick', onDoubleClick as EventListener],
    [el, 'contextmenu', onContextMenu as EventListener],
    [el, 'scroll', onScroll],
    [el, 'keydown', onKeyDown as EventListener],
    [el, 'focus', onFocus],
    [el, 'blur', onBlur],
    [doc, 'copy', onCopy as EventListener],
  ];
  for (const [t, type, fn] of listeners) t.addEventListener(type, fn, type === 'scroll' ? { passive: true } : undefined);
  if (doc.activeElement === el) onFocus();

  return () => {
    if (autoScroll) win.cancelAnimationFrame(autoScroll);
    for (const [t, type, fn] of listeners) t.removeEventListener(type, fn);
  };
}
