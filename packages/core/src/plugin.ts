import type { DisplayList } from './display';
import type { Hit } from './hittest';
import type { ViewportRange } from './layout';
import type { RowModel } from './rows';
import type { Store } from './store';
import type { TextMeasurer, TextWrapper } from './text';
import type { ResolvedTheme } from './theme';
import type { CellValue, GridState } from './types';

/**
 * What a plugin can reach inside a grid. Plugins add behaviour that only some grids need (the
 * list's sticky group headers and text selection live in `@falcon-grid/list`), so the core stays
 * small for everyone else.
 */
export interface GridPluginHost {
  readonly store: Store<GridState>;
  /** The scroll container: the element that gets pointer and keyboard events. */
  readonly element: HTMLElement;
  /** Viewport geometry as it is now, even between frames. */
  viewport(): { vp: ViewportRange; offsets: Float64Array; rows: RowModel };
  getCell(row: number, col: number): CellValue;
  /** The theme with its fonts built. */
  theme(): ResolvedTheme;
  readonly text: TextMeasurer;
  wrapper(): TextWrapper | null;
  /** Auto row heights: content sits at the top of its row instead of being centred. */
  autoHeight(): boolean;
  /** A declarative cell's display list at its column's width (empty for plain columns). */
  displayList(row: number, col: number): DisplayList;
  /**
   * Paints a row's cells into `ctx` (a context the size of the grid's backing store) with the
   * row's top at screen y `top`, clipped to y >= `clipTop`. CSS pixels.
   */
  paintRow(ctx: CanvasRenderingContext2D, row: number, top: number, clipTop: number): void;
  /** Repaint the overlay layer (and the plugins' painting) on the next frame. */
  invalidateOverlay(): void;
  scrollBy(dx: number, dy: number): void;
}

export interface GridPlugin {
  /**
   * Paints over the overlay layer after hover, selection and focus. The context is scaled to
   * CSS pixels; restore anything else you change.
   */
  paintOverlay?(ctx: CanvasRenderingContext2D): void;
  /** Adjusts what is under a point, e.g. a sticky row covering the rows under it. */
  hitTest?(x: number, y: number, hit: Hit): void;
  /**
   * A primary-button press on a cell (not on a clickable region). Return true to own the drag:
   * moves (null while auto-scrolling) and the release then go to this plugin.
   */
  pointerDown?(e: PointerEvent, x: number, y: number, hit: Hit): boolean;
  pointerMove?(x: number, y: number): void;
  pointerUp?(commit: boolean): void;
  /** A key on the grid. Return true if handled (the grid then ignores it). */
  keyDown?(e: KeyboardEvent): boolean;
  /** What Ctrl+C copies, if the plugin has something; otherwise the grid copies its selection. */
  copy?(): { text: string; html: string } | null;
  destroy?(): void;
}

export type GridPluginFactory = (host: GridPluginHost) => GridPlugin;
