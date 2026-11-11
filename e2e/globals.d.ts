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
    paintLog: { paint: string; blitX: number; blitY: number; rowsMeasured: number; overlay: boolean }[];
    events: [string, Record<string, unknown>][];
    columns: import('@falcon-grid/core').ColumnDef[];
    diffImages(a: string, b: string): Promise<Compare>;
    fullRepaint(): void;
  }
}

