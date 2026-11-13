import type { CellRenderer, CellTarget } from './display';

/**
 * What `getCell` returns. Plain columns paint it as text; columns with a `cell` renderer get it
 * as is, so it can be any value (an object for a user cell, an array for tags).
 */
export type CellValue = string | number | boolean | object | null | undefined;

/**
 * Pull-based data access: the grid only asks for cells in the visible window. `col` is the
 * column's current position, which changes when columns are reordered; look data up by
 * `column.id` if columns can move.
 */
export type GetCell = (row: number, col: number, column: ColumnDef) => CellValue;

export type ColumnAlign = 'left' | 'right' | 'center';

export interface ColumnDef {
  id: string;
  title?: string;
  /** Width in CSS pixels. */
  width: number;
  align?: ColumnAlign;
  /**
   * Wrap text onto multiple lines instead of truncating it with an ellipsis. Needs a
   * `textWrapper` (see `@falcon-grid/text`). With `rowSizing: 'auto'`, rows grow to fit.
   */
  wrap?: boolean;
  /** Bounds for drag resizing and auto-fit, in CSS pixels. Defaults 32 and 2000. */
  minWidth?: number;
  maxWidth?: number;
  /** Allow drag resizing (default true). */
  resizable?: boolean;
  /** Allow drag reordering (default true). */
  reorderable?: boolean;
  /** Sort indicator drawn in the header. The grid does not sort; it shows what the data source did. */
  sort?: 'asc' | 'desc' | null;
  /**
   * Draw cells from a display list instead of as text: layout primitives, images and
   * interactive regions. See `cell()` and the built-in column types in `@falcon-grid/cells`.
   */
  cell?: CellRenderer;
}

/** A cell position: row and column index. */
export interface CellRef {
  row: number;
  col: number;
}

/** An inclusive rectangle of cells. Selections are lists of these, never per-cell flags. */
export interface CellRange {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** 'fixed': every row is `theme.rowHeight`. 'auto': rows grow to fit wrapped text (minimum `theme.rowHeight`). */
export type RowSizing = 'fixed' | 'auto';

export interface Theme {
  background: string;
  foreground: string;
  /** Background for odd rows, or null for no striping. */
  rowAltBackground: string | null;
  headerBackground: string;
  headerForeground: string;
  gridLine: string;
  frozenDivider: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  headerFontWeight: string;
  cellPaddingX: number;
  /** Vertical padding above and below the text block in auto-height rows. */
  cellPaddingY: number;
  /** Distance between wrapped lines. */
  lineHeight: number;
  /** Row height in 'fixed' sizing; the minimum row height in 'auto'. */
  rowHeight: number;
  headerHeight: number;
  /** Overlay colours. Translucent fills sit over the cells, so use alpha. */
  hoverBackground: string;
  selectionBackground: string;
  selectionBorder: string;
  /** Active cell ring, and drag indicators. */
  focusRing: string;
  /** Colours for cell primitives: secondary text, links and controls, and status tones. */
  mutedForeground: string;
  accent: string;
  /** Text and marks on an `accent` fill (a checked checkbox, a solid button). */
  accentForeground: string;
  success: string;
  warning: string;
  danger: string;
}

/** Everything the core renders from. Plain data, so a snapshot can be sent to a worker later. */
export interface GridState {
  columns: readonly ColumnDef[];
  rowCount: number;
  frozenColumns: number;
  frozenRows: number;
  rowSizing: RowSizing;
  /** Virtual (unscaled) content offsets in CSS pixels. */
  scrollLeft: number;
  scrollTop: number;
  /** Visible area in CSS pixels, excluding scrollbars. */
  viewportWidth: number;
  viewportHeight: number;
  pixelRatio: number;
  theme: Theme;
  /** Selected ranges; the last one is extended by Shift. Empty for no selection. */
  selection: readonly CellRange[];
  /** The one cell with focus, independent of the selection. */
  activeCell: CellRef | null;
  /** Cell under the pointer (header cells have row -1). */
  hoverCell: CellRef | null;
  /** Whether the grid element has keyboard focus. */
  focused: boolean;
  /** Interactive cell region under the pointer, and the one being pressed. */
  hoverTarget: CellTarget | null;
  pressedTarget: CellTarget | null;
}

export interface FrameInfo {
  /** Monotonic frame counter. */
  frame: number;
  /** Dirty flags handled this frame (see `Dirty`). */
  flags: number;
  /** Time spent inside the frame callback, in milliseconds. */
  durationMs: number;
  /** Cells painted on the base layer this frame (0 if the base layer was not painted). */
  cellsPainted: number;
  /** How the base layer was painted: not at all, fully, or only the changed areas. */
  paint: 'none' | 'full' | 'incremental';
  /** Device pixels the base layer was shifted by scroll blitting this frame. */
  blitX: number;
  blitY: number;
  /** Rows whose height was measured this frame (auto row sizing). */
  rowsMeasured: number;
  /** Whether the overlay layer (hover, selection, focus) was repainted this frame. */
  overlay: boolean;
}

/** A pointer event on a cell. `col` is the column's current position. */
export interface CellEvent {
  row: number;
  col: number;
  column: ColumnDef;
  event: MouseEvent;
}

export interface HeaderEvent {
  col: number;
  column: ColumnDef;
  event: MouseEvent;
}

/** Fired when the user changes the selection or the active cell (not for programmatic changes). */
export interface SelectionChangeEvent {
  selection: readonly CellRange[];
  activeCell: CellRef | null;
  event: Event;
}

/** Fired on every width change while dragging, and on double-click auto-fit. */
export interface ColumnResizeEvent {
  col: number;
  /** The column with its new width. */
  column: ColumnDef;
  width: number;
  event: Event;
}

/** A column moved from index `from` to index `to` (its index after the move). */
export interface ColumnReorderEvent {
  from: number;
  to: number;
  column: ColumnDef;
  event: Event;
}

export interface GridEvents {
  onCellClick?: (e: CellEvent) => void;
  onCellDoubleClick?: (e: CellEvent) => void;
  onCellContextMenu?: (e: CellEvent) => void;
  onHeaderClick?: (e: HeaderEvent) => void;
  onSelectionChange?: (e: SelectionChangeEvent) => void;
  onColumnResize?: (e: ColumnResizeEvent) => void;
  onColumnReorder?: (e: ColumnReorderEvent) => void;
}
