import {
  booleanColumn,
  button,
  cell,
  dateColumn,
  linkColumn,
  numberColumn,
  progress,
  row,
  tagsColumn,
  text,
  textColumn,
  userColumn,
} from '@falcon-grid/cells';
import { createGrid, themeFromCSSVariables, type ColumnDef, type FrameInfo, type GetCell } from '@falcon-grid/core';
import { createDataset, hash, startStream, type Dataset, type SyntheticColumn } from '@falcon-grid/datagen';
import { createPretextWrapper } from '@falcon-grid/text';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const rowsEl = $<HTMLSelectElement>('rows');
const colsEl = $<HTMLSelectElement>('cols');
const frozenColsEl = $<HTMLInputElement>('frozenCols');
const frozenRowsEl = $<HTMLInputElement>('frozenRows');
const themeEl = $<HTMLSelectElement>('theme');
const streamEl = $<HTMLInputElement>('stream');
const wrapEl = $<HTMLInputElement>('wrap');
const cellsEl = $<HTMLInputElement>('cells');
const wrapWidthEl = $<HTMLInputElement>('wrapWidth');
const statsEl = $<HTMLOutputElement>('stats');

// Rolling window of frame work times.
const samples = new Float64Array(240);
let sampleCount = 0;
let sampleIndex = 0;
let frames = 0;
let lastMode = '';
const onFrame = (info: Readonly<FrameInfo>) => {
  if (info.paint !== 'none') lastMode = info.paint;
  samples[sampleIndex] = info.durationMs;
  sampleIndex = (sampleIndex + 1) % samples.length;
  sampleCount = Math.min(sampleCount + 1, samples.length);
  frames++;
};

let data: Dataset = createDataset(Number(rowsEl.value), Number(colsEl.value));
// Columns can be reordered by dragging headers, so data is looked up by column id.
let dataCol = new Map(data.columns.map((c, i) => [c.id, i]));

// ---- Declarative cells -----------------------------------------------------------------------

/** Rows ticked in the Done column. */
const done = new Set<number>();
const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'accent' | 'muted'> = {
  Active: 'success', Pending: 'warning', Blocked: 'danger', Done: 'accent', Archived: 'muted',
};

/** Extra columns shown with declarative cells, after the ID column. */
const extraColumns = (): ColumnDef[] => [
  booleanColumn({
    id: 'done',
    title: 'Done',
    width: 64,
    onChange: (checked, e) => {
      if (checked) done.add(e.row);
      else done.delete(e.row);
      grid.invalidateCell(e.row, e.col);
    },
  }),
  {
    id: 'progress',
    title: 'Progress',
    width: 140,
    cell: cell<number>((v) =>
      row({ gap: 8 }, [
        progress(v, { flex: 1, tone: v >= 1 ? 'success' : v < 0.25 ? 'danger' : 'accent' }),
        text(`${Math.round(v * 100)}%`, { width: 34, align: 'right', color: 'muted', size: 12 }),
      ]),
    ),
  },
  {
    id: 'actions',
    title: '',
    width: 72,
    resizable: false,
    cell: cell<number>(() =>
      row({ gap: 4 }, [
        button({ icon: 'edit', tooltip: 'Edit', onClick: (e) => console.log('edit row', e.row) }),
        button({ icon: 'more', tooltip: 'More', onClick: (e) => console.log('more for row', e.row) }),
      ]),
    ),
  },
];

/** A data column as a built-in declarative column type. */
function declarative(c: SyntheticColumn, wrap: boolean): ColumnDef {
  const o = { id: c.id, title: c.title, width: c.width };
  switch (c.kind) {
    case 'id': return numberColumn({ ...o, format: { useGrouping: false } });
    case 'name': return userColumn(o);
    case 'email': return linkColumn({ ...o, href: (v) => `mailto:${String(v)}` });
    case 'number': return numberColumn(o);
    case 'currency': return numberColumn({ ...o, format: { style: 'currency', currency: 'USD' } });
    case 'date': return dateColumn(o);
    case 'status': return tagsColumn({ ...o, tone: (t) => STATUS_TONE[t] ?? 'muted' });
    case 'short': return tagsColumn(o);
    case 'medium':
    case 'long': return textColumn({ ...o, wrap });
  }
}

const getCell: GetCell = (r, _c, column) => {
  switch (column.id) {
    case 'done': return done.has(r);
    case 'progress': return (hash(r, 7919) % 101) / 100;
    case 'actions': return r;
    default: return data.get(r, dataCol.get(column.id)!);
  }
};

