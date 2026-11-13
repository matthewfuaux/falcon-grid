import type { CellRenderer, ColumnAlign, ColumnDef } from '@falcon-grid/core';

/** Default column width in CSS pixels. */
export const DEFAULT_WIDTH = 150;

/**
 * A column for `<Grid>`. Layout fields are compared structurally, so an inline `columns` array
 * is fine. Functions (`value`, `editValue`) are always read from the latest props and never
 * reset anything; `cell` is compared by identity, so create renderers once (module scope or
 * `useMemo`).
 */
export interface GridColumn<TRow> {
  id: string;
  title?: string;
  /** Starting width in CSS pixels (default 150). Resizing is tracked by the grid; see `columnWidths`. */
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  align?: ColumnAlign;
  /** Wrap text instead of truncating (needs a `textWrapper`). */
  wrap?: boolean;
  resizable?: boolean;
  reorderable?: boolean;
  /** Sort indicator in the header. The grid does not sort; sort the rows yourself. */
  sort?: 'asc' | 'desc' | null;
  /** What the cell shows: a property of the row, or a function of it. Default `row[id]`. */
  value?: (keyof TRow & string) | ((row: TRow, rowIndex: number) => unknown);
  /** Draws the value with declarative cell primitives instead of as text (`@falcon-grid/cells`). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cell?: CellRenderer<any>;
  /** Allow editing with the grid's editor (needs `onCellEdit` on the grid). Default true when editing is enabled. */
  editable?: boolean;
  /** Text the editor starts with. Default: the cell's text. */
  editValue?: (row: TRow, rowIndex: number) => string;
}

/** The value a column shows for a row. */
export function valueOf<TRow>(column: GridColumn<TRow> | undefined, row: TRow | undefined, rowIndex: number): unknown {
  if (!column || row == null) return undefined;
  const v = column.value;
  if (typeof v === 'function') return v(row, rowIndex);
  return (row as Record<string, unknown>)[v ?? column.id];
}

/** The text a column shows for a row (what copying and the editor use). */
export function textOf<TRow>(column: GridColumn<TRow> | undefined, row: TRow | undefined, rowIndex: number): string {
  const value = valueOf(column, row, rowIndex);
  if (value == null) return '';
  return column?.cell ? column.cell.text(value) : String(value);
}

const LAYOUT_KEYS = [
  'id', 'title', 'width', 'minWidth', 'maxWidth', 'align', 'wrap', 'resizable', 'reorderable', 'sort', 'cell', 'editable',
] as const;

/** Same layout: every field except the functions read through refs. `value` counts if it is a key. */
export function sameColumn<TRow>(a: GridColumn<TRow>, b: GridColumn<TRow>): boolean {
  if (a === b) return true;
  for (const k of LAYOUT_KEYS) if (!Object.is(a[k], b[k])) return false;
  const va = a.value;
  const vb = b.value;
  if (typeof va === 'function' || typeof vb === 'function') return typeof va === typeof vb;
  return va === vb;
}

/** Returns `prev` when `next` describes the same columns, so a new array literal does not count as a change. */
export function stableColumns<TRow>(
  prev: readonly GridColumn<TRow>[] | null,
  next: readonly GridColumn<TRow>[],
): readonly GridColumn<TRow>[] {
  if (!prev || prev.length !== next.length) return next;
  for (let i = 0; i < next.length; i++) if (!sameColumn(prev[i]!, next[i]!)) return next;
  return prev;
}

/** Columns in `order` (ids); ids not in it keep their place after the ordered ones. */
export function applyOrder<T extends { id: string }>(columns: readonly T[], order: readonly string[] | null | undefined): readonly T[] {
  if (!order || order.length === 0) return columns;
  const byId = new Map(columns.map((c) => [c.id, c]));
  const out: T[] = [];
  for (const id of order) {
    const c = byId.get(id);
    if (c) {
      out.push(c);
      byId.delete(id);
    }
  }
  for (const c of columns) if (byId.has(c.id)) out.push(c);
  return out;
}

