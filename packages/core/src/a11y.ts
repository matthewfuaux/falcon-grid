import type { CellRegion, CellTarget } from './display';
import { selectionContains } from './selection';
import type { Store } from './store';
import type { CellRange, CellRef, GridState } from './types';

/**
 * The accessibility mirror: a visually hidden `role="grid"` in the DOM layer holding the header
 * and the cells on screen (plus the active cell wherever it is), with `aria-rowindex` and
 * `aria-colindex` carrying the true position. The active cell's element holds DOM focus, so
 * screen readers announce moves natively. In-cell controls are real buttons, links and
 * checkboxes.
 *
 * It costs nothing per frame: scrolling only notes the time, and the mirror is rebuilt once
 * scrolling settles. Focus moves are applied at once.
 */
export interface MirrorHost {
  element: HTMLElement;
  layer: HTMLElement;
  store: Store<GridState>;
  /** The visible window: frozen counts and the scrolling ranges. */
  window(): { frozenRows: number; frozenColumns: number; rowStart: number; rowEnd: number; colStart: number; colEnd: number };
  text(row: number, col: number): string;
  regions(row: number, col: number): readonly CellRegion[];
  bounds(row: number, col: number): { x: number; y: number; width: number; height: number } | null;
  activate(target: CellTarget, event: Event): void;
  select(cell: CellRef, event: Event): void;
  headerClick(col: number, event: MouseEvent): void;
  contextMenu(cell: CellRef, event: MouseEvent): void;
}

export interface Mirror {
  readonly root: HTMLElement;
  /** The active cell, or the first visible cell when there is none. */
  focusCell(): CellRef | null;
  /** Moves DOM focus to the focus cell. */
  focus(): void;
  /** True for the elements grid keys act on: the scroller and mirrored cells (not controls). */
  isKeyTarget(t: EventTarget | null): boolean;
  /** True when `t` is the scroller or anything in the mirror: the grid has focus. */
  owns(t: EventTarget | null): boolean;
  /** Interactive controls of a cell, as region indexes. */
  controls(cell: CellRef): number[];
  /** Focuses a cell's first control; false if it has none. */
  focusControl(cell: CellRef): boolean;
  /** Rebuild once things settle (scrolling, data, selection). */
  schedule(): void;
  sync(): void;
  announce(message: string): void;
  setLabel(label: string | undefined, labelledBy: string | undefined): void;
  destroy(): void;
}

interface CellEl {
  el: HTMLElement;
  textEl: HTMLElement;
  sig: string;
  box: string;
}

interface RowEl {
  el: HTMLElement;
  cells: Map<number, CellEl>;
}

/** Quiet time after the last change before the mirror is rebuilt. */
const SETTLE_MS = 100;

const HIDDEN_TEXT = 'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;';

const roleOf = (r: CellRegion) => r.role ?? (r.onClick ? 'button' : null);

/** Visible rows or columns: the frozen ones, the scrolling window, and `extra`. */
function span(frozen: number, start: number, end: number, extra: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.min(frozen, count); i++) out.push(i);
  for (let i = Math.max(start, frozen); i < Math.min(end, count); i++) out.push(i);
  if (extra >= 0 && extra < count && !out.includes(extra)) {
    out.push(extra);
    out.sort((a, b) => a - b);
  }
  return out;
}

/** Puts `want` (sorted, all children of `parent` after `first`) in order, moving nothing in place. */
function order(parent: HTMLElement, want: readonly HTMLElement[], first: ChildNode | null): void {
  let cur = first;
  for (const el of want) {
    if (el === cur) cur = cur.nextSibling;
    else parent.insertBefore(el, cur);
  }
}

function summary(selection: readonly CellRange[]): string {
  let cells = 0;
  for (const r of selection) cells += (r.bottom - r.top + 1) * (r.right - r.left + 1);
  if (cells <= 1) return '';
  if (selection.length > 1) return `${selection.length} ranges selected, ${cells} cells`;
  const r = selection[0]!;
  const rows = r.bottom - r.top + 1;
  const cols = r.right - r.left + 1;
  return `${rows} ${rows === 1 ? 'row' : 'rows'} by ${cols} ${cols === 1 ? 'column' : 'columns'} selected`;
}

