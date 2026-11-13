/** Globals the fixture page exposes to tests. */
export {};

export interface Compare {
  diff: number;
  first: [number, number] | null;
  colors: string;
  box: number[];
  total: number;
}

declare global {
  interface Window {
    ready?: boolean;
    grid: import('@falcon-grid/core').Grid;
    data: import('@falcon-grid/datagen').Dataset;
    paintLog: { paint: string; blitX: number; blitY: number; rowsMeasured: number; overlay: boolean; cells: number }[];
    events: [string, Record<string, unknown>][];
    columns: import('@falcon-grid/core').ColumnDef[];
    diffImages(a: string, b: string): Promise<Compare>;
    fullRepaint(): void;
    // React fixture (react.html).
    handle: import('@falcon-grid/react').GridHandle;
    /** React Profiler commits so far. */
    commits: number;
    /** Re-renders the app with a fresh inline `columns` array. */
    rerender(): void;
    /** Committed edits: [row, column id, value]. */
    edits: [number, string, string][];
    /** Controlled mode: ignore the next selection changes (the owner keeps its selection). */
    rejectSelection: boolean;
    selectionChanges: number;
    consoleErrors: string[];
    table: import('@tanstack/table-core').Table<number>;
    // List fixture (list.html).
    list: import('@falcon-grid/list').List<{ id: number; header?: string; author: string; body: string }>;
    listHandle: import('@falcon-grid/react').ListHandle;
    prepend(n: number): void;
    append(n: number): void;
    ids: { first(): number; count(): number };
  }
}

