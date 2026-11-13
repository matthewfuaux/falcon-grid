import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FixedRows, VariableRows } from '../src/rows';

/** Reference model: plain arrays and linear scans. */
class NaiveRows {
  heights: (number | null)[];
  constructor(n: number, public estimate: number) {
    this.heights = new Array(n).fill(null);
  }
  h(r: number) {
    return this.heights[r] ?? this.estimate;
  }
  offsetOf(r: number) {
    let s = 0;
    for (let i = 0; i < r; i++) s += this.h(i);
    return s;
  }
  rowAt(y: number) {
    const n = this.heights.length;
    if (n === 0) return -1;
    let r = 0;
    for (let i = 0; i < n; i++) if (this.offsetOf(i) <= y) r = i;
    return r;
  }
}

describe('FixedRows', () => {
  it('is arithmetic', () => {
    const rows = new FixedRows(100, 30);
    expect(rows.total).toBe(3000);
    expect(rows.offsetOf(10)).toBe(300);
    expect(rows.rowAt(299)).toBe(9);
    expect(rows.rowAt(300)).toBe(10);
    expect(rows.rowAt(-5)).toBe(0);
    expect(rows.rowAt(1e9)).toBe(99);
    expect(new FixedRows(0, 30).rowAt(0)).toBe(-1);
  });
});

describe('VariableRows', () => {
  it('starts at the estimate', () => {
    const rows = new VariableRows(1_000_000, 24);
    expect(rows.total).toBe(24_000_000);
    expect(rows.offsetOf(500_000)).toBe(12_000_000);
    expect(rows.rowAt(12_000_000)).toBe(500_000);
  });

  it('applies measured heights', () => {
    const rows = new VariableRows(10, 20);
    rows.setHeight(2, 50);
    expect(rows.offsetOf(3)).toBe(20 + 20 + 50);
    expect(rows.total).toBe(9 * 20 + 50);
    expect(rows.rowAt(40)).toBe(2);
    expect(rows.rowAt(89)).toBe(2);
    expect(rows.rowAt(90)).toBe(3);
    rows.setHeight(2, 10);
    expect(rows.offsetOf(3)).toBe(50);
    rows.unset(2);
    expect(rows.offsetOf(3)).toBe(60);
    expect(rows.measuredCount).toBe(0);
  });

  it('changes the estimate in O(1), moving only unmeasured rows', () => {
    const rows = new VariableRows(100, 20);
    rows.setHeight(0, 100);
    rows.estimate = 30;
    expect(rows.offsetOf(1)).toBe(100);
    expect(rows.offsetOf(2)).toBe(130);
    expect(rows.total).toBe(100 + 99 * 30);
  });

  it('tracks changed rows until commit', () => {
    const rows = new VariableRows(100, 20);
    rows.commit();
    expect(rows.changedIn(0, 100)).toBe(false);
    rows.setHeight(40, 33);
    expect(rows.changedIn(0, 40)).toBe(false);
    expect(rows.changedIn(40, 41)).toBe(true);
    expect(rows.changedIn(10, 60)).toBe(true);
    rows.commit();
    expect(rows.changedIn(0, 100)).toBe(false);
    // An estimate change affects ranges with unmeasured rows only.
    rows.setHeight(5, 20);
    rows.commit();
    rows.estimate = 25;
    expect(rows.changedIn(5, 6)).toBe(false);
    expect(rows.changedIn(5, 7)).toBe(true);
  });

  it('resizes, keeping measurements', () => {
    const rows = new VariableRows(10, 20);
    rows.setHeight(3, 40);
    rows.setHeight(8, 60);
    rows.resize(5);
    expect(rows.total).toBe(4 * 20 + 40);
    rows.resize(20);
    expect(rows.offsetOf(20)).toBe(19 * 20 + 40);
    expect(rows.offsetOf(4)).toBe(3 * 20 + 40);
    expect(rows.rowAt(60)).toBe(3);
  });

  it('inserts rows, moving measurements with their rows', () => {
    const rows = new VariableRows(5, 20);
    rows.setHeight(0, 50);
    rows.setHeight(4, 70);
    rows.commit();
    rows.insert(0, 3);
    expect(rows.count).toBe(8);
    expect(rows.isMeasured(0)).toBe(false);
    expect(rows.heightOf(3)).toBe(50);
    expect(rows.heightOf(7)).toBe(70);
    expect(rows.offsetOf(3)).toBe(60);
    expect(rows.total).toBe(6 * 20 + 50 + 70);
    expect(rows.changedIn(0, 1)).toBe(true);
    rows.insert(8, 2); // append
    expect(rows.count).toBe(10);
    expect(rows.heightOf(7)).toBe(70);
    rows.insert(4, 1); // middle
    expect(rows.heightOf(3)).toBe(50);
    expect(rows.heightOf(8)).toBe(70);
    expect(rows.rowAt(rows.offsetOf(8))).toBe(8);
  });

  it('matches a naive model under random operations (property)', () => {
    type Op = { kind: 'set'; row: number; h: number } | { kind: 'unset'; row: number } | { kind: 'est'; h: number };
    const n = 64;
    const op = fc.oneof(
      fc.record({ kind: fc.constant('set' as const), row: fc.integer({ min: 0, max: n - 1 }), h: fc.integer({ min: 1, max: 200 }) }),
      fc.record({ kind: fc.constant('unset' as const), row: fc.integer({ min: 0, max: n - 1 }) }),
      fc.record({ kind: fc.constant('est' as const), h: fc.integer({ min: 1, max: 100 }) }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 80 }), fc.array(fc.double({ min: -10, max: 10_000, noNaN: true }), { maxLength: 20 }), (ops: Op[], ys) => {
        const fast = new VariableRows(n, 24);
        const slow = new NaiveRows(n, 24);
        for (const o of ops) {
          if (o.kind === 'set') {
            fast.setHeight(o.row, o.h);
            slow.heights[o.row] = o.h;
          } else if (o.kind === 'unset') {
            fast.unset(o.row);
            slow.heights[o.row] = null;
          } else {
            fast.estimate = o.h;
            slow.estimate = o.h;
          }
        }
        for (let r = 0; r <= n; r++) if (Math.abs(fast.offsetOf(r) - slow.offsetOf(r)) > 1e-6) return false;
        if (Math.abs(fast.total - slow.offsetOf(n)) > 1e-6) return false;
        for (const y of ys) if (fast.rowAt(y) !== slow.rowAt(y)) return false;
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it('rowAt inverts offsetOf (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 1, maxLength: 300 }), (hs) => {
        const rows = new VariableRows(hs.length, 30);
        hs.forEach((h, i) => i % 3 !== 0 && rows.setHeight(i, h));
        for (let r = 0; r < hs.length; r++) {
          const top = rows.offsetOf(r);
          if (rows.rowAt(top) !== r) return false;
          if (rows.rowAt(top + rows.heightOf(r) - 1e-3) !== r) return false;
        }
        return true;
      }),
    );
  });
});
