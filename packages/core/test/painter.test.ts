import { describe, expect, it } from 'vitest';
import { buildColumnOffsets, computeViewport } from '../src/layout';
import { BasePainter, MAX_DIRTY_AREAS, snapLine, type PaintContext, type PaintInput } from '../src/painter';
import { FixedRows, VariableRows, type RowModel } from '../src/rows';
import { ELLIPSIS, TextMeasurer, type TextWrapper } from '../src/text';
import { defaultTheme, resolveTheme } from '../src/theme';
import type { ColumnDef } from '../src/types';

/** Records calls; property writes are recorded as `set:<prop>`. */
function recordingContext() {
  const calls: { op: string; args: unknown[] }[] = [];
  const target: Record<string, unknown> = { canvas: {} };
  const ctx = new Proxy(target, {
    get(_, prop: string) {
      if (prop in target) return target[prop];
      return (...args: unknown[]) => void calls.push({ op: prop, args });
    },
    set(_, prop: string, value) {
      target[prop] = value;
      calls.push({ op: `set:${prop}`, args: [value] });
      return true;
    },
  }) as unknown as PaintContext;
  return {
    ctx,
    calls,
    count: (op: string) => calls.filter((c) => c.op === op).length,
    texts: () => calls.filter((c) => c.op === 'fillText').map((c) => c.args[0] as string),
    reset: () => void (calls.length = 0),
  };
}

const columns: ColumnDef[] = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, title: `C${i}`, width: 100 }));
const offsets = buildColumnOffsets(columns);
const theme = resolveTheme(defaultTheme); // rowHeight 32, headerHeight 36
const HEIGHT = 36 + 32 * 10;

/** 7px per character; wraps every 10 characters. */
const measure = (t: string) => [...t].length * 7;
const wrapper: TextWrapper = {
  lineCount: (t) => Math.max(1, Math.ceil(t.length / 10)),
  lines: (t) => t.match(/.{1,10}/g) ?? [''],
  clear: () => {},
};

interface Opts {
  rows?: RowModel;
  autoHeight?: boolean;
  getCell?: PaintInput['getCell'];
  columns?: ColumnDef[];
  frozenColumns?: number;
  frozenRows?: number;
  scrollTop?: number;
  scrollLeft?: number;
  dpr?: number;
  width?: number;
}

function setup() {
  const rec = recordingContext();
  const painter = new BasePainter();
  const text = new TextMeasurer(measure);
  const input = (o: Opts = {}): PaintInput => ({
    ctx: rec.ctx,
    dpr: o.dpr ?? 1,
    columns: o.columns ?? columns,
    offsets,
    rows: o.rows ?? new FixedRows(1000, theme.rowHeight),
    text,
    wrapper,
    autoHeight: o.autoHeight ?? false,
    vp: computeViewport({
      offsets,
      rows: o.rows ?? new FixedRows(1000, theme.rowHeight),
      headerHeight: theme.headerHeight,
      frozenColumns: o.frozenColumns ?? 0,
      frozenRows: o.frozenRows ?? 0,
      scrollLeft: o.scrollLeft ?? 0,
      scrollTop: o.scrollTop ?? 0,
      width: o.width ?? 500,
      height: HEIGHT,
    }),
    theme,
    getCell: o.getCell ?? ((r, c) => (r === 0 && c === 0 ? null : `${r}:${c}`)),
  });
  return { ...rec, painter, input };
}

describe('BasePainter full paint', () => {
  it('paints each visible cell once, skipping empty values', () => {
    const { painter, input, count } = setup();
    const r = painter.paint(input());
    // 5 columns x 10 rows, minus the null cell
    expect(r.cells).toBe(49);
    expect(r.mode).toBe('full');
    expect(count('fillText')).toBe(49 + 5); // + header titles
  });

  it('fills all gridlines as a single path of device-pixel rectangles', () => {
    const { painter, input, count, calls } = setup();
    painter.paint(input({ dpr: 2 }));
    expect(count('fill')).toBe(1);
    expect(count('stroke')).toBe(0);
    // Every rect lands on whole device pixels.
    for (const c of calls.filter((c) => c.op === 'rect')) {
      for (const v of c.args as number[]) expect(Number.isInteger(v * 2)).toBe(true);
    }
  });

  it('sets the cell font once and clips once per column plus the area', () => {
    const { painter, input, calls, count } = setup();
    painter.paint(input());
    const fonts = calls.filter((c) => c.op === 'set:font');
    expect(fonts.map((f) => f.args[0])).toEqual([theme.cellFont, theme.headerFont]);
    expect(count('clip')).toBe(1 + 5 + 5);
  });

  it('paints frozen panes and a divider stroke', () => {
    const { painter, input, count } = setup();
    const r = painter.paint(input({ frozenColumns: 1, frozenRows: 2, scrollTop: 3200 }));
    // 5 columns x 10 rows visible in total, the null cell (0,0) is in the frozen corner
    expect(r.cells).toBe(49);
    expect(count('fill')).toBe(2); // gridlines + dividers
  });

  it('snaps lines to device pixel centres', () => {
    expect(snapLine(100, 1)).toBe(99.5);
    expect(snapLine(100, 2)).toBe(99.75);
    expect(snapLine(33.3, 1.5)).toBeCloseTo((50 - 0.5) / 1.5);
  });
});

