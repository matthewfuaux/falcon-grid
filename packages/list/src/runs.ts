import { contentTop, type GridPluginHost } from '@falcon-grid/core';

/** One painted line of text in a cell, relative to the cell's top-left corner, in CSS pixels. */
export interface TextRun {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  font: string;
  /** Continues the previous run's text after a soft wrap. */
  soft: boolean;
}

const NONE: readonly TextRun[] = [];

/**
 * The text a cell shows, line by line, where it is painted: the text ops of a declarative cell,
 * or the (wrapped or truncated) lines of a plain one, placed as the base painter places them.
 */
export function runsOf(host: GridPluginHost, row: number, col: number): readonly TextRun[] {
  const { rows, offsets } = host.viewport();
  const s = host.store.getSnapshot();
  const column = s.columns[col];
  if (!column || row < 0 || row >= rows.count) return NONE;
  const t = host.theme();
  const auto = host.autoHeight();
  const h = rows.heightOf(row);
  const pad = t.cellPaddingX;
  if (column.cell) {
    const list = host.displayList(row, col);
    if (list.ops.length === 0) return NONE;
    const top = contentTop(list.height, h, t, auto);
    const out: TextRun[] = [];
    for (const op of list.ops) {
      if (op.k === 'text') out.push({ x: pad + op.x, y: top + op.y, w: op.w, h: op.h, text: op.text, font: op.font, soft: op.soft === true });
    }
    return out;
  }
  const v = host.getCell(row, col);
  if (v == null || v === '') return NONE;
  const str = typeof v === 'string' ? v : String(v);
  const width = offsets[col + 1]! - offsets[col]!;
  const avail = width - 2 * pad;
  if (avail <= 0) return NONE;
  const font = t.cellFont;
  const lh = t.lineHeight;
  const wrapper = host.wrapper();
  const lines = column.wrap && wrapper ? wrapper.lines(str, font, avail) : [host.text.fit(str, font, avail)];
  const room = Math.max(1, Math.floor((h - 2 * t.cellPaddingY) / lh + 1e-6));
  const n = Math.min(lines.length, room);
  let y = auto ? t.cellPaddingY : (h - n * lh) / 2;
  const align = column.align ?? 'left';
  const out: TextRun[] = [];
  for (let k = 0; k < n; k++, y += lh) {
    let line = lines[k]!;
    if (k === n - 1 && n < lines.length) line = host.text.fit(line + '…', font, avail);
    const w = host.text.width(line, font);
    const x = align === 'right' ? width - pad - w : align === 'center' ? (width - w) / 2 : pad;
    out.push({ x, y, w, h: lh, text: line, font, soft: k > 0 });
  }
  return out;
}

/** Width of the first `n` characters of a run. */
export function prefixWidth(host: GridPluginHost, run: TextRun, n: number): number {
  if (n <= 0) return 0;
  if (n >= run.text.length) return run.w;
  return host.text.width(run.text.slice(0, n), run.font);
}

/** The character boundary in a run nearest to `dx` pixels from its left edge. */
export function charAt(host: GridPluginHost, run: TextRun, dx: number): number {
  const len = run.text.length;
  if (dx <= 0) return 0;
  if (dx >= run.w) return len;
  // Largest k with prefixWidth(k) <= dx, then the nearer of k and k + 1.
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (prefixWidth(host, run, mid) <= dx) lo = mid;
    else hi = mid - 1;
  }
  let k = lo;
  if (k < len && dx - prefixWidth(host, run, k) > prefixWidth(host, run, k + 1) - dx) k++;
  // Never split a surrogate pair.
  const c = run.text.charCodeAt(k);
  if (k > 0 && k < len && c >= 0xdc00 && c <= 0xdfff) k--;
  return k;
}

const CJK = /[⺀-鿿가-힯＀-￯]/;

/** What joins two runs of the same cell when copying. */
export function joiner(prev: TextRun, next: TextRun): string {
  if (!next.soft) return Math.abs(prev.y - next.y) < 1 ? ' ' : '\n';
  // A soft wrap broke at a space the wrapper dropped; put it back between words.
  const a = prev.text[prev.text.length - 1] ?? ' ';
  const b = next.text[0] ?? ' ';
  return /\s/.test(a) || /\s/.test(b) || CJK.test(a) || CJK.test(b) ? '' : ' ';
}
