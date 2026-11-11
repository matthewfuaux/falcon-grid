import '@glideapps/glide-data-grid/dist/index.css';
import {
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type GridCell,
  type GridColumn,
  type Item,
} from '@glideapps/glide-data-grid';
import { useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { HEADER_HEIGHT, ROW_HEIGHT, params, register } from './common';

const t0 = performance.now();
const { data } = params();
const columns: GridColumn[] = data.columns.map((c) => ({ id: c.id, title: c.title, width: c.width }));
let editor: DataEditorRef | null = null;

function App() {
  const ref = useRef<DataEditorRef>(null);
  const getCellContent = useCallback(([col, row]: Item): GridCell => {
    const text = data.get(row, col);
    return { kind: GridCellKind.Text, data: text, displayData: text, allowOverlay: false };
  }, []);
  return (
    <DataEditor
      ref={(r) => {
        (ref as { current: DataEditorRef | null }).current = r;
        editor = r;
      }}
      width="100%"
      height="100%"
      columns={columns}
      rows={data.rowCount}
      getCellContent={getCellContent}
      rowHeight={ROW_HEIGHT}
      headerHeight={HEADER_HEIGHT}
      rowMarkers="none"
      smoothScrollX
      smoothScrollY
    />
  );
}

createRoot(document.getElementById('root')!).render(<App />);

const pending: { cell: Item }[] = [];
register('glide-data-grid', t0, data, (cells, n) => {
  pending.length = 0;
  for (let i = 0; i < n; i++) pending.push({ cell: [cells[i * 2 + 1]!, cells[i * 2]!] });
  editor?.updateCells(pending);
});
