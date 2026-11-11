# falcon-grid

A small, open source canvas table and list for React, built to stay inside an 8 ms frame budget on 1M rows × 100 columns. Pre-release, under construction. The roadmap is in [`Canvas Grid for React Build Plan.md`](./Canvas%20Grid%20for%20React%20Build%20Plan.md).

## Status

| Phase                                                       | State       |
| ----------------------------------------------------------- | ----------- |
| 0. Foundations: monorepo, CI, playground, benchmark harness | done        |
| 1. Core renderer: fixed-height read-only table              | done        |
| 2. Text engine and variable row heights                     | done        |
| 3–7                                                         | not started |

## Layout

```
packages/core     framework-agnostic store, scheduler, layout, Canvas 2D renderer,
                  text measurement and truncation, row height model (zero deps)
packages/text     optional wrapping engine over Pretext (needed for `wrap` columns)
tools/datagen     deterministic synthetic data (1M × 100 without materialising it)
apps/playground   Vite playground for the core
bench             competitor targets + Playwright benchmark harness
```

## Commands

```sh
pnpm install
pnpm dev                               # playground at http://localhost:5173
pnpm test                              # unit tests (Vitest, fast-check)
pnpm test:e2e                          # browser tests: incremental paint == full repaint, pixel for pixel
pnpm typecheck
pnpm size                              # build + gzip budgets (fails over budget)
pnpm bench                             # all targets × all scenarios
pnpm bench --target glide              # one competitor
pnpm bench --target falcon --scenario scroll-y --rows 100000 --dpr 2
```

Benchmark flags: `--target falcon,glide,vtable,tanstack`, `--scenario scroll-y,scroll-x,updates`, `--rows`, `--cols`, `--width`, `--height`, `--dpr`, `--budget`, `--headed`, `--software` (headless-shell software canvas instead of a GPU canvas via SwiftShader), `--save-trace`, `--no-build`, `--out`. Reports go to `bench/results/<timestamp>/report.md` and `results.json`. The first run needs `pnpm --filter @falcon-grid/bench exec playwright install chromium`.

## Rendering

Scrolling blits: the existing pixels shift by the scroll delta and only the exposed strip is
painted. Panes that move together are merged into one copy. Data changes repaint only the
invalidated cells. Both paths fall back to a full repaint when the canvas is stale, the
geometry changed, a scroll delta is not a whole number of device pixels, or more than 256 cells
are dirty. Gridlines are filled one-device-pixel rectangles rather than strokes, so a partial
repaint rasterises exactly like a full one; `pnpm test:e2e` checks that on software and GPU
canvas at 1x, 1.5x and 2x.

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

claude --ide --resume 81f7fb3f-f518-4c04-8234-5d70d5c8145a
