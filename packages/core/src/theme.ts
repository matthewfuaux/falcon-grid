import type { Theme } from './types';

export const defaultTheme: Theme = {
  background: '#ffffff',
  foreground: '#1f2328',
  rowAltBackground: null,
  headerBackground: '#f6f8fa',
  headerForeground: '#3d444d',
  gridLine: '#d1d9e0',
  frozenDivider: '#818b98',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  fontSize: 13,
  fontWeight: '400',
  headerFontWeight: '600',
  cellPaddingX: 8,
  cellPaddingY: 7,
  lineHeight: 18,
  rowHeight: 32,
  headerHeight: 36,
  hoverBackground: 'rgba(31, 35, 40, 0.04)',
  selectionBackground: 'rgba(9, 105, 218, 0.12)',
  selectionBorder: 'rgba(9, 105, 218, 0.6)',
  focusRing: '#0969da',
  mutedForeground: '#59636e',
  accent: '#0969da',
  accentForeground: '#ffffff',
  success: '#1a7f37',
  warning: '#9a6700',
  danger: '#d1242f',
};

export function mergeTheme(base: Theme, patch: Partial<Theme> | undefined): Theme {
  if (!patch) return base;
  const next = { ...base };
  for (const key of Object.keys(patch) as (keyof Theme)[]) {
    const v = patch[key];
    if (v !== undefined) (next as Record<keyof Theme, unknown>)[key] = v;
  }
  return next;
}

/** Fonts as canvas font strings, resolved once per theme. */
export interface ResolvedTheme extends Theme {
  cellFont: string;
  headerFont: string;
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  return {
    ...theme,
    cellFont: `${theme.fontWeight} ${theme.fontSize}px ${theme.fontFamily}`,
    headerFont: `${theme.headerFontWeight} ${theme.fontSize}px ${theme.fontFamily}`,
  };
}

const NUMERIC_KEYS = new Set<keyof Theme>([
  'fontSize',
  'cellPaddingX',
  'cellPaddingY',
  'lineHeight',
  'rowHeight',
  'headerHeight',
]);

/** `rowAltBackground` -> `--fg-row-alt-background` */
export function themeVariableName(key: keyof Theme, prefix = '--fg-'): string {
  return prefix + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

/**
 * Reads theme values from CSS custom properties (e.g. `--fg-background`, `--fg-row-height`).
 * Pass an element, or anything with `getPropertyValue` such as a CSSStyleDeclaration.
 * Unset variables are left out, so the result can be merged over a base theme.
 */
export function themeFromCSSVariables(
  source: Element | Pick<CSSStyleDeclaration, 'getPropertyValue'>,
  prefix = '--fg-',
): Partial<Theme> {
  const style = 'getPropertyValue' in source ? source : getComputedStyle(source);
  const out: Partial<Record<keyof Theme, unknown>> = {};
  for (const key of Object.keys(defaultTheme) as (keyof Theme)[]) {
    const raw = style.getPropertyValue(themeVariableName(key, prefix)).trim();
    if (!raw) continue;
    if (NUMERIC_KEYS.has(key)) {
      const n = parseFloat(raw);
      if (Number.isFinite(n)) out[key] = n;
    } else if (key === 'rowAltBackground' && raw === 'none') {
      out[key] = null;
    } else {
      out[key] = raw;
    }
  }
  return out as Partial<Theme>;
}
