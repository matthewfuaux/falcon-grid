# Contributing to falcon-grid

Thanks for helping. This file covers how to set up, what a good change looks like, and what CI checks.
For how the code fits together, read [`docs/architecture.md`](./docs/architecture.md) first.

## Setup

You need Node 20 or later and pnpm 10 (`corepack enable` gives you the version pinned in
`package.json`).

```sh
pnpm install
pnpm exec playwright install chromium                           # browser tests
pnpm --filter @falcon-grid/bench exec playwright install chromium  # benchmarks (optional)
pnpm dev                                                        # playground: grid, log viewer, chat
```

The playground (`apps/playground`) has a grid page, a 1M-line log viewer and a chat transcript.
Packages are consumed from source in the workspace, so edits show up without a build.

## Checks

| Command | What it checks |
| --- | --- |
| `pnpm typecheck` | TypeScript strict, every package plus the e2e tests |
| `pnpm test` | Unit tests (Vitest, with fast-check property tests for the data structures) |
| `pnpm test:e2e` | Browser tests: incremental paints match full repaints pixel for pixel, interaction, accessibility (axe), React, TanStack, list mode |
| `pnpm size` | Builds the packages and fails if one is over its gzip budget (`.size-limit.json`) |
| `pnpm bench` | Frame-time benchmarks against Glide Data Grid, VTable and TanStack Table |

CI runs everything except the benchmarks on each pull request. Put the `bench` label on a pull
request to run the falcon-grid benchmarks too.

## What a good change looks like

- **Small and focused.** One behaviour per pull request. For anything that changes a public API
  or adds a feature, open an issue first so we can agree on the shape.
- **Tested at the right layer.** Data structures and layout get unit tests; anything that
  paints gets an e2e test. A change to painting must keep the "incremental equals full repaint"
  tests green on both the software and GPU projects.
- **Inside the budgets.** No new runtime dependencies in `core`. Stay inside the size budgets
  and the 8 ms p95 frame budget. If a feature needs more, say so in the pull request and update
  the budget and the plan with a reason. Don't do it quietly.
- **No allocations in the frame loop.** Painting reuses its buffers. Add to the steady-state
  allocation count only with a reason.
- **React stays out of the frame loop.** Scrolling and hovering must not render.
- **Accessible.** Anything pointer-only needs a keyboard path and an entry in
  `docs/accessibility.md`.
- **Comments say why**, not what. Keep doc comments on public APIs current.

## Commits and pull requests

Write commit subjects in the imperative ("Add sticky group headers"). In the pull request,
say what changed and why, how you tested it, and include benchmark numbers if the change
touches painting or layout.

## Reporting bugs

Use the bug report template. A minimal reproduction (a playground change, a CodeSandbox, or a
failing test) gets a bug fixed fastest. For security issues, don't open an issue: use GitHub's
private vulnerability reporting on the repository.

## Code of conduct

Everyone taking part agrees to the [code of conduct](./CODE_OF_CONDUCT.md).
