# Benchmark report

- **Date:** 2026-11-10T09:16:12.516Z
- **Browser:** Chromium 131.0.6778.33 (headless, GPU canvas via SwiftShader)
- **Machine:** AMD Ryzen 9 9900X 12-Core Processor × 24, 30 GB
- **Platform:** linux x64
- **Data:** 1,000,000 rows × 100 columns
- **Viewport:** 1440×900 @1x

Frame work is main-thread time per frame from the Chrome trace (budget 8 ms at p95).
Interval is time between rAF callbacks; "slow" counts intervals over one 60 Hz frame.

| Library | Scenario | Work p50 | Work p95 | Work p99 | Work max | Frames | Interval p95 | Slow | Long tasks | Heap growth | Mount |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| falcon-grid | scroll-y | 3.20 | 5.32 | 8.58 | 14.6 | 391 | 33.4 | 219 | 0 (0 ms) | 0.11 MB | 17 ms |
| falcon-grid | scroll-x | 3.04 | 4.95 | 5.91 | 15.4 | 208 | 33.4 | 100 | 0 (0 ms) | 0.10 MB | 30 ms |
| falcon-grid | updates | 2.50 | 3.44 | 6.68 | 8.5 | 200 | 33.4 | 115 | 0 (0 ms) | 0.10 MB | 27 ms |
| glide-data-grid | scroll-y | 2.82 | 4.60 | 6.85 | 32.8 | 359 | 49.9 | 269 | 0 (0 ms) | 1.04 MB | 21 ms |
| glide-data-grid | scroll-x | 2.63 | 4.39 | 6.35 | 8.2 | 174 | 33.4 | 38 | 0 (0 ms) | 1.00 MB | 10 ms |
| glide-data-grid | updates | 0.73 | 1.30 | 1.95 | 3.2 | 315 | 16.7 | 0 | 0 (0 ms) | 0.18 MB | 42 ms |
| vtable | scroll-y | 34.11 | 46.57 ⚠ | 56.92 | 120.3 | 850 | 50.1 | 761 | 2 (145 ms) | 11.58 MB | 674 ms |
| vtable | scroll-x | 0.62 | 24.45 ⚠ | 28.40 | 37.0 | 391 | 33.3 | 56 | 0 (0 ms) | 0.51 MB | 709 ms |
| vtable | updates | 16.63 | 20.69 ⚠ | 30.63 | 40.5 | 159 | 50.0 | 121 | 0 (0 ms) | 0.41 MB | 690 ms |
| tanstack-table+virtual | scroll-y | 5.95 | 12.07 ⚠ | 14.81 | 25.0 | 334 | 16.7 | 1 | 0 (0 ms) | 57.72 MB | 4655 ms |
| tanstack-table+virtual | scroll-x | 6.48 | 12.18 ⚠ | 27.28 | 40.8 | 177 | 16.8 | 2 | 0 (0 ms) | 1.22 MB | 4097 ms |
| tanstack-table+virtual | updates | 2.88 | 7.27 | 11.50 | 70.9 | 313 | 16.7 | 1 | 0 (0 ms) | 0.79 MB | 3848 ms |

Library-reported paint time (frame callback only):

| Library | Scenario | p50 | p95 | p99 | max |
| --- | --- | ---: | ---: | ---: | ---: |
| falcon-grid | scroll-y | 1.30 | 1.80 | 2.20 | 2.60 |
| falcon-grid | scroll-x | 1.30 | 1.80 | 2.30 | 2.60 |
| falcon-grid | updates | 1.10 | 1.60 | 1.80 | 1.90 |
