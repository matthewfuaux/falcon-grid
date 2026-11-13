# Migrating from Glide Data Grid

Glide Data Grid and falcon-grid are both canvas grids with a pull-based data model, so most of
a migration is renaming. This guide maps Glide's `DataEditor` (v6) onto falcon-grid's React
`<Grid>` and lists what has no equivalent yet.

## The shape of the change

```tsx
// Glide
<DataEditor
  columns={[{ title: "Name", id: "name", width: 200 }]}
  rows={people.length}
  getCellContent={([col, row]) => ({
    kind: GridCellKind.Text,
    data: people[row].name,
    displayData: people[row].name,
    allowOverlay: true,
  })}
  freezeColumns={1}
/>

// falcon-grid
<Grid
  columns={[{ id: "name", title: "Name", width: 200 }]}
  rowCount={people.length}
  getRow={useCallback((i) => people[i], [people])}
  frozenColumns={1}
  aria-label="People"
/>
```

The main difference is where values come from. Glide asks for a cell object per `[col, row]`.
falcon-grid asks for the **row** (`getRow`) and each column says what it shows: `value` is a
property name (the default is the column `id`) or a function of the row. Columns without a
`cell` renderer draw the value as text.

## Props

| Glide `DataEditor` | falcon-grid `<Grid>` | Notes |
| --- | --- | --- |
| `rows` | `rowCount` | |
| `columns[].title / id / width` | `columns[].title / id / width` | `id` is required. Inline arrays are fine: columns are compared structurally. |
| `getCellContent([col, row])` | `getRow(row)` + `columns[].value` | Memoise `getRow`: its identity is the data-change signal. |
| `rowHeight` (number) | `rowHeight` (number) | |
| `rowHeight` (function) | `rowHeight="auto"` | Heights come from content (wrapped text, cell trees) instead of a function. |
| `headerHeight` | `theme.headerHeight` | |
| `freezeColumns` | `frozenColumns` | `frozenRows` also exists. |
| `gridSelection` / `onGridSelectionChange` | `selection` / `onSelectionChange` | `{ ranges, activeCell }`. Ranges are inclusive `{ top, left, bottom, right }`; whole rows and columns are ranges too (no `CompactSelection`). |
| `onColumnResize(column, newSize)` | `onColumnWidthsChange(widths, change)` | Or leave widths uncontrolled (`defaultColumnWidths`). |
| `onColumnMoved(start, end)` | `onColumnOrderChange(order, change)` | Order is a list of column ids. |
| `onCellClicked(cell, event)` | `onCellClick({ row, col, column, rowData, event })` | Also `onCellDoubleClick`, `onCellContextMenu`, `onHeaderClick`. |
| `onCellEdited(cell, newValue)` | `onCellEdit({ row, rowData, column, value })` | Turns on the reference text editor. Replace it with `editor`. |
| `provideEditor` / overlay editors | `editor` prop, or `<CellOverlay>` | `<CellOverlay row col>` positions any React content over a cell. |
| `getCellsForSelection` | built in | Ctrl/Cmd+C copies TSV and an HTML table. `handle.copySelection()` gives the same data. |
| `theme` | `theme` | Different keys; see below. |
| `smoothScrollX / smoothScrollY` | (always) | Scrolling is pixel-smooth. |
| `onVisibleRegionChanged` | `onScroll` + `handle.getState()` | Or `useGridState(ref, s => …)`. |
| `ref.updateCells([{ cell: [c, r] }])` | `handle.invalidateCell(r, c)` | Also `invalidateRows(start, end)` and `invalidate()`. |
| `ref.scrollTo(col, row)` | `handle.scrollToCell(row, col)` | Note the argument order. `col` can be an index or a column id. |
| `ref.focus()` | `handle.focus()` | |

## Cells

Glide's cell kinds map onto falcon-grid's built-in column types from `@falcon-grid/cells`. They
are ordinary renderers built from public primitives:

| Glide `GridCellKind` | falcon-grid |
| --- | --- |
| `Text` | a plain column, or `textColumn({ wrap })` |
| `Number` | `numberColumn({ format, locale })` |
| `Boolean` | `booleanColumn()`, or a `checkbox` primitive with `onClick` for editing |
| `Uri` | `linkColumn({ href })` |
| `Bubble` | `tagsColumn({ tone })` |
| `Image` | `image` / `avatar` primitives |
| `Loading` | return `null` from `value` while loading, or a `progress` primitive |
| `Markdown`, `Drilldown`, `RowID`, `Protected` | no built-in; compose with `cell()` |

Glide's `customRenderers` (`draw(args, cell)` plus manual hit-testing) become declarative cells.
You describe the cell as a tree of primitives, and clicks, hover states, cursors, tooltips and
accessible controls come from the tree:

```ts
const userCell = cell<User>((u) =>
  row({ gap: 8 }, [
    avatar({ name: u.name, src: u.avatarUrl }),
    text(u.name, { flex: 1 }),
    button({ icon: "more", ariaLabel: `Actions for ${u.name}`, onClick: () => openMenu(u) }),
  ]),
);
// columns: [{ id: "user", title: "User", value: (r) => r.user, cell: userCell }]
```

When you really need raw drawing, the `custom` primitive gives you `draw(ctx, rect)` and an
optional `hitTest`. Give it `text` so copying and screen readers have something.

## Theme

| Glide | falcon-grid |
| --- | --- |
| `bgCell` | `background` |
| `bgCellMedium` (striping) | `rowAltBackground` |
| `textDark` | `foreground` |
| `textMedium`, `textLight` | `mutedForeground` |
| `bgHeader` / `textHeader` | `headerBackground` / `headerForeground` |
| `borderColor` | `gridLine` |
| `accentColor` | `focusRing`, `accent` |
| `accentLight` | `selectionBackground` |
| `fontFamily`, `baseFontStyle` | `fontFamily`, `fontSize`, `fontWeight` |
| `headerFontStyle` | `headerFontWeight` |
| `cellHorizontalPadding` / `cellVerticalPadding` | `cellPaddingX` / `cellPaddingY` |

`themeFromCSSVariables(el)` reads a theme from `--fg-*` CSS variables, if you theme with CSS.

## What you get that Glide doesn't have

- **Auto row heights at scale.** `rowHeight="auto"` with wrapped columns measures rows lazily
  and keeps scrolling anchored. No `rowHeight` function has to measure text.
- **Accessibility.** A DOM mirror with real grid semantics, real focus and real controls. Pass
  `aria-label`.
- **TanStack Table.** `useCanvasTable(table)` renders an existing table instance.
- **List mode.** `<List>` for chat, logs and feeds (see [`list.md`](./list.md)).

## Not there yet

These Glide features have no falcon-grid equivalent in 0.1: row markers (checkbox and number
gutters; build one as a frozen first column), the fill handle, the trailing "add row" row,
column groups, the search UI (falcon-grid has `setSearch` and `findNext` but no built-in box),
paste into ranges, and right-to-left layout.
