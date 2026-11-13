import {
  FixedRows,
  TextMeasurer,
  buildColumnOffsets,
  computeViewport,
  createStore,
  defaultTheme,
  initialGridState,
  mergeTheme,
  resolveTheme,
  type CellEnv,
  type ColumnDef,
  type GridPluginHost,
  type Hit,
  type TextWrapper,
} from '@falcon-grid/core';
import { cell, stack, text } from '@falcon-grid/cells';
import { describe, expect, it, vi } from 'vitest';
import { createTextSelection, runsOf, stickyGroups, stickyHeaderAt } from '../src';
import { joiner } from '../src/runs';

/** 7px per character; wraps every 10 characters at word-free boundaries. */
const wrapper: TextWrapper = {
  lineCount: (t) => Math.max(1, Math.ceil(t.length / 10)),
  lines: (t) => t.match(/.{1,10}/g) ?? [''],
  clear: () => {},
};

const ROW = 30;

/** A plugin host over plain data: no DOM, fixed 30px rows, 300 by 120 viewport, no header. */
function makeHost(items: string[], column: Partial<ColumnDef> = {}) {
  const theme = mergeTheme(defaultTheme, { headerHeight: 0, rowHeight: ROW, cellPaddingX: 8 });
  const columns: ColumnDef[] = [{ id: 'item', width: 300, ...column }];
  const store = createStore({ ...initialGridState({ columns, rowCount: items.length, theme }), viewportWidth: 300, viewportHeight: 120 });
  const rows = new FixedRows(items.length, ROW);
  const offsets = buildColumnOffsets(columns);
  const resolved = resolveTheme(theme);
  const measurer = new TextMeasurer((t) => [...t].length * 7);
  const env: CellEnv = { theme: resolved, text: measurer, wrapper, epoch: 0 };
  const paintRow = vi.fn();
  const invalidateOverlay = vi.fn();
  const host: GridPluginHost = {
    store,
    element: null as unknown as HTMLElement,
    viewport() {
      const s = store.getSnapshot();
      const vp = computeViewport({
        offsets, rows, headerHeight: 0, frozenColumns: 0, frozenRows: 0,
        scrollLeft: 0, scrollTop: s.scrollTop, width: 300, height: 120,
      });
      return { vp, offsets, rows };
    },
    getCell: (r) => items[r],
    theme: () => resolved,
    text: measurer,
    wrapper: () => wrapper,
    autoHeight: () => false,
    displayList: (r, c) => {
      const col = store.getSnapshot().columns[c]!;
      const v = items[r];
      return col.cell && v != null ? col.cell.layout(v, 300 - 16, env) : { ops: [], regions: [], width: 0, height: 0 };
    },
    paintRow,
    invalidateOverlay,
    scrollBy: () => {},
  };
  return { host, store, paintRow, invalidateOverlay };
}

const down = (x: number, y: number, o: { shift?: boolean; t?: number } = {}) =>
  ({ shiftKey: o.shift ?? false, timeStamp: o.t ?? 0 }) as PointerEvent;

const hitAt = (row: number): Hit => ({ region: 'cell', row, col: 0, x0: 0, y0: row * ROW, x1: 300, y1: (row + 1) * ROW });

describe('runsOf', () => {
  it('places plain text as the base painter does', () => {
    const { host } = makeHost(['hello']);
    const [run] = runsOf(host, 0, 0);
    // Centred vertically in a fixed row, left-aligned after the padding.
    expect(run).toMatchObject({ x: 8, w: 35, text: 'hello', soft: false });
    expect(run!.y + run!.h / 2).toBe(ROW / 2);
  });

  it('gives each wrapped line of a declarative cell, marking soft wraps', () => {
    const c = cell<string>((s) => stack({}, [text('Name'), text(s, { wrap: true })]));
    const { host } = makeHost(['abcdefghijklmno'], { cell: c });
    const runs = runsOf(host, 0, 0);
    expect(runs.map((r) => [r.text, r.soft])).toEqual([
      ['Name', false],
      ['abcdefghij', false],
      ['klmno', true],
    ]);
  });

  it('joins soft wraps with a space between words and hard lines with a newline', () => {
    const r = (t: string, y: number, soft = false) => ({ x: 0, y, w: 0, h: 10, text: t, font: '', soft });
    expect(joiner(r('hello', 0), r('world', 10, true))).toBe(' ');
    expect(joiner(r('hello ', 0), r('world', 10, true))).toBe('');
    expect(joiner(r('你好', 0), r('世界', 10, true))).toBe('');
    expect(joiner(r('a', 0), r('b', 10))).toBe('\n');
    expect(joiner(r('a', 0), r('b', 0))).toBe(' ');
  });
});

