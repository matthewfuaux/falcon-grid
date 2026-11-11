import { describe, expect, it, vi } from 'vitest';
import { createScheduler, Dirty, type FrameSource } from '../src/scheduler';
import { createStore } from '../src/store';

describe('store', () => {
  it('merges patches and notifies with next and prev', () => {
    const store = createStore({ a: 1, b: 'x' });
    const listener = vi.fn();
    store.subscribe(listener);
    store.setState({ a: 2 });
    expect(store.getSnapshot()).toEqual({ a: 2, b: 'x' });
    expect(listener).toHaveBeenCalledWith({ a: 2, b: 'x' }, { a: 1, b: 'x' });
  });

  it('skips no-op updates and keeps the snapshot identity', () => {
    const store = createStore({ a: 1 });
    const snap = store.getSnapshot();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setState({ a: 1 });
    store.setState((s) => ({ a: s.a }));
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(snap);
  });

  it('unsubscribes', () => {
    const store = createStore({ a: 1 });
    const listener = vi.fn();
    store.subscribe(listener)();
    store.setState({ a: 2 });
    expect(listener).not.toHaveBeenCalled();
  });
});

function fakeFrames() {
  let next = 1;
  const queue = new Map<number, (t: number) => void>();
  const source: FrameSource = {
    request: (cb) => {
      queue.set(next, cb);
      return next++;
    },
    cancel: (h) => void queue.delete(h),
  };
  const step = () => {
    const cbs = [...queue.values()];
    queue.clear();
    for (const cb of cbs) cb(0);
  };
  return { source, step, get requested() { return queue.size; } };
}

describe('scheduler', () => {
  it('coalesces marks into one frame', () => {
    const frames = fakeFrames();
    const run = vi.fn();
    const s = createScheduler(run, frames.source);
    s.mark(Dirty.Base);
    s.mark(Dirty.Overlay);
    s.mark(Dirty.Base);
    expect(frames.requested).toBe(1);
    frames.step();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(Dirty.Base | Dirty.Overlay);
  });

  it('schedules a new frame for marks made during a frame', () => {
    const frames = fakeFrames();
    const seen: number[] = [];
    const s = createScheduler((f) => {
      seen.push(f);
      if (f & Dirty.Layout) s.mark(Dirty.Base);
    }, frames.source);
    s.mark(Dirty.Layout);
    frames.step();
    frames.step();
    expect(seen).toEqual([Dirty.Layout, Dirty.Base]);
  });

  it('consume takes pending work and cancels the frame', () => {
    const frames = fakeFrames();
    const run = vi.fn();
    const s = createScheduler(run, frames.source);
    s.mark(Dirty.Base);
    expect(s.consume()).toBe(Dirty.Base);
    expect(frames.requested).toBe(0);
    frames.step();
    expect(run).not.toHaveBeenCalled();
  });

  it('flush runs synchronously; destroy stops everything', () => {
    const frames = fakeFrames();
    const run = vi.fn();
    const s = createScheduler(run, frames.source);
    s.mark(Dirty.All);
    s.flush();
    expect(run).toHaveBeenCalledWith(Dirty.All);
    s.mark(Dirty.Base);
    s.destroy();
    frames.step();
    s.mark(Dirty.Base);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
