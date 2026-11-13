import type { CellRenderer } from '@falcon-grid/core';
import { describe, expect, it } from 'vitest';
import { ColumnDefs, applyOrder, columnHelper, sameColumn, stableColumns, textOf, valueOf, type GridColumn } from '../src/columns';

interface Person {
  name: string;
  age: number;
}

const renderer: CellRenderer<Person> = {
  layout: () => ({ ops: [], regions: [], height: 0 }) as never,
  text: (p) => `${p.name} (${p.age})`,
};

describe('stableColumns', () => {
  it('keeps the previous array when an inline array describes the same columns', () => {
    const make = (): GridColumn<Person>[] => [
      { id: 'name', title: 'Name', width: 120 },
      { id: 'age', value: (p) => p.age * 2 },
    ];
    const a = make();
    expect(stableColumns(a, make())).toBe(a);
  });

  it('takes the new array when a layout field changes', () => {
    const a: GridColumn<Person>[] = [{ id: 'name', width: 120 }];
    const b: GridColumn<Person>[] = [{ id: 'name', width: 121 }];
    expect(stableColumns(a, b)).toBe(b);
    expect(stableColumns(a, [...a, { id: 'age' }])).not.toBe(a);
  });

  it('treats a key accessor change as a change, and a new accessor function as none', () => {
    expect(sameColumn<Person>({ id: 'x', value: 'name' }, { id: 'x', value: 'age' })).toBe(false);
    expect(sameColumn<Person>({ id: 'x', value: (p) => p.name }, { id: 'x', value: (p) => p.age })).toBe(true);
    expect(sameColumn<Person>({ id: 'x', value: 'name' }, { id: 'x', value: (p) => p.name })).toBe(false);
  });
});

describe('applyOrder', () => {
  const cols = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  it('puts listed ids first and keeps the rest in place after them', () => {
    expect(applyOrder(cols, ['c', 'a']).map((c) => c.id)).toEqual(['c', 'a', 'b', 'd']);
  });
  it('ignores unknown ids and returns the input without an order', () => {
    expect(applyOrder(cols, ['x', 'b']).map((c) => c.id)).toEqual(['b', 'a', 'c', 'd']);
    expect(applyOrder(cols, undefined)).toBe(cols);
    expect(applyOrder(cols, [])).toBe(cols);
  });
});

describe('ColumnDefs', () => {
  const columns: GridColumn<Person>[] = [
    { id: 'name', title: 'Name', width: 120, cell: renderer },
    { id: 'age', align: 'right' },
  ];

  it('builds core definitions with default widths', () => {
    const defs = new ColumnDefs<Person>().get(columns, undefined, undefined);
    expect(defs).toEqual([
      { id: 'name', title: 'Name', width: 120, cell: renderer },
      { id: 'age', width: 150, align: 'right' },
    ]);
  });

  it('returns the same array when nothing changed, and reuses unchanged definitions', () => {
    const c = new ColumnDefs<Person>();
    const first = c.get(columns, undefined, undefined);
    // New widths object with no effective change: same array.
    expect(c.get(columns, undefined, {})).toBe(first);
    const resized = c.get(columns, undefined, { age: 90 });
    expect(resized).not.toBe(first);
    expect(resized[0]).toBe(first[0]);
    expect(resized[1]).toEqual({ id: 'age', width: 90, align: 'right' });
  });

  it('applies the order and tracks columns by id', () => {
    const c = new ColumnDefs<Person>();
    const defs = c.get(columns, ['age'], undefined);
    expect(defs.map((d) => d.id)).toEqual(['age', 'name']);
    expect(c.byId.get('name')).toBe(columns[0]);
  });
});

describe('values', () => {
  const p: Person = { name: 'Ada', age: 36 };
  it('reads a key, the id, or a function', () => {
    expect(valueOf<Person>({ id: 'name' }, p, 0)).toBe('Ada');
    expect(valueOf<Person>({ id: 'x', value: 'age' }, p, 0)).toBe(36);
    expect(valueOf<Person>({ id: 'x', value: (r, i) => `${r.name}${i}` }, p, 7)).toBe('Ada7');
    expect(valueOf<Person>({ id: 'name' }, undefined, 0)).toBeUndefined();
  });
  it('uses the cell renderer for text when there is one', () => {
    expect(textOf<Person>({ id: 'p', value: (r) => r, cell: renderer }, p, 0)).toBe('Ada (36)');
    expect(textOf<Person>({ id: 'age' }, p, 0)).toBe('36');
    expect(textOf<Person>({ id: 'missing' }, p, 0)).toBe('');
  });
});

describe('columnHelper', () => {
  it('uses the key as the id, and requires an id for function accessors', () => {
    const col = columnHelper<Person>();
    expect(col.accessor('age', { title: 'Age' })).toEqual({ id: 'age', title: 'Age', value: 'age' });
    const user = col.accessor((r) => r, { id: 'user', cell: renderer });
    expect(user.id).toBe('user');
    expect(user.cell).toBe(renderer);
    expect(() => col.accessor((r) => r.name, {} as { id: string })).toThrow(/needs an id/);
  });

  it('types the cell renderer from the accessor', () => {
    const col = columnHelper<Person>();
    // @ts-expect-error: a Person renderer does not take a number.
    col.accessor('age', { cell: renderer });
    expect(true).toBe(true);
  });
});
