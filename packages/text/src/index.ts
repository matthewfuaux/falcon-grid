import {
  layout,
  layoutWithLines,
  prepareWithSegments,
  type PreparedTextWithSegments,
} from '@chenglou/pretext';
import { LRU, type TextWrapper } from '@falcon-grid/core';

export interface PretextWrapperOptions {
  /** Prepared strings kept per font (default 5000). Preparing is the expensive step. */
  capacity?: number;
  /** CSS `white-space`: 'normal' collapses spaces; 'pre-wrap' keeps spaces, tabs and newlines. */
  whiteSpace?: 'normal' | 'pre-wrap';
  /** CSS `word-break`. */
  wordBreak?: 'normal' | 'keep-all';
}

interface Entry {
  prepared: PreparedTextWithSegments;
  /** Last line count and the width it was computed for. */
  countWidth: number;
  count: number;
  /** Last lines and the width they were computed for. */
  linesWidth: number;
  lines: readonly string[];
}

const NO_LINES: readonly string[] = [];

/**
 * A `TextWrapper` over Pretext: each string is prepared once per font (segmentation and
 * measurement), then laid out per width with plain arithmetic. Line counts drive auto row
 * heights; line strings are only built for rows being painted.
 */
export function createPretextWrapper(options: PretextWrapperOptions = {}): TextWrapper {
  const capacity = options.capacity ?? 5000;
  const prepareOptions = {
    ...(options.whiteSpace ? { whiteSpace: options.whiteSpace } : {}),
    ...(options.wordBreak ? { wordBreak: options.wordBreak } : {}),
  };
  const fonts = new Map<string, LRU<string, Entry>>();

  const entry = (text: string, font: string): Entry => {
    let cache = fonts.get(font);
    if (!cache) {
      cache = new LRU(capacity);
      fonts.set(font, cache);
    }
    let e = cache.get(text);
    if (!e) {
      e = {
        prepared: prepareWithSegments(text, font, prepareOptions),
        countWidth: -1,
        count: 0,
        linesWidth: -1,
        lines: NO_LINES,
      };
      cache.set(text, e);
    }
    return e;
  };

  return {
    lineCount(text, font, maxWidth) {
      const e = entry(text, font);
      if (e.countWidth !== maxWidth) {
        e.count = Math.max(1, layout(e.prepared, maxWidth, 1).lineCount);
        e.countWidth = maxWidth;
      }
      return e.count;
    },
    lines(text, font, maxWidth) {
      const e = entry(text, font);
      if (e.linesWidth !== maxWidth) {
        const { lines } = layoutWithLines(e.prepared, maxWidth, 1);
        e.lines = lines.length ? lines.map((l) => l.text) : [''];
        e.linesWidth = maxWidth;
        e.count = e.lines.length;
        e.countWidth = maxWidth;
      }
      return e.lines;
    },
    clear() {
      fonts.clear();
    },
  };
}
