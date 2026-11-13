# Accessibility

The grid paints on canvas, which assistive technology cannot read. Everything a screen reader,
keyboard user or magnifier needs comes from the **accessibility mirror**: a transparent DOM copy
of the grid's structure kept in the DOM layer above the canvases.

## What is exposed

- A `role="grid"` named by `ariaLabel` / `ariaLabelledBy` (React: `aria-label` /
  `aria-labelledby`). **Always give one.** `aria-rowcount` and `aria-colcount` carry the true
  totals (a header row counts as row 1), and `aria-multiselectable="true"`.
- A header row of `columnheader`s with `aria-sort` on sorted columns. Sort changes are announced.
- Rows and `gridcell`s for what is on screen (frozen panes included) plus the active cell, with
  `aria-rowindex` / `aria-colindex` giving their real position and `aria-selected` their state.
  Mirrored elements sit at their cells' real positions, so a screen reader's highlight and a
  magnifier follow the canvas.
- Cell text: the value as text, or for declarative cells `accessibleText` (the tree's text plus
  checkbox and progress state, without control labels).
- In-cell controls: clickable primitives become real `<button>`s, `<a href>` links and
  `role="checkbox"` elements, named by `ariaLabel`, then their label, tooltip or icon name.
- A polite live region for selection summaries ("3 rows by 2 columns selected"), resize and
  move results, sort changes and anything you pass to `grid.announce()`.

The mirror is rebuilt when scrolling has been quiet for 100 ms, never per frame, so it costs
nothing while scrolling. Focus moves are applied immediately.

## Focus

The active cell's mirror element holds DOM focus (a roving tabindex): Tab enters the grid on the
active cell, moves between cells inside it and leaves past the last one, and screen readers
announce each move natively. The canvas
draws the focus ring; it follows the same cell. `grid.focus()` focuses the active cell, and
`grid.isKeyTarget(e.target)` tells your own key handlers whether an event came from the grid
itself rather than from a control or an editor inside it.

## Keyboard

| Keys | Action |
| --- | --- |
| Arrows, Page Up/Down, Home/End | Move the active cell (Ctrl/Cmd: to the edge) |
| Shift + the above | Extend the selection |
| Ctrl/Cmd+A | Select all |
| Shift+Space, Ctrl+Space | Select rows, columns |
| Tab, Shift+Tab | Next, previous cell; leaves the grid at the ends |
| Escape | Collapse the selection to the active cell |
| Ctrl/Cmd+C | Copy as TSV and HTML |
| Enter | Into the active cell's controls (buttons, links, checkboxes) |
| Space | Toggle the active cell's checkbox when it is the only control |
| Inside a cell: Tab, arrows | Next, previous control |
| Inside a cell: Enter, Space | Activate the control |
| Inside a cell: Escape | Back to the cell |
| Alt+Shift+Left/Right | Narrow, widen the active column by 8 px |
| Alt+Shift+Ctrl/Cmd+Left/Right | Move the active column left, right |
| Alt+Shift+S | Activate the column header (`onHeaderClick`; usually sorting) |
| Shift+F10, ContextMenu key | Context menu for the active cell (`onCellContextMenu`) |

With React and `onCellEdit`, Enter, F2 or typing on a cell without controls opens the editor.

## Find in page

Browser find (Ctrl/Cmd+F) cannot see canvas text, and only the visible window is in the DOM.
Use the grid's search instead, wired to your own search box:

```ts
grid.setSearch('overdue');                 // highlights matching cells on screen
await grid.findNext();                      // active cell to the next match, scrolled into view
await grid.findNext({ backwards: true });
grid.setSearch(null);
```

`findNext` scans the whole data set in time slices, so it stays responsive on large grids, and
resolves to the matched cell or `null`. Matching uses the cell's copy text, case-insensitive
unless `{ caseSensitive: true }`.

## Display settings

- **Forced colours** (Windows contrast themes): the grid paints with the user's system colours
  (`Canvas`, `CanvasText`, `Highlight`, `GrayText`, `LinkText`), over your theme.