describe('text selection', () => {
  const items = ['alpha beta', 'gamma', 'delta epsilon', 'zeta'];

  it('drags across rows and copies the selected text', () => {
    const { host, invalidateOverlay } = makeHost(items);
    const onChange = vi.fn();
    const sel = createTextSelection({ onChange });
    const p = sel.plugin(host);
    // Start after "alpha " (x = 8 + 6 * 7) in row 0, end after "delta" in row 2.
    expect(p.pointerDown!(down(50, 15), 8 + 6 * 7, 15, hitAt(0))).toBe(true);
    p.pointerMove!(8 + 5 * 7, 2 * ROW + 15);
    p.pointerUp!(true);
    expect(sel.text()).toBe('beta\ngamma\ndelta');
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(invalidateOverlay).toHaveBeenCalled();
    const copied = p.copy!()!;
    expect(copied.text).toBe('beta\ngamma\ndelta');
    expect(copied.html).toContain('beta\ngamma');
  });

  it('selects backwards, extends with Shift, and clears on a plain click', () => {
    const { host } = makeHost(items);
    const sel = createTextSelection();
    const p = sel.plugin(host);
    p.pointerDown!(down(0, 0), 8 + 4 * 7, ROW + 15, hitAt(1)); // "gamm|a"
    p.pointerMove!(8 + 2 * 7, 15); // "al|pha"
    p.pointerUp!(true);
    expect(sel.text()).toBe('pha beta\ngamm');
    p.pointerDown!(down(0, 0, { shift: true, t: 1000 }), 8 + 4 * 7, 3 * ROW + 15, hitAt(3));
    p.pointerUp!(true);
    expect(sel.text()).toBe('a\ndelta epsilon\nzeta');
    p.pointerDown!(down(0, 0, { t: 2000 }), 20, 15, hitAt(0));
    p.pointerUp!(true);
    expect(sel.range()).toBeNull();
    expect(p.copy!()).toBeNull();
  });

  it('selects a word on double click and a row on triple click', () => {
    const { host } = makeHost(items);
    const sel = createTextSelection();
    const p = sel.plugin(host);
    const x = 8 + 8 * 7; // inside "beta"
    for (const t of [0, 100]) {
      p.pointerDown!(down(0, 0, { t }), x, 15, hitAt(0));
      p.pointerUp!(true);
    }
    expect(sel.text()).toBe('beta');
    p.pointerDown!(down(0, 0, { t: 200 }), x, 15, hitAt(0));
    p.pointerUp!(true);
    expect(sel.text()).toBe('alpha beta');
  });

  it('selects all with Ctrl+A, clears with Escape, and follows inserted rows', () => {
    const { host } = makeHost(items);
    const sel = createTextSelection();
    const p = sel.plugin(host);
    const key = (k: string, ctrl = false) => ({ key: k, ctrlKey: ctrl, metaKey: false, shiftKey: false, altKey: false }) as KeyboardEvent;
    expect(p.keyDown!(key('a', true))).toBe(true);
    expect(sel.text()).toBe(items.join('\n'));
    sel.shiftRows(0, 2);
    expect(sel.range()!.start.row).toBe(2);
    expect(p.keyDown!(key('Escape'))).toBe(true);
    expect(sel.range()).toBeNull();
    expect(p.keyDown!(key('Escape'))).toBe(false);
  });

  it('copies whole rows with the renderer text, partial rows from the painted runs', () => {
    const c = cell<string>((s) => text(s, { wrap: true }), { text: (s) => `[${s}]` });
    const { host } = makeHost(['abcdefghijklmno', 'xyz'], { cell: c });
    const sel = createTextSelection();
    const p = sel.plugin(host);
    sel.selectAll();
    expect(sel.text()).toBe('[abcdefghijklmno]\n[xyz]');
    // From inside the first line of row 0 to the end of row 1: the soft wrap joins with a space.
    const top = runsOf(host, 0, 0)[0]!;
    p.pointerDown!(down(0, 0, { t: 5000 }), 8 + 7 * 7, top.y + 2, hitAt(0));
    p.pointerMove!(299, ROW + 29);
    expect(sel.text()).toBe('hij klmno\n[xyz]');
  });
});

describe('sticky group headers', () => {
  // Groups of 4: rows 0, 4, 8 … are headers.
  const items = Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? `Group ${i / 4}` : `item ${i}`));
  const groupOf = (r: number) => r - (r % 4);

  it('pins the current group header once it scrolls off, and lets the next push it up', () => {
    const { host, store } = makeHost(items);
    expect(stickyHeaderAt(host, groupOf)).toBeNull(); // header 0 is in place
    store.setState({ scrollTop: 45 }); // row 1 at the top
    expect(stickyHeaderAt(host, groupOf)).toEqual({ row: 0, top: 0, bottom: ROW });
    store.setState({ scrollTop: 100 }); // row 4 (next header) starts at y = 20
    expect(stickyHeaderAt(host, groupOf)).toEqual({ row: 0, top: -10, bottom: 20 });
    store.setState({ scrollTop: 130 }); // row 4 is at the top, partly scrolled
    expect(stickyHeaderAt(host, groupOf)).toEqual({ row: 4, top: 0, bottom: ROW });
  });

  it('paints the header on the overlay and takes pointer hits over it', () => {
    const { host, store, paintRow } = makeHost(items);
    const p = stickyGroups(groupOf)(host);
    store.setState({ scrollTop: 45 });
    const ctx = { getTransform: () => ({ a: 2 }), setTransform: vi.fn(), fillRect: vi.fn(), fillStyle: '' } as unknown as CanvasRenderingContext2D;
    p.paintOverlay!(ctx);
    expect(paintRow).toHaveBeenCalledWith(ctx, 0, 0, 0);
    const hit = hitAt(1);
    p.hitTest!(10, 10, hit);
    expect(hit.row).toBe(0);
    const below = hitAt(2);
    p.hitTest!(10, 40, below);
    expect(below.row).toBe(2);
  });
});
