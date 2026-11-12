import type { ImageCache } from './images';
import type { SpriteAtlas } from './sprites';
import type { TextMeasurer, TextWrapper } from './text';
import type { ResolvedTheme } from './theme';
import type { ColumnDef } from './types';

/**
 * Display lists: what a declarative cell compiles to. Plain data in CSS pixels, relative to the
 * cell's content box (inside the horizontal padding). `@falcon-grid/cells` builds them from
 * layout primitives; the core paints them and hit-tests their regions.
 */

/** Style overrides while an op's region is hovered or pressed. */
export interface OpStyle {
  color?: string;
  alpha?: number;
  underline?: boolean;
}

interface OpBase {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Index into the list's regions: the op restyles while that region is hovered or pressed. */
  region?: number;
  hover?: OpStyle;
  press?: OpStyle;
  /** Opacity, 0 to 1 (default 1). */
  alpha?: number;
}

/** A filled (or, with `line`, outlined) rectangle with optional rounded corners. */
export interface RectOp extends OpBase {
  k: 'rect';
  color: string;
  radius?: number;
  /** Outline width in CSS pixels; the rectangle is stroked inside its bounds instead of filled. */
  line?: number;
}

/** One line of text, already truncated to fit. `w` is its advance width; drawn centred in `h`. */
export interface TextOp extends OpBase {
  k: 'text';
  color: string;
  text: string;
  font: string;
  underline?: boolean;
}

/** An SVG path in a `box`-unit square viewBox, scaled to `w` by `h`. Stroked when `line` is set. */
export interface PathOp extends OpBase {
  k: 'path';
  color: string;
  path: string;
  box: number;
  /** Stroke width in CSS pixels; filled when absent. */
  line?: number;
}

/** An image by URL, loaded and cached by the grid. Clipped to a rounded rectangle with `radius`. */
export interface ImageOp extends OpBase {
  k: 'image';
  src: string;
  radius?: number;
}

/** Escape hatch: raw canvas drawing. The context is saved and restored around the call. */
export interface CustomOp extends OpBase {
  k: 'custom';
  draw: (ctx: CanvasRenderingContext2D, rect: { x: number; y: number; width: number; height: number }) => void;
}

export type DrawOp = RectOp | TextOp | PathOp | ImageOp | CustomOp;

/** Passed to region click handlers. */
export interface CellActionEvent {
  row: number;
  col: number;
  column: ColumnDef;
  event: Event;
}

/** An interactive area of a cell, relative to the content box like the ops. */
export interface CellRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  /** CSS cursor while hovered (default 'pointer' when clickable). */
  cursor?: string;
  /** Shown as a native tooltip while hovered. */
  tooltip?: string;
  onClick?: (e: CellActionEvent) => void;
  /** Finer test within the rectangle, in the same coordinates. */
  hitTest?: (x: number, y: number) => boolean;
}

export interface DisplayList {
  ops: readonly DrawOp[];
  regions: readonly CellRegion[];
  /** Natural content width (what the content wants, before fitting), for auto-fit. */
  width: number;
  /** Content height: the row is at least this plus vertical padding in auto row sizing. */
  height: number;
}

export const EMPTY_LIST: DisplayList = { ops: [], regions: [], width: 0, height: 0 };

/** What a cell renderer gets to lay out with. `epoch` changes whenever cached layouts go stale. */
export interface CellEnv {
  theme: ResolvedTheme;
  text: TextMeasurer;
  wrapper: TextWrapper | null;
  epoch: number;
}

/**
 * Draws a column's cells from display lists instead of as text. Build one with `cell()` from
 * `@falcon-grid/cells`, or implement it directly.
 */
export interface CellRenderer {
  /** The display list for a value at a content width. Called per visible cell; cache it. */
  layout(value: unknown, width: number, env: CellEnv): DisplayList;
  /** Plain text for copying. */
  text(value: unknown): string;
  /** The value changed in place (same identity): drop anything cached for it. */
  forget?(value: unknown): void;
}

/** A cell region under interaction: hovered or pressed. */
export interface CellTarget {
  row: number;
  col: number;
  region: number;
}

/** Vertical offset of a display list within its row: top-aligned in auto rows, else centred. */
export function contentTop(listHeight: number, rowHeight: number, theme: ResolvedTheme, autoHeight: boolean): number {
  return autoHeight ? theme.cellPaddingY : (rowHeight - listHeight) / 2;
}

/** Index of the region under a point (content-box coordinates), topmost first, or -1. */
export function regionAt(list: DisplayList, x: number, y: number): number {
  for (let i = list.regions.length - 1; i >= 0; i--) {
    const r = list.regions[i]!;
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h && (!r.hitTest || r.hitTest(x, y))) return i;
  }
  return -1;
}

