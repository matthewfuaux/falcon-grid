import {
  createGrid,
  type CellRenderer,
  type CellValue,
  type ColumnDef,
  type FrameInfo,
  type FrameSource,
  type Grid,
  type GridPluginFactory,
  type TextWrapper,
  type Theme,
} from '@falcon-grid/core';
import { createTextSelection, type TextSelection } from './selection';
import { stickyGroups } from './sticky';

/** A pointer event on an item. */
export interface ListItemEvent<T> {
  index: number;
  item: T | undefined;
  event: MouseEvent;
}

export interface ListOptions<T> {
  itemCount: number;
  /** The item at an index, called only for items on screen (and ones being measured). */
  getItem: (index: number) => T | undefined;
  /**
   * How an item is drawn: a renderer made with `cell()` from `@falcon-grid/cells`. Without
   * one, items are drawn as text (`String(item)`), wrapped when a `textWrapper` is given.
   */
  item?: CellRenderer<T>;
  /** 'auto' (default): each item is as tall as its content. A number: every item that tall. */
  itemHeight?: 'auto' | number;
  /** Wrapping engine for wrapped text, e.g. `createPretextWrapper()` from `@falcon-grid/text`. */
  textWrapper?: TextWrapper;
  /** Follow the bottom while scrolled to it: for chat, logs and feeds. Starts at the bottom. */
  stickToBottom?: boolean;
  /**
   * Sticky group headers: the index of the header item of the group `index` belongs to (a
   * header returns its own index), or -1. Called for a few items per frame; keep it cheap.
   */
  groupOf?: (index: number) => number;
  /** Select text with the pointer and copy it (default true). Fixed at creation. */
  textSelection?: boolean;
  /** Lines between items (default false). */
  dividers?: boolean;
  /** Merged over the default theme. The header height is always 0. */
  theme?: Partial<Theme>;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  onItemClick?: (e: ListItemEvent<T>) => void;
  onItemDoubleClick?: (e: ListItemEvent<T>) => void;
  onItemContextMenu?: (e: ListItemEvent<T>) => void;
  /** The text selection changed: whether anything is selected now. */
  onTextSelectionChange?: (selected: boolean) => void;
  respectUserPreferences?: boolean;
  scaleWithRootFont?: boolean;
  onFrame?: (info: Readonly<FrameInfo>) => void;
  /** Override the frame source (tests). */
  frameSource?: FrameSource;
}

type Updatable<T> = Omit<ListOptions<T>, 'textSelection' | 'frameSource'>;

export interface List<T> {
  /** The grid underneath: one column, no header. An escape hatch. */
  readonly grid: Grid;
  readonly element: HTMLElement;
  /**
   * Applies changed options. A new `getItem` repaints and re-measures the items on screen;
   * items changed in place off screen need `invalidateItems`.
   */
  update(options: Partial<Updatable<T>>): void;
  /** `count` items were inserted before `index` (prepending older messages: index 0). */
  insertItems(index: number, count: number): void;
  /** Repaint and re-measure items [start, end) after they changed in place (a streaming message). */
  invalidateItems(start: number, end: number): void;
  /** Repaint and re-measure everything. */
  invalidate(): void;
  /** 'start' puts the item at the top; 'nearest' (default) scrolls the least to show it. */
  scrollToItem(index: number, align?: 'start' | 'nearest'): void;
  scrollToBottom(): void;
  /** Whether the view is scrolled to the bottom (within a pixel). */
  isAtBottom(): boolean;
  /** The first and last (exclusive) items on screen. */
  visibleItems(): { start: number; end: number };
  /** The text selection, or null if `textSelection` is off. */
  readonly textSelection: TextSelection | null;
  focus(): void;
  destroy(): void;
}

const listTheme = (theme: Partial<Theme> | undefined, dividers: boolean): Partial<Theme> => ({
  rowAltBackground: null,
  ...(dividers ? {} : { gridLine: 'transparent' }),
  ...theme,
  headerHeight: 0,
});

/**
 * A canvas list: the grid's variable-height engine with one full-width column and no header.
 * Items are declarative cells (or text) of any height, measured only as they come into view.
 */
