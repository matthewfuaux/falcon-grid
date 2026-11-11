import { LRU } from './lru';

export const ELLIPSIS = '…';

/** Measures the advance width of `text` in `font`, in CSS pixels. */
export type MeasureFn = (text: string, font: string) => number;

/**
 * Multi-line wrapping, supplied by an add-on (see `@falcon-grid/text`) so the core stays small
 * and dependency-free. Implementations should cache the expensive per-string work.
 */
export interface TextWrapper {
  /** Number of lines `text` takes at `maxWidth`. */
  lineCount(text: string, font: string, maxWidth: number): number;
  /** The lines to paint at `maxWidth`. May return a cached array; do not mutate it. */
  lines(text: string, font: string, maxWidth: number): readonly string[];
  /** Drop cached measurements, e.g. after fonts load. */
  clear(): void;
}

let sharedContext: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

/** Canvas-based measurement on a private context, so it never disturbs a painting context. */
export const canvasMeasure: MeasureFn = (text, font) => {
  if (!sharedContext) {
    sharedContext =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(1, 1).getContext('2d')
        : document.createElement('canvas').getContext('2d');
    if (!sharedContext) throw new Error('falcon-grid: Canvas 2D is not available for text measurement');
  }
  if (sharedContext.font !== font) sharedContext.font = font;
  return sharedContext.measureText(text).width;
};

interface Entry {
  /** Full advance width. */
  width: number;
  /** Last truncation: the available width it was computed for, and the result. */
  fitWidth: number;
  fit: string;
}

interface FontCache {
  entries: LRU<string, Entry>;
  /** Advance widths of printable ASCII (32..126) measured one by one: the fast path. */
  ascii: Float64Array;
  ellipsis: number;
}

/**
 * Cached single-line measurement and ellipsis truncation, per font.
 *
 * - Widths are cached in an LRU keyed by string.
 * - Printable ASCII strings get a fast path from a per-character width table. Summed character
 *   widths ignore kerning, so the table only decides clear cases ("fits easily") and seeds the
 *   truncation search; borderline cases are measured exactly.
 * - Truncation binary-searches the cut point and caches the result per string and width.
 */
export class TextMeasurer {
  private readonly fonts = new Map<string, FontCache>();
  /** Measurements made (cache misses); for tests and instrumentation. */
  measurements = 0;

  constructor(
    private readonly measure: MeasureFn = canvasMeasure,
    private readonly capacity = 20_000,
  ) {}

  clear(): void {
    this.fonts.clear();
  }

  private font(font: string): FontCache {
    let f = this.fonts.get(font);
    if (!f) {
      const ascii = new Float64Array(127);
      for (let c = 32; c < 127; c++) ascii[c] = this.measure(String.fromCharCode(c), font);
      f = { entries: new LRU(this.capacity), ascii, ellipsis: this.measure(ELLIPSIS, font) };
      this.fonts.set(font, f);
    }
    return f;
  }

  private exact(text: string, font: string): number {
    this.measurements++;
    return this.measure(text, font);
  }

  /** Advance width of `text`. */
  width(text: string, font: string): number {
    const f = this.font(font);
    let e = f.entries.get(text);
    if (!e) {
      e = { width: this.exact(text, font), fitWidth: -1, fit: text };
      f.entries.set(text, e);
    }
    return e.width;
  }

  /** `text` if it fits in `maxWidth`, otherwise the longest prefix that fits followed by an ellipsis. */
  fit(text: string, font: string, maxWidth: number): string {
    const f = this.font(font);
    let e = f.entries.get(text);
    if (e && e.fitWidth === maxWidth) return e.fit;

    if (!e) {
      // Fast path: printable ASCII that clearly fits needs no exact measurement.
      const sum = asciiWidth(text, f.ascii);
      if (sum >= 0 && sum <= maxWidth - Math.max(2, sum * 0.02)) return text;
      e = { width: this.exact(text, font), fitWidth: -1, fit: text };
      f.entries.set(text, e);
    }
    e.fitWidth = maxWidth;
    e.fit = e.width <= maxWidth ? text : this.truncate(text, font, maxWidth, f);
    return e.fit;
  }

  private truncate(text: string, font: string, maxWidth: number, f: FontCache): string {
    if (maxWidth < f.ellipsis) return '';
    const fits = (k: number) => this.exact(text.slice(0, k) + ELLIPSIS, font) <= maxWidth;

    // Seed the search with summed ASCII widths when possible, then confirm exactly.
    let k = asciiCut(text, f.ascii, maxWidth - f.ellipsis);
    if (k >= 0) {
      k = safeCut(text, k);
      while (k > 0 && !fits(k)) k = safeCut(text, k - 1);
      while (k + 1 < text.length && fits(safeCut(text, k + 1)) && safeCut(text, k + 1) > k) k = safeCut(text, k + 1);
      return trimEnd(text.slice(0, k)) + ELLIPSIS;
    }

    // Exact binary search: the largest k with width(prefix + ellipsis) <= maxWidth.
    let lo = 0;
    let hi = text.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (fits(safeCut(text, mid))) lo = mid;
      else hi = mid - 1;
    }
    return trimEnd(text.slice(0, safeCut(text, lo))) + ELLIPSIS;
  }
}

/** Summed ASCII widths, or -1 if the string has characters outside printable ASCII. */
function asciiWidth(text: string, table: Float64Array): number {
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 32 || c > 126) return -1;
    w += table[c]!;
  }
  return w;
}

/** Number of leading characters whose summed ASCII widths fit `budget`, or -1 if not ASCII. */
function asciiCut(text: string, table: Float64Array, budget: number): number {
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 32 || c > 126) return -1;
    w += table[c]!;
    if (w > budget) return i;
  }
  return text.length;
}

/** Moves a cut point back so it never splits a surrogate pair. */
function safeCut(text: string, k: number): number {
  if (k <= 0) return 0;
  if (k >= text.length) return text.length;
  const c = text.charCodeAt(k);
  return c >= 0xdc00 && c <= 0xdfff ? k - 1 : k;
}

function trimEnd(s: string): string {
  return s.replace(/\s+$/, '');
}