// ---- Painting ---------------------------------------------------------------------------------

/** The subset of the canvas API display lists paint with. */
export type OpContext = Pick<
  CanvasRenderingContext2D,
  | 'setTransform'
  | 'scale'
  | 'fillRect'
  | 'beginPath'
  | 'rect'
  | 'fill'
  | 'stroke'
  | 'save'
  | 'restore'
  | 'clip'
  | 'fillText'
  | 'drawImage'
  | 'imageSmoothingEnabled'
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'lineCap'
  | 'lineJoin'
  | 'globalAlpha'
  | 'font'
  | 'textAlign'
  | 'textBaseline'
> & { roundRect?: CanvasRenderingContext2D['roundRect'] };

/** Interaction state of one cell while painting: region indexes, or -1. */
export interface OpState {
  hover: number;
  press: number;
}

/**
 * Remembers the last style set while painting a batch of ops, so repeated fonts and colours are
 * not set again. Reset it whenever something else touches the context.
 */
export class StyleCache {
  font = '';
  fill = '';
  stroke = '';
  alpha = 1;
  reset(): void {
    this.font = this.fill = this.stroke = '';
    this.alpha = 1;
  }
}

const paths = new Map<string, Path2D>();
const pathOf = (d: string): Path2D | null => {
  if (typeof Path2D === 'undefined') return null;
  let p = paths.get(d);
  if (!p) {
    p = new Path2D(d);
    paths.set(d, p);
  }
  return p;
};

const snapPx = (v: number, dpr: number) => Math.round(v * dpr) / dpr;

/**
 * Paints one op with its cell's content box at (ox, oy), in a context whose transform is
 * `scale(dpr)`. Rectangles and text snap to device pixels. With an atlas, antialiased shapes
 * (rounded or outlined rectangles, paths, images) are drawn once as sprites and copied at whole
 * device pixels, so every paint path produces the same pixels. Returns false if the op is an
 * image that is not loaded yet (the caller arranges a repaint).
 */
