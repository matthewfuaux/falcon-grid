import { ListTable } from '@visactor/vtable';
import { HEADER_HEIGHT, ROW_HEIGHT, params, register } from './common';

const t0 = performance.now();
const { data } = params();

// VTable wants an array of records. One small object per row with lazy getters on a shared
// prototype keeps 1M rows affordable without materialising 100M strings.
const proto: Record<string, unknown> = {};
data.columns.forEach((c, col) => {
  Object.defineProperty(proto, c.id, {
    get(this: { r: number }) {
      return data.get(this.r, col);
    },
    set(this: { r: number }, v: string) {
      data.set(this.r, col, v);
    },
  });
});
const records = new Array(data.rowCount);
for (let r = 0; r < data.rowCount; r++) {
  const rec = Object.create(proto);
  rec.r = r;
  records[r] = rec;
}

const table = new ListTable({
  container: document.getElementById('root')!,
  columns: data.columns.map((c) => ({ field: c.id, title: c.title, width: c.width })),
  records,
  defaultRowHeight: ROW_HEIGHT,
  defaultHeaderRowHeight: HEADER_HEIGHT,
  widthMode: 'standard',
  heightMode: 'standard',
});

register('vtable', t0, data, (cells, n) => {
  // The dataset already holds the new values; ask VTable to re-render those cells.
  for (let i = 0; i < n; i++) {
    const row = cells[i * 2]!;
    const col = cells[i * 2 + 1]!;
    table.changeCellValue(col, row + 1, data.get(row, col));
  }
});
