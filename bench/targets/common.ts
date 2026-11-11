import { createDataset, startStream, type CellWindow, type Dataset } from '@falcon-grid/datagen';

/** The contract every benchmark target page implements on `window.__bench`. */
export interface BenchTarget {
  name: string;
  ready: boolean;
  /** Time from script start to the first painted frame, in ms. */
  mountMs: number;
  /** Start streaming `rate` cell updates per second over the top-left visible window. */
  startUpdates(rate: number): void;
  stopUpdates(): void;
  /** Library-reported paint durations, where the library exposes them. */
  internalFrames?: number[];
  /** Jump to a fraction of the rows, as a scrollbar drag would (targets that support wrap scenarios). */
  jumpTo?: (fraction: number) => void;
}

declare global {
  interface Window {
    __bench?: BenchTarget;
  }
}

export const ROW_HEIGHT = 32;
export const HEADER_HEIGHT = 36;

export function params() {
  const q = new URLSearchParams(location.search);
  const rows = Number(q.get('rows') ?? 1_000_000);
  const cols = Number(q.get('cols') ?? 100);
  return { rows, cols, data: createDataset(rows, cols) };
}

/** Updates land in the first visible rows and columns; every target starts scrolled to the top. */
export const UPDATE_WINDOW: CellWindow = { rowStart: 0, rowEnd: 20, colStart: 0, colEnd: 8 };

export function register(
  name: string,
  t0: number,
  data: Dataset,
  onBatch: (cells: Int32Array, n: number) => void,
  extra: Partial<BenchTarget> = {},
): void {
  let stop: (() => void) | null = null;
  const target: BenchTarget = {
    name,
    ready: false,
    mountMs: 0,
    startUpdates(rate) {
      stop?.();
      stop = startStream({
        rate,
        window: () => UPDATE_WINDOW,
        apply: (cells, n, values) => {
          for (let i = 0; i < n; i++) data.set(cells[i * 2]!, cells[i * 2 + 1]!, values[i]!);
          onBatch(cells, n);
        },
      });
    },
    stopUpdates() {
      stop?.();
      stop = null;
    },
    ...extra,
  };
  window.__bench = target;
  // Two frames: the first runs the library's paint, the second confirms it was presented.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      target.mountMs = performance.now() - t0;
      target.ready = true;
    }),
  );
}
