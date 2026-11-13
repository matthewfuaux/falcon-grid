import { cell, row, text } from '@falcon-grid/cells';
import { LRU, type FrameInfo } from '@falcon-grid/core';
import { hash } from '@falcon-grid/datagen';
import { createList } from '@falcon-grid/list';
import { createPretextWrapper } from '@falcon-grid/text';

/**
 * A log viewer over 1,000,000 lines that are never materialised: each line is generated from
 * its index when it scrolls into view. Live tail appends lines and the view follows the bottom
 * until you scroll up. Drag to select text across lines; Ctrl+C copies it.
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const START = Date.UTC(2026, 10, 14, 0, 0, 0);
const LEVELS = ['DEBUG', 'INFO', 'INFO', 'INFO', 'INFO', 'WARN', 'ERROR'] as const;
const TONE = { DEBUG: 'muted', INFO: 'accent', WARN: 'warning', ERROR: 'danger' } as const;
const SERVICES = ['api', 'auth', 'billing', 'search', 'worker', 'gateway', 'cache'];
const PATHS = ['/v1/users', '/v1/orders', '/v1/search', '/v1/invoices', '/healthz', '/v1/sessions'];
const MESSAGES = [
  (h: number) => `GET ${PATHS[h % PATHS.length]} 200 ${(h % 900) + 3}ms`,
  (h: number) => `POST ${PATHS[h % PATHS.length]} 201 ${(h % 400) + 12}ms`,
  (h: number) => `cache miss for key user:${h % 100_000}, fetching from primary`,
  (h: number) => `job ${h.toString(16)} finished in ${(h % 5000) / 100}s`,
  (h: number) => `slow query (${(h % 3000) + 500}ms): SELECT * FROM orders WHERE customer_id = ${h % 50_000} AND status IN ('open', 'pending') ORDER BY created_at DESC LIMIT 50`,
  (h: number) => `retrying upstream request (attempt ${(h % 4) + 1} of 5) after connection reset by peer`,
  (h: number) => `token refreshed for session ${h.toString(36)}`,
  (h: number) => `payload validation failed: field "items[${h % 12}].quantity" must be a positive integer, got ${-(h % 7)}; request rejected with 422 and the client was asked to resubmit`,
];

interface Line {
  ts: string;
  level: (typeof LEVELS)[number];
  service: string;
  msg: string;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
/** Line `i`, generated from its index. Cached so a line keeps its identity while on screen. */
const cache = new LRU<number, Line>(4000);
function line(i: number): Line {
  let l = cache.get(i);
  if (l) return l;
  const h = hash(i, 7);
  const t = new Date(START + i * 37);
  l = {
    ts: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}.${pad(t.getUTCMilliseconds(), 3)}`,
    level: LEVELS[h % LEVELS.length]!,
    service: SERVICES[(h >>> 8) % SERVICES.length]!,
    msg: MESSAGES[(h >>> 12) % MESSAGES.length]!(h >>> 4),
  };
  cache.set(i, l);
  return l;
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const logCell = (wrap: boolean) =>
  cell<Line>(
    (l) =>
      row({ gap: 10, align: 'start' }, [
        text(l.ts, { color: 'muted', width: 92 }),
        text(l.level, { color: TONE[l.level], weight: 600, width: 44 }),
        text(l.service, { color: 'muted', width: 60 }),
        text(l.msg, { flex: 1, wrap }),
      ]),
    { text: (l) => `${l.ts} ${l.level.padEnd(5)} ${l.service.padEnd(8)} ${l.msg}` },
  );
const cells = { flat: logCell(false), wrapped: logCell(true) };

let count = 1_000_000;
const stats = $<HTMLOutputElement>('stats');
let frameMs = 0;
const onFrame = (f: Readonly<FrameInfo>) => {
  frameMs = frameMs * 0.9 + f.durationMs * 0.1;
};

const list = createList<Line>($('list'), {
  itemCount: count,
  getItem: (i) => (i < count ? line(i) : undefined),
  item: cells.flat,
  itemHeight: 20,
  textWrapper: createPretextWrapper(),
  stickToBottom: true,
  theme: { fontFamily: MONO, fontSize: 12, lineHeight: 18, cellPaddingY: 1 },
  ariaLabel: 'Log lines',
  onFrame,
});

// Live tail: lines arrive in small batches; the view follows while it is at the bottom.
let tail = 0;
const startTail = () => {
  tail = window.setInterval(() => {
    count += 10;
    list.update({ itemCount: count });
  }, 50);
};
const tailEl = $<HTMLInputElement>('tail');
tailEl.onchange = () => (tailEl.checked ? startTail() : clearInterval(tail));
startTail();

$<HTMLInputElement>('wrap').onchange = (e) => {
  const wrap = (e.target as HTMLInputElement).checked;
  list.update({ item: wrap ? cells.wrapped : cells.flat, itemHeight: wrap ? 'auto' : 20 });
};

// Find: browser find-in-page cannot see canvas text, so the grid's search stands in.
const findEl = $<HTMLInputElement>('find');
findEl.oninput = () => list.grid.setSearch(findEl.value || null);
const next = () => void list.grid.findNext();
$('next').onclick = next;
findEl.onkeydown = (e) => e.key === 'Enter' && next();

const bottomEl = $<HTMLButtonElement>('bottom');
bottomEl.onclick = () => list.scrollToBottom();
list.element.addEventListener('scroll', () => (bottomEl.hidden = list.isAtBottom()), { passive: true });

setInterval(() => {
  const { start } = list.visibleItems();
  const sel = list.textSelection?.range();
  stats.textContent =
    `${count.toLocaleString('en-US')} lines · line ${(start + 1).toLocaleString('en-US')} · ` +
    `${frameMs.toFixed(2)} ms/frame${sel ? ` · ${sel.end.row - sel.start.row + 1} lines selected` : ''}`;
}, 250);
