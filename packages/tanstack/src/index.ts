import type { CellRenderer } from '@falcon-grid/core';
import { stableColumns, type GridColumn, type GridProps } from '@falcon-grid/react';
import type { Column, Row, RowData, Table } from '@tanstack/table-core';
import { useCallback, useRef } from 'react';

declare module '@tanstack/table-core' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /**
     * Draws this column's cells with declarative cell primitives (`@falcon-grid/cells`). It gets
     * the column's value (`row.getValue(id)`). Without it the value is drawn as text.
     */
    canvasCell?: CellRenderer<TValue>;
    /** Header text on the canvas. Default: `header` when it is a string, else the column id. */
    canvasTitle?: string;
  }
}

/** The `<Grid>` props `useCanvasTable` provides. Spread them, then add your own. */
export type CanvasTableProps<TData> = Required<
  Pick<
    GridProps<Row<TData>>,
    | 'rowCount'
    | 'getRow'
    | 'columns'
    | 'columnWidths'
    | 'onColumnWidthsChange'
    | 'columnOrder'
    | 'onColumnOrderChange'
    | 'frozenColumns'
    | 'onHeaderClick'
  >
>;

/**
 * A TanStack column as a grid column. Width is left out (it goes through `columnWidths`), so
 * the column stays the same object while it is being resized.
 */
export function toGridColumn<TData>(column: Column<TData, unknown>): GridColumn<Row<TData>> {
  const def = column.columnDef;
  const meta = def.meta;
  const c: GridColumn<Row<TData>> = {
    id: column.id,
    title: meta?.canvasTitle ?? (typeof def.header === 'string' ? def.header : column.id),
    resizable: column.getCanResize(),
    sort: column.getIsSorted() || null,
    value: (row) => row.getValue(column.id),
  };
  if (def.minSize !== undefined) c.minWidth = def.minSize;
  if (def.maxSize !== undefined) c.maxWidth = def.maxSize;
  if (meta?.canvasCell) c.cell = meta.canvasCell;
  return c;
}

/**
 * A full column order after the visible columns were reordered: hidden columns keep their
 * slots, and the visible ones fill theirs in the new order.
 */
export function mergeColumnOrder(
  current: readonly string[],
  allIds: readonly string[],
  visibleOrder: readonly string[],
): string[] {
  const known = new Set(allIds);
  const listed = new Set(current);
  const full = [...current.filter((id) => known.has(id)), ...allIds.filter((id) => !listed.has(id))];
  const visible = new Set(visibleOrder);
  let i = 0;
  return full.map((id) => (visible.has(id) ? visibleOrder[i++]! : id));
}

function sameRecord(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Renders a TanStack Table instance on the canvas: maps the row model, visible columns,
 * sizing, ordering, left pinning (as frozen columns) and sort indicators to `<Grid>` props,
 * and writes resizing, reordering and header-click sorting back to the table's state.
 *
 * ```tsx
 * const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() });
 * return <Grid {...useCanvasTable(table)} />;
 * ```
 *
 * Right-pinned columns are shown last but do not stay frozen.
 */
export function useCanvasTable<TData>(table: Table<TData>): CanvasTableProps<TData> {
  const tableRef = useRef(table);
  tableRef.current = table;
  const prev = useRef<{
    columns: readonly GridColumn<Row<TData>>[] | null;
    widths: Readonly<Record<string, number>>;
    order: readonly string[];
  }>({ columns: null, widths: {}, order: [] });

  // Not `getVisibleLeafColumns()`: that ignores pinning, and frozen columns must come first.
  const visible = [
    ...table.getLeftVisibleLeafColumns(),
    ...table.getCenterVisibleLeafColumns(),
    ...table.getRightVisibleLeafColumns(),
  ];
  const p = prev.current;
  const columns = stableColumns(p.columns, visible.map(toGridColumn));
  const widths = Object.fromEntries(visible.map((c) => [c.id, c.getSize()]));
  const order = visible.map((c) => c.id);
  p.columns = columns;
  if (!sameRecord(p.widths, widths)) p.widths = widths;
  if (!sameList(p.order, order)) p.order = order;

  const rows = table.getRowModel().rows;
  const getRow = useCallback((i: number): Row<TData> | undefined => rows[i], [rows]);

  const onColumnWidthsChange = useCallback<CanvasTableProps<TData>['onColumnWidthsChange']>((_, { columnId, width }) => {
    tableRef.current.setColumnSizing((old) => ({ ...old, [columnId]: width }));
  }, []);
  const onColumnOrderChange = useCallback<CanvasTableProps<TData>['onColumnOrderChange']>((visibleOrder) => {
    const t = tableRef.current;
    const all = t.getAllLeafColumns().map((c) => c.id);
    t.setColumnOrder((old) => mergeColumnOrder(old, all, visibleOrder));
  }, []);
  const onHeaderClick = useCallback<CanvasTableProps<TData>['onHeaderClick']>(({ column, event }) => {
    tableRef.current.getColumn(column.id)?.getToggleSortingHandler()?.(event);
  }, []);

  return {
    rowCount: rows.length,
    getRow,
    columns,
    columnWidths: p.widths,
    onColumnWidthsChange,
    columnOrder: p.order,
    onColumnOrderChange,
    frozenColumns: table.getLeftVisibleLeafColumns().length,
    onHeaderClick,
  };
}
