import {
  createGrid,
  defaultTheme,
  type CellEvent,
  type CellRange,
  type CellRef,
  type CellValue,
  type ColumnDef,
  type FrameInfo,
  type Grid as CoreGrid,
  type GridOptions,
  type HeaderEvent,
  type TextWrapper,
  type Theme,
} from '@falcon-grid/core';
import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type ForwardedRef,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { ColumnDefs, stableColumns, textOf, valueOf, type GridColumn } from './columns';
import { GridContext, HandleImpl, columnIndex, useIsoLayoutEffect, type GridHandle, type GridSelection } from './handle';
import { CellOverlay, TextEditor, type EditMove, type EditorProps } from './overlay';

/** A pointer event on a cell, with the row's data and the column as passed to `<Grid>`. */
export interface GridCellEvent<TRow> {
  /** Row index. */
  row: number;
  /** Column position (changes when columns are reordered); prefer `column.id`. */
  col: number;
  column: GridColumn<TRow>;
  rowData: TRow | undefined;
  event: MouseEvent;
}

export interface GridHeaderEvent<TRow> {
  col: number;
  column: GridColumn<TRow>;
  event: MouseEvent;
}

export interface ColumnWidthChange {
  columnId: string;
  width: number;
  event: Event;
}

export interface ColumnOrderChange {
  columnId: string;
  /** Positions before and after the move. */
  from: number;
  to: number;
  event: Event;
}

/** A committed edit. Update your data; the cell is repainted for you. */
export interface CellEdit<TRow> {
  row: number;
  rowData: TRow;
  column: GridColumn<TRow>;
  value: string;
}

export interface ScrollPosition {
  left: number;
  top: number;
}

export interface GridProps<TRow> {
  rowCount: number;
  /** Column definitions. An inline array is fine: columns are compared structurally. */
  columns: readonly GridColumn<TRow>[];
  /**
   * The row at an index, called only for visible rows. Its identity is the data-change signal:
   * a new function repaints the grid, so wrap it in `useCallback` over your rows. For changes
   * in place, call `invalidateRows` or `invalidateCell` on the handle instead.
   */
  getRow: (rowIndex: number) => TRow | undefined;
  /** Row height in CSS pixels (default `theme.rowHeight`), or 'auto' to fit wrapped content. */
  rowHeight?: number | 'auto';
  frozenColumns?: number;
  frozenRows?: number;
  /** Merged over the default theme. Compared shallowly, so an inline object is fine. */
  theme?: Partial<Theme>;
  /** Wrapping engine for `wrap` columns, e.g. `createPretextWrapper()` from `@falcon-grid/text`. */
  textWrapper?: TextWrapper;

  /** Controlled selection. Without it the grid keeps its own, starting from `defaultSelection`. */
  selection?: GridSelection;
  defaultSelection?: GridSelection;
  /** The user changed the selection or the active cell. */
  onSelectionChange?: (selection: GridSelection, event: Event) => void;

  /** Controlled widths by column id, overriding `column.width`. */
  columnWidths?: Readonly<Record<string, number>>;
  defaultColumnWidths?: Readonly<Record<string, number>>;
  /** Fired on every width change while dragging, with all widths set by resizing so far. */
  onColumnWidthsChange?: (widths: Record<string, number>, change: ColumnWidthChange) => void;

  /** Controlled column order (ids). Columns missing from it follow, in `columns` order. */
  columnOrder?: readonly string[];
  defaultColumnOrder?: readonly string[];
  onColumnOrderChange?: (order: string[], change: ColumnOrderChange) => void;

  /**
   * Controlled scroll position, in CSS pixels of content. The grid scrolls when it changes.
   * Controlling it re-renders your component on every scroll frame, so prefer
   * `defaultScrollPosition` plus `onScroll` (or the handle) unless you need it.
   */
  scrollPosition?: Partial<ScrollPosition>;
  defaultScrollPosition?: Partial<ScrollPosition>;
  onScroll?: (position: ScrollPosition) => void;

  onCellClick?: (e: GridCellEvent<TRow>) => void;
  /** Starts editing unless the handler calls `event.preventDefault()`. */
  onCellDoubleClick?: (e: GridCellEvent<TRow>) => void;
  onCellContextMenu?: (e: GridCellEvent<TRow>) => void;
  onHeaderClick?: (e: GridHeaderEvent<TRow>) => void;

