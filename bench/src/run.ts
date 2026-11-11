/**
 * Benchmark harness. Builds the target pages, serves them, and runs scripted scenarios in
 * Chromium via Playwright, recording main-thread work per frame, frame intervals, long tasks
 * and heap size.
 *
 *   pnpm bench                          all targets, all scenarios
 *   pnpm bench --target glide           one competitor
 *   pnpm bench --target falcon,vtable --scenario scroll-y --rows 100000
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright';
import { build, preview } from 'vite';
import { TRACE_CATEGORIES, frameWork } from './trace';

const TARGETS = ['falcon', 'glide', 'vtable', 'tanstack'] as const;
const SCENARIOS = ['scroll-y', 'scroll-x', 'updates', 'scroll-y-wrap', 'scroll-up-wrap'] as const;
type Scenario = (typeof SCENARIOS)[number];
/**
 * Wrapped text with auto-height rows. Only targets with built-in auto row heights take part:
 * the competitors would need hand-written measurement, which would not be a fair comparison.
 */
const WRAP_SCENARIOS: readonly Scenario[] = ['scroll-y-wrap', 'scroll-up-wrap'];
const WRAP_TARGETS = ['falcon'];

const { values: args } = parseArgs({
  options: {
    target: { type: 'string', default: TARGETS.join(',') },
    scenario: { type: 'string', default: SCENARIOS.join(',') },
    rows: { type: 'string', default: '1000000' },
    cols: { type: 'string', default: '100' },
    width: { type: 'string', default: '1440' },
    height: { type: 'string', default: '900' },
    dpr: { type: 'string', default: '1' },
    budget: { type: 'string', default: '8' },
    headed: { type: 'boolean', default: false },
    software: { type: 'boolean', default: false },
    'save-trace': { type: 'boolean', default: false },
    'no-build': { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});

const targets = args.target!.split(',').map((t) => t.trim()) as (typeof TARGETS)[number][];
const scenarios = args.scenario!.split(',').map((s) => s.trim()) as Scenario[];
for (const t of targets) if (!TARGETS.includes(t)) throw new Error(`Unknown target "${t}". Known: ${TARGETS.join(', ')}`);
for (const s of scenarios) if (!SCENARIOS.includes(s)) throw new Error(`Unknown scenario "${s}". Known: ${SCENARIOS.join(', ')}`);
const budget = Number(args.budget);

const benchDir = resolve(import.meta.dirname, '..');
const configFile = resolve(benchDir, 'vite.config.ts');

interface Stats {
  frames: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

interface Result {
  target: string;
  library: string;
  scenario: Scenario;
  mountMs: number;
  /** Main-thread work per frame, from the trace. */
  work: Stats;
  /** Time between rAF callbacks as seen by the page. */
  interval: Stats & { over16_7: number };
  /** Paint time reported by the library itself, where available. */
  internal?: Stats;
  longTasks: { count: number; totalMs: number };
  heapMB: { before: number; after: number; growth: number };
}

function stats(values: number[]): Stats {
  const v = [...values].sort((a, b) => a - b);
  const at = (p: number) => (v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))]! : 0);
  return { frames: v.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: v[v.length - 1] ?? 0 };
}

/**
 * In-page recorder: rAF intervals and long tasks between start() and stop().
 * A plain string, because tsx rewrites functions in ways that break when serialised to the page.
 */
const RECORDER = `(() => {
  let intervals = [], longTasks = [], running = false, last = 0;
  const loop = (t) => {
    if (!running) return;
    if (last) intervals.push(t - last);
    last = t;
    requestAnimationFrame(loop);
  };
  try {
    new PerformanceObserver((list) => {
      if (running) for (const e of list.getEntries()) longTasks.push(e.duration);
    }).observe({ type: 'longtask' });
  } catch {}
  window.__rec = {
    start() { intervals = []; longTasks = []; last = 0; running = true; requestAnimationFrame(loop); },
    stop() { running = false; return { intervals, longTasks }; },
  };
})();`;