export function createList<T>(container: HTMLElement, options: ListOptions<T>): List<T> {
  let o = { ...options };
  const selection = o.textSelection === false ? null : createTextSelection(o.onTextSelectionChange ? { onChange: (v) => o.onTextSelectionChange?.(v) } : {});
  const plugins: GridPluginFactory[] = [];
  if (selection) plugins.push(selection.plugin);
  // Sticky headers paint after the selection, so they cover it.
  let groupOf = o.groupOf;
  if (groupOf) plugins.push(stickyGroups((r) => groupOf!(r)));

  const column = (width: number): ColumnDef => {
    const c: ColumnDef = { id: 'item', title: '', width, resizable: false, reorderable: false };
    if (o.item) c.cell = o.item as CellRenderer;
    else if (o.textWrapper) c.wrap = true;
    return c;
  };
  const itemEvent = (e: { row: number; event: MouseEvent }): ListItemEvent<T> => ({ index: e.row, item: o.getItem(e.row), event: e.event });
  const sizing = () => (o.itemHeight === undefined || o.itemHeight === 'auto' ? 'auto' : 'fixed');
  const theme = () => {
    const t = listTheme(o.theme, o.dividers === true);
    return typeof o.itemHeight === 'number' ? { ...t, rowHeight: o.itemHeight } : t;
  };

  const grid = createGrid(container, {
    columns: [column(0)],
    rowCount: o.itemCount,
    getCell: (row) => o.getItem(row) as CellValue,
    rowSizing: sizing(),
    theme: theme(),
    stickToBottom: o.stickToBottom === true,
    plugins,
    onCellClick: (e) => o.onItemClick?.(itemEvent(e)),
    onCellDoubleClick: (e) => o.onItemDoubleClick?.(itemEvent(e)),
    onCellContextMenu: (e) => o.onItemContextMenu?.(itemEvent(e)),
    ...(o.textWrapper ? { textWrapper: o.textWrapper } : {}),
    ...(o.ariaLabel ? { ariaLabel: o.ariaLabel } : {}),
    ...(o.ariaLabelledBy ? { ariaLabelledBy: o.ariaLabelledBy } : {}),
    ...(o.respectUserPreferences !== undefined ? { respectUserPreferences: o.respectUserPreferences } : {}),
    ...(o.scaleWithRootFont !== undefined ? { scaleWithRootFont: o.scaleWithRootFont } : {}),
    ...(o.onFrame ? { onFrame: o.onFrame } : {}),
    ...(o.frameSource ? { frameSource: o.frameSource } : {}),
  });

  // The one column always spans the viewport.
  let width = -1;
  const fit = () => {
    const w = grid.getState().viewportWidth;
    if (w === width) return;
    width = w;
    grid.update({ columns: [column(w)] });
  };
  const unsubscribe = grid.store.subscribe(fit);
  fit();

  /** Re-measures what is on screen (a new `getItem` usually means items there changed). */
  const refreshVisible = () => {
    grid.invalidate({ remeasure: false });
    const { start, end } = grid.visibleRows();
    if (end > start) grid.invalidateRows(start, end);
  };

  return {
    grid,
    element: grid.element,
    textSelection: selection,
    update(next) {
      const prev = o;
      o = { ...o, ...next };
      if ('groupOf' in next) groupOf = o.groupOf ?? (() => -1);
      // `undefined` is meaningful in a patch: it clears the text wrapper and the labels.
      const patch: { [K in keyof Parameters<Grid['update']>[0]]?: Parameters<Grid['update']>[0][K] | undefined } = {};
      if (next.itemCount !== undefined && next.itemCount !== prev.itemCount) patch.rowCount = next.itemCount;
      if (o.item !== prev.item || o.textWrapper !== prev.textWrapper) {
        patch.columns = [column(width < 0 ? 0 : width)];
      }
      if (o.textWrapper !== prev.textWrapper) patch.textWrapper = o.textWrapper;
      if (o.itemHeight !== prev.itemHeight) patch.rowSizing = sizing();
      if (o.theme !== prev.theme || o.dividers !== prev.dividers || o.itemHeight !== prev.itemHeight) patch.theme = theme();
      if (next.stickToBottom !== undefined) patch.stickToBottom = next.stickToBottom;
      if ('ariaLabel' in next || 'ariaLabelledBy' in next) {
        patch.ariaLabel = o.ariaLabel;
        patch.ariaLabelledBy = o.ariaLabelledBy;
      }
      if (next.respectUserPreferences !== undefined) patch.respectUserPreferences = next.respectUserPreferences;
      if (next.scaleWithRootFont !== undefined) patch.scaleWithRootFont = next.scaleWithRootFont;
      if ('onFrame' in next) patch.onFrame = next.onFrame;
      grid.update(patch as Parameters<Grid['update']>[0]);
      if (o.getItem !== prev.getItem) refreshVisible();
      else if (o.groupOf !== prev.groupOf) grid.invalidate({ remeasure: false });
    },
    insertItems(index, count) {
      o = { ...o, itemCount: o.itemCount + count };
      selection?.shiftRows(index, count);
      grid.insertRows(index, count);
    },
    invalidateItems: (start, end) => grid.invalidateRows(start, end),
    invalidate: () => grid.invalidate(),
    scrollToItem(index, align = 'nearest') {
      if (align === 'start') grid.scrollToRow(index);
      else grid.scrollToCell(index, 0);
    },
    scrollToBottom: () => grid.scrollTo({ top: Number.MAX_SAFE_INTEGER }),
    isAtBottom() {
      const el = grid.element;
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    },
    visibleItems: () => grid.visibleRows(),
    focus: () => grid.focus(),
    destroy() {
      unsubscribe();
      grid.destroy();
    },
  };
}
