import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LRU } from '../src/lru';
import { ELLIPSIS, TextMeasurer, type MeasureFn } from '../src/text';

/**
 * A fake font: 7px per character, ellipsis 8px, and kerning that tightens "AV" by 1.5px and
 * loosens "rr" by 0.5px, so summed character widths are not exact.
 */
const fakeMeasure: MeasureFn = (text) => {
  let w = 0;
  for (const ch of text) w += ch === ELLIPSIS ? 8 : 7;
  for (let i = 0; i + 1 < text.length; i++) {
    const pair = text.slice(i, i + 2);
    if (pair === 'AV') w -= 1.5;
    if (pair === 'rr') w += 0.5;
  }
  return w;
};

describe('LRU', () => {
  it('evicts the least recently used entry', () => {
    const lru = new LRU<string, number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.get('a');
    lru.set('c', 3);
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBe(1);
    expect(lru.get('c')).toBe(3);
    expect(lru.size).toBe(2);
  });
});

describe('TextMeasurer', () => {
  it('measures and caches widths', () => {
    const m = new TextMeasurer(fakeMeasure);
    expect(m.width('hello', 'f')).toBe(35);
    const before = m.measurements;
    m.width('hello', 'f');
    expect(m.measurements).toBe(before);
  });

  it('returns text that fits unchanged, without measuring clear ASCII cases', () => {
    const m = new TextMeasurer(fakeMeasure);
    expect(m.fit('short', 'f', 100)).toBe('short');
    expect(m.measurements).toBe(0);
  });

  it('truncates with an ellipsis to the longest prefix that fits', () => {
    const m = new TextMeasurer(fakeMeasure);
    // 10 chars = 70px; 50px leaves room for 6 chars + ellipsis (42 + 8)
    expect(m.fit('abcdefghij', 'f', 50)).toBe('abcdef' + ELLIPSIS);
    expect(m.fit('abcdefghij', 'f', 49)).toBe('abcde' + ELLIPSIS);
  });

  it('trims trailing spaces before the ellipsis', () => {
    const m = new TextMeasurer(fakeMeasure);
    expect(m.fit('abc   defghij', 'f', 50)).toBe('abc' + ELLIPSIS);
  });

  it('returns an empty string when not even the ellipsis fits', () => {
    expect(new TextMeasurer(fakeMeasure).fit('abc', 'f', 5)).toBe('');
  });

  it('caches truncation per width', () => {
    const m = new TextMeasurer(fakeMeasure);
    m.fit('abcdefghijklmnop', 'f', 60);
    const n = m.measurements;
    expect(m.fit('abcdefghijklmnop', 'f', 60)).toBe('abcdefg' + ELLIPSIS);
    expect(m.measurements).toBe(n);
    expect(m.fit('abcdefghijklmnop', 'f', 40)).toBe('abcd' + ELLIPSIS);
  });

  it('never splits a surrogate pair', () => {
    const m = new TextMeasurer(fakeMeasure);
    const s = 'ab😀😀😀cd';
    const out = m.fit(s, 'f', 40);
    expect(out.endsWith(ELLIPSIS)).toBe(true);
    const body = out.slice(0, -1);
    const last = body.charCodeAt(body.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it('always returns the longest prefix that exactly fits, kerning included (property)', () => {
    const m = new TextMeasurer(fakeMeasure);
    fc.assert(
      fc.property(fc.stringMatching(/^[AVrab é]{0,40}$/), fc.integer({ min: 10, max: 300 }), (text, width) => {
        const out = m.fit(text, 'f', width);
        if (fakeMeasure(text, 'f') <= width) return out === text;
        if (out === '') return width < 8;
        if (!out.endsWith(ELLIPSIS) || fakeMeasure(out, 'f') > width) return false;
        // The next longer prefix (before trimming) must not fit.
        const prefix = out.slice(0, -1);
        const k = text.indexOf(prefix) === 0 ? prefix.length : -1;
        if (k < 0) return false;
        let next = k + 1;
        while (next < text.length && text[next - 1] === ' ') next++;
        return next > text.length - 1 || fakeMeasure(text.slice(0, next) + ELLIPSIS, 'f') > width || text.slice(k, next).trim() === '';
      }),
      { numRuns: 500 },
    );
  });
});