export function paintOp(
  ctx: OpContext,
  op: DrawOp,
  ox: number,
  oy: number,
  dpr: number,
  state: OpState,
  style: StyleCache,
  images: ImageCache | null,
  sprites: SpriteAtlas | null = null,
): boolean {
  const hovered = op.region !== undefined && op.region === state.hover;
  const variant = hovered ? (op.region === state.press ? (op.press ?? op.hover) : op.hover) : undefined;
  const alpha = variant?.alpha ?? op.alpha ?? 1;
  if (alpha <= 0) return true;
  if (alpha !== style.alpha) {
    ctx.globalAlpha = alpha;
    style.alpha = alpha;
  }
  const x = ox + op.x;
  const y = oy + op.y;
  switch (op.k) {
    case 'rect': {
      const color = variant?.color ?? op.color;
      // Device-pixel bounds.
      const dx = Math.round(x * dpr);
      const dy = Math.round(y * dpr);
      const dw = Math.round((x + op.w) * dpr) - dx;
      const dh = Math.round((y + op.h) * dpr) - dy;
      if (dw <= 0 || dh <= 0) return true;
      if (!op.line && !op.radius) {
        if (color !== style.fill) ctx.fillStyle = style.fill = color;
        ctx.fillRect(dx / dpr, dy / dpr, dw / dpr, dh / dpr);
        return true;
      }
      const w = dw / dpr;
      const h = dh / dpr;
      const radius = op.radius ?? 0;
      const line = op.line ?? 0;
      const draw = (c: OpContext) => {
        if (line) {
          c.strokeStyle = color;
          c.lineWidth = line;
          const i = line / 2;
          c.beginPath();
          roundRect(c, i, i, w - line, h - line, Math.max(0, radius - i));
          c.stroke();
        } else {
          c.fillStyle = color;
          c.beginPath();
          roundRect(c, 0, 0, w, h, radius);
          c.fill();
        }
      };
      const key = `r${dw},${dh},${radius},${line},${color}`;
      if (drawSprite(ctx, sprites, key, dpr, dx, dy, dw, dh, 1, draw)) return true;
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, dx, dy);
      draw(ctx);
      ctx.restore();
      style.fill = style.stroke = '';
      return true;
    }
    case 'text': {
      const color = variant?.color ?? op.color;
      if (op.font !== style.font) ctx.font = style.font = op.font;
      if (color !== style.fill) ctx.fillStyle = style.fill = color;
      const ty = snapPx(y + op.h / 2, dpr);
      ctx.fillText(op.text, snapPx(x, dpr), ty);
      if (variant?.underline ?? op.underline) {
        // Just below the text's middle line plus half an x-height: close to a CSS underline.
        const uy = Math.round((y + op.h / 2 + op.h * 0.32) * dpr) / dpr;
        ctx.fillRect(snapPx(x, dpr), uy, Math.max(1 / dpr, snapPx(op.w, dpr)), Math.max(1, Math.round(dpr)) / dpr);
      }
      return true;
    }
    case 'path': {
      const p = pathOf(op.path);
      if (!p) return true;
      const color = variant?.color ?? op.color;
      const sx = op.w / op.box;
      const sy = op.h / op.box;
      const dx = Math.round(x * dpr);
      const dy = Math.round(y * dpr);
      const draw = (c: OpContext) => {
        const cc = c as CanvasRenderingContext2D;
        // The path's box scaled to the op's size, on top of the device scale.
        cc.scale(sx, sy);
        if (op.line) {
          cc.strokeStyle = color;
          cc.lineWidth = op.line / sx;
          cc.lineCap = 'round';
          cc.lineJoin = 'round';
          cc.stroke(p);
        } else {
          cc.fillStyle = color;
          cc.fill(p);
        }
      };
      // Strokes reach half their width past the box; round caps a little more.
      const pad = Math.ceil(((op.line ?? 0) * dpr) / 2) + 1;
      const key = `p${op.w},${op.h},${op.line ?? 0},${color},${op.path}`;
      if (drawSprite(ctx, sprites, key, dpr, dx, dy, op.w * dpr, op.h * dpr, pad, draw)) return true;
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, dx, dy);
      draw(ctx);
      ctx.restore();
      // restore() brings back the context's own fill and stroke, which may differ from the cache.
      style.fill = style.stroke = '';
      return true;
    }
    case 'image': {
      const img = images?.get(op.src);
      if (!img) return false;
      const dx = Math.round(x * dpr);
      const dy = Math.round(y * dpr);
      const dw = Math.round((x + op.w) * dpr) - dx;
      const dh = Math.round((y + op.h) * dpr) - dy;
      if (dw <= 0 || dh <= 0) return true;
      const w = dw / dpr;
      const h = dh / dpr;
      const draw = (c: OpContext) => {
        const cc = c as CanvasRenderingContext2D;
        cc.imageSmoothingEnabled = true;
        if (!op.radius) {
          cc.drawImage(img, 0, 0, w, h);
          return;
        }
        // Rounded: fill the shape with the image as a pattern. A clip would also work, but clips
        // on the atlas trip a Chromium GPU canvas bug that erases earlier sprites.
        const pattern = cc.createPattern(img, 'no-repeat');
        const iw = (img as { width: number }).width;
        const ih = (img as { height: number }).height;
        if (!pattern || !iw || !ih) return;
        pattern.setTransform(new DOMMatrix([w / iw, 0, 0, h / ih, 0, 0]));
        cc.fillStyle = pattern;
        cc.beginPath();
        roundRect(cc, 0, 0, w, h, op.radius);
        cc.fill();
      };
      const key = `i${dw},${dh},${op.radius ?? 0},${op.src}`;
      if (drawSprite(ctx, sprites, key, dpr, dx, dy, dw, dh, 1, draw)) return true;
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, dx, dy);
      draw(ctx);
      ctx.restore();
      return true;
    }
    case 'custom': {
      ctx.save();
      op.draw(ctx as CanvasRenderingContext2D, { x, y, width: op.w, height: op.h });
      ctx.restore();
      style.reset();
      style.alpha = -1; // unknown after user code: set it again next time
      return true;
    }
  }
}

/**
 * Copies a sprite to device pixel (dx, dy), drawing it into the atlas first if needed. Returns
 * false if there is no atlas or the sprite does not fit, and the caller draws directly.
 */
function drawSprite(
  ctx: OpContext,
  sprites: SpriteAtlas | null,
  key: string,
  dpr: number,
  dx: number,
  dy: number,
  w: number,
  h: number,
  pad: number,
  draw: (c: OpContext) => void,
): boolean {
  if (!sprites) return false;
  const s = sprites.get(key, dpr, w, h, pad, draw);
  const atlas = sprites.canvas;
  if (!s || !atlas) return false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(atlas, s.x, s.y, s.w, s.h, dx - s.pad, dy - s.pad, s.w, s.h);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return true;
}

function roundRect(ctx: Pick<OpContext, 'rect' | 'roundRect'>, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  if (radius > 0 && ctx.roundRect) ctx.roundRect(x, y, w, h, radius);
  else ctx.rect(x, y, w, h);
}
