import type { CellRenderer } from '@falcon-grid/core';
import {
  createTable,
  getCoreRowModel,
  getSortedRowModel,
  type ColumnDef,
  type Table,
  type TableOptionsResolved,
  type TableState,
  type Updater,
} from '@tanstack/table-core';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { mergeColumnOrder, toGridColumn, useCanvasTable, type CanvasTableProps } from '../src';

interface Person {
  name: string;
  age: number;
}

const data: Person[] = [
  { name: 'Cy', age: 30 },
  { name: 'Ada', age: 36 },
  { name: 'Bo', age: 25 },
];

const ageCell: CellRenderer<number> = {
  layout: () => ({ ops: [], regions: [], height: 0 }) as never,
  text: (n) => `${n} years`,
};

const columns: ColumnDef<Person, any>[] = [
  { accessorKey: 'name', header: 'Name', size: 120, minSize: 60 },
  { accessorKey: 'age', header: () => 'Age', meta: { canvasCell: ageCell } },
  { id: 'note', header: 'Note', accessorFn: (p) => `${p.name}!`, enableResizing: false },
];

/** A table-core instance with its own state, as `useReactTable` would hold it. */
function makeTable(initial: Partial<TableState> = {}): Table<Person> {
  let state = { ...initial } as TableState;
  const options: TableOptionsResolved<Person> = {
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    state,
    onStateChange: (u: Updater<TableState>) => {
      state = typeof u === 'function' ? u(state) : u;
      table.setOptions((o) => ({ ...o, state }));
    },
    renderFallbackValue: null,
  };
  const table = createTable(options);
  state = { ...table.initialState, ...initial };
  table.setOptions((o) => ({ ...o, state }));
  return table;
}

/** Runs the hook once (server rendering runs hooks without a DOM). */
function propsFor(table: Table<Person>): CanvasTableProps<Person> {
  let out: CanvasTableProps<Person> | null = null;
  function Probe() {
    out = useCanvasTable(table);
    return null;
  }
  renderToString(<Probe />);
  return out!;
}

describe('toGridColumn', () => {
  it('maps titles, sizing limits, resizing, sort state and the canvas cell', () => {
    const table = makeTable({ sorting: [{ id: 'age', desc: true }] });
    const [name, age, note] = table.getVisibleLeafColumns().map(toGridColumn);
    expect(name).toMatchObject({ id: 'name', title: 'Name', minWidth: 60, resizable: true, sort: null });
    // A function header cannot be drawn on canvas: the id stands in.
    expect(age).toMatchObject({ id: 'age', title: 'age', sort: 'desc', cell: ageCell });
    expect(note).toMatchObject({ id: 'note', resizable: false });
    expect(name).not.toHaveProperty('width');
  });

  it('reads values through the row model', () => {
    const table = makeTable();
    const row = table.getRowModel().rows[1]!;
    const [name, , note] = table.getVisibleLeafColumns().map(toGridColumn);
    expect((name!.value as (r: typeof row, i: number) => unknown)(row, 1)).toBe('Ada');
    expect((note!.value as (r: typeof row, i: number) => unknown)(row, 1)).toBe('Ada!');
  });
});

describe('mergeColumnOrder', () => {
  it('reorders visible columns and keeps hidden ones in their slots', () => {
    // 'b' is hidden; visible a, c, d become d, a, c.
    expect(mergeColumnOrder(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd'], ['d', 'a', 'c'])).toEqual(['d', 'b', 'a', 'c']);
  });
  it('fills in columns missing from the current order and drops unknown ones', () => {
    expect(mergeColumnOrder(['x', 'c'], ['a', 'b', 'c'], ['b', 'a', 'c'])).toEqual(['b', 'a', 'c']);
  });
});

describe('useCanvasTable', () => {
  it('maps the row model, widths, order and pinning', () => {
    const table = makeTable({ columnPinning: { left: ['age'], right: [] } });
    const p = propsFor(table);
    expect(p.rowCount).toBe(3);
    expect(p.getRow(0)!.original).toBe(data[0]);
    expect(p.columns.map((c) => c.id)).toEqual(['age', 'name', 'note']);
    expect(p.columnOrder).toEqual(['age', 'name', 'note']);
    expect(p.columnWidths).toEqual({ age: 150, name: 120, note: 150 });
    expect(p.frozenColumns).toBe(1);
  });

  it('writes resizing and reordering back to the table state', () => {
    const table = makeTable();
    const p = propsFor(table);
    p.onColumnWidthsChange({ name: 200 }, { columnId: 'name', width: 200, event: new Event('x') });
    expect(table.getState().columnSizing).toEqual({ name: 200 });
    expect(propsFor(table).columnWidths.name).toBe(200);

    table.getColumn('note')!.toggleVisibility(false);
    p.onColumnOrderChange(['age', 'name'], { columnId: 'age', from: 1, to: 0, event: new Event('x') });
    expect(table.getState().columnOrder).toEqual(['age', 'name', 'note']);
    expect(propsFor(table).columns.map((c) => c.id)).toEqual(['age', 'name']);
  });

  it('sorts on header click and shows the indicator', () => {
    const table = makeTable();
    const p = propsFor(table);
    const event = { shiftKey: false, persist() {} } as unknown as MouseEvent;
    p.onHeaderClick({ col: 0, column: p.columns[0]!, event });
    const next = propsFor(table);
    expect(next.columns[0]!.sort).toBe('asc');
    expect(next.getRow(0)!.original.name).toBe('Ada');
  });
});