/** The column definition for an id under the current settings. */
function define(id: string): ColumnDef {
  const extra = extraColumns().find((c) => c.id === id);
  if (extra) return extra;
  const c = data.columns[dataCol.get(id)!]!;
  const wrap = wrapEl.checked && (c.kind === 'medium' || c.kind === 'long');
  const width = wrap && c.kind === 'long' ? Number(wrapWidthEl.value) : c.width;
  return cellsEl.checked ? { ...declarative(c, wrap), width } : { ...c, wrap, width };
}

/**
 * Columns for the current settings. Works from the grid's current columns, so the order and
 * widths the user changed are kept (except long text widths, which follow the slider).
 */
function columnsFor(current: readonly ColumnDef[] | null): ColumnDef[] {
  const ids = current ? current.map((c) => c.id) : data.columns.map((c) => c.id);
  const withExtras = cellsEl.checked
    ? ids.includes('done') ? ids : [ids[0]!, ...extraColumns().map((c) => c.id), ...ids.slice(1)]
    : ids.filter((id) => dataCol.has(id));
  return withExtras.map((id) => {
    const def = define(id);
    const prev = current?.find((c) => c.id === id);
    const kind = dataCol.has(id) ? data.columns[dataCol.get(id)!]!.kind : null;
    const keepWidth = prev && !(wrapEl.checked && kind === 'long');
    return keepWidth ? { ...def, width: prev.width } : def;
  });
}

const grid = createGrid($('grid'), {
  columns: columnsFor(null),
  textWrapper: createPretextWrapper(),
  rowCount: data.rowCount,
  getCell,
  frozenColumns: Number(frozenColsEl.value),
  frozenRows: Number(frozenRowsEl.value),
  onFrame,
  onCellDoubleClick: ({ row, column }) => console.log('double-click', row, column.id),
});

const rebuild = () => {
  data = createDataset(Number(rowsEl.value), Number(colsEl.value));
  dataCol = new Map(data.columns.map((c, i) => [c.id, i]));
  done.clear();
  grid.update({ columns: columnsFor(null), rowCount: data.rowCount, getCell: (...args) => getCell(...args) }); // a new function: the data changed
  grid.setSelection([], null);
};
const current = () => grid.store.getSnapshot().columns;
wrapEl.onchange = () => grid.update({ columns: columnsFor(current()), rowSizing: wrapEl.checked ? 'auto' : 'fixed' });
wrapWidthEl.oninput = () => grid.update({ columns: columnsFor(current()) });
cellsEl.onchange = () => grid.update({ columns: columnsFor(current()) });
rowsEl.onchange = colsEl.onchange = rebuild;
frozenColsEl.oninput = () => grid.update({ frozenColumns: Number(frozenColsEl.value) });
frozenRowsEl.oninput = () => grid.update({ frozenRows: Number(frozenRowsEl.value) });
themeEl.onchange = () => {
  document.documentElement.dataset.theme = themeEl.value;
  grid.update({ theme: themeFromCSSVariables(document.documentElement) });
};
$('jump').onclick = () => grid.scrollTo({ top: Number.MAX_SAFE_INTEGER });

let stopStream: (() => void) | null = null;
streamEl.onchange = () => {
  stopStream?.();
  stopStream = null;
  if (!streamEl.checked) return;
  stopStream = startStream({
    rate: 1000,
    window: () => {
      const { start, end } = grid.visibleRows();
      return { rowStart: start, rowEnd: end, colStart: 0, colEnd: 8 };
    },
    apply: (cells, n, values) => {
      // Data columns to on-screen positions, which differ once columns are reordered.
      const position = new Map(grid.store.getSnapshot().columns.map((c, i) => [dataCol.get(c.id), i]));
      for (let i = 0; i < n; i++) {
        data.set(cells[i * 2]!, cells[i * 2 + 1]!, values[i]!);
        const col = position.get(cells[i * 2 + 1]!);
        if (col !== undefined) grid.invalidateCell(cells[i * 2]!, col);
      }
    },
  });
};

const sorted = new Float64Array(samples.length);
let lastFrames = 0;
let lastTime = performance.now();
setInterval(() => {
  const now = performance.now();
  const fps = ((frames - lastFrames) * 1000) / (now - lastTime);
  lastFrames = frames;
  lastTime = now;
  const view = sorted.subarray(0, sampleCount);
  view.set(samples.subarray(0, sampleCount));
  view.sort();
  const pct = (p: number) => (sampleCount ? view[Math.min(sampleCount - 1, Math.floor(p * sampleCount))]! : 0);
  const row = (grid.visibleRows().start + 1).toLocaleString();
  statsEl.textContent =
    `row ${row} · ${lastMode} · paints/s ${fps.toFixed(0)} · frame p50 ${pct(0.5).toFixed(2)}ms p95 ${pct(0.95).toFixed(2)}ms`;
}, 500);

// Handy for poking at it from the console.
Object.assign(window, { grid });
