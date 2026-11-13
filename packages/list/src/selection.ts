import { colX, rowY, type GridPlugin, type GridPluginFactory, type GridPluginHost } from '@falcon-grid/core';
import { charAt, joiner, prefixWidth, runsOf, type TextRun } from './runs';

/** A caret position: a character boundary in one of a row's text runs. */
export interface TextPoint {
  row: number;
  run: number;
  ch: number;
}

/** Past every run of a row: the end of its text. */
const END = 1e9;

const before = (a: TextPoint, b: TextPoint) =>
  a.row !== b.row ? a.row < b.row : a.run !== b.run ? a.run < b.run : a.ch < b.ch;
const same = (a: TextPoint, b: TextPoint) => a.row === b.row && a.run === b.run && a.ch === b.ch;

export interface TextSelectionOptions {
  /** Called when the selection changes, with whether anything is selected. */
  onChange?: (selected: boolean) => void;
  /** Plain text of a whole row, used when a copy covers it fully (default: its runs joined). */
  rowText?: (row: number, col: number) => string;
}

/**
 * Text selection over the painted text of a column: drag to select across rows, double-click
 * for a word, triple-click for a row, Shift+click to extend, Ctrl+A for everything, Escape to
 * clear. The selection is painted on the overlay and copied as plain text.
 *
 * Pass `plugin` to the grid's `plugins`; the rest of the object reads and changes the selection.
 */
export interface TextSelection {
  readonly plugin: GridPluginFactory;
  /** Ordered start and end, or null when nothing is selected. */
  range(): { start: TextPoint; end: TextPoint; col: number } | null;
  /** The selected text, as Ctrl+C copies it. */
  text(): string;
  /** Selects all text in a column (default 0). */
  selectAll(col?: number): void;
  clear(): void;
  /** Rows were inserted before `index`: move the selection with its rows. */
  shiftRows(index: number, count: number): void;
}

