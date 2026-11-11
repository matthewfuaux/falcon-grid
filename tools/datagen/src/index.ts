/**
 * Deterministic, lazily computed synthetic data. Nothing is materialised: a 1M x 100 dataset
 * costs only the overrides written by streaming updates.
 */

export type ColumnKind =
  | 'id'
  | 'name'
  | 'email'
  | 'number'
  | 'currency'
  | 'date'
  | 'status'
  | 'short'
  | 'medium'
  | 'long';

export interface SyntheticColumn {
  id: string;
  title: string;
  width: number;
  kind: ColumnKind;
  align: 'left' | 'right';
}

const KIND_CYCLE: ColumnKind[] = ['name', 'email', 'number', 'currency', 'date', 'status', 'short', 'medium', 'long'];
const WIDTH: Record<ColumnKind, number> = {
  id: 90,
  name: 160,
  email: 220,
  number: 110,
  currency: 120,
  date: 120,
  status: 110,
  short: 140,
  medium: 220,
  long: 320,
};

export function makeColumns(count: number): SyntheticColumn[] {
  const out: SyntheticColumn[] = [];
  for (let i = 0; i < count; i++) {
    const kind = i === 0 ? 'id' : KIND_CYCLE[(i - 1) % KIND_CYCLE.length]!;
    out.push({
      id: `c${i}`,
      title: i === 0 ? 'ID' : `${kind[0]!.toUpperCase()}${kind.slice(1)} ${i}`,
      width: WIDTH[kind],
      kind,
      align: kind === 'id' || kind === 'number' || kind === 'currency' ? 'right' : 'left',
    });
  }
  return out;
}

/** 32-bit integer hash. Same inputs, same output, every run. */
export function hash(a: number, b: number): number {
  let x = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

const FIRST = ['Ada', 'Grace', 'Linus', 'Margaret', 'Alan', 'Barbara', 'Ken', 'Radia', 'Dennis', 'Frances', 'Edsger', 'Hedy', 'Tim', 'Katherine', 'Donald', 'Sophie', 'Yukihiro', 'Anders', 'Guido', 'Mei'];
const LAST = ['Lovelace', 'Hopper', 'Torvalds', 'Hamilton', 'Turing', 'Liskov', 'Thompson', 'Perlman', 'Ritchie', 'Allen', 'Dijkstra', 'Lamarr', 'Bernerslee', 'Johnson', 'Knuth', 'Wilson', 'Matsumoto', 'Hejlsberg', 'Vanrossum', 'Zhang'];
const STATUS = ['Active', 'Pending', 'Blocked', 'Done', 'Archived'];
const WORDS = (
  'the quick brown fox jumps over lazy dog canvas grid render frame budget scroll pixel layout ' +
  'column row header frozen theme text glyph measure cache wrap anchor offset tree prefix sum ' +
  'binary search window overscan paint batch font colour selection focus keyboard pointer'
).split(' ');

function words(seed: number, min: number, max: number): string {
  const n = min + (seed % (max - min + 1));
  let s = '';
  for (let i = 0; i < n; i++) {
    const w = WORDS[hash(seed, i) % WORDS.length]!;
    s += i === 0 ? w[0]!.toUpperCase() + w.slice(1) : ' ' + w;
  }
  return s;
}

const DAY = 86_400_000;
const EPOCH = Date.UTC(2020, 0, 1);

/** The base value of a cell, formatted as display text. */
export function cellText(row: number, kind: ColumnKind, col: number): string {
  const h = hash(row, col);
  switch (kind) {
    case 'id':
      return String(row + 1);
    case 'name':
      return `${FIRST[h % FIRST.length]} ${LAST[(h >>> 8) % LAST.length]}`;
    case 'email':
      return `${FIRST[h % FIRST.length]!.toLowerCase()}.${LAST[(h >>> 8) % LAST.length]!.toLowerCase()}${h % 100}@example.com`;
    case 'number':
      return String(h % 100_000);
    case 'currency':
      return `$${((h % 10_000_000) / 100).toFixed(2)}`;
    case 'date':
      return new Date(EPOCH + (h % 2000) * DAY).toISOString().slice(0, 10);
    case 'status':
      return STATUS[h % STATUS.length]!;
    case 'short':
      return words(h, 1, 2);
    case 'medium':
      return words(h, 3, 8);
    case 'long':
      return words(h, 8, 24);
  }
}

export interface Dataset {
  readonly rowCount: number;
  readonly columns: SyntheticColumn[];
  get(row: number, col: number): string;
  set(row: number, col: number, value: string): void;
  /** Number of cells overridden by `set`. */
  readonly overrides: number;
}

export function createDataset(rowCount: number, columnCount: number): Dataset {
  const columns = makeColumns(columnCount);
  const kinds = columns.map((c) => c.kind);
  const overrides = new Map<number, string>();
  return {
    rowCount,
    columns,
    get(row, col) {
      if (overrides.size > 0) {
        const o = overrides.get(row * columnCount + col);
        if (o !== undefined) return o;
      }
      return cellText(row, kinds[col]!, col);
    },
    set(row, col, value) {
      overrides.set(row * columnCount + col, value);
    },
    get overrides() {
      return overrides.size;
    },
  };
}

export interface CellWindow {
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
}

export interface StreamOptions {
  /** Cell updates per second. */
  rate: number;
  /** Rows and columns to update, usually the visible window. Called once per batch. */
  window: () => CellWindow;
  /** Applies one batch. `cells` holds [row, col] pairs; `values[i]` belongs to pair i. */
  apply: (cells: Int32Array, count: number, values: string[]) => void;
  /** Batch interval in ms (default 16). */
  interval?: number;
}

/** Streams random updates over a window at a fixed rate. Returns a stop function. */
export function startStream(opts: StreamOptions): () => void {
  const interval = opts.interval ?? 16;
  let seed = 1;
  let carry = 0;
  let last = performance.now();
  const capacity = Math.ceil((opts.rate * interval * 4) / 1000) + 8;
  const cells = new Int32Array(capacity * 2);
  const values: string[] = [];
  const timer = setInterval(() => {
    const now = performance.now();
    carry += ((now - last) * opts.rate) / 1000;
    last = now;
    const n = Math.min(Math.floor(carry), capacity);
    carry -= n;
    if (n === 0) return;
    const w = opts.window();
    const rows = Math.max(1, w.rowEnd - w.rowStart);
    const cols = Math.max(1, w.colEnd - w.colStart);
    values.length = n;
    for (let i = 0; i < n; i++) {
      const h = hash(seed++, 7);
      cells[i * 2] = w.rowStart + (h % rows);
      cells[i * 2 + 1] = w.colStart + ((h >>> 12) % cols);
      values[i] = String(h % 1_000_000);
    }
    opts.apply(cells, n, values);
  }, interval);
  return () => clearInterval(timer);
}
