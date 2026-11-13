import { initialGridState, type CellRange, type CellRef, type Grid, type GridState } from '@falcon-grid/core';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

/** Layout effects on the client, nothing on the server (no SSR warning). */
export const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** The selection: ranges plus the active (focused) cell. */
export interface GridSelection {
  ranges: readonly CellRange[];
  activeCell: CellRef | null;
}

/** A column by position or by id. */
export type ColumnKey = number | string;

/**
 * Imperative access to a mounted `<Grid>`. Safe to call before mount or after unmount: calls
 * do nothing and reads return the initial state.
 */
export interface GridHandle {
  /** The core grid, or null while not mounted. An escape hatch; prefer the methods. */
  readonly grid: Grid | null;
  getState(): GridState;
  /** Called on every state change (scroll, hover, selection…), and when the grid mounts or unmounts. */
  subscribe(listener: () => void): () => void;
  scrollToCell(row: number, col: ColumnKey): void;
  scrollToRow(row: number): void;
  scrollTo(position: { left?: number; top?: number }): void;
  /** Repaint rows [start, end) after their data changed in place, e.g. on a streaming tick. */
  invalidateRows(start: number, end: number): void;
  invalidateCell(row: number, col: ColumnKey): void;
  /** Repaint everything (and re-measure auto row heights unless `remeasure` is false). */
  invalidate(options?: { remeasure?: boolean }): void;
  getCellBounds(row: number, col: ColumnKey): { x: number; y: number; width: number; height: number } | null;
  /** Open the editor on a cell (needs `onCellEdit`). */
  startEditing(row: number, col: ColumnKey): void;
  copySelection(): { text: string; html: string } | null;
  focus(): void;
}

const INITIAL = initialGridState();

/** Column position for a key, or -1. */
export function columnIndex(grid: Grid, col: ColumnKey): number {
  if (typeof col === 'number') return col;
  return grid.getState().columns.findIndex((c) => c.id === col);
}

/** The handle `<Grid>` gives out. Created before the core grid exists and outlives remounts. */
export class HandleImpl implements GridHandle {
  grid: Grid | null = null;
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  /** Set by `<Grid>`. */
  edit: (row: number, col: number) => void = () => {};

  attach(grid: Grid | null): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.grid = grid;
    if (grid) this.unsubscribe = grid.store.subscribe(() => this.emit());
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  getState = (): GridState => this.grid?.getState() ?? INITIAL;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  scrollToCell(row: number, col: ColumnKey): void {
    const g = this.grid;
    if (g) g.scrollToCell(row, columnIndex(g, col));
  }
  scrollToRow(row: number): void {
    this.grid?.scrollToRow(row);
  }
  scrollTo(position: { left?: number; top?: number }): void {
    this.grid?.scrollTo(position);
  }
  invalidateRows(start: number, end: number): void {
    this.grid?.invalidateRows(start, end);
  }
  invalidateCell(row: number, col: ColumnKey): void {
    const g = this.grid;
    if (g) g.invalidateCell(row, columnIndex(g, col));
  }
  invalidate(options?: { remeasure?: boolean }): void {
    this.grid?.invalidate(options);
  }
  getCellBounds(row: number, col: ColumnKey) {
    const g = this.grid;
    return g ? g.getCellBounds(row, columnIndex(g, col)) : null;
  }
  startEditing(row: number, col: ColumnKey): void {
    const g = this.grid;
    if (g) this.edit(row, columnIndex(g, col));
  }
  copySelection() {
    return this.grid?.copySelection() ?? null;
  }
  focus(): void {
    this.grid?.focus();
  }
}

/**
 * A ref for `<Grid ref={…}>` that `useGridState` can watch: components re-render when the grid
 * mounts, not only when its state changes. A plain `useRef` works too, without that.
 */
export interface GridRef {
  current: GridHandle | null;
}

class WatchedRef implements GridRef {
  declare current: GridHandle | null;
  private readonly listeners = new Set<() => void>();
  constructor() {
    let value: GridHandle | null = null;
    // An own property: React only accepts objects that have `current` themselves as refs.
    Object.defineProperty(this, 'current', {
      enumerable: true,
      get: () => value,
      set: (v: GridHandle | null) => {
        if (v === value) return;
        value = v;
        for (const l of this.listeners) l();
      },
    });
  }
  watch(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}

/** A stable ref to pass to `<Grid ref={…}>` and to `useGridState(ref, selector)`. */
export function useGridRef(): GridRef {
  return useState(() => new WatchedRef())[0];
}

/** Provided by `<Grid>` to its children (overlays). */
export const GridContext = createContext<{ handle: HandleImpl; layer: HTMLElement | null } | null>(null);

export function useGridContext(): { handle: HandleImpl; layer: HTMLElement | null } {
  const ctx = useContext(GridContext);
  if (!ctx) throw new Error('falcon-grid: this component must be rendered inside <Grid>');
  return ctx;
}

type Selector<T> = (state: GridState) => T;
type Equal<T> = (a: T, b: T) => boolean;

/**
 * Subscribes a component to part of the grid's state. It re-renders only when the selected
 * value changes (`Object.is`, or `isEqual`), so select narrowly: `s => s.activeCell`, not
 * `s => s`, which changes on every scroll frame.
 *
 * Inside `<Grid>` children: `useGridState(selector)`. Elsewhere: `useGridState(ref, selector)`
 * with the ref from `useGridRef()`.
 */
export function useGridState<T>(selector: Selector<T>, isEqual?: Equal<T>): T;
export function useGridState<T>(ref: GridRef, selector: Selector<T>, isEqual?: Equal<T>): T;
export function useGridState<T>(a: GridRef | Selector<T>, b?: Selector<T> | Equal<T>, c?: Equal<T>): T {
  const ctx = useContext(GridContext);
  const ref: GridRef | null = typeof a === 'function' ? null : a;
  const selector = (typeof a === 'function' ? a : b) as Selector<T>;
  const isEqual = (typeof a === 'function' ? b : c) as Equal<T> | undefined;
  if (!ref && !ctx) throw new Error('falcon-grid: useGridState(selector) needs <Grid> above it; pass a ref otherwise');

  const subscribe = useCallback(
    (cb: () => void) => {
      if (!ref) return ctx!.handle.subscribe(cb);
      let inner = ref.current?.subscribe(cb);
      const reattach = () => {
        inner?.();
        inner = ref.current?.subscribe(cb);
        cb();
      };
      const unwatch = ref instanceof WatchedRef ? ref.watch(reattach) : null;
      return () => {
        unwatch?.();
        inner?.();
      };
    },
    [ref, ctx],
  );

  const memo = useRef<{ state: GridState | null; selector: Selector<T> | null; value: T | undefined }>({
    state: null,
    selector: null,
    value: undefined,
  });
  const getSnapshot = (): T => {
    const state = ref ? (ref.current?.getState() ?? INITIAL) : ctx!.handle.getState();
    const m = memo.current;
    if (m.state === state && m.selector === selector) return m.value as T;
    const value = selector(state);
    const had = m.state !== null;
    m.state = state;
    m.selector = selector;
    if (had && (isEqual ? isEqual(m.value as T, value) : Object.is(m.value, value))) return m.value as T;
    m.value = value;
    return value;
  };
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The handle of the `<Grid>` this component is rendered inside. */
export function useGrid(): GridHandle {
  return useGridContext().handle;
}