- **`prefers-contrast: more`**: `highContrastTheme` applies under your theme: solid lines, darker
  secondary text and tones.
- **`prefers-reduced-motion`**: the grid has no animation; scrolling is always instant.
- **Text size**: theme sizes (font, padding, row and header height) scale with the root font
  size, so the browser's text size setting applies. Column widths and primitive sizes in
  declarative cells do not scale. Browser zoom is handled by the device pixel ratio.

Turn off the first two with `respectUserPreferences: false` and scaling with
`scaleWithRootFont: false`.

The default theme passes WCAG AA, checked in `packages/core/test/theme.test.ts`: text at least
4.5:1 (including badge labels on their tint and text on the selection), the focus ring and
selection border at least 3:1.

## List mode

`<List>` and `createList` use the same mirror with one column and no header row: rows are
numbered from 1 and `aria-rowcount` is the item count. Sticky group headers are painted copies
of the header item, which is mirrored once, in its place. Text selection is a pointer feature,
plus Ctrl/Cmd+A. Ctrl/Cmd+C copies the selected text, or the active item when nothing is
selected.

## Automated checks

- `e2e/a11y.spec.ts` runs axe on the mirror (plain, declarative cells, frozen panes), asserts the
  accessibility tree with an ARIA snapshot, and covers focus, keyboard paths, controls, search
  and display settings.
- `e2e/list.spec.ts` checks the list's mirror (no header row, true item count).
- `packages/core/test/theme.test.ts` checks theme contrast.

## Manual audit

Automated checks cannot tell whether the grid is usable with a screen reader. Each release is
audited by hand with this script on every combination below, on the e2e fixture with declarative
cells: run `pnpm exec vite e2e/fixture` and open `/?cells&cols=4` (100,000 rows, an Actions
column with Edit and Delete buttons, and a Done checkbox column).

**Script**

1. Tab to the grid. The grid's name, its size and the first cell are announced.
2. Read a row: move right across three cells. Each cell's column header and value are announced.
3. Jump: Ctrl+End, then Ctrl+Home. The row and column position are announced.
4. Sort a column: Alt+Shift+S, or in browse mode activate the column header. The new sort is
   announced and the cell under focus is read.
5. Activate an in-cell button: move to the Actions column, Enter, move to Delete, Enter. The
   button is announced by name, and the action happens.
6. Toggle a checkbox: Space on a Done cell. The new state is announced.
7. Select a range and copy: Shift+Down twice, Shift+Right. The selection size is announced.
   Ctrl+C, then paste into a text editor: the cells arrive as tab-separated text.
8. Resize and move a column with Alt+Shift+arrows. The width and position are announced.
9. Browse mode: read the table with the screen reader's table commands (e.g. NVDA Ctrl+Alt+arrows).

**List mode** (open `/list.html?groups&bottom` on the same server):

10. Tab to the list. Its name and the item under focus are announced; there is no header row.
11. Arrow up through several items, across a sticky day header. Each item's text is read.
12. Ctrl+A, then Ctrl+C, then paste: the transcript arrives as plain text, one item per line.

**Results**

| Screen reader | Browser | Date | Result | Notes |
| --- | --- | --- | --- | --- |
| NVDA | Firefox | | not yet run | |
| NVDA | Chrome | | not yet run | |
| JAWS | Chrome | | not yet run | |
| VoiceOver (macOS) | Safari | | not yet run | |

## Known limitations

- Only the visible window and the active cell are in the DOM. Browse-mode reading covers what is
  on screen; scrolling brings in the rest within 100 ms of stopping.
- While scrolling, mirrored positions lag until scrolling settles, so a magnifier tracking the
  screen reader cursor can trail the canvas briefly.
- `custom` primitives are opaque: give them `text` (read and copied) and an `ariaLabel` when
  clickable.
- Header cells are not part of keyboard navigation; their actions have the shortcuts above.
