# Starter issues

Well-scoped first contributions, ready to file as GitHub issues with the labels shown. Each one
names the files involved and what "done" means. Once filed, the issue tracker is the source of
truth and this file can go.

---

### `removeRows(index, count)` on the grid and `removeItems` on the list

Labels: `good first issue`, `core`, `list`

`grid.insertRows` moves measured heights, the selection and the scroll anchor with their rows.
Removal needs the mirror image, for deleting messages or trimming a log buffer.

- `core/src/rows.ts`: `VariableRows.remove(index, count)`, alongside `insert`.
- `core/src/grid.ts`: `removeRows` next to `insertRows`. Clamp or drop selection ranges and the
  active cell that fall inside the removed rows.
- `list/src/list.ts`: `removeItems`, plus `TextSelection.shiftRows` with a negative count.
- Done: unit tests in `core/test/rows.test.ts` and an e2e test showing the view stays still
  when rows above it are removed.

### `scrollToItem` alignment: `'center'` and `'end'`

Labels: `good first issue`, `list`

`List.scrollToItem(index, align)` supports `'start'` and `'nearest'`. Add `'center'` and
`'end'`, computed from `grid.getRowBounds` or the row model, and the same options on the React
handle. Done: e2e tests in `e2e/list.spec.ts`.

### Keyboard text selection in lists

Labels: `good first issue`, `list`, `accessibility`

Text selection (`list/src/selection.ts`) is pointer-only, apart from Ctrl/Cmd+A. Add
Shift+Up/Down to extend the selection by whole items from the active item, so keyboard users
can copy a span of messages. Done: unit tests with the fake host in `list/test/list.test.ts`,
and a line in `docs/accessibility.md`.

### A row number column helper

Labels: `good first issue`, `cells`

Glide users expect row markers. Add `rowNumberColumn()` to `cells/src/columns.ts`: a narrow,
right-aligned, muted column whose value is the row index plus one. The value comes from
`getCell`, so document how to wire it (`value: (_, i) => i + 1` in React). Done: a unit test,
and a mention in `docs/migrating-from-glide.md`.

### Search box on the playground grid page

Labels: `good first issue`, `playground`

`grid.setSearch` and `findNext` exist, but the main playground page has no search box (the
log viewer does). Add one to `apps/playground/index.html` and `src/main.ts`, with Enter for
next and Shift+Enter for previous.

### Right-pinned columns stay frozen

Labels: `help wanted`, `core`, `tanstack`

TanStack right pinning is shown last but scrolls. Frozen panes on the right need a right
frozen width in `computeViewport` (`core/src/layout.ts`), regions in the painter and overlay,
hit-testing, and the adapter mapping in `tanstack/src/index.ts`. This one is bigger: open a
design comment on the issue before starting.

### Recipe: a context menu with `<CellOverlay>`

Labels: `good first issue`, `docs`

Write `docs/recipes/context-menu.md`: open a menu from `onCellContextMenu` (including
Shift+F10), position it with `<CellOverlay clip={false}>`, and return focus to the grid on
close. Include a playground example or an e2e fixture.