function toDef<TRow>(c: GridColumn<TRow>, width: number): ColumnDef {
  const d: ColumnDef = { id: c.id, width };
  if (c.title !== undefined) d.title = c.title;
  if (c.minWidth !== undefined) d.minWidth = c.minWidth;
  if (c.maxWidth !== undefined) d.maxWidth = c.maxWidth;
  if (c.align !== undefined) d.align = c.align;
  if (c.wrap !== undefined) d.wrap = c.wrap;
  if (c.resizable !== undefined) d.resizable = c.resizable;
  if (c.reorderable !== undefined) d.reorderable = c.reorderable;
  if (c.sort !== undefined) d.sort = c.sort;
  if (c.cell !== undefined) d.cell = c.cell;
  return d;
}

/**
 * Builds the core's column definitions, reusing the previous definition object for every
 * column that did not change, so the core sees exactly which columns did.
 */
export class ColumnDefs<TRow> {
  private columns: readonly GridColumn<TRow>[] | null = null;
  private order: readonly string[] | null | undefined = undefined;
  private widths: Readonly<Record<string, number>> | undefined = undefined;
  private defs: ColumnDef[] = [];
  private bySource = new Map<GridColumn<TRow>, ColumnDef>();
  /** Columns by id, in display order. */
  byId = new Map<string, GridColumn<TRow>>();

  get(
    columns: readonly GridColumn<TRow>[],
    order: readonly string[] | null | undefined,
    widths: Readonly<Record<string, number>> | undefined,
  ): readonly ColumnDef[] {
    if (columns === this.columns && order === this.order && widths === this.widths) return this.defs;
    this.columns = columns;
    this.order = order;
    this.widths = widths;
    const ordered = applyOrder(columns, order);
    const bySource = new Map<GridColumn<TRow>, ColumnDef>();
    const byId = new Map<string, GridColumn<TRow>>();
    const defs: ColumnDef[] = [];
    let changed = ordered.length !== this.defs.length;
    for (let i = 0; i < ordered.length; i++) {
      const c = ordered[i]!;
      const width = widths?.[c.id] ?? c.width ?? DEFAULT_WIDTH;
      let d = this.bySource.get(c);
      if (!d || d.width !== width) d = toDef(c, width);
      bySource.set(c, d);
      byId.set(c.id, c);
      if (d !== this.defs[i]) changed = true;
      defs.push(d);
    }
    this.bySource = bySource;
    this.byId = byId;
    if (changed) this.defs = defs;
    return this.defs;
  }
}

type ColumnOptions<TRow, V> = Omit<GridColumn<TRow>, 'id' | 'value' | 'cell'> & {
  /** A renderer for this column's value type. */
  cell?: CellRenderer<V>;
};

/**
 * Typed column definitions: the value type flows from the accessor into `cell`.
 *
 * ```ts
 * const col = columnHelper<Person>();
 * const columns = [
 *   col.accessor('name', { title: 'Name' }),
 *   col.accessor((p) => p, { id: 'user', cell: userCell }), // userCell: CellRenderer<Person>
 * ];
 * ```
 */
export function columnHelper<TRow>() {
  function accessor<K extends keyof TRow & string>(key: K, options?: ColumnOptions<TRow, TRow[K]> & { id?: string }): GridColumn<TRow>;
  function accessor<V>(fn: (row: TRow, rowIndex: number) => V, options: ColumnOptions<TRow, V> & { id: string }): GridColumn<TRow>;
  function accessor(
    a: string | ((row: TRow, rowIndex: number) => unknown),
    options: Omit<GridColumn<TRow>, 'id' | 'value'> & { id?: string } = {},
  ): GridColumn<TRow> {
    const id = options.id ?? (typeof a === 'string' ? a : '');
    if (!id) throw new Error('falcon-grid: a column with a function accessor needs an id');
    return { ...options, id, value: a as GridColumn<TRow>['value'] & {} };
  }
  return { accessor };
}
