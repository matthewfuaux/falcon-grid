import type { CellActionEvent, ColumnDef } from '@falcon-grid/core';
import { cell } from './cell';
import { avatar, badge, checkbox, link, row, stack, text, type Tone } from './nodes';

/**
 * Built-in column types, each a `cell()` over the public primitives. They return a `ColumnDef`;
 * spread it and override anything.
 */

/** Column settings every built-in type takes. */
export type ColumnOptions = Omit<ColumnDef, 'cell' | 'width'> & { width?: number };

const base = (o: ColumnOptions, width: number, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  ...extra,
  ...o,
  width: o.width ?? width,
});

/** Plain text, truncated or wrapped. */
export function textColumn(
  o: ColumnOptions & { wrap?: boolean; maxLines?: number; muted?: boolean },
): ColumnDef {
  const { wrap, maxLines, muted, ...rest } = o;
  const opts = {
    ...(wrap ? { wrap } : {}),
    ...(maxLines !== undefined ? { maxLines } : {}),
    ...(muted ? { color: 'muted' as const } : {}),
    align: o.align ?? 'left',
  };
  return base(rest, 200, {
    cell: cell<unknown>((v) => text(String(v), opts), { text: String }),
  });
}

/** Parses numbers given as strings, ignoring currency symbols and grouping. */
const toNumber = (v: unknown): number =>
  typeof v === 'number' ? v : typeof v === 'string' ? Number.parseFloat(v.replace(/[^0-9.eE+-]/g, '')) : Number.NaN;

/** Numbers, right-aligned and formatted with `Intl.NumberFormat`. */
export function numberColumn(
  o: ColumnOptions & { format?: Intl.NumberFormatOptions | ((n: number) => string); locale?: string },
): ColumnDef {
  const { format, locale, ...rest } = o;
  const fmt = typeof format === 'function' ? format : new Intl.NumberFormat(locale, format).format;
  const show = (v: unknown) => {
    const n = toNumber(v);
    return Number.isNaN(n) ? String(v) : fmt(n);
  };
  return base(rest, 120, {
    align: 'right',
    cell: cell<unknown>((v) => text(show(v), { align: o.align ?? 'right' }), { text: show }),
  });
}

/** Dates (Date objects, timestamps or ISO strings), formatted with `Intl.DateTimeFormat`. */
export function dateColumn(
  o: ColumnOptions & { format?: Intl.DateTimeFormatOptions | ((d: Date) => string); locale?: string },
): ColumnDef {
  const { format, locale, ...rest } = o;
  const fmt =
    typeof format === 'function'
      ? format
      : new Intl.DateTimeFormat(locale, format ?? { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
          .format;
  const show = (v: unknown) => {
    const d = v instanceof Date ? v : new Date(v as string | number);
    return Number.isNaN(d.getTime()) ? String(v) : fmt(d);
  };
  return base(rest, 130, {
    cell: cell<unknown>((v) => text(show(v), { align: o.align ?? 'left' }), { text: show }),
  });
}

/** A checkbox. With `onChange` it toggles; update your data and call `invalidateCell`. */
export function booleanColumn(
  o: ColumnOptions & { onChange?: (checked: boolean, e: CellActionEvent) => void },
): ColumnDef {
  const { onChange, ...rest } = o;
  return base(rest, 90, {
    align: 'center',
    cell: cell<unknown>(
      (v) => {
        const checked = v === true || v === 'true' || v === 1;
        return row({ justify: o.align === 'left' ? 'start' : o.align === 'right' ? 'end' : 'center' }, [
          checkbox(checked, onChange ? { onClick: (e) => onChange(!checked, e), ariaLabel: o.title ?? o.id } : {}),
        ]);
      },
      { text: (v) => String(v === true || v === 'true' || v === 1) },
    ),
  });
}

/** Tags as badges: an array, or a comma-separated string. Tags that do not fit are hidden. */
export function tagsColumn(o: ColumnOptions & { tone?: (tag: string) => Tone | (string & {}) }): ColumnDef {
  const { tone, ...rest } = o;
  const tags = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String) : String(v).split(',').map((s) => s.trim()).filter(Boolean);
  return base(rest, 180, {
    cell: cell<unknown>(
      (v) => row({ gap: 4, overflow: 'hide' }, tags(v).map((t) => badge(t, tone ? { tone: tone(t) } : {}))),
      { text: (v) => tags(v).join(', ') },
    ),
  });
}

/** A link. Opens `href(value)` in a new tab, or calls `onClick`. */
export function linkColumn(
  o: ColumnOptions & {
    href?: (value: unknown) => string;
    label?: (value: unknown) => string;
    onClick?: (value: unknown, e: CellActionEvent) => void;
  },
): ColumnDef {
  const { href, label, onClick, ...rest } = o;
  const show = (v: unknown) => (label ? label(v) : String(v));
  return base(rest, 200, {
    cell: cell<unknown>(
      (v) =>
        link(show(v), {
          ...(href ? { href: href(v) } : {}),
          ...(onClick ? { onClick: (e: CellActionEvent) => onClick(v, e) } : {}),
          flex: 1,
        }),
      { text: show },
    ),
  });
}

export interface UserValue {
  name: string;
  avatarUrl?: string;
  /** A second, muted line, such as an email address or role. */
  detail?: string;
}

/** An avatar and a name, with an optional muted second line. Takes a `UserValue` or a name. */
export function userColumn(o: ColumnOptions): ColumnDef {
  const user = (v: unknown): UserValue => (typeof v === 'object' && v !== null ? (v as UserValue) : { name: String(v) });
  return base(o, 200, {
    cell: cell<unknown>(
      (v) => {
        const u = user(v);
        const name = text(u.name, { weight: 500, flex: 1 });
        return row({ gap: 8 }, [
          avatar({ name: u.name, ...(u.avatarUrl ? { src: u.avatarUrl } : {}) }),
          u.detail ? stack({ flex: 1 }, [name, text(u.detail, { color: 'muted', size: 12 })]) : name,
        ]);
      },
      { text: (v) => user(v).name },
    ),
  });
}