export function createMirror(host: MirrorHost): Mirror {
  const { store, element } = host;
  const doc = element.ownerDocument;
  const win = doc.defaultView ?? window;

  const root = doc.createElement('div');
  root.setAttribute('role', 'grid');
  root.setAttribute('aria-multiselectable', 'true');
  root.dataset.falconMirror = '';
  // Transparent but in the accessibility tree, with cells at their real positions so a screen
  // reader's highlight and a magnifier follow the canvas.
  root.style.cssText = 'position:absolute;inset:0;overflow:hidden;opacity:0;pointer-events:none;';
  const header = doc.createElement('div');
  header.setAttribute('role', 'row');
  header.setAttribute('aria-rowindex', '1');
  root.append(header);
  const live = doc.createElement('div');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  live.style.cssText = HIDDEN_TEXT;
  host.layer.prepend(root, live);

  const rowEls = new Map<number, RowEl>();
  const headEls = new Map<number, { el: HTMLElement; sig: string; box: string }>();
  const sorts = new Map<string, string>();
  let focused: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastChange = 0;
  let lastSummary = '';
  let summaryTimer: ReturnType<typeof setTimeout> | undefined;
  let synced = false;

  const cellOf = (t: EventTarget | null): HTMLElement | null =>
    t instanceof win.HTMLElement && root.contains(t) ? t.closest<HTMLElement>('[role="gridcell"]') : null;
  const refOf = (el: HTMLElement): CellRef => ({ row: Number(el.dataset.r), col: Number(el.dataset.c) });

  const focusCell = (): CellRef | null => {
    const s = store.getSnapshot();
    if (s.rowCount === 0 || s.columns.length === 0) return null;
    if (s.activeCell && s.activeCell.row < s.rowCount && s.activeCell.col < s.columns.length) return s.activeCell;
    const w = host.window();
    return { row: w.frozenRows > 0 ? 0 : Math.min(w.rowStart, s.rowCount - 1), col: w.frozenColumns > 0 ? 0 : Math.min(w.colStart, s.columns.length - 1) };
  };

  const place = (el: HTMLElement, b: { x: number; y: number; width: number; height: number } | null, prev: string) => {
    const box = b ? `left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px;` : 'left:0;top:0;width:1px;height:1px;';
    if (box !== prev) el.style.cssText = `position:absolute;overflow:hidden;white-space:nowrap;${box}`;
    return box;
  };

  /** Brings a cell's content and attributes up to date, keeping elements (and focus) in place. */
  const fill = (c: CellEl, row: number, col: number, selected: boolean, tab: boolean) => {
    const text = host.text(row, col);
    const regions = host.regions(row, col);
    let sig = text;
    for (const r of regions) if (roleOf(r)) sig += `\u0000${roleOf(r)}|${r.label ?? r.tooltip ?? ''}|${r.checked}|${r.href ?? ''}`;
    if (sig !== c.sig) {
      c.sig = sig;
      if (c.textEl.textContent !== text) c.textEl.textContent = text;
      const old = Array.from(c.el.querySelectorAll<HTMLElement>('[data-fg-ctl]'));
      let i = 0;
      regions.forEach((r, index) => {
        const role = roleOf(r);
        if (!role) return;
        const tag = role === 'button' ? 'button' : role === 'link' && r.href ? 'a' : 'span';
        let el = old[i];
        if (!el || el.localName !== tag || el.getAttribute('role') !== (tag === 'span' ? role : null)) {
          const fresh = doc.createElement(tag);
          if (el) el.replaceWith(fresh);
          else c.el.append(fresh);
          el = fresh;
          if (tag === 'span') el.setAttribute('role', role);
          if (tag === 'button') (el as HTMLButtonElement).type = 'button';
          el.tabIndex = -1;
        }
        i++;
        el.dataset.fgCtl = String(index);
        const label = r.label ?? r.tooltip ?? '';
        if (el.textContent !== label) el.textContent = label;
        if (tag === 'a') (el as HTMLAnchorElement).href = r.href!;
        if (role === 'checkbox') el.setAttribute('aria-checked', String(!!r.checked));
      });
      for (; i < old.length; i++) old[i]!.remove();
    }
    const sel = String(selected);
    if (c.el.getAttribute('aria-selected') !== sel) c.el.setAttribute('aria-selected', sel);
    const t = tab ? 0 : -1;
    if (c.el.tabIndex !== t) c.el.tabIndex = t;
  };

  const newCell = (row: number, col: number): CellEl => {
    const el = doc.createElement('div');
    el.setAttribute('role', 'gridcell');
    el.dataset.r = String(row);
    el.dataset.c = String(col);
    el.setAttribute('aria-colindex', String(col + 1));
    const textEl = doc.createElement('span');
    el.append(textEl);
    return { el, textEl, sig: '\u0001', box: '' };
  };

  const newRow = (row: number): RowEl => {
    const el = doc.createElement('div');
    el.setAttribute('role', 'row');
    el.setAttribute('aria-rowindex', String(row + 2));
    return { el, cells: new Map() };
  };

  /** Makes sure one cell is mirrored (creating its row and cell in order) and up to date. */
  const ensure = (cell: CellRef): CellEl => {
    let r = rowEls.get(cell.row);
    if (!r) {
      r = newRow(cell.row);
      rowEls.set(cell.row, r);
      const after = [...rowEls.keys()].filter((k) => k > cell.row).sort((a, b) => a - b)[0];
      root.insertBefore(r.el, after === undefined ? null : rowEls.get(after)!.el);
    }
    let c = r.cells.get(cell.col);
    if (!c) {
      c = newCell(cell.row, cell.col);
      r.cells.set(cell.col, c);
      const after = [...r.cells.keys()].filter((k) => k > cell.col).sort((a, b) => a - b)[0];
      r.el.insertBefore(c.el, after === undefined ? null : r.cells.get(after)!.el);
    }
    const s = store.getSnapshot();
    c.box = place(c.el, host.bounds(cell.row, cell.col), c.box);
    fill(c, cell.row, cell.col, selectionContains(s.selection, cell.row, cell.col), true);
    if (focused && focused !== c.el && focused.tabIndex === 0) focused.tabIndex = -1;
    focused = c.el;
    return c;
  };

  const sync = () => {
    clearTimeout(timer);
    timer = undefined;
    synced = true;
    const s = store.getSnapshot();
    const w = host.window();
    const f = focusCell();
    root.setAttribute('aria-rowcount', String(s.rowCount + 1));
    root.setAttribute('aria-colcount', String(s.columns.length));
    element.tabIndex = f ? -1 : 0;
    const rows = span(w.frozenRows, w.rowStart, w.rowEnd, f?.row ?? -1, s.rowCount);
    const cols = span(w.frozenColumns, w.colStart, w.colEnd, f?.col ?? -1, s.columns.length);
    const colSet = new Set(cols);

    // Header: one columnheader per mirrored column, with the sort state.
    for (const [c, h] of headEls) if (!colSet.has(c)) (h.el.remove(), headEls.delete(c));
    const heads: HTMLElement[] = [];
    for (const c of cols) {
      const column = s.columns[c]!;
      let h = headEls.get(c);
      if (!h) {
        const el = doc.createElement('div');
        el.setAttribute('role', 'columnheader');
        el.dataset.c = String(c);
        h = { el, sig: '', box: '' };
        headEls.set(c, h);
      }
      const title = column.title ?? column.id;
      const sort = column.sort === 'asc' ? 'ascending' : column.sort === 'desc' ? 'descending' : '';
      const sig = `${c}|${title}|${sort}`;
      if (sig !== h.sig) {
        h.sig = sig;
        h.el.setAttribute('aria-colindex', String(c + 1));
        h.el.textContent = title;
        if (sort) h.el.setAttribute('aria-sort', sort);
        else h.el.removeAttribute('aria-sort');
      }
      const b = host.bounds(0, c);
      h.box = place(h.el, b && { x: b.x, y: 0, width: b.width, height: s.theme.headerHeight }, h.box);
      heads.push(h.el);
    }
    order(header, heads, header.firstChild);

    // Announce sort changes (the owner sorted after a header click).
    const seen = new Set<string>();
    for (const column of s.columns) {
      seen.add(column.id);
      const now = column.sort ?? '';
      const before = sorts.get(column.id);
      if (before !== undefined && before !== now && now) {
        announce(`${column.title ?? column.id} sorted ${now === 'asc' ? 'ascending' : 'descending'}`);
      }
      sorts.set(column.id, now);
    }
    for (const id of sorts.keys()) if (!seen.has(id)) sorts.delete(id);

    // Rows and cells. Nothing that stays is moved, so the focused cell keeps focus.
    const rowSet = new Set(rows);
    for (const [r, el] of rowEls) if (!rowSet.has(r)) (el.el.remove(), rowEls.delete(r));
    const rowList: HTMLElement[] = [];
    for (const r of rows) {
      let re = rowEls.get(r);
      if (!re) {
        re = newRow(r);
        rowEls.set(r, re);
      }
      for (const [c, ce] of re.cells) if (!colSet.has(c)) (ce.el.remove(), re.cells.delete(c));
      const cellList: HTMLElement[] = [];
      for (const c of cols) {
        let ce = re.cells.get(c);
        if (!ce) {
          ce = newCell(r, c);
          re.cells.set(c, ce);
        }
        ce.box = place(ce.el, host.bounds(r, c), ce.box);
        const isFocus = f !== null && f.row === r && f.col === c;
        fill(ce, r, c, selectionContains(s.selection, r, c), isFocus);
        if (isFocus) focused = ce.el;
        cellList.push(ce.el);
      }
      order(re.el, cellList, re.el.firstChild);
      rowList.push(re.el);
    }
    order(root, rowList, header.nextSibling);
  };

  const hasFocus = () => {
    const a = doc.activeElement;
    return a === element || (a !== null && root.contains(a));
  };

  const focus = () => {
    const f = focusCell();
    if (!f) {
      element.focus({ preventScroll: true });
      return;
    }
    const c = ensure(f);
    if (doc.activeElement !== c.el) c.el.focus({ preventScroll: true });
  };

  const announce = (message: string) => {
    live.textContent = message === live.textContent ? `${message} ` : message;
  };

  const controls = (cell: CellRef): number[] => {
    const out: number[] = [];
    host.regions(cell.row, cell.col).forEach((r, i) => roleOf(r) && out.push(i));
    return out;
  };

  const ctlEls = (cellEl: HTMLElement) => Array.from(cellEl.querySelectorAll<HTMLElement>('[data-fg-ctl]'));

  // ---- Events from assistive technology and keyboard focus inside the mirror ------------------

  const targetOf = (ctl: HTMLElement): CellTarget => {
    const cellEl = ctl.closest<HTMLElement>('[role="gridcell"]')!;
    return { ...refOf(cellEl), region: Number(ctl.dataset.fgCtl) };
  };

  const onClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    const ctl = t.closest<HTMLElement>('[data-fg-ctl]');
    if (ctl) {
      e.preventDefault(); // links open through the region's handler
      host.activate(targetOf(ctl), e);
      return;
    }
    const cellEl = cellOf(t);
    if (cellEl) {
      host.select(refOf(cellEl), e);
      return;
    }
    const head = t.closest<HTMLElement>('[role="columnheader"]');
    if (head) host.headerClick(Number(head.dataset.c), e);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const ctl = (e.target as HTMLElement).closest?.<HTMLElement>('[data-fg-ctl]');
    if (!ctl) return;
    const cellEl = ctl.closest<HTMLElement>('[role="gridcell"]')!;
    const all = ctlEls(cellEl);
    const i = all.indexOf(ctl);
    const role = ctl.getAttribute('role');
    if (e.key === 'Escape') {
      e.preventDefault();
      cellEl.focus({ preventScroll: true });
    } else if (e.key === 'Tab' || e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      // Cycle through the cell's controls; Escape leaves.
      e.preventDefault();
      const back = e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey);
      all[(i + (back ? all.length - 1 : 1)) % all.length]!.focus({ preventScroll: true });
    } else if ((e.key === ' ' && role === 'checkbox') || (e.key === 'Enter' && role === 'link')) {
      e.preventDefault();
      host.activate(targetOf(ctl), e);
    }
  };

  const onContextMenu = (e: MouseEvent) => {
    const cellEl = cellOf(e.target);
    if (cellEl) host.contextMenu(refOf(cellEl), e);
  };

  const onFocusIn = (e: FocusEvent) => {
    const ctl = (e.target as HTMLElement).closest?.<HTMLElement>('[data-fg-ctl]');
    const target = ctl ? targetOf(ctl) : null;
    const prev = store.getSnapshot().focusTarget;
    if (prev !== target && !(prev && target && prev.row === target.row && prev.col === target.col && prev.region === target.region)) {
      store.setState({ focusTarget: target });
    }
  };

  const onFocusOut = (e: FocusEvent) => {
    if (!root.contains(e.relatedTarget as Node | null) && store.getSnapshot().focusTarget) store.setState({ focusTarget: null });
  };

  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeyDown);
  root.addEventListener('contextmenu', onContextMenu);
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('focusout', onFocusOut);

  const settle = () => {
    timer = undefined;
    const wait = lastChange + SETTLE_MS - performance.now();
    if (wait > 0) timer = setTimeout(settle, wait);
    else sync();
  };
  const schedule = () => {
    lastChange = performance.now();
    if (timer === undefined) timer = setTimeout(settle, SETTLE_MS);
  };

  const unsubscribe = store.subscribe((next, prev) => {
    if (next.activeCell !== prev.activeCell) {
      // Focus follows the active cell at once; the rest of the mirror catches up later.
      if (hasFocus()) focus();
      else if (synced) {
        const f = focusCell();
        if (f) ensure(f);
      }
      schedule();
    } else if (
      next.scrollTop !== prev.scrollTop ||
      next.scrollLeft !== prev.scrollLeft ||
      next.columns !== prev.columns ||
      next.rowCount !== prev.rowCount ||
      next.viewportWidth !== prev.viewportWidth ||
      next.viewportHeight !== prev.viewportHeight ||
      next.frozenColumns !== prev.frozenColumns ||
      next.frozenRows !== prev.frozenRows ||
      next.theme !== prev.theme
    ) {
      schedule();
    }
    if (next.selection !== prev.selection) {
      schedule();
      clearTimeout(summaryTimer);
      summaryTimer = setTimeout(() => {
        const text = summary(store.getSnapshot().selection);
        if (text && text !== lastSummary) announce(text);
        lastSummary = text;
      }, 250);
    }
  });

  schedule();

  return {
    root,
    focusCell,
    focus,
    isKeyTarget: (t) => t === element || cellOf(t) === t,
    owns: (t) => t === element || (t instanceof win.Node && root.contains(t)),
    controls,
    focusControl(cell) {
      const c = ensure(cell);
      const first = ctlEls(c.el)[0];
      if (!first) return false;
      first.focus({ preventScroll: true });
      return true;
    },
    schedule,
    sync,
    announce,
    setLabel(label, labelledBy) {
      if (label) root.setAttribute('aria-label', label);
      else root.removeAttribute('aria-label');
      if (labelledBy) root.setAttribute('aria-labelledby', labelledBy);
      else root.removeAttribute('aria-labelledby');
    },
    destroy() {
      clearTimeout(timer);
      clearTimeout(summaryTimer);
      unsubscribe();
      root.remove();
      live.remove();
    },
  };
}
