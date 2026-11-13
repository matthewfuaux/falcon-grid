# Benchmarks

How falcon-grid compares with Glide Data Grid, VisActor VTable and TanStack Table with
TanStack Virtual: the same data and the same scripted input, in the same browser. Everything
here can be reproduced with one command.

## Method

- **Data:** 1,000,000 rows × 100 columns of deterministic synthetic data (`tools/datagen`):
  ids, names, emails, numbers, currency, dates, statuses and short, medium and long text. No
  target materialises the rows.
- **Viewport:** 1440 × 900 CSS pixels at a device pixel ratio of 1. Rows are 32 px and the
  header is 36 px for every target.
- **Browser:** Chromium 131 (Playwright 1.49), headless. The canvas is GPU-accelerated through
  SwiftShader, as on real hardware; `--software` uses the software canvas instead.
- **Targets** (`bench/targets`): each library in its documented, idiomatic setup at the
  versions pinned in `bench/package.json`: Glide Data Grid 6.0.3, VTable 1.26.8, TanStack Table
  8.21.3 with TanStack Virtual 3.14.26 rendering DOM rows and columns.
- **Scenarios** (`bench/src/run.ts`):

  | Scenario | Input |
  | --- | --- |
  | `scroll-y` | 300 wheel events of 120 px down, one per 60 Hz frame |
  | `scroll-x` | 150 wheel events of 120 px right |
  | `updates` | 1,000 cell updates per second for 5 s on the visible window (20 rows × 8 columns) |
  | `scroll-y-wrap` | `scroll-y` with wrapped text and auto row heights (falcon-grid only) |
  | `scroll-up-wrap` | jump to the middle, then scroll up into unmeasured rows (falcon-grid only) |
  | `scroll-y-cells`, `scroll-x-cells` | every column a declarative cell from the built-in column types (falcon-grid only) |

  The wrap and cell scenarios are falcon-grid only because the other libraries would need
  hand-written measurement or drawing code, which wouldn't be a fair comparison.

- **Measures:**
  - **Work:** main-thread time per frame from the Chrome trace: script, style, layout, paint and
    commit. This is the number the 8 ms budget applies to, at p95.
  - **Interval:** time between `requestAnimationFrame` callbacks. **Slow** counts intervals over
    one 60 Hz frame. Headless Chromium with SwiftShader often presents at 30 Hz, so the interval
    numbers say more about the harness than the library. Compare work, not intervals.
  - **Long tasks** (over 50 ms), **heap growth** across the run after a forced GC, and **mount**:
    script start to the first presented frame.
  - **Library paint:** falcon-grid's own frame callback time (`onFrame`), for reference.

## Results

Run on 13 Nov 2026 ([raw data](./benchmarks/2026-11-13/)). Machine: AMD Ryzen 9 9900X
(12 cores), 30 GB, Linux x64. Work in milliseconds. ⚠ marks a p95 over the 8 ms budget.

| Library | Scenario | Work p50 | Work p95 | Work p99 | Long tasks | Heap growth | Mount |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| falcon-grid | scroll-y | 3.17 | 6.79 | 10.52 | 0 | 0.88 MB | 20 ms |
| falcon-grid | scroll-x | 2.56 | 5.88 | 7.42 | 0 | 0.36 MB | 17 ms |
| falcon-grid | updates | 1.65 | 3.04 | 4.98 | 0 | 0.22 MB | 29 ms |
| falcon-grid | scroll-y-wrap | 3.30 | 6.93 | 12.53 | 0 | -0.28 MB | 30 ms |
| falcon-grid | scroll-up-wrap | 3.26 | 6.57 | 11.84 | 0 | -1.01 MB | 19 ms |
| falcon-grid | scroll-y-cells | 4.84 | 8.18 ⚠ | 14.03 | 0 | 6.26 MB | 23 ms |
| falcon-grid | scroll-x-cells | 2.96 | 7.14 | 8.66 | 0 | 2.04 MB | 21 ms |
| Glide Data Grid | scroll-y | 3.07 | 5.23 | 7.63 | 0 | 1.04 MB | 48 ms |
| Glide Data Grid | scroll-x | 2.71 | 4.70 | 7.20 | 0 | 1.00 MB | 17 ms |
| Glide Data Grid | updates | 0.81 | 1.39 | 2.42 | 0 | 0.18 MB | 10 ms |
| VTable | scroll-y | 37.78 | 54.77 ⚠ | 64.42 | 5 (311 ms) | 11.60 MB | 703 ms |
| VTable | scroll-x | 0.80 | 28.71 ⚠ | 33.82 | 0 | 0.52 MB | 754 ms |
| VTable | updates | 18.25 | 24.84 ⚠ | 30.60 | 0 | 0.42 MB | 730 ms |
| TanStack Table + Virtual | scroll-y | 5.83 | 12.42 ⚠ | 14.70 | 0 | 57.72 MB | 4713 ms |
| TanStack Table + Virtual | scroll-x | 6.65 | 12.45 ⚠ | 30.56 | 0 | 1.22 MB | 4090 ms |
| TanStack Table + Virtual | updates | 3.47 | 8.75 ⚠ | 15.04 | 0 | 0.79 MB | 4087 ms |

