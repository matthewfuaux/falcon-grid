# falcon-grid

A small, open source canvas table and list for React, built to stay inside an 8 ms frame budget on 1M rows × 100 columns. Pre-release, under construction. The roadmap is in [`Canvas Grid for React Build Plan.md`](./Canvas%20Grid%20for%20React%20Build%20Plan.md).

## Status

| Phase                                                       | State                                    |
| ----------------------------------------------------------- | ---------------------------------------- |
| 0. Foundations: monorepo, CI, playground, benchmark harness | done                                     |
| 1. Core renderer: fixed-height read-only table              | done                                     |
| 2. Text engine and variable row heights                     | done                                     |
| 3. Interaction: selection, keyboard, resize, reorder, copy  | done                                     |
| 4. Declarative cells: primitives, display lists, built-ins  | done                                     |
| 5. React API and TanStack adapter                           | done                                     |
| 6. Accessibility: ARIA mirror, focus, keyboard, search      | done; manual screen reader audit pending |
| 7                                                           | not started                              |

## Layout

```
packages/core     framework-agnostic store, scheduler, layout, Canvas 2D renderer,
                  text measurement and truncation, row height model (zero deps)
packages/text     optional wrapping engine over Pretext (needed for `wrap` columns)
packages/cells    declarative cells: layout primitives, compiler to display lists,
                  built-in column types (text, number, date, boolean, tags, link, user)
packages/react    <Grid>, hooks, imperative handle, DOM overlays and a reference editor
packages/tanstack useCanvasTable(table): renders a TanStack Table instance on the canvas
tools/datagen     deterministic synthetic data (1M × 100 without materialising it)
apps/playground   Vite playground for the core
bench             competitor targets + Playwright benchmark harness
```

## React

```tsx
import { Grid, columnHelper } from "@falcon-grid/react";

const col = columnHelper<Person>();
const columns = [
  col.accessor("name", { title: "Name", width: 200 }),
  col.accessor((p) => p, { id: "user", title: "User", cell: userCell }), // userCell: CellRenderer<Person>
];

const getRow = useCallback((i: number) => people[i], [people]);
<Grid
  rowCount={people.length}
  columns={columns}
  getRow={getRow}
  rowHeight="auto"
  frozenColumns={1}
/>;
```

React stays out of the frame loop: scrolling and hovering never render. Columns are compared
structurally, so an inline array is fine; `getRow`'s identity is the data-change signal, so
memoise it (or call `invalidateRows` on the handle for changes in place). Selection, column
widths, column order and scroll position each work controlled (`selection` +
`onSelectionChange`) or uncontrolled (`defaultSelection`). `useGridState(selector)` subscribes
a component to a slice of grid state, `<CellOverlay>` positions DOM over a cell, and
`onCellEdit` turns on the reference text editor (double-click, Enter, F2 or typing).

With TanStack Table, only the render layer changes:

```tsx
import { useCanvasTable } from "@falcon-grid/tanstack";

const table = useReactTable({
  data,
  columns,
  getCoreRowModel: getCoreRowModel(),
});
return <Grid {...useCanvasTable(table)} />;
```

Sizing, ordering, left pinning (as frozen columns) and sorting map both ways. Columns opt in to
declarative cells with `meta: { canvasCell }`; others draw their value as text.

## Accessibility

A transparent DOM mirror gives screen readers a real `role="grid"` with true row and column
counts, real focus on the active cell, and real buttons, links and checkboxes for clickable cell
content. Everything pointer-only has a key, browser find is replaced by `setSearch` and
`findNext`, and the grid follows forced colours, `prefers-contrast` and the browser's text size.
Give every grid a name (`ariaLabel`, or `aria-label` in React). Details, the keyboard
reference and the manual audit script are in [`docs/accessibility.md`](./docs/accessibility.md).

## Commands

```sh
pnpm install
pnpm dev                               # playground at http://localhost:5173
pnpm test                              # unit tests (Vitest, fast-check)
pnpm test:e2e                          # browser tests: paint correctness, interaction, React and TanStack
pnpm typecheck
pnpm size                              # build + gzip budgets (fails over budget)
pnpm bench                             # all targets × all scenarios
pnpm bench --target glide              # one competitor
pnpm bench --target falcon --scenario scroll-y --rows 100000 --dpr 2
```

Benchmark flags: `--target falcon,glide,vtable,tanstack`, `--scenario scroll-y,scroll-x,updates,scroll-y-wrap,scroll-up-wrap,scroll-y-cells,scroll-x-cells`, `--rows`, `--cols`, `--width`, `--height`, `--dpr`, `--budget`, `--headed`, `--software` (headless-shell software canvas instead of a GPU canvas via SwiftShader), `--save-trace`, `--no-build`, `--out`. Reports go to `bench/results/<timestamp>/report.md` and `results.json`. The first run needs `pnpm --filter @falcon-grid/bench exec playwright install chromium`.

