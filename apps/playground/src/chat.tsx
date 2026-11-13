import { avatar, badge, cell, row, stack, text } from '@falcon-grid/cells';
import { hash } from '@falcon-grid/datagen';
import { List, type ListHandle } from '@falcon-grid/react';
import { createPretextWrapper } from '@falcon-grid/text';
import { StrictMode, useCallback, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * A chat transcript in React: messages of any length with sticky day headers, older history
 * loaded above as you scroll up (the view stays still), and replies that stream in token by
 * token while the view sticks to the bottom. Streaming updates bypass React: the message is
 * changed in place and only its item is repainted and re-measured.
 */

type Item =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'msg'; key: string; author: string; time: string; body: string; streaming?: boolean };

const HISTORY = 20_000;
const PAGE = 400;
const PER_DAY = 37;
const PEOPLE = ['Ana Lima', 'Ben Okafor', 'Chloé Martin', 'Dev Patel', 'Emi Sato', 'Falcon Bot'];
const WORDS = (
  'the build is green again after the flaky snapshot fix landed and I think we can ship the list ' +
  'mode preview today if the sticky headers hold up under fast scrolling on the low end laptop we ' +
  'measured last week; also the chat demo needs streaming replies so lets wire that up next'
).split(' ');

/** History message `n` (0 is the oldest), generated on demand. */
function historyItems(from: number, to: number): Item[] {
  const out: Item[] = [];
  for (let n = from; n < to; n++) {
    if (n % PER_DAY === 0) {
      const d = new Date(Date.UTC(2026, 0, 1) + (n / PER_DAY) * 86_400_000);
      out.push({ kind: 'day', key: `d${n}`, label: d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' }) });
    }
    const h = hash(n, 3);
    const words = 3 + (h % 9) * ((h >>> 5) % 4 === 0 ? 8 : 1);
    let body = '';
    for (let w = 0; w < words; w++) body += (w ? ' ' : '') + WORDS[(h + w * 5) % WORDS.length];
    const minutes = (n % PER_DAY) * 17 + 480;
    out.push({
      kind: 'msg',
      key: `m${n}`,
      author: PEOPLE[h % (PEOPLE.length - 1)]!,
      time: `${Math.floor(minutes / 60) % 24}:${String(minutes % 60).padStart(2, '0')}`,
      body: body[0]!.toUpperCase() + body.slice(1) + '.',
    });
  }
  return out;
}

const itemCell = cell<Item>((m) =>
  m.kind === 'day'
    ? row({ justify: 'center' }, [badge(m.label, { tone: 'muted' })])
    : row({ gap: 10, align: 'start' }, [
        avatar({ name: m.author, size: 28 }),
        stack({ gap: 2, flex: 1 }, [
          row({ gap: 8 }, [text(m.author, { weight: 600 }), text(m.time, { color: 'muted', size: 11 })]),
          text(m.streaming ? `${m.body} ▍` : m.body, { wrap: true }),
        ]),
      ]),
);

const wrapper = createPretextWrapper();
const now = () => new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false });

function Chat() {
  const list = useRef<ListHandle>(null);
  /** History loaded so far starts at message `loadedFrom`; everything newer is in `items`. */
  const [state, setState] = useState(() => ({ loadedFrom: HISTORY - PAGE, items: historyItems(HISTORY - PAGE, HISTORY) }));
  const [draft, setDraft] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const loading = useRef(false);
  const items = state.items;
  const latest = useRef(items);
  latest.current = items;

  // Header index for every item, for sticky day headers.
  const headerOf = useMemo(() => {
    const out = new Int32Array(items.length);
    let h = -1;
    items.forEach((m, i) => {
      if (m.kind === 'day') h = i;
      out[i] = h;
    });
    return out;
  }, [items]);

  const getItem = useCallback((i: number) => items[i], [items]);
  const itemKey = useCallback((i: number) => items[i]!.key, [items]);
  const groupOf = useCallback((i: number) => headerOf[i] ?? -1, [headerOf]);

  const loadOlder = () => {
    if (loading.current || state.loadedFrom === 0) return;
    loading.current = true;
    // As if from a server.
    setTimeout(() => {
      setState((s) => {
        const from = Math.max(0, s.loadedFrom - PAGE);
        return { loadedFrom: from, items: [...historyItems(from, s.loadedFrom), ...s.items] };
      });
      loading.current = false;
    }, 250);
  };

  /** A reply that streams in word by word, changed in place and repainted without a render. */
  const streamReply = (base: Item[]) => {
    const reply: Item = { kind: 'msg', key: `r${Date.now()}`, author: 'Falcon Bot', time: now(), body: '', streaming: true };
    const words = Array.from({ length: 40 + Math.floor(Math.random() * 80) }, (_, w) => WORDS[(w * 7 + base.length) % WORDS.length]);
    setState((s) => ({ ...s, items: [...s.items, reply] }));
    let w = 0;
    const timer = setInterval(() => {
      if (reply.kind !== 'msg') return;
      reply.body += (w ? ' ' : '') + words[w];
      w++;
      if (w >= words.length) {
        reply.streaming = false;
        clearInterval(timer);
      }
      const index = latest.current.indexOf(reply);
      if (index >= 0) list.current?.invalidateItems(index, index + 1);
    }, 35);
  };

  const send = () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    const mine: Item = { kind: 'msg', key: `u${Date.now()}`, author: 'You', time: now(), body };
    const next = [...items, mine];
    setState((s) => ({ ...s, items: [...s.items, mine] }));
    list.current?.scrollToBottom();
    setTimeout(() => streamReply(next), 400);
  };

  return (
    <>
      <header className="toolbar">
        <nav className="nav">
          <a href="/">Grid</a> <a href="/logs.html">Logs</a> <strong>Chat</strong>
        </nav>
        <button type="button" onClick={() => streamReply(items)}>Stream a reply</button>
        {!atBottom && (
          <button type="button" onClick={() => list.current?.scrollToBottom()}>
            Jump to latest
          </button>
        )}
        <output className="stats">
          {items.length.toLocaleString('en-US')} items loaded{state.loadedFrom > 0 ? ' · scroll up for older' : ' · start of history'}
        </output>
      </header>
      <div style={{ flex: 1, minHeight: 0 }}>
        <List
          ref={list}
          itemCount={items.length}
          getItem={getItem}
          itemKey={itemKey}
          item={itemCell}
          groupOf={groupOf}
          textWrapper={wrapper}
          stickToBottom
          theme={{ cellPaddingX: 16, cellPaddingY: 6 }}
          aria-label="Conversation"
          onScroll={({ top, atBottom }) => {
            setAtBottom(atBottom);
            if (top < 400) loadOlder();
          }}
        />
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Message" aria-label="Message" />
        <button type="submit">Send</button>
      </form>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Chat />
  </StrictMode>,
);
