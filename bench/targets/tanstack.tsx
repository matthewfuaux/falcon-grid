import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type Row,
  type Table,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useReducer, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { HEADER_HEIGHT, ROW_HEIGHT, params, register } from './common';

const t0 = performance.now();
const { data } = params();
const rows = Array.from({ length: data.rowCount }, (_, i) => i);
const columns: ColumnDef<number, string>[] = data.columns.map((c, col) => ({
  id: c.id,
  header: c.title,
  size: c.width,
  accessorFn: (r) => data.get(r, col),
}));

let rerender: () => void = () => {};
let tableRef: Table<number> | null = null;

const cellStyle = {
  position: 'absolute',
  top: 0,
  height: ROW_HEIGHT,
  padding: '0 8px',
  boxSizing: 'border-box',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
  lineHeight: `${ROW_HEIGHT - 1}px`,
  borderRight: '1px solid #d1d9e0',
  borderBottom: '1px solid #d1d9e0',
} as const;

function App() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  rerender = force;
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() });
  tableRef = table;
  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRows = table.getRowModel().rows;
  const leafColumns = table.getVisibleLeafColumns();

  const rowV = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 4,
  });
  const colV = useVirtualizer({
    horizontal: true,
    count: leafColumns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => leafColumns[i]!.getSize(),
    overscan: 2,
  });
  const vCols = colV.getVirtualItems();

  const renderCells = (row: Row<number>) => {
    const cells = row.getVisibleCells();
    return vCols.map((vc) => {
      const cell = cells[vc.index]!;
      return (
        <div key={cell.id} style={{ ...cellStyle, left: vc.start, width: vc.size }}>
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </div>
      );
    });
  };

  return (
    <div ref={scrollRef} style={{ height: '100%', overflow: 'auto', position: 'relative' }}>
      <div style={{ width: colV.getTotalSize(), height: rowV.getTotalSize() + HEADER_HEIGHT, position: 'relative' }}>
        <div style={{ position: 'sticky', top: 0, zIndex: 1, height: HEADER_HEIGHT, background: '#f6f8fa', fontWeight: 600 }}>
          {vCols.map((vc) => {
            const header = table.getFlatHeaders()[vc.index]!;
            return (
              <div key={header.id} style={{ ...cellStyle, height: HEADER_HEIGHT, lineHeight: `${HEADER_HEIGHT - 1}px`, left: vc.start, width: vc.size }}>
                {flexRender(header.column.columnDef.header, header.getContext())}
              </div>
            );
          })}
        </div>
        {rowV.getVirtualItems().map((vr) => {
          const row = tableRows[vr.index]!;
          return (
            <div key={row.id} style={{ position: 'absolute', top: 0, left: 0, height: ROW_HEIGHT, width: colV.getTotalSize(), transform: `translateY(${vr.start + HEADER_HEIGHT}px)` }}>
              {renderCells(row)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

register('tanstack-table+virtual', t0, data, (cells, n) => {
  // TanStack caches accessor values per row; drop the cache for changed rows, then re-render.
  const rowModel = tableRef?.getRowModel().rows;
  for (let i = 0; i < n; i++) {
    const row = rowModel?.[cells[i * 2]!] as unknown as { _valuesCache: Record<string, unknown> } | undefined;
    if (row) row._valuesCache = {};
  }
  rerender();
});
