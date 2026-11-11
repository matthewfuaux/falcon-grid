import { describe, expect, it } from 'vitest';
import { hitTest, RESIZE_HANDLE } from '../src/hittest';
import { buildColumnOffsets, computeViewport } from '../src/layout';
import { FixedRows } from '../src/rows';
import type { ColumnDef } from '../src/types';

const columns: ColumnDef[] = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, width: 100 }));
const offsets = buildColumnOffsets(columns);
const rows = new FixedRows(1000, 30);

const vpOf = (o: { scrollLeft?: number; scrollTop?: number; frozenColumns?: number; frozenRows?: number } = {}) =>
  computeViewport({
    offsets,
    rows,
    headerHeight: 40,
    frozenColumns: o.frozenColumns ?? 0,
    frozenRows: o.frozenRows ?? 0,
    scrollLeft: o.scrollLeft ?? 0,
    scrollTop: o.scrollTop ?? 0,
    width: 450,
    height: 400,
  });

const hit = (x: number, y: number, o?: Parameters<typeof vpOf>[0], cols = columns) => ({
  ...hitTest(x, y, vpOf(o), offsets, rows, cols),
});

describe('hitTest', () => {
  it('finds cells with their bounds', () => {
    expect(hit(150, 75)).toMatchObject({ region: 'cell', row: 1, col: 1, x0: 100, x1: 200, y0: 70, y1: 100 });
  });

  it('accounts for scrolling', () => {
    expect(hit(10, 45, { scrollLeft: 250, scrollTop: 300 })).toMatchObject({ region: 'cell', row: 10, col: 2, x0: -50 });
  });

  it('puts frozen panes on top of scrolled content', () => {
    const o = { scrollLeft: 250, scrollTop: 300, frozenColumns: 1, frozenRows: 2 };
    expect(hit(50, 45, o)).toMatchObject({ region: 'cell', row: 0, col: 0 });
    expect(hit(150, 45, o)).toMatchObject({ region: 'cell', row: 0, col: 4 }); // content x 400
    expect(hit(50, 150, o)).toMatchObject({ region: 'cell', row: 13, col: 0 });
  });

  it('finds header cells', () => {
    expect(hit(150, 10)).toMatchObject({ region: 'header', row: -1, col: 1 });
  });

  it('finds the resize handle on either side of a column edge', () => {
    expect(hit(100 - RESIZE_HANDLE, 10)).toMatchObject({ region: 'resize', col: 0 });
    expect(hit(100 + RESIZE_HANDLE, 10)).toMatchObject({ region: 'resize', col: 0 });
    expect(hit(100 + RESIZE_HANDLE + 1, 10)).toMatchObject({ region: 'header', col: 1 });
  });

  it('offers the frozen edge, not a hidden scrolled edge', () => {
    // Scrolled 50px: column 1's right edge is at 150; column 0 (frozen) ends at 100.
    const o = { scrollLeft: 50, frozenColumns: 1 };
    expect(hit(102, 10, o)).toMatchObject({ region: 'resize', col: 0 });
    expect(hit(148, 10, o)).toMatchObject({ region: 'resize', col: 1 });
  });

  it('respects resizable: false', () => {
    const cols = columns.map((c, i) => (i === 0 ? { ...c, resizable: false } : c));
    expect(hit(100, 10, {}, cols)).toMatchObject({ region: 'header', col: 1 });
  });

  it('misses outside the content', () => {
    expect(hit(-1, 50).region).toBe('none');
    expect(hit(460, 50).region).toBe('none');
    expect(hit(50, 50, { scrollLeft: 600 }).region).toBe('cell');
    expect(hit(449, 50, { scrollLeft: 600 }).region).toBe('none'); // past the last column
  });
});
