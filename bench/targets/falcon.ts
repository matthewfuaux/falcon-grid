import { createGrid, type ColumnDef } from '@falcon-grid/core';
import { createPretextWrapper } from '@falcon-grid/text';
import { HEADER_HEIGHT, ROW_HEIGHT, params, register } from './common';

const t0 = performance.now();
const { data } = params();
const internalFrames: number[] = [];
// ?wrap: medium and long text columns wrap, and rows size to fit them.
const wrap = new URLSearchParams(location.search).has('wrap');
const columns: ColumnDef[] = data.columns.map((c) =>
  wrap && (c.kind === 'medium' || c.kind === 'long') ? { ...c, wrap: true } : c,
);

const grid = createGrid(document.getElementById('root')!, {
  columns,
  rowCount: data.rowCount,
  getCell: (r, c) => data.get(r, c),
  rowSizing: wrap ? 'auto' : 'fixed',
  ...(wrap ? { textWrapper: createPretextWrapper() } : {}),
  theme: { rowHeight: ROW_HEIGHT, headerHeight: HEADER_HEIGHT },
  onFrame: (info) => {
    if (info.paint !== 'none') internalFrames.push(info.durationMs);
  },
});

register('falcon-grid', t0, data, (cells, n) => grid.invalidateCells(cells, n), {
  internalFrames,
  jumpTo: (fraction) => {
    grid.scrollToRow(Math.floor(data.rowCount * fraction));
  },
});
