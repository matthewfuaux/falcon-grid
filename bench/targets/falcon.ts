import {
  dateColumn,
  linkColumn,
  numberColumn,
  tagsColumn,
  textColumn,
  userColumn,
} from '@falcon-grid/cells';
import { createGrid, type ColumnDef } from '@falcon-grid/core';
import type { SyntheticColumn } from '@falcon-grid/datagen';
import { createPretextWrapper } from '@falcon-grid/text';
import { HEADER_HEIGHT, ROW_HEIGHT, params, register } from './common';

const t0 = performance.now();
const { data } = params();
const internalFrames: number[] = [];
// ?wrap: medium and long text columns wrap, and rows size to fit them.
const wrap = new URLSearchParams(location.search).has('wrap');
// ?cells: every column is a built-in declarative column type.
const cells = new URLSearchParams(location.search).has('cells');
const TONES: Record<string, 'success' | 'warning' | 'danger' | 'accent' | 'muted'> = {
  Active: 'success', Pending: 'warning', Blocked: 'danger', Done: 'accent', Archived: 'muted',
};
function declarative(c: SyntheticColumn): ColumnDef {
  const o = { id: c.id, title: c.title, width: c.width };
  switch (c.kind) {
    case 'id': return numberColumn({ ...o, format: { useGrouping: false } });
    case 'name': return userColumn(o);
    case 'email': return linkColumn({ ...o, href: (v) => `mailto:${String(v)}` });
    case 'number': return numberColumn({ ...o, locale: 'en-US' });
    case 'currency': return numberColumn({ ...o, locale: 'en-US', format: { style: 'currency', currency: 'USD' } });
    case 'date': return dateColumn({ ...o, locale: 'en-US' });
    case 'status': return tagsColumn({ ...o, tone: (t) => TONES[t] ?? 'muted' });
    case 'short': return tagsColumn(o);
    case 'medium':
    case 'long': return textColumn({ ...o, wrap });
  }
}
const columns: ColumnDef[] = data.columns.map((c) =>
  cells ? declarative(c) : wrap && (c.kind === 'medium' || c.kind === 'long') ? { ...c, wrap: true } : c,
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
