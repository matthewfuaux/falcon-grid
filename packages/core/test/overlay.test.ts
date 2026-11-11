import { describe, expect, it } from 'vitest';
import { buildColumnOffsets, computeViewport } from '../src/layout';
import { paintOverlay, type DragIndicator, type OverlayContext } from '../src/overlay';
import { FixedRows } from '../src/rows';
import { defaultTheme } from '../src/theme';
import type { CellRange, CellRef } from '../src/types';

function recorder() {
  const calls: { op: string; args: unknown[]; fill: unknown }[] = [];
  const state: Record<string, unknown> = { fillStyle: '' };
  const ctx = new Proxy(state, {
    get: (_, p: string) => (p in state ? state[p] : (...args: unknown[]) => void calls.push({ op: p, args, fill: state.fillStyle })),
    set: (_, p: string, v) => ((state[p] = v), true),
  }) as unknown as OverlayContext;
  return { ctx, calls, fills: (style: string) => calls.filter((c) => c.op === 'fillRect' && c.fill === style) };
}

const columns = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, width: 100 }));
const offsets = buildColumnOffsets(columns);
const rows = new FixedRows(100, 30);

function paint(o: { selection?: CellRange[]; activeCell?: CellRef | null; hoverCell?: CellRef | null; frozenColumns?: number; drag?: DragIndicator }) {
  const rec = recorder();
  const vp = computeViewport({
    offsets, rows, headerHeight: 40, frozenColumns: o.frozenColumns ?? 0, frozenRows: 0,
    scrollLeft: 0, scrollTop: 0, width: 500, height: 400,
  });
  paintOverlay({
    ctx: rec.ctx, dpr: 1, width: 500, height: 400, vp, offsets, rows, theme: defaultTheme,
    selection: o.selection ?? [], activeCell: o.activeCell ?? null, hoverCell: o.hoverCell ?? null,
    focused: true, drag: o.drag ?? { kind: 'none' },
  });
  return rec;
}

describe('paintOverlay', () => {
  it('clears the layer every paint', () => {
    expect(paint({}).calls[1]).toMatchObject({ op: 'clearRect', args: [0, 0, 500, 400] });
  });

  it('draws a lone active cell as a ring with no fill', () => {
    const { fills } = paint({ selection: [{ top: 2, left: 1, bottom: 2, right: 1 }], activeCell: { row: 2, col: 1 } });
    expect(fills(defaultTheme.focusRing)).toHaveLength(4);
    // Only the header tint uses the selection colour.
    expect(fills(defaultTheme.selectionBackground).map((c) => c.args)).toEqual([[100, 0, 100, 40]]);
  });

  it('fills and borders a range, snapped to device pixels', () => {
    const { fills } = paint({ selection: [{ top: 0, left: 0, bottom: 1, right: 1 }], activeCell: { row: 0, col: 0 } });
    expect(fills(defaultTheme.selectionBackground)).toContainEqual(expect.objectContaining({ args: [0, 40, 200, 60] }));
    expect(fills(defaultTheme.selectionBorder)).toHaveLength(4);
    for (const c of fills(defaultTheme.selectionBorder)) for (const v of c.args as number[]) expect(Number.isInteger(v)).toBe(true);
  });

  it('draws a range crossing the frozen boundary in both panes', () => {
    const { fills } = paint({ selection: [{ top: 0, left: 0, bottom: 0, right: 2 }], frozenColumns: 1 });
    // Header tint + body fill, once per column pane.
    expect(fills(defaultTheme.selectionBackground)).toHaveLength(4);
  });

  it('tints the hovered row, but not while dragging', () => {
    expect(paint({ hoverCell: { row: 3, col: 0 } }).fills(defaultTheme.hoverBackground).map((c) => c.args)).toEqual([[0, 130, 500, 30]]);
    expect(paint({ hoverCell: { row: 3, col: 0 }, drag: { kind: 'resize', x: 100 } }).fills(defaultTheme.hoverBackground)).toHaveLength(0);
  });
});