falcon-grid's own paint time per frame (p50 / p95): scroll-y 1.2 / 2.0 ms, wrapped
0.9 / 1.6 ms, declarative cells 2.3 / 4.0 ms.

### Reading the results

- falcon-grid and Glide Data Grid are in the same range on plain scrolling. Glide is ahead on
  this run: 5.2 against 6.8 ms at p95 for vertical scrolling. It is also well ahead on streaming
  updates (1.4 against 3.0 ms).
- falcon-grid keeps wrapped text with auto row heights inside the budget (6.9 ms p95), which
  none of the others offer without custom code.
- Declarative cells in all 100 columns are at the edge of the budget on vertical scrolling
  (8.2 ms p95). See the known issue below.
- VTable spends 18–55 ms per frame at p95 here, and TanStack Table with Virtual takes over 4 s to
  mount a million rows and 12 ms per frame to scroll them as DOM.

### Known issue: scrolling got slower in Phase 6

The Phase 6 accessibility work made scrolling slower. Back-to-back runs of
`--target falcon --scenario scroll-y,scroll-y-cells` on the same machine (work p95, two runs
each):

| Build | scroll-y | scroll-y-cells |
| --- | ---: | ---: |
| Before Phase 6 (`bf73cd8`) | 3.93, 4.48 | 6.12, 6.29 |
| Phase 6 (`ad9d069`) | 6.23, 6.14 | 8.57, 8.42 |
| Phase 7 (list mode) | 6.03, 6.43 | 7.82, 8.44 |
| Phase 7, mirror DOM disabled (diagnostic only) | 5.06, 5.01 | 6.89, 7.27 |

List mode adds nothing measurable. About half of the regression is the accessibility
mirror's DOM: the trace shows more Layerize, Commit and HitTest time per frame. The rest is
per-frame script that hasn't been tracked down yet. Fixing this is the next performance task.

## Phase 0 baselines

The first run of the harness, on 10 Nov 2026 ([raw data](./benchmarks/2026-11-10-phase0/)), same
machine and settings, before any of falcon-grid's optimisation work. Work p95 in milliseconds:

| Library | scroll-y | scroll-x | updates |
| --- | ---: | ---: | ---: |
| falcon-grid (Phase 0 prototype) | 5.32 | 4.95 | 3.44 |
| Glide Data Grid | 4.60 | 4.39 | 1.30 |
| VTable | 46.57 | 24.45 | 20.69 |
| TanStack Table + Virtual | 12.07 | 12.18 | 7.27 |

The competitors' numbers today are within run-to-run noise of these, about ±15% on this machine.

## Reproduce

```sh
pnpm install
pnpm --filter @falcon-grid/bench exec playwright install chromium
pnpm bench                                               # every target and scenario (~5 minutes)
pnpm bench --target falcon,glide --scenario scroll-y     # a subset
pnpm bench --dpr 2 --rows 100000 --software              # other settings
```

Each run writes `bench/results/<timestamp>/report.md` and `results.json` with the machine and
browser details. Close other heavy programs first: other load on the machine moves these
numbers by 10–20%. To compare two builds, run them back to back, more than once.
