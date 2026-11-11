export type CellValue = string | number | boolean | null | undefined;

/** Pull-based data access: the grid only asks for cells in the visible window. */
export type GetCell = (row: number, col: number) => CellValue;

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
}