describe('BasePainter scroll blitting', () => {
  it('starts with a full paint', () => {
    const { painter, input } = setup();
    expect(painter.update(input()).mode).toBe('full');
  });

  it('shifts the body and header and paints only the exposed row', () => {
    const { painter, input, calls, texts, reset } = setup();
    painter.paint(input());
    reset();
    const r = painter.update(input({ scrollTop: 32 }));
    expect(r.mode).toBe('incremental');
    expect(r.blitY).toBe(32);
    const blits = calls.filter((c) => c.op === 'drawImage');
    // Only the body moves vertically (no frozen columns); the header does not move.
    expect(blits).toHaveLength(1);
    // source y = bodyTop + 32, dest y = bodyTop
    expect(blits[0]!.args.slice(2, 3)).toEqual([36 + 32]);
    expect(blits[0]!.args.slice(6, 7)).toEqual([36]);
    // New bottom row 10 is the only one painted.
    expect(texts().every((t) => t.startsWith('10:'))).toBe(true);
    expect(r.cells).toBe(5);
  });

  it('blits each pane separately when scrolling diagonally', () => {
    const { painter, input, calls, reset } = setup();
    painter.paint(input({ frozenColumns: 1 }));
    reset();
    painter.update(input({ frozenColumns: 1, scrollTop: 64, scrollLeft: 50 }));
    const blits = calls.filter((c) => c.op === 'drawImage');
    // body (both axes), frozen columns (vertical), header (horizontal)
    expect(blits).toHaveLength(3);
  });

  it('merges panes into one blit when scrolling along one axis', () => {
    const { painter, input, calls, reset } = setup();
    const o = { frozenColumns: 1, frozenRows: 2 };
    painter.paint(input(o));
    reset();
    painter.update(input({ ...o, scrollLeft: 50 }));
    // header + frozen rows + body, as one rectangle right of the frozen column, full height
    expect(calls.filter((c) => c.op === 'drawImage').map((c) => c.args.slice(1))).toEqual([
      [150, 0, 350, HEIGHT, 100, 0, 350, HEIGHT],
    ]);
    reset();
    painter.update(input({ ...o, scrollLeft: 50, scrollTop: 64 }));
    // frozen column + body, as one rectangle below the frozen rows, full width
    const bodyTop = 36 + 64;
    expect(calls.filter((c) => c.op === 'drawImage').map((c) => c.args.slice(1))).toEqual([
      [0, bodyTop + 64, 500, HEIGHT - bodyTop - 64, 0, bodyTop, 500, HEIGHT - bodyTop - 64],
    ]);
  });

  it('does nothing when the scroll position is unchanged', () => {
    const { painter, input, count, reset } = setup();
    painter.paint(input());
    reset();
    const r = painter.update(input());
    expect(r.areas).toBe(0);
    expect(count('fillText')).toBe(0);
  });

  it('repaints fully on a fractional device-pixel delta', () => {
    const { painter, input } = setup();
    painter.paint(input({ dpr: 1.5 }));
    // 1px * 1.5 = 1.5 device pixels: cannot blit cleanly
    expect(painter.update(input({ dpr: 1.5, scrollTop: 1 })).mode).toBe('full');
    // 2px * 1.5 = 3 device pixels: fine
    expect(painter.update(input({ dpr: 1.5, scrollTop: 3 })).mode).toBe('incremental');
  });

  it('repaints fully when the geometry changes', () => {
    const { painter, input } = setup();
    painter.paint(input());
    expect(painter.update(input({ width: 600, scrollTop: 32 })).mode).toBe('full');
    expect(painter.update(input({ width: 600, frozenRows: 1, scrollTop: 32 })).mode).toBe('full');
  });

  it('repaints a whole region when the jump exceeds it', () => {
    const { painter, input, count, reset } = setup();
    painter.paint(input());
    reset();
    const r = painter.update(input({ scrollTop: 3200 }));
    expect(r.mode).toBe('incremental');
    expect(count('drawImage')).toBe(0);
    expect(r.cells).toBe(50);
  });

  it('repaints fully after invalidate()', () => {
    const { painter, input } = setup();
    painter.paint(input());
    painter.invalidate();
    expect(painter.update(input({ scrollTop: 32 })).mode).toBe('full');
  });
});

