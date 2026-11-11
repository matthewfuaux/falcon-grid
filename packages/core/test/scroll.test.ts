import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ScrollAxis } from '../src/scroll';

const MAX = 1_000_000;
const VIEW = 800;

function axis(content: number) {
  const a = new ScrollAxis(MAX);
  a.configure(content, VIEW);
  a.observeDom(0);
  return a;
}

describe('ScrollAxis', () => {
  it('is the identity under the limit', () => {
    const a = axis(500_000);
    expect(a.scaled).toBe(false);
    a.onScroll(1234, true);
    expect(a.virtual).toBe(1234);
    a.onScroll(5000, false);
    expect(a.virtual).toBe(5000);
    expect(a.thumbTarget()).toBeNull();
  });

  it('moves 1:1 for relative input past the limit', () => {
    const a = axis(32_000_000);
    expect(a.extent).toBe(MAX);
    for (let i = 1; i <= 10; i++) a.onScroll(i * 100, true);
    expect(a.virtual).toBe(1000);
  });

  it('maps absolute input proportionally', () => {
    const a = axis(32_000_000);
    a.onScroll(a.domMax, false);
    expect(a.virtual).toBeCloseTo(a.virtualMax, 3);
    a.onScroll(0, false);
    expect(a.virtual).toBe(0);
  });

  it('re-syncs the thumb without moving the content', () => {
    const a = axis(32_000_000);
    a.onScroll(10_000, true);
    expect(a.virtual).toBe(10_000);
    const target = a.thumbTarget()!;
    expect(target).toBeLessThan(10_000);
    a.expect(target);
    a.onScroll(target, false);
    expect(a.virtual).toBe(10_000);
    expect(a.thumbTarget()).toBeNull();
    // Further relative input continues from there.
    a.onScroll(target + 50, true);
    expect(a.virtual).toBe(10_050);
  });

  it('detects being stuck at the DOM edge before the content edge', () => {
    const a = axis(32_000_000);
    a.onScroll(a.domMax, true);
    expect(a.virtual).toBeLessThan(a.virtualMax);
    expect(a.stuck).toBe(true);
    const target = a.thumbTarget()!;
    a.expect(target);
    a.onScroll(target, false);
    expect(a.stuck).toBe(false);
  });

  it('scrollTo jumps and ignores its own scroll event', () => {
    const a = axis(32_000_000);
    const dom = a.scrollTo(16_000_000);
    expect(a.virtual).toBe(16_000_000);
    a.onScroll(dom, false);
    expect(a.virtual).toBe(16_000_000);
    expect(a.scrollTo(Number.MAX_SAFE_INTEGER)).toBeCloseTo(a.domMax, 3);
    expect(a.virtual).toBe(a.virtualMax);
  });

  it('keeps the virtual offset in range when content shrinks', () => {
    const a = axis(32_000_000);
    a.scrollTo(30_000_000);
    a.configure(2_000_000, VIEW);
    expect(a.virtual).toBe(2_000_000 - VIEW);
  });

  it('virtual stays within bounds for any input sequence (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.boolean()), { maxLength: 50 }),
        (steps) => {
          const a = axis(50_000_000);
          for (const [t, rel] of steps) {
            a.onScroll(t * a.domMax, rel);
            if (a.virtual < 0 || a.virtual > a.virtualMax) return false;
          }
          return true;
        },
      ),
    );
  });
});
