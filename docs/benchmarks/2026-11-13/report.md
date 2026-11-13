# Benchmark report

- **Date:** 2026-11-13T21:34:42.767Z
- **Browser:** Chromium 131.0.6778.33 (headless, GPU canvas via SwiftShader)
- **Machine:** AMD Ryzen 9 9900X 12-Core Processor × 24, 30 GB
- **Platform:** linux x64
- **Data:** 1,000,000 rows × 100 columns
- **Viewport:** 1440×900 @1x

Frame work is main-thread time per frame from the Chrome trace (budget 8 ms at p95).
Interval is time between rAF callbacks; "slow" counts intervals over one 60 Hz frame.

| Library | Scenario | Work p50 | Work p95 | Work p99 | Work max | Frames | Interval p95 | Slow | Long tasks | Heap growth | Mount |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| falcon-grid | scroll-y | 3.17 | 6.79 | 10.52 | 13.8 | 414 | 33.4 | 271 | 0 (0 ms) | 0.88 MB | 20 ms |
| falcon-grid | scroll-x | 2.56 | 5.88 | 7.42 | 10.7 | 193 | 33.3 | 23 | 0 (0 ms) | 0.36 MB | 17 ms |
| falcon-grid | updates | 1.65 | 3.04 | 4.98 | 6.9 | 173 | 49.9 | 134 | 0 (0 ms) | 0.22 MB | 29 ms |
| falcon-grid | scroll-y-wrap | 3.30 | 6.93 | 12.53 | 16.2 | 396 | 33.4 | 278 | 0 (0 ms) | -0.28 MB | 30 ms |
| falcon-grid | scroll-up-wrap | 3.26 | 6.57 | 11.84 | 16.7 | 400 | 33.4 | 274 | 0 (0 ms) | -1.01 MB | 19 ms |
| falcon-grid | scroll-y-cells | 4.84 | 8.18 ⚠ | 14.03 | 15.5 | 446 | 49.9 | 260 | 0 (0 ms) | 6.26 MB | 23 ms |
| falcon-grid | scroll-x-cells | 2.96 | 7.14 | 8.66 | 11.7 | 202 | 33.4 | 19 | 0 (0 ms) | 2.04 MB | 21 ms |
| glide-data-grid | scroll-y | 3.07 | 5.23 | 7.63 | 10.6 | 361 | 49.9 | 272 | 0 (0 ms) | 1.04 MB | 48 ms |
| glide-data-grid | scroll-x | 2.71 | 4.70 | 7.20 | 8.7 | 178 | 33.4 | 42 | 0 (0 ms) | 1.00 MB | 17 ms |
| glide-data-grid | updates | 0.81 | 1.39 | 2.42 | 3.0 | 315 | 16.7 | 0 | 0 (0 ms) | 0.18 MB | 10 ms |
| vtable | scroll-y | 37.78 | 54.77 ⚠ | 64.42 | 129.8 | 814 | 50.1 | 704 | 5 (311 ms) | 11.60 MB | 703 ms |
| vtable | scroll-x | 0.80 | 28.71 ⚠ | 33.82 | 44.6 | 325 | 33.4 | 80 | 0 (0 ms) | 0.52 MB | 754 ms |
| vtable | updates | 18.25 | 24.84 ⚠ | 30.60 | 58.8 | 157 | 50.0 | 109 | 0 (0 ms) | 0.42 MB | 730 ms |
| tanstack-table+virtual | scroll-y | 5.83 | 12.42 ⚠ | 14.70 | 21.4 | 455 | 16.8 | 3 | 0 (0 ms) | 57.72 MB | 4713 ms |
| tanstack-table+virtual | scroll-x | 6.65 | 12.45 ⚠ | 30.56 | 32.4 | 178 | 16.7 | 1 | 0 (0 ms) | 1.22 MB | 4090 ms |
| tanstack-table+virtual | updates | 3.47 | 8.75 ⚠ | 15.04 | 61.8 | 313 | 16.8 | 1 | 0 (0 ms) | 0.79 MB | 4087 ms |

Library-reported paint time (frame callback only):

| Library | Scenario | p50 | p95 | p99 | max |
| --- | --- | ---: | ---: | ---: | ---: |
| falcon-grid | scroll-y | 1.20 | 2.00 | 3.20 | 4.10 |
| falcon-grid | scroll-x | 0.80 | 1.80 | 2.90 | 3.80 |
| falcon-grid | updates | 0.70 | 1.30 | 1.60 | 2.10 |
| falcon-grid | scroll-y-wrap | 0.90 | 1.60 | 2.10 | 2.30 |
| falcon-grid | scroll-up-wrap | 0.80 | 1.60 | 2.10 | 2.40 |
| falcon-grid | scroll-y-cells | 2.30 | 4.00 | 5.50 | 7.90 |
| falcon-grid | scroll-x-cells | 1.20 | 2.90 | 3.60 | 4.10 |
