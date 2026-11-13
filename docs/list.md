# List mode

`@falcon-grid/list` is a canvas list: the grid's variable-height engine with one full-width
column and no header. Items are declarative cells (or plain text) of any height. Heights are
only measured as items come into view, so a list of a million items mounts as fast as a list of
ten. It is built for chat transcripts, logs and feeds.

Four things set it apart from a plain grid:

- **Stick to bottom.** While the view is at the bottom it stays there as items are appended or
  grow (a streaming message). Once the user scrolls up, new items no longer move the content.
- **Prepending keeps the view still.** Loading older items above doesn't move what is on screen,
  even at the very top.
- **Sticky group headers.** The current group's header stays at the top until the next group's
  header pushes it off.
- **Text selection.** Drag to select text across items, double-click for a word, triple-click
  for an item, Shift+click to extend, Ctrl/Cmd+A for everything. Ctrl/Cmd+C copies plain text.

## React

```tsx
import { cell, avatar, row, stack, text } from "@falcon-grid/cells";
import { List } from "@falcon-grid/react";
import { createPretextWrapper } from "@falcon-grid/text";

const messageCell = cell<Message>((m) =>
  row({ gap: 10, align: "start" }, [
    avatar({ name: m.author }),
    stack({ flex: 1 }, [text(m.author, { weight: 600 }), text(m.body, { wrap: true })]),
  ]),
);
const wrapper = createPretextWrapper();

function Transcript({ messages }: { messages: Message[] }) {
  const getItem = useCallback((i: number) => messages[i], [messages]);
  return (
    <List
      itemCount={messages.length}
      getItem={getItem}
      itemKey={(i) => messages[i]!.id} // recognises prepends
      item={messageCell}
      textWrapper={wrapper}
      stickToBottom
      aria-label="Conversation"
    />
  );
}
```

- `getItem`'s identity is the data-change signal. A new function repaints and re-measures the
  items on screen. Items that change in place (a reply streaming in) should be repainted with
  `ref.current.invalidateItems(i, i + 1)`, which needs no render at all.
- With `itemKey`, adding items at the start is recognised as a prepend: when the old first item
  now sits `n` places down, the list inserts `n` items above and keeps the view still. Without
  `itemKey`, call `ref.current.insertItems(0, n)`.
- `groupOf(index)` turns on sticky headers. It returns the index of the header item of the
  group `index` belongs to (a header returns its own index), or -1. It's called for a few items
  per frame, so make it a lookup, not a scan.
- `onScroll({ top, atBottom })` is the place to load older history or show "jump to latest".
- The handle (`ref`) has `scrollToItem`, `scrollToBottom`, `isAtBottom`, `insertItems`,
  `invalidateItems`, `invalidate`, `getSelectedText`, `clearTextSelection` and `focus`.
- Scrolling, hovering and selecting text never render React.

## Core

```ts
import { createList } from "@falcon-grid/list";

const list = createList(el, {
  itemCount: lines.length,
  getItem: (i) => lines[i],
  itemHeight: 20,            // fixed height; the default 'auto' fits content
  stickToBottom: true,
  ariaLabel: "Build log",
});

list.update({ itemCount: lines.length }); // appended
list.insertItems(0, 200);                 // prepended
list.invalidateItems(n - 1, n);           // the last item changed in place
list.textSelection?.text();               // the selected text
list.grid;                                // the grid underneath, for anything else
```

Without an `item` renderer, items are drawn as text: wrapped when a `textWrapper` is given,
truncated otherwise. Other options are `dividers` (lines between items), `theme`, `textSelection: false`, `onItemClick`,
`onItemDoubleClick`, `onItemContextMenu` and `onTextSelectionChange`.

## Building blocks

The list is a grid with two plugins, both usable on a plain grid through `createGrid`'s
`plugins` option:

- `createTextSelection()` returns `{ plugin, text(), range(), selectAll(), clear(), shiftRows() }`.
  It selects text in one column at a time, from the same text runs the painter draws.
- `stickyGroups(groupOf)` paints the sticky row on the overlay layer and routes pointer hits on
  it to the header row.

Two core features carry the rest, and grids can use them too: `stickToBottom` in the grid
options, and `grid.insertRows(index, count)`. Inserting rows moves measured heights, the
selection and the active cell with their rows, and keeps the content on screen still.

## Accessibility

The mirror is a grid with one column and no header row, so rows are numbered from 1. Arrow
keys move between items and Enter reaches the controls inside one. Text selection is pointer
and Ctrl/Cmd+A only; keyboard users copy whole items with Ctrl/Cmd+C on the active item.

## Limits

- Text selection works on painted text. A truncated line copies as painted unless the whole
  item is selected, in which case the item's full text (the renderer's `text`) is copied.
- A new `getItem` re-measures only the items on screen. Off-screen items that changed in place
  need `invalidateItems`.
- Prepends are recognised only as pure prepends: if items are added at both ends in one update,
  call `insertItems` for the start yourself.
