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
  selectionBorder: 'rgba(9, 105, 218, 0.8)',
  focusRing: '#0969da',
  matchBackground: 'rgba(212, 167, 44, 0.4)',
  mutedForeground: '#59636e',
  // Tones are dark enough for 4.5:1 on white and on the 14% tint behind badge labels.
  accent: '#0860ca',
  accentForeground: '#ffffff',
  success: '#187733',
  warning: '#8a5c00',
  danger: '#c21d2a',
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

/** Applied under `prefers-contrast: more`: solid lines and stronger secondary colours. */
export const highContrastTheme: Partial<Theme> = {
  foreground: '#010409',
  headerForeground: '#010409',
  gridLine: '#59636e',
  frozenDivider: '#010409',
  mutedForeground: '#393f46',
  selectionBackground: 'rgba(9, 105, 218, 0.2)',
  selectionBorder: '#0550ae',
  focusRing: '#0550ae',
  accent: '#0550ae',
  success: '#055d20',
  warning: '#6c4400',
  danger: '#a0111f',
};

/**
 * Colours for `forced-colors: active` (Windows contrast themes), from the user's system
 * colours. Canvas pixels are not adjusted by the browser, so the grid paints with them itself.
 */
export function forcedColorsTheme(doc: Document): Partial<Theme> {
  const probe = doc.createElement('span');
  probe.style.display = 'none';
  doc.body.append(probe);
  const sys = (name: string) => {
    probe.style.color = name;
    return getComputedStyle(probe).color;
  };
  const alpha = (rgb: string, a: number) => rgb.replace(/^rgba?\(([^,]+),([^,]+),([^,)]+).*$/, `rgba($1,$2,$3, ${a})`);
  const canvas = sys('Canvas');
  const text = sys('CanvasText');
  const highlight = sys('Highlight');
  const muted = sys('GrayText');
  const link = sys('LinkText');
  probe.remove();
  return {
    background: canvas,
    foreground: text,
    rowAltBackground: null,
    headerBackground: canvas,
    headerForeground: text,
    gridLine: muted,
    frozenDivider: text,
    hoverBackground: 'transparent',
    selectionBackground: alpha(highlight, 0.3),
    selectionBorder: highlight,
    focusRing: highlight,
    matchBackground: alpha(highlight, 0.5),
    mutedForeground: text,
    accent: link,
    accentForeground: canvas,
    success: text,
    warning: text,
    danger: text,
  };
}

const SCALED_KEYS = ['fontSize', 'cellPaddingX', 'cellPaddingY', 'lineHeight', 'rowHeight', 'headerHeight'] as const;

/** Sizes scaled for a root font size other than 16px (the user's text size setting). */
export function scaleTheme(theme: Theme, factor: number): Theme {
  if (factor === 1) return theme;
  const next = { ...theme };
  for (const k of SCALED_KEYS) next[k] = Math.round(theme[k] * factor * 4) / 4;
  return next;
}
