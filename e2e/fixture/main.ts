import { createDataset, type SyntheticColumn } from '@falcon-grid/datagen';
import { createGrid, type CellActionEvent, type ColumnDef, type FrameInfo } from '@falcon-grid/core';
import {
  booleanColumn,
  button,
  cell,
  dateColumn,
  linkColumn,
  numberColumn,
  row,
  tagsColumn,
  textColumn,
  userColumn,
} from '@falcon-grid/cells';
import { createPretextWrapper } from '@falcon-grid/text';

const q = new URLSearchParams(location.search);
const data = createDataset(Number(q.get('rows') ?? 100_000), Number(q.get('cols') ?? 40));
const wrap = q.has('wrap');
const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'accent' | 'muted'> = {
  Active: 'success', Pending: 'warning', Blocked: 'danger', Done: 'accent', Archived: 'muted',
};

/** A data column as a built-in declarative column type. */
function declarative(c: SyntheticColumn): ColumnDef {
  const o = { id: c.id, title: c.title, width: c.width };
  switch (c.kind) {
    case 'id': return numberColumn({ ...o, format: { useGrouping: false } });
    case 'name': return userColumn(o);
    case 'email': return linkColumn({ ...o, href: (v) => `mailto:${String(v)}` });
    case 'number': return numberColumn({ ...o, locale: 'en-US' });
    case 'currency': return numberColumn({ ...o, locale: 'en-US', format: { style: 'currency', currency: 'USD' } });
    case 'date': return dateColumn({ ...o, locale: 'en-US' });
    case 'status': return tagsColumn({ ...o, tone: (t) => STATUS_TONE[t] ?? 'muted' });
    case 'short': return tagsColumn(o);
    case 'medium':
    case 'long': return textColumn({ ...o, wrap });
  }
}

// ?cells: data columns use the built-in declarative types, plus action buttons and a checkbox.
const cells = q.has('cells');
// In wrap mode, medium and long text columns wrap and rows grow to fit.
const columns: ColumnDef[] = data.columns.map((c) =>
  cells ? declarative(c) : wrap && (c.kind === 'medium' || c.kind === 'long') ? { ...c, wrap: true } : c,
);
/** Rows whose checkbox is ticked (the 'done' column). */
const done = new Set<number>();
const action = (name: string) => (e: CellActionEvent) => events.push([name, { row: e.row, col: e.col, column: e.column.id }]);
if (cells) {
  columns.push(
    {
      id: 'actions',
      title: 'Actions',
      width: 80,
      cell: cell<number>(() =>
        row({ gap: 4 }, [
          button({ icon: 'edit', tooltip: 'Edit', onClick: action('edit') }),
          button({ icon: 'trash', tooltip: 'Delete', onClick: action('delete') }),
        ]),
      ),
    },
    booleanColumn({
      id: 'done',
      title: 'Done',
      onChange: (checked, e) => {
        if (checked) done.add(e.row);
        else done.delete(e.row);
        grid.invalidateCell(e.row, e.col);
      },
    }),
  );
}

// ?images: user cells carry an avatar image (one shared data URL), loaded by the grid.
const avatarUrl = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 40;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#e8590c';
  ctx.fillRect(0, 0, 40, 40);
  return c.toDataURL('image/png');
})();
const users = new Map<number, { name: string; avatarUrl: string }>();
const images = q.has('images');

const paintLog: (Pick<FrameInfo, 'paint' | 'blitX' | 'blitY' | 'flags' | 'rowsMeasured' | 'overlay'> & { cells: number })[] = [];
// Columns can be reordered, so data is looked up by column id.
const dataCol = new Map(data.columns.map((c, i) => [c.id, i]));
/** Events the grid fired, for interaction tests: [name, detail without the DOM event]. */
const events: [string, Record<string, unknown>][] = [];
const record = (name: string) => (e: { event: Event; column?: ColumnDef }) => {
  const { event: _event, column, ...rest } = e as { event: Event; column?: ColumnDef } & Record<string, unknown>;
  events.push([name, column ? { ...rest, column: column.id } : rest]);
};

const grid = createGrid(document.getElementById('root')!, {
  columns,
  rowCount: data.rowCount,
  getCell: (r, _c, column) => {
    if (column.id === 'actions') return r;
    if (column.id === 'done') return done.has(r);
    const d = dataCol.get(column.id)!;
    if (images && data.columns[d]!.kind === 'name') {
      let u = users.get(r);
      if (!u) users.set(r, (u = { name: data.get(r, d), avatarUrl }));
      return u;
    }
    return data.get(r, d);
  },
  frozenColumns: Number(q.get('frozenColumns') ?? 0),
  frozenRows: Number(q.get('frozenRows') ?? 0),
  rowSizing: wrap || q.has('auto') ? 'auto' : 'fixed',
  ...(wrap ? { textWrapper: createPretextWrapper() } : {}),
  theme: q.has('zebra') ? { rowAltBackground: '#f3f5f8', rowHeight: 27 } : {},
  onFrame: (f) =>
    paintLog.push({
      paint: f.paint, blitX: f.blitX, blitY: f.blitY, flags: f.flags, cells: f.cellsPainted, rowsMeasured: f.rowsMeasured, overlay: f.overlay,
    }),
  onCellClick: record('cellClick'),
  onCellDoubleClick: record('cellDoubleClick'),
  onHeaderClick: record('headerClick'),
  onSelectionChange: record('selectionChange'),
  onColumnResize: record('columnResize'),
  onColumnReorder: record('columnReorder'),
});

/**
 * Diffs two PNG screenshots (as data URLs) on a scratch canvas. The grid's own canvas is never
 * read back: Chrome moves canvases that are read from to the CPU, which changes how text is
 * rasterised and would make the comparison meaningless on GPU.
 */
async function diffImages(a: string, b: string) {
  const load = async (src: string) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    return { w: img.width, data: ctx.getImageData(0, 0, img.width, img.height).data };
  };
  const [x, y] = await Promise.all([load(a), load(b)]);
  let diff = 0;
  let first: [number, number] | null = null;
  let colors = '';
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < x.data.length; i += 4) {
    if (x.data[i] !== y.data[i] || x.data[i + 1] !== y.data[i + 1] || x.data[i + 2] !== y.data[i + 2]) {
      diff++;
      const px = (i / 4) % x.w;
      const py = Math.floor(i / 4 / x.w);
      if (!first) {
        first = [px, py];
        colors = `${x.data.slice(i, i + 3).join(',')} vs full ${y.data.slice(i, i + 3).join(',')}`;
      }
      box[0] = Math.min(box[0]!, px);
      box[1] = Math.min(box[1]!, py);
      box[2] = Math.max(box[2]!, px);
      box[3] = Math.max(box[3]!, py);
    }
  }
  return { diff, first, colors, box, total: x.data.length / 4 };
}

/** Repaints everything from scratch, keeping row measurements so the scroll position holds still. */
function fullRepaint() {
  grid.invalidate({ remeasure: false });
  grid.flush();
}

Object.assign(window, { grid, data, columns, paintLog, events, diffImages, fullRepaint, ready: true });
