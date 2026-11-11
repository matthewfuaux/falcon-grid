import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { selectionToClipboard } from '../src/clipboard';
import {
  clampRange,
  colRange,
  coveredSpans,
  extendRange,
  extentOf,
  moveCell,
  rangeOf,
  rowRange,
  selectionContains,
  tabCell,
} from '../src/selection';
import type { ColumnDef } from '../src/types';

const d = { rows: 100, cols: 10, page: 20 };
const at = (row: number, col: number) => ({ row, col });

describe('ranges', () => {
  it('normalises either corner order', () => {
    expect(rangeOf(at(5, 7), at(2, 3))).toEqual({ top: 2, left: 3, bottom: 5, right: 7 });
  });

  it('tests containment across several ranges', () => {
    const sel = [rangeOf(at(0, 0), at(1, 1)), colRange(5, 5, 100)];
    expect(selectionContains(sel, 1, 1)).toBe(true);
    expect(selectionContains(sel, 99, 5)).toBe(true);
    expect(selectionContains(sel, 2, 2)).toBe(false);
  });

  it('clamps to the grid', () => {
    expect(clampRange({ top: -3, left: 8, bottom: 200, right: 20 }, 100, 10)).toEqual({ top: 0, left: 8, bottom: 99, right: 9 });
    expect(clampRange({ top: 150, left: 0, bottom: 160, right: 1 }, 100, 10)).toBeNull();
  });

  it('merges covered spans', () => {
    const sel = [rangeOf(at(0, 0), at(2, 0)), rangeOf(at(3, 4), at(5, 4)), rangeOf(at(10, 1), at(12, 1))];
    expect(coveredSpans(sel, 'rows')).toEqual([[0, 5], [10, 12]]);
    expect(coveredSpans(sel, 'cols')).toEqual([[0, 1], [4, 4]]);
  });
});

describe('extending', () => {
  it('moves the corner opposite the active cell', () => {
    const r = rangeOf(at(5, 5), at(8, 2));
    expect(extentOf(r, at(5, 5))).toEqual(at(8, 2));
    expect(extentOf(r, at(8, 2))).toEqual(at(5, 5));
  });

  it('round-trips: extending to the extent gives the same range (property)', () => {
    fc.assert(
      fc.property(fc.nat(99), fc.nat(9), fc.nat(99), fc.nat(9), (r0, c0, r1, c1) => {
        const active = at(r0, c0);
        const range = rangeOf(active, at(r1, c1));
        expect(extendRange(range, active, extentOf(range, active), d)).toEqual(range);
      }),
    );
  });

  it('keeps whole rows whole when extending down', () => {
    const r = rowRange(4, 4, 10);
    expect(extendRange(r, at(4, 3), at(6, 3), d)).toEqual(rowRange(4, 6, 10));
  });

  it('keeps whole columns whole when extending right', () => {
    const r = colRange(2, 2, 100);
    expect(extendRange(r, at(0, 2), at(0, 4), d)).toEqual(colRange(2, 4, 100));
  });
});

describe('keyboard movement', () => {
  const from = at(50, 5);
  it.each([
    ['ArrowUp', false, at(49, 5)],
    ['ArrowDown', false, at(51, 5)],
    ['ArrowLeft', false, at(50, 4)],
    ['ArrowRight', false, at(50, 6)],
    ['ArrowUp', true, at(0, 5)],
    ['ArrowDown', true, at(99, 5)],
    ['ArrowLeft', true, at(50, 0)],
    ['ArrowRight', true, at(50, 9)],
    ['PageUp', false, at(30, 5)],
    ['PageDown', false, at(70, 5)],
    ['Home', false, at(50, 0)],
    ['End', false, at(50, 9)],
    ['Home', true, at(0, 0)],
    ['End', true, at(99, 9)],
  ] as const)('%s (ctrl %s)', (key, ctrl, expected) => {
    expect(moveCell(from, key, ctrl, d)).toEqual(expected);
  });

  it('stops at the edges', () => {
    expect(moveCell(at(0, 0), 'ArrowUp', false, d)).toEqual(at(0, 0));
    expect(moveCell(at(95, 9), 'PageDown', false, d)).toEqual(at(99, 9));
  });

  it('ignores other keys', () => {
    expect(moveCell(from, 'a', false, d)).toBeNull();
  });

  it('tabs along rows and wraps, and stops past either end', () => {
    expect(tabCell(at(0, 9), false, d)).toEqual(at(1, 0));
    expect(tabCell(at(1, 0), true, d)).toEqual(at(0, 9));
    expect(tabCell(at(99, 9), false, d)).toBeNull();
    expect(tabCell(at(0, 0), true, d)).toBeNull();
  });
});

describe('clipboard', () => {
  const columns: ColumnDef[] = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, width: 100 }));
  const getCell = (r: number, c: number) => `${r}.${c}`;

  it('writes a range as TSV and an HTML table', () => {
    const { text, html } = selectionToClipboard([rangeOf(at(1, 1), at(2, 2))], getCell, columns);
    expect(text).toBe('1.1\t1.2\n2.1\t2.2');
    expect(html).toBe('<table><tr><td>1.1</td><td>1.2</td></tr><tr><td>2.1</td><td>2.2</td></tr></table>');
  });

  it('quotes and escapes special characters', () => {
    const { text, html } = selectionToClipboard([rangeOf(at(0, 0), at(0, 1))], (_r, c) => (c === 0 ? 'a\tb "c"' : '<x&y>'), columns);
    expect(text).toBe('"a\tb ""c"""\t<x&y>');
    expect(html).toContain('<td>&lt;x&amp;y&gt;</td>');
  });

  it('copies only covered columns of several ranges, blank outside them', () => {
    const sel = [rangeOf(at(0, 0), at(1, 0)), rangeOf(at(1, 3), at(1, 3))];
    expect(selectionToClipboard(sel, getCell, columns).text).toBe('0.0\t\n1.0\t1.3');
  });

  it('writes empty values as empty fields', () => {
    expect(selectionToClipboard([rangeOf(at(0, 0), at(0, 2))], (_r, c) => (c === 1 ? null : 'x'), columns).text).toBe('x\t\tx');
  });
});
