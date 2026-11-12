import { describe, expect, it } from 'vitest';
import { StyleCache, paintOp, type DrawOp, type OpContext } from '../src/display';
import { SpriteAtlas, type SpriteContext } from '../src/sprites';

/** Records calls on a context; property writes are recorded as `set:<prop>`. */
function recorder(extra: Record<string, unknown> = {}) {
  const calls: { op: string; args: unknown[] }[] = [];
  const target: Record<string, unknown> = { ...extra };
  const ctx = new Proxy(target, {
    get(_, prop: string) {
      if (prop in target) return target[prop];
      return (...args: unknown[]) => void calls.push({ op: prop, args });
    },
    set(_, prop: string, value) {
      target[prop] = value;
      calls.push({ op: `set:${prop}`, args: [value] });
      return true;
    },
  });
  return { ctx, calls, ops: (op: string) => calls.filter((c) => c.op === op) };
}

function atlas(size = 64) {
  const surface = recorder();
  const canvas = { id: 'atlas' };
  const a = new SpriteAtlas(size, () => ({ canvas: canvas as unknown as CanvasImageSource, ctx: surface.ctx as unknown as SpriteContext }));
  return { a, surface, canvas };
}

describe('SpriteAtlas', () => {
  it('draws a sprite once and returns the same slot afterwards', () => {
    const { a } = atlas();
    let draws = 0;
    const s1 = a.get('k', 1, 10, 10, 1, () => draws++);
    const s2 = a.get('k', 1, 10, 10, 1, () => draws++);
    expect(draws).toBe(1);
    expect(s2).toBe(s1);
    expect(s1).toMatchObject({ x: 0, y: 0, w: 12, h: 12, pad: 1 });
  });

  it('draws at the slot origin plus padding, scaled by the pixel ratio, with no clip', () => {
    const { a, surface } = atlas();
    a.get('a', 2, 10, 10, 1, () => {});
    a.get('b', 2, 10, 10, 1, () => {});
    const transforms = surface.ops('setTransform').map((c) => c.args);
    expect(transforms).toContainEqual([2, 0, 0, 2, 13, 1]); // second slot starts at x = 12
    expect(surface.ops('clip')).toHaveLength(0);
  });

  it('packs sprites of similar height on one shelf and starts a new shelf for taller ones', () => {
    const { a } = atlas();
    const s1 = a.get('a', 1, 10, 10, 1, () => {});
    const s2 = a.get('b', 1, 8, 9, 1, () => {});
    const s3 = a.get('c', 1, 10, 30, 1, () => {});
    expect(s2).toMatchObject({ x: 12, y: 0 });
    expect(s3).toMatchObject({ x: 0, y: 12 });
    expect(s1!.y).toBe(0);
  });

  it('clears and starts over when full', () => {
    const { a, surface } = atlas(32);
    for (let i = 0; i < 6; i++) a.get(`k${i}`, 1, 14, 14, 1, () => {});
    expect(a.resets).toBe(1);
    expect(surface.ops('clearRect')).toHaveLength(1);
    // Earlier keys are gone and get redrawn.
    let drawn = false;
    a.get('k0', 1, 14, 14, 1, () => (drawn = true));
    expect(drawn).toBe(true);
  });

  it('forgets everything when the pixel ratio changes', () => {
    const { a } = atlas();
    a.get('k', 1, 10, 10, 1, () => {});
    let drawn = false;
    a.get('k', 2, 20, 20, 1, () => (drawn = true));
    expect(drawn).toBe(true);
  });

  it('returns null for sprites larger than the atlas, or without a canvas', () => {
    expect(atlas(32).a.get('big', 1, 40, 10, 1, () => {})).toBeNull();
    expect(new SpriteAtlas(64, () => null).get('k', 1, 10, 10, 1, () => {})).toBeNull();
  });
});

describe('paintOp with sprites', () => {
  const state = { hover: -1, press: -1 };

  it('copies rounded rectangles from the atlas at whole device pixels', () => {
    const { a, canvas } = atlas(256);
    const main = recorder();
    const op: DrawOp = { k: 'rect', x: 0.4, y: 0.3, w: 20, h: 20, radius: 10, color: '#123456' };
    paintOp(main.ctx as unknown as OpContext, op, 10, 20, 1.5, state, new StyleCache(), null, a);
    const [copy] = main.ops('drawImage');
    expect(copy!.args[0]).toBe(canvas);
    const [, , , sw, sh, dx, dy, dw, dh] = copy!.args as number[];
    expect([dx, dy]).toEqual([Math.round(10.4 * 1.5) - 1, Math.round(20.3 * 1.5) - 1]);
    expect([dw, dh]).toEqual([sw, sh]);
    // Drawn with an identity transform, then the device scale restored.
    expect(main.ops('setTransform').map((c) => c.args)).toEqual([
      [1, 0, 0, 1, 0, 0],
      [1.5, 0, 0, 1.5, 0, 0],
    ]);
    expect(main.ops('fill')).toHaveLength(0);
  });

  it('reuses the sprite for the same shape and colour, and makes a new one per colour', () => {
    const { a, surface } = atlas(256);
    const main = recorder();
    const style = new StyleCache();
    const op: DrawOp = { k: 'rect', x: 0, y: 0, w: 16, h: 16, radius: 3, line: 1, color: '#000' };
    for (let i = 0; i < 3; i++) paintOp(main.ctx as unknown as OpContext, op, 0, i * 32, 1, state, style, null, a);
    paintOp(main.ctx as unknown as OpContext, { ...op, color: '#f00' }, 0, 0, 1, state, style, null, a);
    expect(surface.ops('stroke')).toHaveLength(2);
    expect(main.ops('drawImage')).toHaveLength(4);
  });

  it('draws plain rectangles directly', () => {
    const { a } = atlas(256);
    const main = recorder();
    paintOp(main.ctx as unknown as OpContext, { k: 'rect', x: 0, y: 0, w: 10, h: 10, color: '#000' }, 0, 0, 1, state, new StyleCache(), null, a);
    expect(main.ops('fillRect')).toHaveLength(1);
    expect(main.ops('drawImage')).toHaveLength(0);
  });

  it('draws directly without an atlas', () => {
    const main = recorder();
    paintOp(main.ctx as unknown as OpContext, { k: 'rect', x: 0, y: 0, w: 10, h: 10, radius: 5, color: '#000' }, 0, 0, 1, state, new StyleCache(), null);
    expect(main.ops('fill')).toHaveLength(1);
    expect(main.ops('drawImage')).toHaveLength(0);
  });
});
