/**
 * Sprites: shapes rasterised once into an atlas canvas, then copied to the grid at whole device
 * pixels.
 *
 * Why: drawing an antialiased curve straight onto the grid is not reproducible across paint
 * paths. Chromium's software rasteriser switches antialiasing algorithm when a clip cuts through
 * a path (a pane edge, an exposed strip), and its GPU backend can rasterise the same path
 * differently in a full repaint and a one-cell repaint. Either way a blitted shape stops matching
 * a freshly painted one. A 1:1 copy of a bitmap at integer device coordinates, under a clip on
 * device-pixel boundaries, is exact on every backend, which is the same guarantee scroll blits
 * already rely on. It is also cheaper than rasterising the same badge or icon on every paint.
 */

/** A sprite's place in the atlas, in device pixels. Its content starts `pad` pixels in. */
export interface Sprite {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly pad: number;
}

/** The context sprites are drawn with: a 2D context (an OffscreenCanvas one in practice). */
export type SpriteContext = CanvasRenderingContext2D;

interface Surface {
  canvas: CanvasImageSource;
  ctx: SpriteContext;
}

export type SurfaceFactory = (size: number) => Surface | null;

const defaultSurface: SurfaceFactory = (size) => {
  let canvas: OffscreenCanvas | HTMLCanvasElement;
  if (typeof OffscreenCanvas === 'function') canvas = new OffscreenCanvas(size, size);
  else if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
  } else return null;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null;
  return ctx ? { canvas, ctx } : null;
};

interface Shelf {
  y: number;
  h: number;
  x: number;
}

/**
 * A square atlas packed in shelves (rows of sprites of similar height). When it fills up it is
 * cleared and refilled: sprites are cheap to redraw, and a grid rarely needs more distinct
 * shapes on screen than fit.
 */
export class SpriteAtlas {
  private surface: Surface | null | undefined;
  private readonly sprites = new Map<string, Sprite>();
  private shelves: Shelf[] = [];
  private nextY = 0;
  private dpr = 0;
  /** Times the atlas filled and was cleared; for tests and diagnostics. */
  resets = 0;

  constructor(
    readonly size = 1024,
    private readonly createSurface: SurfaceFactory = defaultSurface,
  ) {}

  /** The atlas canvas, to draw sprites from. Null until the first sprite (or if unsupported). */
  get canvas(): CanvasImageSource | null {
    return this.surface?.canvas ?? null;
  }

  /**
   * The sprite for `key`, drawing it first if needed. `w` and `h` are the content size in device
   * pixels and `pad` the margin around it for antialiasing and strokes. `draw` gets a context
   * with the transform at the content's top-left corner, scaled by the device pixel ratio.
   * Returns null when sprites are unavailable or the sprite is larger than the atlas; the caller
   * then draws directly.
   */
  get(key: string, dpr: number, w: number, h: number, pad: number, draw: (ctx: SpriteContext) => void): Sprite | null {
    if (dpr !== this.dpr) {
      this.clear();
      this.dpr = dpr;
    }
    const hit = this.sprites.get(key);
    if (hit) return hit;
    if (this.surface === undefined) this.surface = this.createSurface(this.size);
    const surface = this.surface;
    if (!surface) return null;
    const sw = Math.ceil(w) + pad * 2;
    const sh = Math.ceil(h) + pad * 2;
    if (sw > this.size || sh > this.size) return null;
    let slot = this.place(sw, sh);
    if (!slot) {
      this.clear();
      this.resets++;
      slot = this.place(sw, sh)!;
    }
    const sprite: Sprite = { x: slot.x, y: slot.y, w: sw, h: sh, pad };
    const { ctx } = surface;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // No clip around the slot: the padding keeps each shape inside it, and clips on an atlas
    // canvas trip a Chromium GPU bug where a later stroke erases earlier sprites.
    ctx.globalAlpha = 1;
    ctx.setTransform(dpr, 0, 0, dpr, sprite.x + pad, sprite.y + pad);
    draw(ctx);
    ctx.restore();
    this.sprites.set(key, sprite);
    return sprite;
  }

  /** Forgets every sprite and clears the canvas. */
  clear(): void {
    this.sprites.clear();
    this.shelves = [];
    this.nextY = 0;
    if (this.surface) {
      const { ctx } = this.surface;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.size, this.size);
    }
  }

  private place(w: number, h: number): { x: number; y: number } | null {
    // The shortest shelf that is tall enough and not much taller, with room left.
    let best: Shelf | null = null;
    for (const s of this.shelves) {
      if (s.h >= h && s.h <= h * 1.5 + 2 && this.size - s.x >= w && (!best || s.h < best.h)) best = s;
    }
    if (!best) {
      if (this.nextY + h > this.size) return null;
      best = { y: this.nextY, h, x: 0 };
      this.shelves.push(best);
      this.nextY += h;
    }
    const at = { x: best.x, y: best.y };
    best.x += w;
    return at;
  }
}
