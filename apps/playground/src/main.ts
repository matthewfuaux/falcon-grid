import { createGrid, themeFromCSSVariables, type ColumnDef, type FrameInfo, type GetCell } from '@falcon-grid/core';
import { createDataset, startStream, type Dataset } from '@falcon-grid/datagen';
import { createPretextWrapper } from '@falcon-grid/text';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const rowsEl = $<HTMLSelectElement>('rows');
const colsEl = $<HTMLSelectElement>('cols');
const frozenColsEl = $<HTMLInputElement>('frozenCols');
const frozenRowsEl = $<HTMLInputElement>('frozenRows');
const themeEl = $<HTMLSelectElement>('theme');
const streamEl = $<HTMLInputElement>('stream');
const wrapEl = $<HTMLInputElement>('wrap');
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
const getCell: GetCell = (r, _c, column) => data.get(r, dataCol.get(column.id)!);

/**
 * Medium and long text columns wrap when wrapping is on, long ones at the chosen width. Works
 * on the grid's current columns, so widths and order the user changed are kept.
 */
const withWrap = (columns: readonly ColumnDef[]): ColumnDef[] =>
  columns.map((c) => {
    const kind = data.columns[dataCol.get(c.id)!]!.kind;
    const wrap = wrapEl.checked && (kind === 'medium' || kind === 'long');
    return { ...c, wrap, width: wrap && kind === 'long' ? Number(wrapWidthEl.value) : c.width };
  });

const grid = createGrid($('grid'), {
  columns: withWrap(data.columns),
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
  grid.update({ columns: withWrap(data.columns), rowCount: data.rowCount, getCell: (...args) => getCell(...args) }); // a new function: the data changed
  grid.setSelection([], null);
};
const current = () => grid.store.getSnapshot().columns;
wrapEl.onchange = () => grid.update({ columns: withWrap(current()), rowSizing: wrapEl.checked ? 'auto' : 'fixed' });
wrapWidthEl.oninput = () => grid.update({ columns: withWrap(current()) });
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
      const position = new Map(grid.store.getSnapshot().columns.map((c, i) => [dataCol.get(c.id)!, i]));
      for (let i = 0; i < n; i++) {
        data.set(cells[i * 2]!, cells[i * 2 + 1]!, values[i]!);
        grid.invalidateCell(cells[i * 2]!, position.get(cells[i * 2 + 1]!)!);
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
