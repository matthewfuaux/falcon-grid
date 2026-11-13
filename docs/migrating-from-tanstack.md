# Moving a TanStack Table from DOM to canvas

If you render a TanStack Table v8 instance into a `<table>` (perhaps virtualised with TanStack
Virtual), you can keep the table. Columns, data, sorting, filtering, sizing, ordering and
pinning stay as they are. Only the render layer changes:

```tsx
import { Grid } from "@falcon-grid/react";
import { useCanvasTable } from "@falcon-grid/tanstack";

const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel(), /* … */ });

// Before: <table>{table.getHeaderGroups().map(…flexRender…)}</table>
return <Grid {...useCanvasTable(table)} aria-label="Orders" />;
```

`useCanvasTable` returns the `<Grid>` props for the table's current row model and visible
columns. It writes column resizing, column reordering and header-click sorting back into the
table's state. Spread them, then add your own props (`rowHeight`, `onCellClick`, `theme` and so on).

## What maps

| TanStack | On the canvas |
| --- | --- |
| `getRowModel().rows` | the grid's rows (sorted, filtered, paginated, as the table computes them) |
| visible leaf columns | grid columns |
| `column.getSize()`, `setColumnSizing` | widths, and drag resizing |
| `columnOrder`, `setColumnOrder` | order, and drag reordering (hidden columns keep their slots) |
| left pinning | frozen columns |
| `column.getIsSorted()` | the header's sort arrow; a header click calls the column's sort handler |
| `minSize` / `maxSize`, `enableResizing` | `minWidth` / `maxWidth`, `resizable` |
| `row.getValue(id)` | what the cell shows |

## Cells: from `flexRender` to cell renderers

DOM cells are React elements. Canvas cells are cell renderers: plain functions that return a
tree of layout primitives. Columns opt in through `meta.canvasCell`. Columns without one draw
their value as text, so you can migrate one column at a time.

```tsx
import { cell, row, avatar, text, badge } from "@falcon-grid/cells";

const statusCell = cell<string>((s) => badge(s, { tone: s === "Late" ? "danger" : "success" }));

const columns = [
  columnHelper.accessor("status", {
    header: "Status",
    cell: (info) => <StatusPill value={info.getValue()} />, // still used by any DOM rendering
    meta: { canvasCell: statusCell },
  }),
];
```

A canvas cell gets the column's value, `row.getValue(id)`. If a cell needs more of the row,
make the accessor return it (`columnHelper.accessor((r) => r, { id: "customer", … })`).
Create renderers once, at module scope or in `useMemo`: they cache their layouts.

Interactive DOM cells become primitives with `onClick`: `button`, `link` and `checkbox`. They get
hover and pressed states, cursors, tooltips, and real controls in the accessibility mirror.

Cell layouts are cached by value. A cell that also shows state from outside its value, such as a row
selection checkbox, needs a repaint when that state changes:

```tsx
const selectCell = cell<string>((id) => {
  const row = tableRef.current.getRow(id);
  return checkbox({ checked: row.getIsSelected(), ariaLabel: "Select row", onClick: () => row.toggleSelected() });
});
columnHelper.accessor((o) => o.id, { id: "select", header: "", size: 40, meta: { canvasCell: selectCell } });

// Selection is not part of the cell's value: drop cached layouts when it changes.
useEffect(() => gridRef.current?.invalidate({ remeasure: false }), [rowSelection]);
```

## Headers

Canvas headers are text. A string `header` is used as is, and `meta.canvasTitle` overrides it,
which is useful when `header` is a function or JSX. Header menus and filter inputs belong
outside the grid, or in a DOM overlay. Use `onHeaderClick`, or `onCellContextMenu` for
row menus.

## Styling

CSS classes on cells and rows don't apply to a canvas. Colours, fonts, padding and row height
come from `theme`, or from `--fg-*` CSS variables through `themeFromCSSVariables`. Per-cell
styling (a red number, a muted row) belongs in the cell renderer: `text(v, { color: "danger" })`.

## What changes for users

- **Scrolling is faster** and stays smooth at a million rows. React does not render while
  scrolling.
- **Selection and copy are built in:** click, drag, Shift, Ctrl/Cmd+A and Ctrl/Cmd+C as TSV
  and HTML. Your own row selection (`rowSelection` state) is separate and keeps working.
- **Browser find (Ctrl+F) can't see canvas text.** Wire a search box to
  `handle.grid.setSearch(q)` and `findNext()` (see [`accessibility.md`](./accessibility.md)).
- **Accessibility** comes from the grid's mirror: a `role="grid"` with real focus. Give the grid
  an `aria-label`.

## Not supported yet

- Column groups (`header` groups spanning columns): leaf columns render, groups don't.
- Expanded and grouped rows render as flat rows, with no indentation or expanders. Build an
  expander with a `button` primitive and indent with a `spacer` if you need one.
- Right-pinned columns are shown last but don't stay frozen.
- Footers.
- Cells that render arbitrary React. Use primitives, or a `<CellOverlay>` for the active cell.
