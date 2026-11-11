import { describe, expect, it } from 'vitest';
import { defaultTheme, mergeTheme, resolveTheme, themeFromCSSVariables, themeVariableName } from '../src/theme';

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
