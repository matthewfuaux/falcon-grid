/** Minimal Chrome trace parsing: main-thread work per frame. */

interface TraceEvent {
  name: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: { name?: string };
}

export const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
];

/**
 * Returns the main-thread busy time (ms) for each frame of the page's renderer.
 * Frames are delimited by BeginMainThreadFrame; a frame's work is the sum of top-level
 * RunTask durations that start inside it. This covers input handling, script, rAF callbacks,
 * style, layout and paint recording, but not raster or GPU work on other threads.
 */
export function frameWork(traceJson: string): number[] {
  const events = (JSON.parse(traceJson) as { traceEvents: TraceEvent[] }).traceEvents;

  const mainThreads = new Set<string>();
  for (const e of events) {
    if (e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain') mainThreads.add(`${e.pid}:${e.tid}`);
  }
  // The page's renderer is the main thread that did the most work.
  const busy = new Map<string, number>();
  for (const e of events) {
    if (e.name !== 'RunTask' || e.ph !== 'X') continue;
    const key = `${e.pid}:${e.tid}`;
    if (mainThreads.has(key)) busy.set(key, (busy.get(key) ?? 0) + (e.dur ?? 0));
  }
  const main = [...busy.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!main) return [];

  const onMain = (e: TraceEvent) => `${e.pid}:${e.tid}` === main;
  const boundaries = events
    .filter((e) => e.name === 'BeginMainThreadFrame' && onMain(e))
    .map((e) => e.ts)
    .sort((a, b) => a - b);
  const tasks = events
    .filter((e) => e.name === 'RunTask' && e.ph === 'X' && onMain(e))
    .sort((a, b) => a.ts - b.ts);
  if (boundaries.length < 2) return [];

  // Drop nested RunTasks (a task inside another task's span).
  const top: TraceEvent[] = [];
  let end = -Infinity;
  for (const t of tasks) {
    if (t.ts >= end) {
      top.push(t);
      end = t.ts + (t.dur ?? 0);
    }
  }

  const work = new Array<number>(boundaries.length - 1).fill(0);
  let f = 0;
  for (const t of top) {
    while (f < boundaries.length - 1 && t.ts >= boundaries[f + 1]!) f++;
    if (t.ts < boundaries[0]! || f >= boundaries.length - 1) continue;
    work[f]! += (t.dur ?? 0) / 1000;
  }
  return work;
}