describe('BasePainter dirty cells', () => {
  const dirty = (...pairs: number[]) => ({ cells: Int32Array.from(pairs), count: pairs.length / 2 });

  it('paints only the dirty cells', () => {
    const { painter, input, texts, reset } = setup();
    painter.paint(input());
    reset();
    const r = painter.update(input(), dirty(3, 2, 5, 4));
    expect(r.mode).toBe('incremental');
    expect(r.areas).toBe(2);
    expect(texts().sort()).toEqual(['3:2', '5:4']);
  });

  it('skips cells outside the viewport', () => {
    const { painter, input, reset, texts } = setup();
    painter.paint(input());
    reset();
    const r = painter.update(input(), dirty(500, 1, 2, 19));
    expect(r.areas).toBe(0);
    expect(texts()).toEqual([]);
  });

  it('paints whole rows for col -1', () => {
    const { painter, input, texts, reset } = setup();
    painter.paint(input());
    reset();
    painter.update(input(), dirty(4, -1));
    expect(texts().sort()).toEqual(['4:0', '4:1', '4:2', '4:3', '4:4']);
  });

  it('maps frozen cells to their pane', () => {
    const { painter, input, texts, reset } = setup();
    const o = { frozenColumns: 1, frozenRows: 1, scrollTop: 3200, scrollLeft: 1000 };
    painter.paint(input(o));
    reset();
    painter.update(input(o), dirty(0, 0, 0, 12, 105, 0));
    // (0,0) is null; (0,12) is in the frozen row; (105,0) in the frozen column
    expect(texts().sort()).toEqual(['0:12', '105:0']);
  });

  it('falls back to a full paint past the limit', () => {
    const { painter, input } = setup();
    painter.paint(input());
    const pairs = Array.from({ length: (MAX_DIRTY_AREAS + 1) * 2 }, () => 1);
    expect(painter.update(input(), dirty(...pairs)).mode).toBe('full');
  });

  it('combines a scroll blit with dirty cells at their new position', () => {
    const { painter, input, texts, reset } = setup();
    painter.paint(input());
    reset();
    painter.update(input({ scrollTop: 32 }), dirty(5, 3));
    expect(texts().sort()).toEqual(['10:0', '10:1', '10:2', '10:3', '10:4', '5:3']);
  });
});

describe('BasePainter text', () => {
  it('truncates long text with an ellipsis', () => {
    const { painter, input, texts } = setup();
    painter.paint(input({ getCell: (r, c) => (r === 1 && c === 1 ? 'x'.repeat(40) : null) }));
    // 100px column - 16px padding = 84px: 10 chars (70px) + ellipsis (7px)
    expect(texts()).toContain('x'.repeat(11) + ELLIPSIS);
  });

  it('draws wrapped lines, clamped to the row with an ellipsis', () => {
    const { painter, input, calls } = setup();
    const cols = columns.map((c, i) => (i === 1 ? { ...c, wrap: true } : c));
    painter.paint(input({ columns: cols, getCell: (r, c) => (r === 1 && c === 1 ? 'a'.repeat(25) : null) }));
    const drawn = calls.filter((c) => c.op === 'fillText' && String(c.args[0]).startsWith('a'));
    // Fixed 32px rows with 18px lines and 7px padding fit one line: clamped with an ellipsis.
    expect(drawn.map((c) => c.args[0])).toEqual(['a'.repeat(10) + ELLIPSIS]);
  });

  it('draws every wrapped line in an auto-height row, from the top', () => {
    const { painter, input, calls } = setup();
    const rows = new VariableRows(1000, 32);
    rows.setHeight(1, 3 * 18 + 14);
    const cols = columns.map((c, i) => (i === 1 ? { ...c, wrap: true } : c));
    painter.paint(input({ rows, autoHeight: true, columns: cols, getCell: (r, c) => (r === 1 && c === 1 ? 'a'.repeat(25) : null) }));
    const drawn = calls.filter((c) => c.op === 'fillText' && String(c.args[0]).startsWith('a'));
    expect(drawn.map((c) => c.args[0])).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
    // Row 1 starts at 36 + 32; first line centre = top + 7 + 9
    expect(drawn.map((c) => c.args[2])).toEqual([36 + 32 + 16, 36 + 32 + 34, 36 + 32 + 52]);
  });
});

describe('BasePainter variable rows', () => {
  it('positions rows from the row model', () => {
    const { painter, input, calls } = setup();
    const rows = new VariableRows(1000, 32);
    rows.setHeight(0, 100);
    painter.paint(input({ rows }));
    const row1 = calls.find((c) => c.op === 'fillText' && c.args[0] === '1:0')!;
    expect(row1.args[2]).toBe(36 + 100 + 16);
  });

  it('does not blit when scroll anchoring moved scrollTop but not the content', () => {
    const { painter, input, count, reset } = setup();
    const rows = new VariableRows(1000, 32);
    for (let r = 50; r < 70; r++) rows.setHeight(r, 32);
    rows.commit();
    painter.paint(input({ rows, scrollTop: 50 * 32 }));
    reset();
    // A row above the viewport turns out 40px taller; anchoring adds 40 to scrollTop.
    rows.setHeight(10, 72);
    const r = painter.update(input({ rows, scrollTop: 50 * 32 + 40 }));
    expect(r.mode).toBe('incremental');
    expect(r.blitY).toBe(0);
    expect(count('drawImage')).toBe(0);
  });

  it('repaints fully when a row on screen changes height', () => {
    const { painter, input } = setup();
    const rows = new VariableRows(1000, 32);
    rows.commit();
    painter.paint(input({ rows }));
    rows.setHeight(3, 60);
    expect(painter.update(input({ rows })).mode).toBe('full');
  });
});