async function heapMB(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('Performance.enable');
  const { metrics } = await cdp.send('Performance.getMetrics');
  await cdp.detach();
  return (metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0) / 2 ** 20;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wheel input at a steady rate, roughly one event per 60Hz frame. */
async function wheel(page: Page, steps: number, dx: number, dy: number) {
  const interval = 1000 / 60;
  const start = Date.now();
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(dx, dy);
    const wait = start + (i + 1) * interval - Date.now();
    if (wait > 0) await sleep(wait);
  }
}

async function runScenario(
  browser: Browser,
  url: string,
  target: string,
  scenario: Scenario,
  outDir: string,
): Promise<Result> {
  const context = await browser.newContext({
    viewport: { width: Number(args.width), height: Number(args.height) },
    deviceScaleFactor: Number(args.dpr),
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript({ content: RECORDER });
  await page.goto(url);
  await page.waitForFunction(() => window.__bench?.ready, null, { timeout: 180_000, polling: 100 });
  if (errors.length) throw new Error(`${target}: page error: ${errors[0]}`);
  const { mountMs, library } = await page.evaluate(() => ({ mountMs: window.__bench!.mountMs, library: window.__bench!.name }));

  await page.mouse.move(Number(args.width) / 2, Number(args.height) / 2);
  // Scrolling up into unmeasured rows exercises lazy measurement with scroll anchoring.
  if (scenario === 'scroll-up-wrap') await page.evaluate(() => window.__bench!.jumpTo!(0.5));
  await sleep(500);
  const before = await heapMB(page);
  await page.evaluate(() => {
    if (window.__bench!.internalFrames) window.__bench!.internalFrames.length = 0;
  });

  await browser.startTracing(page, { categories: TRACE_CATEGORIES });
  await page.evaluate(() => (window as unknown as { __rec: { start(): void } }).__rec.start());

  if (scenario === 'scroll-y' || scenario === 'scroll-y-wrap') await wheel(page, 300, 0, 120);
  else if (scenario === 'scroll-x') await wheel(page, 150, 120, 0);
  else if (scenario === 'scroll-up-wrap') await wheel(page, 300, 0, -120);
  else {
    await page.evaluate(() => window.__bench!.startUpdates(1000));
    await sleep(5000);
    await page.evaluate(() => window.__bench!.stopUpdates());
  }
  await sleep(250);

  const rec = await page.evaluate(() =>
    (window as unknown as { __rec: { stop(): { intervals: number[]; longTasks: number[] } } }).__rec.stop(),
  );
  const trace = (await browser.stopTracing()).toString('utf8');
  if (args['save-trace']) writeFileSync(resolve(outDir, `${target}-${scenario}.trace.json`), trace);
  const internal = await page.evaluate(() => window.__bench!.internalFrames?.slice());
  const after = await heapMB(page);
  await context.close();

  const work = frameWork(trace);
  const interval = stats(rec.intervals);
  return {
    target,
    library,
    scenario,
    mountMs,
    work: stats(work),
    interval: { ...interval, over16_7: rec.intervals.filter((i) => i > 1000 / 60 + 2).length },
    ...(internal?.length ? { internal: stats(internal) } : {}),
    longTasks: { count: rec.longTasks.length, totalMs: rec.longTasks.reduce((a, b) => a + b, 0) },
    heapMB: { before, after, growth: after - before },
  };
}

const f = (n: number, d = 1) => n.toFixed(d);

function report(results: Result[], meta: Record<string, string>): string {
  const lines = [
    '# Benchmark report',
    '',
    ...Object.entries(meta).map(([k, v]) => `- **${k}:** ${v}`),
    '',
    `Frame work is main-thread time per frame from the Chrome trace (budget ${budget} ms at p95).`,
    'Interval is time between rAF callbacks; "slow" counts intervals over one 60 Hz frame.',
    '',
    '| Library | Scenario | Work p50 | Work p95 | Work p99 | Work max | Frames | Interval p95 | Slow | Long tasks | Heap growth | Mount |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const r of results) {
    const pass = r.work.p95 <= budget ? '' : ' ⚠';
    lines.push(
      `| ${r.library} | ${r.scenario} | ${f(r.work.p50, 2)} | ${f(r.work.p95, 2)}${pass} | ${f(r.work.p99, 2)} | ${f(r.work.max, 1)} | ${r.work.frames} | ${f(r.interval.p95)} | ${r.interval.over16_7} | ${r.longTasks.count} (${f(r.longTasks.totalMs, 0)} ms) | ${f(r.heapMB.growth, 2)} MB | ${f(r.mountMs, 0)} ms |`,
    );
  }
  const internal = results.filter((r) => r.internal);
  if (internal.length) {
    lines.push('', 'Library-reported paint time (frame callback only):', '', '| Library | Scenario | p50 | p95 | p99 | max |', '| --- | --- | ---: | ---: | ---: | ---: |');
    for (const r of internal) lines.push(`| ${r.library} | ${r.scenario} | ${f(r.internal!.p50, 2)} | ${f(r.internal!.p95, 2)} | ${f(r.internal!.p99, 2)} | ${f(r.internal!.max, 2)} |`);
  }
  return lines.join('\n') + '\n';
}

async function main() {
  if (!args['no-build']) {
    console.log('Building benchmark targets…');
    await build({ configFile, logLevel: 'warn' });
  }
  const server = await preview({ configFile, preview: { port: 4317, strictPort: false }, logLevel: 'warn' });
  const base = server.resolvedUrls?.local[0] ?? 'http://localhost:4317/';
  // Full Chromium (new headless) with SwiftShader gives a GPU-accelerated canvas, like a real
  // laptop. The headless shell rasterises canvas in software on the main thread, which inflates
  // per-frame work for every canvas grid; pass --software to measure that instead.
  const browser = await chromium.launch({
    headless: !args.headed,
    ...(args.software ? {} : { channel: 'chromium' }),
    args: [
      '--enable-precise-memory-info',
      '--disable-renderer-backgrounding',
      ...(args.software
        ? []
        : ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
    ],
  });

  const outDir = args.out ?? resolve(benchDir, 'results', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(outDir, { recursive: true });
  const results: Result[] = [];
  try {
    for (const target of targets) {
      for (const scenario of scenarios) {
        process.stdout.write(`${target} / ${scenario} … `);
        if (WRAP_SCENARIOS.includes(scenario) && !WRAP_TARGETS.includes(target)) {
          console.log(`${target} / ${scenario} … skipped (no built-in auto row heights)`);
          continue;
        }
        const wrap = WRAP_SCENARIOS.includes(scenario) ? '&wrap' : '';
        const url = `${base}${target}.html?rows=${args.rows}&cols=${args.cols}${wrap}`;
        const r = await runScenario(browser, url, target, scenario, outDir);
        results.push(r);
        console.log(`work p95 ${f(r.work.p95, 2)} ms over ${r.work.frames} frames`);
      }
    }
  } finally {
    await browser.close();
    server.httpServer.close();
  }

  const meta = {
    Date: new Date().toISOString(),
    Browser: `Chromium ${browser.version()} (${args.headed ? 'headed' : 'headless'}, ${args.software ? 'software canvas' : 'GPU canvas via SwiftShader'})`,
    Machine: `${cpus()[0]?.model ?? 'unknown'} × ${cpus().length}, ${f(totalmem() / 2 ** 30, 0)} GB`,
    Platform: `${process.platform} ${process.arch}`,
    Data: `${Number(args.rows).toLocaleString('en-US')} rows × ${args.cols} columns`,
    Viewport: `${args.width}×${args.height} @${args.dpr}x`,
  };
  const md = report(results, meta);
  writeFileSync(resolve(outDir, 'results.json'), JSON.stringify({ meta, results }, null, 2));
  writeFileSync(resolve(outDir, 'report.md'), md);
  console.log('\n' + md);
  console.log(`Saved to ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