export function createTextSelection(options: TextSelectionOptions = {}): TextSelection {
  let host: GridPluginHost | null = null;
  let anchor: TextPoint | null = null;
  let focus: TextPoint | null = null;
  let col = 0;
  /** The press: a word or row granularity extends by whole words or rows. */
  let unit: 'char' | 'word' | 'row' = 'char';
  let unitAnchor: [TextPoint, TextPoint] | null = null;
  /** Click counting: pointer events carry no click count once their mouse events are prevented. */
  let lastDown = { t: -1e9, x: 0, y: 0, n: 0 };

  const changed = () => {
    host?.invalidateOverlay();
    options.onChange?.(range() !== null);
  };

  const range = () => {
    if (!anchor || !focus || same(anchor, focus)) return null;
    return before(anchor, focus) ? { start: anchor, end: focus, col } : { start: focus, end: anchor, col };
  };

  /** The caret position nearest a viewport point, within column `col`. */
  const pointAt = (x: number, y: number): TextPoint | null => {
    const h = host!;
    const { vp, rows, offsets } = h.viewport();
    if (rows.count === 0) return null;
    const bodyY = Math.max(vp.bodyTop, Math.min(y, vp.height - 1));
    const content = bodyY - vp.headerHeight + vp.scrollTop;
    if (content >= rows.total) return { row: rows.count - 1, run: END, ch: END };
    const row = Math.max(vp.frozenRows, rows.rowAt(content));
    const runs = runsOf(h, row, col);
    if (runs.length === 0) return { row, run: 0, ch: 0 };
    const lx = x - colX(col, offsets, vp);
    const ly = y - rowY(row, rows, vp);
    // The run on the line under the pointer nearest in x; between lines, the next line down.
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i]!;
      if (ly < r.y || ly >= r.y + r.h) continue;
      const d = lx < r.x ? r.x - lx : lx > r.x + r.w ? lx - r.x - r.w : 0;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    if (best < 0) {
      const below = runs.findIndex((r) => r.y > ly);
      if (below < 0) return { row, run: runs.length - 1, ch: runs[runs.length - 1]!.text.length };
      return { row, run: below, ch: 0 };
    }
    const r = runs[best]!;
    return { row, run: best, ch: charAt(h, r, lx - r.x) };
  };

  /** Clamps a point's run and character to the row's actual text. */
  const resolve = (p: TextPoint, runs: readonly TextRun[]): [number, number] => {
    if (runs.length === 0) return [0, 0];
    if (p.run >= runs.length) return [runs.length - 1, runs[runs.length - 1]!.text.length];
    return [p.run, Math.min(p.ch, runs[p.run]!.text.length)];
  };

  const wordAround = (p: TextPoint): [TextPoint, TextPoint] => {
    const runs = runsOf(host!, p.row, col);
    const [ri, ch] = resolve(p, runs);
    const t = runs[ri]?.text ?? '';
    const word = /[\p{L}\p{N}_]/u;
    let a = ch;
    let b = ch;
    if (word.test(t[ch] ?? '') || word.test(t[ch - 1] ?? '')) {
      while (a > 0 && word.test(t[a - 1]!)) a--;
      while (b < t.length && word.test(t[b]!)) b++;
    } else if (b < t.length) b++;
    return [{ row: p.row, run: ri, ch: a }, { row: p.row, run: ri, ch: b }];
  };

  const rowAround = (p: TextPoint): [TextPoint, TextPoint] => [
    { row: p.row, run: 0, ch: 0 },
    { row: p.row, run: END, ch: END },
  ];

  /** Moves the focus end to a point, by the current unit. */
  const extendTo = (p: TextPoint) => {
    if (unit === 'char' || !unitAnchor) {
      focus = p;
      return;
    }
    const [a, b] = unit === 'word' ? wordAround(p) : rowAround(p);
    if (before(p, unitAnchor[0])) {
      anchor = unitAnchor[1];
      focus = a;
    } else {
      anchor = unitAnchor[0];
      focus = b;
    }
  };

  const text = (): string => {
    const r = range();
    const h = host;
    if (!r || !h) return '';
    const { start, end } = r;
    const rowCount = h.viewport().rows.count;
    const out: string[] = [];
    const whole = (row: number) => {
      if (options.rowText) return options.rowText(row, col);
      const s = h.store.getSnapshot();
      const column = s.columns[col];
      const v = h.getCell(row, col);
      if (v == null) return '';
      return column?.cell ? column.cell.text(v) : String(v);
    };
    for (let row = start.row; row <= Math.min(end.row, rowCount - 1); row++) {
      if (row > start.row && row < end.row) {
        out.push(whole(row));
        continue;
      }
      const runs = runsOf(h, row, col);
      const [r0, c0] = row === start.row ? resolve(start, runs) : [0, 0];
      const [r1, c1] = row === end.row ? resolve(end, runs) : [runs.length - 1, runs[runs.length - 1]?.text.length ?? 0];
      const last = runs[runs.length - 1];
      if (r0 === 0 && c0 === 0 && last && r1 === runs.length - 1 && c1 === last.text.length) {
        out.push(whole(row));
        continue;
      }
      let line = '';
      for (let i = r0; i <= r1 && i < runs.length; i++) {
        const run = runs[i]!;
        if (i > r0) line += joiner(runs[i - 1]!, run);
        line += run.text.slice(i === r0 ? c0 : 0, i === r1 ? c1 : run.text.length);
      }
      out.push(line);
    }
    return out.join('\n');
  };

  const paint = (ctx: CanvasRenderingContext2D) => {
    const r = range();
    const h = host!;
    if (!r) return;
    const { vp, rows, offsets } = h.viewport();
    const from = Math.max(r.start.row, vp.rowStart);
    const to = Math.min(r.end.row + 1, vp.rowEnd);
    if (to <= from) return;
    const x0 = col < vp.frozenColumns ? 0 : vp.frozenWidth;
    ctx.beginPath();
    ctx.rect(x0, vp.bodyTop, vp.width - x0, vp.height - vp.bodyTop);
    ctx.clip();
    ctx.fillStyle = h.theme().selectionBackground;
    const left = colX(col, offsets, vp);
    for (let row = from; row < to; row++) {
      const runs = runsOf(h, row, col);
      if (runs.length === 0) continue;
      const top = rowY(row, rows, vp);
      const [r0, c0] = row === r.start.row ? resolve(r.start, runs) : [0, 0];
      const [r1, c1] = row === r.end.row ? resolve(r.end, runs) : [runs.length - 1, END];
      for (let i = r0; i <= r1 && i < runs.length; i++) {
        const run = runs[i]!;
        const a = i === r0 ? prefixWidth(h, run, c0) : 0;
        const b = i === r1 ? prefixWidth(h, run, c1) : run.w;
        // A selected line break shows as a sliver, like a browser's.
        const w = b > a ? b - a : i < r1 || row < r.end.row ? 4 : 0;
        if (w > 0) ctx.fillRect(left + run.x + a, top + run.y, w, run.h);
      }
    }
  };

  const plugin: GridPlugin = {
    paintOverlay: paint,
    pointerDown(e, x, y, hit) {
      const p = pointAt(x, y);
      if (!p) return false;
      if (e.shiftKey && anchor && hit.col === col) {
        unit = 'char';
        focus = p;
      } else {
        col = hit.col;
        const near = e.timeStamp - lastDown.t < 500 && Math.abs(x - lastDown.x) < 5 && Math.abs(y - lastDown.y) < 5;
        const n = near ? lastDown.n + 1 : 1;
        lastDown = { t: e.timeStamp, x, y, n };
        unit = n >= 3 ? 'row' : n === 2 ? 'word' : 'char';
        unitAnchor = unit === 'char' ? null : unit === 'word' ? wordAround(p) : rowAround(p);
        if (unitAnchor) [anchor, focus] = unitAnchor;
        else anchor = focus = p;
      }
      changed();
      return true;
    },
    pointerMove(x, y) {
      const p = pointAt(x, y);
      if (!p) return;
      const prev = focus;
      extendTo(p);
      if (!prev || !focus || !same(prev, focus)) changed();
    },
    pointerUp() {
      if (anchor && focus && same(anchor, focus)) anchor = focus = null;
    },
    keyDown(e) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && (e.key === 'a' || e.key === 'A')) {
        api.selectAll(col);
        return true;
      }
      if (e.key === 'Escape' && range()) {
        api.clear();
        return true;
      }
      return false;
    },
    copy() {
      const t = text();
      if (!t) return null;
      const esc = t.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
      return { text: t, html: `<div style="white-space:pre-wrap">${esc}</div>` };
    },
    destroy() {
      host = null;
    },
  };

  const api: TextSelection = {
    plugin: (h) => {
      host = h;
      return plugin;
    },
    range,
    text,
    selectAll(c = 0) {
      const n = host?.viewport().rows.count ?? 0;
      if (n === 0) return;
      col = c;
      unit = 'char';
      anchor = { row: 0, run: 0, ch: 0 };
      focus = { row: n - 1, run: END, ch: END };
      changed();
    },
    clear() {
      if (!anchor && !focus) return;
      anchor = focus = null;
      changed();
    },
    shiftRows(index, count) {
      for (const p of new Set([anchor, focus, ...(unitAnchor ?? [])])) if (p && p.row >= index) p.row += count;
      if (anchor) host?.invalidateOverlay();
    },
  };
  return api;
}
