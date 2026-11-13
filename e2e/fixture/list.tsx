import { cell, row, stack, text } from '@falcon-grid/cells';
import { createList, type ListItemEvent } from '@falcon-grid/list';
import { List, type ListHandle } from '@falcon-grid/react';
import { createPretextWrapper } from '@falcon-grid/text';
import { Profiler, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * List fixture. Query flags:
 *   n=…      item count (default 2000)
 *   bottom   stick to bottom
 *   groups   a header item every 25 items, sticky
 *   react    render with <List> (prepends through `itemKey`) instead of createList
 */
const q = new URLSearchParams(location.search);
const N = Number(q.get('n') ?? 2000);
const GROUP = 25;
const groups = q.has('groups');

interface Msg {
  id: number;
  header?: string;
  author: string;
  body: string;
}

const WORDS = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua'.split(' ');
/** Deterministic message `id`: one to five lines of text at the fixture width. */
const message = (id: number): Msg => {
  if (groups && id % GROUP === 0) return { id, header: `Day ${id / GROUP}`, author: '', body: '' };
  const words = 2 + ((id * 7) % 23) * ((id % 5) + 1);
  let body = `m${id}`;
  for (let w = 0; w < words; w++) body += ` ${WORDS[(id + w * 13) % WORDS.length]}`;
  return { id, author: `User ${id % 7}`, body };
};

const msgCell = cell<Msg>((m) =>
  m.header
    ? row({ justify: 'center' }, [text(m.header, { weight: 700 })])
    : stack({ gap: 2 }, [text(m.author, { weight: 600 }), text(m.body, { wrap: true })]),
);

const wrapper = createPretextWrapper();
const events: [string, Record<string, unknown>][] = [];
const onItemClick = (e: ListItemEvent<Msg>) => events.push(['click', { index: e.index, id: e.item?.id }]);

/** Items are a window [first, first + count) of message ids, so prepends are real. */
let first = 0;
let count = N;
const ids = { first: () => first, count: () => count };

const root = document.getElementById('root')!;
let commits = 0;

if (q.has('react')) {
  let setRange: (r: { first: number; count: number }) => void = () => {};
  function App() {
    const [range, set] = useState({ first: 0, count: N });
    setRange = set;
    const getItem = useCallback((i: number) => (i < range.count ? message(range.first + i) : undefined), [range]);
    return (
      <Profiler id="list" onRender={() => commits++}>
        <List
          ref={(h: ListHandle | null) => void (h && Object.assign(window, { listHandle: h }))}
          itemCount={range.count}
          getItem={getItem}
          itemKey={(i) => range.first + i}
          item={msgCell}
          textWrapper={wrapper}
          stickToBottom={q.has('bottom')}
          onItemClick={onItemClick}
          aria-label="Messages"
        />
      </Profiler>
    );
  }
  createRoot(root).render(<App />);
  Object.assign(window, {
    prepend(n: number) {
      first -= n;
      count += n;
      setRange({ first, count });
    },
    append(n: number) {
      count += n;
      setRange({ first, count });
    },
  });
} else {
  const list = createList<Msg>(root, {
    itemCount: N,
    getItem: (i) => (i < count ? message(first + i) : undefined),
    item: msgCell,
    textWrapper: wrapper,
    stickToBottom: q.has('bottom'),
    ...(groups ? { groupOf: (i: number) => { const id = first + i; return id - (((id % GROUP) + GROUP) % GROUP) - first; } } : {}),
    onItemClick,
    ariaLabel: 'Messages',
  });
  Object.assign(window, {
    list,
    prepend(n: number) {
      first -= n;
      count += n;
      list.insertItems(0, n);
    },
    append(n: number) {
      count += n;
      list.update({ itemCount: count });
    },
  });
}
Object.assign(window, { events, ids, get commits() { return commits; }, ready: true });