## Rendering

Scrolling blits: the existing pixels shift by the scroll delta and only the exposed strip is
painted. Panes that move together are merged into one copy. Data changes repaint only the
invalidated cells. Both paths fall back to a full repaint when the canvas is stale, the
geometry changed, a scroll delta is not a whole number of device pixels, or more than 256 cells
are dirty. Gridlines are filled one-device-pixel rectangles rather than strokes, so a partial
repaint rasterises exactly like a full one; `pnpm test:e2e` checks that on software and GPU
canvas at 1x, 1.5x and 2x.

Antialiased shapes in declarative cells (rounded and outlined rectangles, icons, rounded images)
are rasterised once into a sprite atlas and copied at whole device pixels. Drawing them
directly is not reproducible: Chromium's software rasteriser changes antialiasing when a clip
cuts through a path, and its GPU backend can rasterise a path differently in a one-cell repaint
than in a full one. Text and plain rectangles are drawn directly. `custom` cells draw straight
to the canvas and get no such guarantee.

## Wrapped text and auto row heights

Columns with `wrap: true` wrap instead of truncating; with `rowSizing: 'auto'` rows grow to
fit. Row heights are never all measured up front: unmeasured rows count at an estimate that
learns from measured ones, and a Fenwick tree gives row-to-offset and offset-to-row in
O(log n). Rows are measured as they near the viewport and ahead of it while the browser is
idle. When a measured height differs from its estimate above the viewport, scroll anchoring
keeps the content on screen still. Resizing a wrapped column re-measures and keeps the top row
in place.

```ts
import { createPretextWrapper } from "@falcon-grid/text";

createGrid(el, {
  columns: [{ id: "notes", title: "Notes", width: 320, wrap: true } /* … */],
  rowSizing: "auto",
  textWrapper: createPretextWrapper(),
  /* … */
});
```

## Using the core

```ts
import { createGrid, themeFromCSSVariables } from "@falcon-grid/core";

const grid = createGrid(document.getElementById("grid")!, {
  // the container must have a size
  columns: [
    { id: "name", title: "Name", width: 160 },
    { id: "n", title: "N", width: 80, align: "right" },
  ],
  rowCount: 1_000_000,
  getCell: (row, col) => (col === 0 ? `Row ${row}` : row * 2),
  frozenColumns: 1,
  theme: themeFromCSSVariables(document.documentElement), // reads --fg-background, --fg-row-height, …
});

grid.invalidateCell(12, 3); // one cell changed: repaints just that cell
grid.invalidateRows(10, 20); // some rows changed
grid.invalidate(); // everything changed: full repaint
grid.update({ rowCount: 10 }); // prop changes go through the store
grid.scrollTo({ top: 1e9 });
grid.destroy();
```

## Non-goals for 0.1

Spreadsheet features (formulas, fill handle, merged cells), pivoting and aggregation, charts in cells, WebGL/WebGPU, wrappers for other frameworks, and editing beyond a basic DOM overlay editor hook.

## Licence

MIT

## Interaction

Hover, selection, the active cell and drag indicators are painted on a separate overlay canvas,
so none of them repaint cells. The selection is a list of ranges (`store.selection`); the active
cell (`store.activeCell`) is separate from it.

- **Pointer:** click selects, Shift-click extends, Ctrl/Cmd-click adds a range, drag selects
  (auto-scrolling at the edges). Header click selects columns. Touch scrolls natively; a tap
  selects.
- **Keyboard:** arrows, Page Up/Down, Home/End, with Ctrl/Cmd to jump to the edges and Shift to
  extend. Tab and Shift+Tab move along rows (Tab leaves the grid at the last cell). Escape
  collapses the selection, Ctrl/Cmd+A selects all, Ctrl+Space and Shift+Space select columns and
  rows. The active cell always scrolls into view.
- **Columns:** drag a header edge to resize (`minWidth`/`maxWidth`, default 32 and 2000),
  double-click it to fit the header and the visible cells, drag a header to reorder. Escape
  cancels a drag. Opt out per column with `resizable: false` or `reorderable: false`.
- **Copy:** Ctrl/Cmd+C copies the selection as TSV and an HTML table.
- **Events:** `onCellClick`, `onCellDoubleClick`, `onCellContextMenu`, `onHeaderClick`,
  `onSelectionChange`, `onColumnResize`, `onColumnReorder`, each with the row and column and
  the original DOM event.

Reordering changes column indices, so `getCell(row, col, column)` also receives the column
definition: look data up by `column.id` if columns can move.
