import { describe, expect, it } from 'vitest';
import { defaultTheme, highContrastTheme, mergeTheme, resolveTheme, scaleTheme, themeFromCSSVariables, themeVariableName } from '../src/theme';

const styleOf = (vars: Record<string, string>) => ({ getPropertyValue: (n: string) => vars[n] ?? '' });

describe('theme', () => {
  it('names variables in kebab case', () => {
    expect(themeVariableName('rowAltBackground')).toBe('--fg-row-alt-background');
    expect(themeVariableName('fontSize', '--x-')).toBe('--x-font-size');
  });

  it('reads CSS variables, parsing numbers and skipping unset ones', () => {
    const t = themeFromCSSVariables(
      styleOf({
        '--fg-background': ' #000 ',
        '--fg-row-height': '28px',
        '--fg-font-size': 'oops',
        '--fg-row-alt-background': 'none',
      }),
    );
    expect(t).toEqual({ background: '#000', rowHeight: 28, rowAltBackground: null });
  });

  it('merges over a base without undefined values', () => {
    const t = mergeTheme(defaultTheme, { rowHeight: 20, background: undefined } as never);
    expect(t.rowHeight).toBe(20);
    expect(t.background).toBe(defaultTheme.background);
  });

  it('resolves font strings', () => {
    const r = resolveTheme({ ...defaultTheme, fontFamily: 'Inter', fontSize: 12, headerFontWeight: '700' });
    expect(r.cellFont).toBe('400 12px Inter');
    expect(r.headerFont).toBe('700 12px Inter');
  });
});

// ---- WCAG contrast ------------------------------------------------------------------------------

type RGBA = [number, number, number, number];

function parse(c: string): RGBA {
  const hex = c.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = c.match(/^rgba?\(([^)]+)\)$/)!;
  const [r, g, b, a = '1'] = m[1]!.split(',').map((s) => s.trim());
  return [Number(r), Number(g), Number(b), Number(a)];
}

/** `top` composited over an opaque `bottom`. */
function over(top: string, bottom: string): RGBA {
  const [r, g, b, a] = parse(top);
  const [R, G, B] = parse(bottom);
  return [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1];
}

function luminance([r, g, b]: RGBA): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrast(a: RGBA, b: RGBA): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

describe.each([
  ['default', defaultTheme],
  ['high contrast', mergeTheme(defaultTheme, highContrastTheme)],
])('%s theme meets WCAG AA', (_, t) => {
  const bg = parse(t.background);
  const text = (fg: string, on: RGBA = bg) => contrast(over(fg, `rgb(${on.slice(0, 3).join(',')})`), on);
  const onSelection = over(t.selectionBackground, t.background);

  it('text is at least 4.5:1', () => {
    expect(text(t.foreground)).toBeGreaterThanOrEqual(4.5);
    expect(text(t.headerForeground, parse(t.headerBackground))).toBeGreaterThanOrEqual(4.5);
    expect(text(t.mutedForeground)).toBeGreaterThanOrEqual(4.5);
    for (const tone of [t.accent, t.success, t.warning, t.danger]) expect(text(tone)).toBeGreaterThanOrEqual(4.5);
    // Text on the selection tint and on striped rows.
    expect(text(t.foreground, onSelection)).toBeGreaterThanOrEqual(4.5);
    // Badge labels sit on a 14% tint of their own tone.
    for (const tone of [t.mutedForeground, t.accent, t.success, t.warning, t.danger]) {
      const [r, g, b] = parse(tone);
      const tint = over(`rgba(${r},${g},${b},0.14)`, t.background);
      expect(text(tone, tint)).toBeGreaterThanOrEqual(4.5);
    }
    expect(text(t.accentForeground, parse(t.accent))).toBeGreaterThanOrEqual(4.5);
  });

  it('focus ring and selection border are at least 3:1 against what they sit on', () => {
    expect(contrast(over(t.focusRing, t.background), bg)).toBeGreaterThanOrEqual(3);
    expect(contrast(over(t.focusRing, t.background), onSelection)).toBeGreaterThanOrEqual(3);
    expect(contrast(over(t.selectionBorder, t.background), bg)).toBeGreaterThanOrEqual(3);
  });
});

describe('scaleTheme', () => {
  it('scales sizes, rounded to quarter pixels, and leaves colours alone', () => {
    const t = scaleTheme(defaultTheme, 1.25);
    expect(t.fontSize).toBe(16.25);
    expect(t.rowHeight).toBe(40);
    expect(t.headerHeight).toBe(45);
    expect(t.background).toBe(defaultTheme.background);
    expect(scaleTheme(defaultTheme, 1)).toBe(defaultTheme);
  });
});
