import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildColumnOffsets,
  computeViewport,
  domToVirtual,
  indexAtOffset,
  scrollExtent,
  virtualToDom,
} from '../src/layout';
import { FixedRows } from '../src/rows';

const cols = (...widths: number[]) => widths.map((width, i) => ({ id: `c${i}`, width }));

describe('buildColumnOffsets', () => {
  it('builds prefix sums', () => {
    expect([...buildColumnOffsets(cols(10, 20, 30))]).toEqual([0, 10, 30, 60]);
  });
  it('reuses the output array when the length matches', () => {
    const out = new Float64Array(3);
    expect(buildColumnOffsets(cols(1, 2), out)).toBe(out);
  });
  it('treats negative widths as zero', () => {
    expect([...buildColumnOffsets(cols(10, -5, 10))]).toEqual([0, 10, 10, 20]);
  });
});

describe('indexAtOffset', () => {
  const offsets = buildColumnOffsets(cols(10, 20, 30));
  it('finds the containing column', () => {
    expect(indexAtOffset(offsets, 0)).toBe(0);
    expect(indexAtOffset(offsets, 9.99)).toBe(0);
    expect(indexAtOffset(offsets, 10)).toBe(1);
    expect(indexAtOffset(offsets, 29)).toBe(1);
    expect(indexAtOffset(offsets, 30)).toBe(2);
  });
  it('clamps outside the range', () => {
    expect(indexAtOffset(offsets, -5)).toBe(0);
    expect(indexAtOffset(offsets, 60)).toBe(2);
    expect(indexAtOffset(offsets, 1e9)).toBe(2);
  });
  it('returns -1 with no columns', () => {
    expect(indexAtOffset(new Float64Array(1), 0)).toBe(-1);
  });
  it('matches a linear scan (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 1, maxLength: 200 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (widths, t) => {
          const o = buildColumnOffsets(cols(...widths));
          const x = t * o[widths.length]! * 0.9999;
          let expected = 0;
          for (let i = 0; i < widths.length; i++) if (o[i]! <= x) expected = i;
          return indexAtOffset(o, x) === expected;
        },
      ),
    );
  });
});

describe('computeViewport', () => {
  const offsets = buildColumnOffsets(cols(...Array.from({ length: 100 }, () => 100)));
  const base = {
    offsets,
    rows: new FixedRows(1_000_000, 30),
    headerHeight: 40,
    frozenColumns: 0,
    frozenRows: 0,
    scrollLeft: 0,
    scrollTop: 0,
    width: 1000,
    height: 640,
  };

  it('covers the viewport at the origin', () => {
    const vp = computeViewport(base);
    expect([vp.colStart, vp.colEnd]).toEqual([0, 10]);
    // 600px of body / 30px = 20 rows
    expect([vp.rowStart, vp.rowEnd]).toEqual([0, 20]);
  });

  it('includes partially visible rows and columns', () => {
    const vp = computeViewport({ ...base, scrollLeft: 50, scrollTop: 15 });
    expect([vp.colStart, vp.colEnd]).toEqual([0, 11]);
    expect([vp.rowStart, vp.rowEnd]).toEqual([0, 21]);
  });

  it('applies overscan within bounds', () => {
    const vp = computeViewport({ ...base, scrollTop: 300, overscan: 3 });
    expect([vp.rowStart, vp.rowEnd]).toEqual([7, 33]);
    expect([vp.colStart, vp.colEnd]).toEqual([0, 13]);
  });

  it('stops at the last row', () => {
    const scrollTop = 40 + 1_000_000 * 30 - 640;
    const vp = computeViewport({ ...base, scrollTop });
    expect(vp.rowEnd).toBe(1_000_000);
    expect(vp.rowStart).toBe(1_000_000 - 20);
  });

  it('starts the body after frozen rows and columns', () => {
    const vp = computeViewport({ ...base, frozenColumns: 2, frozenRows: 3 });
    expect(vp.frozenWidth).toBe(200);
    expect(vp.frozenHeight).toBe(90);
    expect(vp.bodyTop).toBe(130);
    expect(vp.colStart).toBe(2);
    expect(vp.rowStart).toBe(3);
  });

  it('scrolls body rows under frozen rows', () => {
    const vp = computeViewport({ ...base, frozenRows: 3, scrollTop: 300 });
    // body visible from content y = 300 + 90 = 390 -> row 13
    expect(vp.rowStart).toBe(13);
  });

  it('clamps frozen counts', () => {
    const vp = computeViewport({ ...base, rows: new FixedRows(2, 30), frozenRows: 10, frozenColumns: 500 });
    expect(vp.frozenRows).toBe(2);
    expect(vp.frozenColumns).toBe(100);
    expect(vp.colStart).toBe(vp.colEnd);
    expect(vp.rowStart).toBe(vp.rowEnd);
  });

  it('handles empty data', () => {
    const vp = computeViewport({ ...base, offsets: new Float64Array(1), rows: new FixedRows(0, 30) });
    expect(vp.colEnd - vp.colStart).toBe(0);
    expect(vp.rowEnd - vp.rowStart).toBe(0);
  });

  it('every visible row is in range (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 1, max: 80 }),
        fc.integer({ min: 0, max: 5 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 50, max: 2000 }),
        (rowCount, rowHeight, frozenRows, t, height) => {
          const headerHeight = 30;
          const maxScroll = Math.max(0, headerHeight + rowCount * rowHeight - height);
          const scrollTop = t * maxScroll;
          const vp = computeViewport({ ...base, rows: new FixedRows(rowCount, rowHeight), headerHeight, frozenRows, scrollTop, height });
          // Each body row whose screen span intersects [bodyTop, height) must be in [rowStart, rowEnd).
          for (let r = vp.frozenRows; r < rowCount; r++) {
            const top = headerHeight + r * rowHeight - scrollTop;
            const visible = Math.max(top, vp.bodyTop) < Math.min(top + rowHeight, height);
            const inRange = r >= vp.rowStart && r < vp.rowEnd;
            if (visible && !inRange) return false;
            if (top > height) break;
          }
          return vp.rowStart >= vp.frozenRows && vp.rowEnd <= rowCount;
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('scroll scaling', () => {
  const max = 1_000_000;
  it('is the identity under the limit', () => {
    expect(scrollExtent(5000, max)).toBe(5000);
    expect(domToVirtual(123, 5000, 500, max)).toBe(123);
    expect(virtualToDom(123, 5000, 500, max)).toBe(123);
  });

  it('maps the full range proportionally past the limit', () => {
    const content = 30_000_000;
    const view = 800;
    expect(scrollExtent(content, max)).toBe(max);
    expect(domToVirtual(0, content, view, max)).toBe(0);
    expect(domToVirtual(max - view, content, view, max)).toBeCloseTo(content - view, 3);
    expect(virtualToDom(content - view, content, view, max)).toBeCloseTo(max - view, 3);
  });

  it('round-trips (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2_000_000, max: 100_000_000 }),
        fc.integer({ min: 100, max: 4000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (content, view, t) => {
          const v = t * (content - view);
          const back = domToVirtual(virtualToDom(v, content, view, max), content, view, max);
          return Math.abs(back - v) < 1e-3;
        },
      ),
    );
  });
});
