/** Dirty flags. Every change marks one or more; one rAF callback does the work once per frame. */
export const Dirty = {
  None: 0,
  /** Sizes, columns, theme or pixel ratio changed. Implies a full base repaint. */
  Layout: 1,
  /** Full base repaint. */
  Base: 2,
  Overlay: 4,
  /** Some cells changed; repaint just those. */
  Cells: 8,
  /** Scroll position changed; blit and paint the exposed strips. */
  Scroll: 16,
  All: 7,
} as const;

export interface Scheduler {
  /** Marks work for the next frame, requesting one if none is pending. */
  mark(flags: number): void;
  /** Takes pending flags now (cancelling the scheduled frame). Lets a frame absorb work it caused itself. */
  consume(): number;
  /** Runs any pending work synchronously. */
  flush(): void;
  readonly pending: number;
  destroy(): void;
}

export interface FrameSource {
  request(cb: (time: number) => void): number;
  cancel(handle: number): void;
}

const defaultFrameSource = (): FrameSource => ({
  request: (cb) => requestAnimationFrame(cb),
  cancel: (h) => cancelAnimationFrame(h),
});

export function createScheduler(
  run: (flags: number) => void,
  source: FrameSource = defaultFrameSource(),
): Scheduler {
  let pending = 0;
  let handle = 0;
  let destroyed = false;

  const tick = () => {
    handle = 0;
    const flags = pending;
    pending = 0;
    if (flags !== 0 && !destroyed) run(flags);
  };

  return {
    mark(flags) {
      if (destroyed || flags === 0) return;
      pending |= flags;
      if (handle === 0) handle = source.request(tick);
    },
    consume() {
      const flags = pending;
      pending = 0;
      if (handle !== 0) {
        source.cancel(handle);
        handle = 0;
      }
      return flags;
    },
    flush() {
      if (handle !== 0) {
        source.cancel(handle);
        handle = 0;
      }
      tick();
    },
    get pending() {
      return pending;
    },
    destroy() {
      destroyed = true;
      if (handle !== 0) source.cancel(handle);
      handle = 0;
      pending = 0;
    },
  };
}
