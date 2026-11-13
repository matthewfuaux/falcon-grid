import type { FrameInfo } from '@falcon-grid/core';
import { createDataset } from '@falcon-grid/datagen';
import { Grid, useGridRef, useGridState, type GridColumn, type GridRef, type GridSelection } from '@falcon-grid/react';
import { useCanvasTable } from '@falcon-grid/tanstack';
import { getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { Profiler, StrictMode, useReducer, useState, type ReactNode } from 'react';
import { hydrateRoot, createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';

/**
 * React fixture. Query flags:
 *   strict      wrap in <StrictMode>
 *   controlled  controlled selection (window.rejectSelection makes the owner ignore changes)
 *   tanstack    a TanStack Table example rendered with useCanvasTable
 *   ssr         server-render to a string, then hydrate
 */
const q = new URLSearchParams(location.search);
const data = createDataset(Number(q.get('rows') ?? 100_000), Number(q.get('cols') ?? 20));

const consoleErrors: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    // `?ssr` server-renders in the browser, where `window` exists, so the component picks
    // useLayoutEffect and React warns. On a real server it picks useEffect (see ssr.test.tsx).
    if (String(args[0]).includes('useLayoutEffect does nothing on the server')) return;
    consoleErrors.push(args.map(String).join(' '));
    original(...args);
  };
}

const paintLog: { paint: string; blitX: number; blitY: number; rowsMeasured: number; overlay: boolean; cells: number }[] = [];
const onFrame = (f: Readonly<FrameInfo>) =>
  paintLog.push({ paint: f.paint, blitX: f.blitX, blitY: f.blitY, rowsMeasured: f.rowsMeasured, overlay: f.overlay, cells: f.cellsPainted });

const edits: [number, string, string][] = [];
const edited = new Map<string, string>();
let handleRef: GridRef | null = null;
let commits = 0;
let rerender = () => {};

/** Rows are indices; values come from the synthetic dataset, or an edit. */
const getRow = (i: number): number | undefined => (i < data.rowCount ? i : undefined);

/** A fresh array each call, as an inline `columns={[...]}` would be. */
const columnsFor = (): GridColumn<number>[] =>
  data.columns.map((c, i) => ({
    id: c.id,
    title: c.title,
    width: c.width,
    value: (r: number) => edited.get(`${r}:${c.id}`) ?? data.get(r, i),
  }));

/** Shows the active cell; re-renders only when it changes. */
function ActiveCell() {
  const active = useGridState((s) => s.activeCell);
  return <output id="active">{active ? `${active.row},${active.col}` : 'none'}</output>;
}

function App() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  rerender = force;
  const ref = useGridRef();
  handleRef = ref;
  const [selection, setSelection] = useState<GridSelection>({ ranges: [], activeCell: null });
  const controlled = q.has('controlled');
  return (
    <Grid
      ref={ref}
      rowCount={data.rowCount}
      columns={columnsFor()}
      getRow={getRow}
      frozenColumns={Number(q.get('frozenColumns') ?? 0)}
      onFrame={onFrame}
      {...(q.has('top') ? { defaultScrollPosition: { top: Number(q.get('top')) } } : {})}
      {...(controlled
        ? {
            selection,
            onSelectionChange: (s: GridSelection) => {
              window.selectionChanges++;
              if (!window.rejectSelection) setSelection(s);
            },
          }
        : { onSelectionChange: () => void window.selectionChanges++ })}
      onCellEdit={({ row, column, value }) => {
        edits.push([row, column.id, value]);
        edited.set(`${row}:${column.id}`, value);
      }}
    >
      <ActiveCell />
    </Grid>
  );
}

// The TanStack example from bench/targets/tanstack.tsx, rendered on canvas: the table setup
// is the same, and the render layer is `<Grid {...useCanvasTable(table)} />`.
const rows = Array.from({ length: data.rowCount }, (_, i) => i);
const tableColumns: ColumnDef<number, string>[] = data.columns.map((c, col) => ({
  id: c.id,
  header: c.title,
  size: c.width,
  accessorFn: (r) => data.get(r, col),
}));

function TanstackApp() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  rerender = force;
  const ref = useGridRef();
  handleRef = ref;
  const table = useReactTable({
    data: rows,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  window.table = table;
  return <Grid ref={ref} {...useCanvasTable(table)} onFrame={onFrame} />;
}

function Root() {
  let app: ReactNode = q.has('tanstack') ? <TanstackApp /> : <App />;
  app = (
    <Profiler id="grid" onRender={() => void commits++}>
      {app}
    </Profiler>
  );
  return q.has('strict') ? <StrictMode>{app}</StrictMode> : app;
}

Object.defineProperties(window, {
  grid: { get: () => handleRef?.current?.grid, configurable: true },
  handle: { get: () => handleRef?.current, configurable: true },
  commits: { get: () => commits, configurable: true },
  ready: { get: () => !!handleRef?.current?.grid, configurable: true },
});
Object.assign(window, {
  paintLog,
  edits,
  consoleErrors,
  rejectSelection: false,
  selectionChanges: 0,
  rerender: () => rerender(),
});

const container = document.getElementById('root')!;
if (q.has('ssr')) {
  container.innerHTML = renderToString(<Root />);
  (window as unknown as { serverHTML: string }).serverHTML = container.innerHTML;
  hydrateRoot(container, <Root />, {
    onRecoverableError: (e) => consoleErrors.push(`recoverable: ${String(e)}`),
  });
} else {
  createRoot(container).render(<Root />);
}