  /**
   * Turns on editing: double-click, Enter, F2 or typing on the active cell opens `editor` over
   * it. Columns opt out with `editable: false`.
   */
  onCellEdit?: (edit: CellEdit<TRow>) => void;
  /** The editor component (default `TextEditor`). */
  editor?: ComponentType<EditorProps<TRow>>;

  /** Called after every painted frame. For instrumentation; keep it cheap. */
  onFrame?: (info: Readonly<FrameInfo>) => void;

  /** Accessible name of the grid. Give one of these: screen readers announce it on entry. */
  'aria-label'?: string;
  'aria-labelledby'?: string;
  /** Follow `prefers-contrast` and forced colours (default true). */
  respectUserPreferences?: boolean;
  /** Scale theme sizes with the root font size (default true). */
  scaleWithRootFont?: boolean;

  /** Size of the grid (default 100% of its parent). Also the size of the server placeholder. */
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: CSSProperties;
  /** Overlays (`<CellOverlay>`) and components using `useGridState`. */
  children?: ReactNode;
}

interface EditState {
  row: number;
  colId: string;
  initial: string;
  typed: boolean;
}

/** Last values pushed into the core, to send only what changed. */
interface Pushed {
  defs: readonly ColumnDef[];
  rowCount: number;
  frozenColumns: number;
  frozenRows: number;
  rowSizing: 'fixed' | 'auto';
  theme: Partial<Theme>;
  textWrapper: TextWrapper | undefined;
  onFrame: ((info: Readonly<FrameInfo>) => void) | undefined;
  getRow: unknown;
  selection: GridSelection | undefined;
  scroll: Partial<ScrollPosition> | undefined;
  controlledSelection: boolean;
  label: string | undefined;
  labelledBy: string | undefined;
  prefs: boolean | undefined;
  scaleFont: boolean | undefined;
}

const EMPTY_THEME: Partial<Theme> = {};

function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

const cellRange = ({ row, col }: CellRef): CellRange => ({ top: row, left: col, bottom: row, right: col });

const MOVES: Record<Exclude<EditMove, null>, [number, number]> = {
  up: [-1, 0],
  down: [1, 0],
  left: [0, -1],
  right: [0, 1],
};

