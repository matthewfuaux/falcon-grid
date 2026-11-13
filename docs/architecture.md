# Architecture

A short tour for contributors: what each package does, how a frame happens, and the invariants
the tests protect.

## Packages

```
core       store, scheduler, layout, row model, painters, hit-testing, interaction,
           accessibility mirror, plugin hooks. Zero runtime dependencies.
text       TextWrapper over Pretext, for wrapped text (optional)
cells      declarative cell primitives, the compiler to display lists, built-in column types
list       list mode: createList, text selection and sticky group plugins
react      <Grid>, <List>, hooks, imperative handles, DOM overlays, the reference editor
tanstack   useCanvasTable(table): a TanStack Table instance as <Grid> props
```

The dependencies only point down: `react` → `list` → `core`, and `cells`/`text` → `core`. The
core knows nothing about React, cells or Pretext. It talks to them through small interfaces:
`CellRenderer` (anything that produces a display list), `TextWrapper` and `GridPlugin`.

## One frame

Everything goes through one store and one scheduler (`core/src/store.ts`, `scheduler.ts`):

1. **Input** (scroll, pointer, keys, `update()`, `invalidate*()`) changes the store or marks
   cells dirty. Nothing paints yet.
2. **The store subscription** in `grid.ts` turns changes into dirty flags: `Layout` (sizes,
   columns, theme), `Base` (full repaint), `Scroll`, `Cells`, `Overlay`.
3. **One `requestAnimationFrame` callback** (`run` in `grid.ts`) does the work once:
   - layout: column prefix sums, the row model, the scroll extent, scroll anchoring;
   - auto row heights: measure rows entering the viewport and restore the anchor;
   - base layer (`painter.ts`): a full repaint, or a blit of the scrolled pixels plus the exposed
     strips, plus dirty cells;
   - overlay layer (`overlay.ts`): hover, selection, the focus ring and drag indicators, then
     plugin painting (sticky headers, text selection), cleared and redrawn every time.
4. **The accessibility mirror** (`a11y.ts`) rebuilds 100 ms after things settle, never per
   frame. Focus moves are applied at once.

## Geometry

- **Columns:** prefix sums in a `Float64Array` with a binary search (`layout.ts`).
- **Rows:** `FixedRows` is arithmetic. `VariableRows` keeps two Fenwick trees over measured
  rows (heights and counts), so unmeasured rows count at a learned estimate and both lookups
  are O(log n) (`rows.ts`). Changing the estimate is O(1).
- **Scrolling** uses a native scroller with a spacer. Past the browser's element size limit,
  `ScrollAxis` (`scroll.ts`) maps DOM positions to virtual ones: relative input moves 1:1 and
  absolute input maps proportionally.
- **Anchoring:** before heights change, the grid records the row at the top and how far into
  it the view is, then restores that afterwards. `insertRows` shifts the anchor with its row.
  `stickToBottom` pins the anchor to the end instead.

## Painting

The base painter paints device-pixel-aligned **areas**: the whole viewport, the strips a
scroll blit exposed, or dirty cells. Within an area the order is always the same: backgrounds,
gridlines as one path, cell content, header text, frozen dividers. That way an area repaint
produces the same pixels as a full repaint. The e2e suite checks this on software and GPU
canvas at several pixel ratios.

Declarative cells compile once per value and width to a **display list** (`display.ts`): rects,
text runs, paths, images, custom ops, plus hit regions. The painter paints lists op index by op
index across a column, so consecutive draws share state. Antialiased shapes go through a
sprite atlas (`sprites.ts`) so every paint path rasterises them identically.

## Interaction and plugins

`interaction.ts` turns pointer and key events into store changes (selection, active cell,
hover) and host calls (resize, reorder, copy). Hit-testing (`hittest.ts`) maps a point to a
region, row and column, and then to a cell's interactive region.

Plugins (`plugin.ts`) are how optional behaviour stays out of the core bundle. A plugin can
paint on the overlay, adjust hit-tests, take over a pointer drag, handle keys and supply
copied text. The host gives it the viewport, cell values, display lists, the theme and
`paintRow`, which draws a row anywhere through the base painter. The list package's sticky
headers and text selection are plugins.

## React

`<Grid>` and `<List>` create the core once, in a layout effect, and push changed props into it
after each render. Columns are compared structurally and callbacks are read through refs, so
inline props don't reset anything. Scrolling and hovering never set React state. Components
that need grid state subscribe to a slice with `useGridState`.

## Invariants the tests protect

- Incremental paints match full repaints pixel for pixel (`e2e/render.spec.ts`, `rows.spec.ts`).
- No React commits during scroll or hover (`e2e/react.spec.ts`, `list.spec.ts`).
- The row model matches a naive model under random operations (`core/test/rows.test.ts`).
- Bundle sizes stay inside `.size-limit.json`.
- The default theme passes WCAG AA contrast (`core/test/theme.test.ts`), and axe finds nothing
  on the mirror (`e2e/a11y.spec.ts`).

## Where to start

- A rendering bug: `painter.ts`, then `display.ts` for declarative cells.
- Scrolling or row heights: `grid.ts` (anchoring, measurement), `rows.ts`, `scroll.ts`.
- A cell primitive: `cells/src/nodes.ts` (the API) and `compile.ts` (layout and ops).
- Keyboard or screen readers: `interaction.ts` and `a11y.ts`.