function GridImpl<TRow>(props: GridProps<TRow>, ref: ForwardedRef<GridHandle>): ReactElement {
  const handle = useState(() => new HandleImpl())[0];
  useImperativeHandle(ref, () => handle, [handle]);

  const propsRef = useRef(props);
  propsRef.current = props;

  const hostRef = useRef<HTMLDivElement>(null);
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  const [editing, setEditing] = useState<EditState | null>(null);

  // Everything below lives across renders and core re-creation (Strict Mode, Fast Refresh).
  const self = useState(() => ({
    columnDefs: new ColumnDefs<TRow>(),
    stable: null as readonly GridColumn<TRow>[] | null,
    theme: EMPTY_THEME,
    /** Uncontrolled widths and order. */
    widths: undefined as Readonly<Record<string, number>> | undefined,
    order: undefined as readonly string[] | undefined,
    /** Columns from the latest props by id, for their functions. */
    latest: { columns: null as readonly GridColumn<TRow>[] | null, byId: new Map<string, GridColumn<TRow>>() },
    pushed: null as Pushed | null,
    /** State carried over when the core grid is re-created. */
    saved: null as { selection: GridSelection; scroll: ScrollPosition } | null,
  }))[0];

  /** The latest column with this id (its `value` and `editValue` may be new closures). */
  const latestColumn = (id: string): GridColumn<TRow> | undefined => {
    const cols = propsRef.current.columns;
    if (self.latest.columns !== cols) self.latest = { columns: cols, byId: new Map(cols.map((c) => [c.id, c])) };
    return self.latest.byId.get(id);
  };

  /** Props resolved to what the core takes. Pure apart from caches; called during effects. */
  const resolve = () => {
    const p = propsRef.current;
    self.stable = stableColumns(self.stable, p.columns);
    const defs = self.columnDefs.get(self.stable, p.columnOrder ?? self.order, p.columnWidths ?? self.widths);
    let theme = p.theme ?? EMPTY_THEME;
    if (typeof p.rowHeight === 'number') theme = { ...theme, rowHeight: p.rowHeight };
    if (theme !== self.theme && !shallowEqual(theme, self.theme)) self.theme = theme;
    return {
      defs,
      theme: self.theme,
      rowSizing: p.rowHeight === 'auto' ? ('auto' as const) : ('fixed' as const),
    };
  };

  const pushColumns = (grid: CoreGrid) => {
    const { defs } = resolve();
    if (defs !== grid.getState().columns) grid.update({ columns: defs });
    if (self.pushed) self.pushed.defs = defs;
  };

  /** Applies a user's selection change: directly when uncontrolled, and tells the owner. */
  const selectCell = (grid: CoreGrid, cell: CellRef, event: Event) => {
    const p = propsRef.current;
    const ranges = [cellRange(cell)];
    if (p.selection === undefined) grid.setSelection(ranges, cell);
    p.onSelectionChange?.({ ranges, activeCell: cell }, event);
    grid.scrollToCell(cell.row, cell.col);
  };

  const startEditing = (row: number, col: number, typed?: string) => {
    const grid = handle.grid;
    const p = propsRef.current;
    if (!grid || !p.onCellEdit) return;
    const def = grid.getState().columns[col];
    const column = def && latestColumn(def.id);
    if (!column || column.editable === false) return;
    const rowData = p.getRow(row);
    if (rowData === undefined) return;
    const initial = typed ?? (column.editValue ? column.editValue(rowData, row) : textOf(column, rowData, row));
    grid.scrollToCell(row, col);
    setEditing({ row, colId: column.id, initial, typed: typed !== undefined });
  };
  handle.edit = (row, col) => startEditing(row, col);

  // Create the core grid. Runs again under Strict Mode and Fast Refresh; state carries over.
  useIsoLayoutEffect(() => {
    const host = hostRef.current!;
    const p = propsRef.current;
    const { defs, theme, rowSizing } = resolve();

    const cellEvent = (e: CellEvent): GridCellEvent<TRow> => ({
      row: e.row,
      col: e.col,
      column: latestColumn(e.column.id) ?? ({ id: e.column.id } as GridColumn<TRow>),
      rowData: propsRef.current.getRow(e.row),
      event: e.event,
    });
    const headerEvent = (e: HeaderEvent): GridHeaderEvent<TRow> => ({
      col: e.col,
      column: latestColumn(e.column.id) ?? ({ id: e.column.id } as GridColumn<TRow>),
      event: e.event,
    });

    const options: GridOptions = {
      columns: defs,
      rowCount: p.rowCount,
      getCell: (row, _col, column) =>
        valueOf(latestColumn(column.id), propsRef.current.getRow(row), row) as CellValue,
      frozenColumns: p.frozenColumns ?? 0,
      frozenRows: p.frozenRows ?? 0,
      rowSizing,
      theme,
      controlledSelection: p.selection !== undefined,
      // Width and order live here (props or uncontrolled state), so re-renders keep them.
      controlledColumns: true,
      onCellClick: (e) => propsRef.current.onCellClick?.(cellEvent(e)),
      onCellDoubleClick: (e) => {
        propsRef.current.onCellDoubleClick?.(cellEvent(e));
        if (!e.event.defaultPrevented) startEditing(e.row, e.col);
      },
      onCellContextMenu: (e) => propsRef.current.onCellContextMenu?.(cellEvent(e)),
      onHeaderClick: (e) => propsRef.current.onHeaderClick?.(headerEvent(e)),
      onSelectionChange: (e) =>
        propsRef.current.onSelectionChange?.({ ranges: e.selection, activeCell: e.activeCell }, e.event),
      onColumnResize: (e) => {
        const q = propsRef.current;
        const columnId = e.column.id;
        const widths = { ...(q.columnWidths ?? self.widths), [columnId]: e.width };
        if (q.columnWidths === undefined) {
          self.widths = widths;
          pushColumns(grid);
        }
        q.onColumnWidthsChange?.(widths, { columnId, width: e.width, event: e.event });
      },
      onColumnReorder: (e) => {
        const q = propsRef.current;
        const order = grid.getState().columns.map((c) => c.id);
        const [id] = order.splice(e.from, 1);
        order.splice(e.to, 0, id!);
        if (q.columnOrder === undefined) {
          self.order = order;
          pushColumns(grid);
        }
        q.onColumnOrderChange?.(order, { columnId: id!, from: e.from, to: e.to, event: e.event });
      },
    };
    if (p.textWrapper) options.textWrapper = p.textWrapper;
    if (p.onFrame) options.onFrame = p.onFrame;
    if (p['aria-label']) options.ariaLabel = p['aria-label'];
    if (p['aria-labelledby']) options.ariaLabelledBy = p['aria-labelledby'];
    if (p.respectUserPreferences !== undefined) options.respectUserPreferences = p.respectUserPreferences;
    if (p.scaleWithRootFont !== undefined) options.scaleWithRootFont = p.scaleWithRootFont;
    const grid = createGrid(host, options);

    const saved = self.saved;
    const selection = p.selection ?? saved?.selection ?? p.defaultSelection;
    if (selection) grid.setSelection(selection.ranges, selection.activeCell);
    // The scroller has no size until the grid is laid out, and scrolling it now would clamp to
    // 0, so the starting position waits for a viewport.
    let pendingScroll = p.scrollPosition ?? saved?.scroll ?? p.defaultScrollPosition ?? null;
    if (pendingScroll && !pendingScroll.left && !pendingScroll.top) pendingScroll = null;
    const applyPendingScroll = () => {
      if (!pendingScroll || grid.getState().viewportHeight <= 0) return;
      const to = pendingScroll;
      pendingScroll = null;
      grid.scrollTo(to);
    };
    applyPendingScroll();

    self.pushed = {
      defs,
      rowCount: p.rowCount,
      frozenColumns: p.frozenColumns ?? 0,
      frozenRows: p.frozenRows ?? 0,
      rowSizing,
      theme,
      textWrapper: p.textWrapper,
      onFrame: p.onFrame,
      getRow: p.getRow,
      selection: p.selection,
      scroll: p.scrollPosition,
      controlledSelection: p.selection !== undefined,
      label: p['aria-label'],
      labelledBy: p['aria-labelledby'],
      prefs: p.respectUserPreferences,
      scaleFont: p.scaleWithRootFont,
    };

    // onScroll: the store changes for many reasons; report only scroll moves.
    let { scrollLeft: lastLeft, scrollTop: lastTop } = grid.getState();
    const unsubscribe = grid.store.subscribe(() => {
      applyPendingScroll();
      const s = grid.getState();
      if (s.scrollLeft === lastLeft && s.scrollTop === lastTop) return;
      lastLeft = s.scrollLeft;
      lastTop = s.scrollTop;
      propsRef.current.onScroll?.({ left: lastLeft, top: lastTop });
    });

    // Enter, F2 or a printable key on the active cell starts editing.
    const onKeyDown = (e: KeyboardEvent) => {
      if (!grid.isKeyTarget(e.target) || e.defaultPrevented || e.isComposing) return;
      if (e.altKey || e.ctrlKey || e.metaKey || !propsRef.current.onCellEdit) return;
      const active = grid.getState().activeCell;
      if (!active) return;
      if (e.key === 'Enter' || e.key === 'F2') {
        e.preventDefault();
        startEditing(active.row, active.col);
      } else if (e.key.length === 1 && e.key !== ' ') {
        e.preventDefault();
        startEditing(active.row, active.col, e.key);
      }
    };
    grid.element.addEventListener('keydown', onKeyDown);

    handle.attach(grid);
    setLayer(grid.domLayer);

    return () => {
      const s = grid.getState();
      self.saved = {
        selection: { ranges: s.selection, activeCell: s.activeCell },
        scroll: { left: s.scrollLeft, top: s.scrollTop },
      };
      grid.element.removeEventListener('keydown', onKeyDown);
      unsubscribe();
      handle.attach(null);
      grid.destroy();
      self.pushed = null;
      setLayer(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push changed props into the core after every render. Renders never happen during scroll or
  // hover, and unchanged props cost a few comparisons.
  useIsoLayoutEffect(() => {
    const grid = handle.grid;
    const last = self.pushed;
    if (!grid || !last) return;
    const p = propsRef.current;
    const { defs, theme, rowSizing } = resolve();
    // `undefined` is meaningful here: it clears `textWrapper` and `onFrame`.
    const patch: { [K in keyof GridOptions]?: GridOptions[K] | undefined } = {};
    if (defs !== last.defs) patch.columns = last.defs = defs;
    if (p.rowCount !== last.rowCount) patch.rowCount = last.rowCount = p.rowCount;
    if ((p.frozenColumns ?? 0) !== last.frozenColumns) patch.frozenColumns = last.frozenColumns = p.frozenColumns ?? 0;
    if ((p.frozenRows ?? 0) !== last.frozenRows) patch.frozenRows = last.frozenRows = p.frozenRows ?? 0;
    if (rowSizing !== last.rowSizing) patch.rowSizing = last.rowSizing = rowSizing;
    if (theme !== last.theme) patch.theme = last.theme = theme;
    if (p.textWrapper !== last.textWrapper) {
      patch.textWrapper = last.textWrapper = p.textWrapper;
    }
    if (p.onFrame !== last.onFrame) patch.onFrame = last.onFrame = p.onFrame;
    const controlled = p.selection !== undefined;
    if (controlled !== last.controlledSelection) patch.controlledSelection = last.controlledSelection = controlled;
    if (p['aria-label'] !== last.label || p['aria-labelledby'] !== last.labelledBy) {
      patch.ariaLabel = last.label = p['aria-label'];
      patch.ariaLabelledBy = last.labelledBy = p['aria-labelledby'];
    }
    if (p.respectUserPreferences !== last.prefs) {
      last.prefs = p.respectUserPreferences;
      patch.respectUserPreferences = p.respectUserPreferences ?? true;
    }
    if (p.scaleWithRootFont !== last.scaleFont) {
      last.scaleFont = p.scaleWithRootFont;
      patch.scaleWithRootFont = p.scaleWithRootFont ?? true;
    }
    if (Object.keys(patch).length > 0) grid.update(patch as Partial<GridOptions>);

    if (p.getRow !== last.getRow) {
      last.getRow = p.getRow;
      grid.invalidate();
    }
    if (p.selection && p.selection !== last.selection) {
      const s = grid.getState();
      if (s.selection !== p.selection.ranges || s.activeCell !== p.selection.activeCell) {
        grid.setSelection(p.selection.ranges, p.selection.activeCell);
      }
    }
    last.selection = p.selection;
    if (p.scrollPosition && p.scrollPosition !== last.scroll) {
      const s = grid.getState();
      const { left, top } = p.scrollPosition;
      const to: Partial<ScrollPosition> = {};
      if (left !== undefined && left !== s.scrollLeft) to.left = left;
      if (top !== undefined && top !== s.scrollTop) to.top = top;
      if (to.left !== undefined || to.top !== undefined) grid.scrollTo(to);
    }
    last.scroll = p.scrollPosition;
  });

  const ctx = useMemo(() => ({ handle, layer }), [handle, layer]);

  let editorElement: ReactNode = null;
  const editColumn = editing ? latestColumn(editing.colId) : undefined;
  const editRow = editing ? props.getRow(editing.row) : undefined;
  if (editing && editColumn && editRow !== undefined && layer) {
    const Editor = props.editor ?? (TextEditor as ComponentType<EditorProps<TRow>>);
    const { row, colId } = editing;
    const finish = () => {
      setEditing(null);
      // Keyboard commits and cancels hand focus back; a blur (focus went elsewhere) does not.
      const grid = handle.grid;
      if (grid && layer.contains(layer.ownerDocument.activeElement)) grid.focus();
      return grid;
    };
    editorElement = (
      <CellOverlay row={row} col={colId}>
        <Editor
          key={`${row}:${colId}`}
          rowIndex={row}
          row={editRow}
          column={editColumn}
          initialValue={editing.initial}
          typed={editing.typed}
          commit={(value, move) => {
            const grid = finish();
            propsRef.current.onCellEdit?.({ row, rowData: editRow, column: editColumn, value });
            if (!grid) return;
            const col = columnIndex(grid, colId);
            if (col >= 0) grid.invalidateCell(row, col);
            if (move && col >= 0) {
              const s = grid.getState();
              const [dr, dc] = MOVES[move];
              const next = {
                row: Math.max(0, Math.min(s.rowCount - 1, row + dr)),
                col: Math.max(0, Math.min(s.columns.length - 1, col + dc)),
              };
              selectCell(grid, next, new Event('falcon-grid-edit'));
            }
          }}
          cancel={() => void finish()}
        />
      </CellOverlay>
    );
  }

  const { width = '100%', height = '100%', className, style } = props;
  const background = props.theme?.background ?? defaultTheme.background;
  return (
    <div
      className={className}
      data-falcon-grid-root=""
      style={{ position: 'relative', overflow: 'hidden', width, height, background, ...style }}
    >
      {/* The core grid mounts here on the client; on the server this is the sized placeholder. */}
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      <GridContext.Provider value={ctx}>
        {props.children}
        {editorElement}
      </GridContext.Provider>
    </div>
  );
}

/**
 * A canvas grid. Creates the core once, pushes prop changes into it after renders, and keeps
 * React out of scrolling and hovering: neither causes a render.
 *
 * ```tsx
 * <Grid rowCount={rows.length} columns={columns} getRow={getRow} rowHeight="auto" />
 * ```
 */
export const Grid = forwardRef(GridImpl) as <TRow>(
  props: GridProps<TRow> & { ref?: Ref<GridHandle> },
) => ReactElement;
