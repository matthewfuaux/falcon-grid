import { ELLIPSIS, type CellEnv, type CellRegion, type DisplayList, type DrawOp, type OpStyle } from '@falcon-grid/core';
import { icons } from './icons';
import type { BoxNode, CellNode, IconNode, Interactive, Sizing, TextOptions, Tone } from './nodes';

/** Sizes worked out during one compile, kept on the nodes (a tree is compiled once per value). */
interface Laid {
  /** Natural width. */
  _iw?: number;
  /** Children's widths in a row, and how many fit with overflow 'hide'. */
  _cw?: number[];
  _shown?: number;
  /** Height at the assigned width. */
  _h?: number;
}
type N = CellNode & Laid;

const BADGE_PAD = 6;
const BUTTON_SIZE = 24;
const BUTTON_PAD = 10;
const AVATAR_COLORS = ['#8250df', '#0969da', '#1a7f37', '#bf3989', '#9a6700', '#cf222e', '#1b7c83', '#6e7781'];

const isBox = (n: CellNode): n is BoxNode => n.type === 'row' || n.type === 'stack';
const shrinks = (n: CellNode) =>
  n.width === undefined && ((n.type === 'text' && n.truncate !== false) || n.type === 'badge' || n.type === 'link');
const clamp = (n: Sizing, w: number) => Math.max(n.minWidth ?? 0, Math.min(n.maxWidth ?? Infinity, w));

/**
 * Lays out a cell tree and compiles it to a display list in one pass over the tree per step:
 * natural widths bottom-up, widths top-down (a single-pass flex subset: fixed and natural sizes,
 * gaps, `flex` grow, shrinking of truncatable items), heights bottom-up, then positions top-down,
 * emitting draw ops and hit regions as it goes.
 */
export class Compiler {
  private env!: CellEnv;
  private ops: DrawOp[] = [];
  private regions: CellRegion[] = [];

  compile(root: CellNode, width: number, env: CellEnv): DisplayList {
    this.env = env;
    this.ops = [];
    this.regions = [];
    // A single primitive sits in an implicit row; text and bars fill it, like a block would.
    const fills = root.type === 'text' || root.type === 'progress' || root.type === 'custom';
    const top: N = isBox(root)
      ? root
      : { type: 'row', children: [fills && root.flex === undefined && root.width === undefined ? { ...root, flex: 1 } : root] };
    const natural = this.natural(top);
    const w = top.width !== undefined ? Math.min(top.width, width) : width;
    const h = this.height(top, w);
    this.emit(top, 0, 0, w, h);
    return { ops: this.ops, regions: this.regions, width: Math.ceil(natural), height: h };
  }

  // ---- Fonts and colours ------------------------------------------------------------------------

  private font(o: TextOptions, weight?: number | string, size?: number): string {
    const t = this.env.theme;
    return `${o.italic ? 'italic ' : ''}${o.weight ?? weight ?? t.fontWeight} ${o.size ?? size ?? t.fontSize}px ${t.fontFamily}`;
  }

  private lineHeight(size: number | undefined): number {
    const t = this.env.theme;
    return size === undefined ? t.lineHeight : Math.round((t.lineHeight * size) / t.fontSize);
  }

  private color(c: Tone | string | undefined, fallback: string): string {
    const t = this.env.theme;
    switch (c) {
      case undefined:
        return fallback;
      case 'default':
        return t.foreground;
      case 'muted':
        return t.mutedForeground;
      case 'accent':
        return t.accent;
      case 'success':
        return t.success;
      case 'warning':
        return t.warning;
      case 'danger':
        return t.danger;
      default:
        return c;
    }
  }

  private textWidth(s: string, font: string): number {
    return s ? this.env.text.width(s, font) : 0;
  }

  // ---- Measuring ------------------------------------------------------------------------------

  /** Natural main-axis width. */
  private natural(n: N): number {
    if (n._iw !== undefined) return n._iw;
    const t = this.env.theme;
    let w: number;
    switch (n.type) {
      case 'text':
        w = this.textWidth(n.text, this.font(n));
        break;
      case 'row': {
        w = Math.max(0, n.children.length - 1) * (n.gap ?? 0);
        for (const c of n.children) w += this.natural(c);
        break;
      }
      case 'stack':
        w = 0;
        for (const c of n.children) w = Math.max(w, this.natural(c));
        break;
      case 'spacer':
        w = n.size ?? 0;
        break;
      case 'icon':
        w = n.size ?? 16;
        break;
      case 'image':
        w = n.width;
        break;
      case 'avatar':
        w = n.size ?? 20;
        break;
      case 'badge':
        w = this.textWidth(n.label, this.badgeFont()) + 2 * BADGE_PAD;
        break;
      case 'button':
        w = n.label
          ? this.textWidth(n.label, this.font({}, 500)) + 2 * BUTTON_PAD + (n.icon ? 16 + 6 : 0)
          : BUTTON_SIZE;
        break;
      case 'link':
        w = this.textWidth(n.label, t.cellFont);
        break;
      case 'progress':
        w = 64;
        break;
      case 'checkbox':
        w = n.size ?? 16;
        break;
      case 'custom':
        w = 0;
        break;
    }
    n._iw = clamp(n, n.width ?? w);
    return n._iw;
  }

  private badgeFont(): string {
    return this.font({}, 500, this.env.theme.fontSize - 1);
  }

  private flexOf(n: CellNode): number {
    if (n.width !== undefined) return 0;
    if (n.flex !== undefined) return n.flex;
    return (n.type === 'spacer' && n.size === undefined) || (n.type === 'custom' && n.width === undefined) ? 1 : 0;
  }

  /** Splits a row's width among its children. */
  private rowWidths(n: BoxNode & Laid, w: number): number[] {
    const kids = n.children;
    const out = kids.map((c) => (this.flexOf(c) > 0 ? clamp(c, 0) : this.natural(c)));
    const gaps = Math.max(0, kids.length - 1) * (n.gap ?? 0);
    let free = w - gaps;
    let flexTotal = 0;
    for (let i = 0; i < kids.length; i++) {
      free -= out[i]!;
      flexTotal += this.flexOf(kids[i]!);
    }
    if (free > 0 && flexTotal > 0) {
      for (let i = 0; i < kids.length; i++) {
        const f = this.flexOf(kids[i]!);
        if (f > 0) out[i] = clamp(kids[i]!, out[i]! + (free * f) / flexTotal);
      }
    } else if (free < 0 && n.overflow !== 'hide') {
      let total = 0;
      for (let i = 0; i < kids.length; i++) if (shrinks(kids[i]!)) total += out[i]!;
      if (total > 0) {
        const cut = Math.min(-free, total);
        for (let i = 0; i < kids.length; i++) {
          if (shrinks(kids[i]!)) out[i] = Math.max(kids[i]!.minWidth ?? 0, out[i]! - (cut * out[i]!) / total);
        }
      }
    }
    n._shown = kids.length;
    if (n.overflow === 'hide') {
      let x = 0;
      for (let i = 0; i < kids.length; i++) {
        x += out[i]! + (i > 0 ? (n.gap ?? 0) : 0);
        if (x > w + 0.5) {
          n._shown = i;
          break;
        }
      }
    }
    return out;
  }

  /** Width of a stack child: the stack's width when stretched, else its natural width. */
  private stackChildWidth(n: BoxNode, c: CellNode, w: number): number {
    return (n.align ?? 'stretch') === 'stretch' || this.flexOf(c) > 0 ? w : Math.min(w, this.natural(c));
  }

  /** Height at width `w`; for rows also fixes the children's widths. */
  private height(n: N, w: number): number {
    const t = this.env.theme;
    let h: number;
    switch (n.type) {
      case 'text': {
        const lh = this.lineHeight(n.size);
        h = lh;
        if (n.wrap && this.env.wrapper && w > 0) {
          const lines = this.env.wrapper.lineCount(n.text, this.font(n), w);
          h = Math.min(lines, n.maxLines ?? Infinity) * lh;
        }
        break;
      }
      case 'row': {
        const cw = (n._cw = this.rowWidths(n, w));
        h = 0;
        for (let i = 0; i < n._shown!; i++) h = Math.max(h, this.height(n.children[i]!, cw[i]!));
        break;
      }
      case 'stack': {
        h = Math.max(0, n.children.length - 1) * (n.gap ?? 0);
        for (const c of n.children) h += this.height(c, this.stackChildWidth(n, c, w));
        break;
      }
      case 'spacer':
        h = n.size ?? 0;
        break;
      case 'icon':
        h = n.size ?? 16;
        break;
      case 'image':
        h = n.height;
        break;
      case 'avatar':
        h = n.size ?? 20;
        break;
      case 'badge':
        h = t.lineHeight;
        break;
      case 'button':
        h = BUTTON_SIZE;
        break;
      case 'link':
        h = t.lineHeight;
        break;
      case 'progress':
        h = n.height ?? 6;
        break;
      case 'checkbox':
        h = n.size ?? 16;
        break;
      case 'custom':
        h = n.height;
        break;
    }
    n._h = h;
    return h;
  }

  // ---- Emitting -------------------------------------------------------------------------------

  /** Adds a hit region for an interactive or tooltipped node; returns its index. */
  private region(n: CellNode & { hitTest?: (x: number, y: number) => boolean }, x: number, y: number, w: number, h: number) {
    if (!('onClick' in n && n.onClick) && n.tooltip === undefined) return undefined;
    const r: CellRegion = { x, y, w, h };
    if ('onClick' in n && n.onClick) {
      r.onClick = n.onClick;
      // Clickable: a control for assistive technology.
      r.role = n.type === 'checkbox' ? 'checkbox' : n.type === 'link' ? 'link' : 'button';
      r.label = n.ariaLabel ?? nameOf(n);
      if (n.type === 'checkbox') r.checked = n.checked;
      if (n.type === 'link' && n.href) r.href = n.href;
    }
    if (n.tooltip !== undefined) r.tooltip = n.tooltip;
    if ('cursor' in n && n.cursor !== undefined) r.cursor = n.cursor;
    const test = n.hitTest;
    if (test) r.hitTest = (px, py) => test(px - x, py - y);
    this.regions.push(r);
    return this.regions.length - 1;
  }

  private op<T extends DrawOp>(op: T, region: number | undefined, hover?: OpStyle, press?: OpStyle): void {
    if (region !== undefined) {
      op.region = region;
      if (hover) op.hover = hover;
      if (press) op.press = press;
    }
    this.ops.push(op);
  }

  private textOp(s: string, font: string, color: string, x: number, y: number, w: number, h: number, align: string, region?: number, hover?: OpStyle, soft?: boolean) {
    if (!s) return;
    const tw = this.textWidth(s, font);
    const tx = align === 'right' ? x + w - tw : align === 'center' ? x + (w - tw) / 2 : x;
    const op: DrawOp = { k: 'text', x: tx, y, w: tw, h, text: s, font, color };
    if (soft) op.soft = true;
    this.op(op, region, hover);
  }

  private iconOp(def: IconNode['icon'], x: number, y: number, size: number, color: string, region?: number, hover?: OpStyle) {
    const d = typeof def === 'string' ? icons[def] : def;
    const op: DrawOp = { k: 'path', x, y, w: size, h: size, path: d.path, box: d.box, color };
    if ('stroke' in d && d.stroke) op.line = (d.stroke * size) / d.box;
    this.op(op, region, hover);
  }

  private emit(n: N, x: number, y: number, w: number, h: number): void {
    const t = this.env.theme;
    switch (n.type) {
      case 'row': {
        const cw = n._cw!;
        const shown = n._shown!;
        const gap = n.gap ?? 0;
        let used = Math.max(0, shown - 1) * gap;
        for (let i = 0; i < shown; i++) used += cw[i]!;
        const rest = Math.max(0, w - used);
        const justify = n.justify ?? 'start';
        let cx = x + (justify === 'center' ? rest / 2 : justify === 'end' ? rest : 0);
        const step = gap + (justify === 'between' && shown > 1 ? rest / (shown - 1) : 0);
        const align = n.align ?? 'center';
        for (let i = 0; i < shown; i++) {
          const c = n.children[i]! as N;
          const ch = align === 'stretch' ? h : c._h!;
          const cy = align === 'start' || align === 'stretch' ? y : align === 'end' ? y + h - ch : y + (h - ch) / 2;
          this.emit(c, cx, cy, cw[i]!, ch);
          cx += cw[i]! + step;
        }
        break;
      }
      case 'stack': {
        const align = n.align ?? 'stretch';
        let cy = y;
        for (const child of n.children) {
          const c = child as N;
          const cw = this.stackChildWidth(n, c, w);
          const cx = align === 'center' ? x + (w - cw) / 2 : align === 'end' ? x + w - cw : x;
          this.emit(c, cx, cy, cw, c._h!);
          cy += c._h! + (n.gap ?? 0);
        }
        break;
      }
      case 'text': {
        const font = this.font(n);
        const lh = this.lineHeight(n.size);
        const color = this.color(n.color, t.foreground);
        const align = n.align ?? 'left';
        const region = this.region(n, x, y, w, h);
        const top = y + (h - n._h!) / 2;
        if (n.wrap && this.env.wrapper && w > 0) {
          const lines = this.env.wrapper.lines(n.text, font, w);
          const count = Math.min(lines.length, n.maxLines ?? Infinity);
          for (let i = 0; i < count; i++) {
            let line = lines[i]!;
            if (i === count - 1 && count < lines.length) line = this.env.text.fit(line + ELLIPSIS, font, w);
            this.textOp(line, font, color, x, top + i * lh, w, lh, align, region, undefined, i > 0);
          }
        } else {
          const s = n.truncate === false ? n.text : this.env.text.fit(n.text, font, Math.max(0, w));
          this.textOp(s, font, color, x, top, w, lh, align, region);
        }
        break;
      }
      case 'icon': {
        const size = n.size ?? 16;
        const region = this.region(n, x, y, w, h);
        const color = this.color(n.color, n.onClick ? t.mutedForeground : t.foreground);
        this.iconOp(n.icon, x + (w - size) / 2, y + (h - size) / 2, size, color, region, n.onClick ? { color: t.foreground } : undefined);
        break;
      }
      case 'image': {
        const region = this.region(n, x, y, w, h);
        const op: DrawOp = { k: 'image', x, y, w: Math.min(w, n.width), h: n.height, src: n.src };
        if (n.radius) op.radius = n.radius;
        this.op(op, region);
        break;
      }
      case 'avatar': {
        const size = n.size ?? 20;
        const region = this.region(n, x, y, size, size);
        let hash = 0;
        for (let i = 0; i < n.name.length; i++) hash = (Math.imul(hash, 31) + n.name.charCodeAt(i)) | 0;
        this.op({ k: 'rect', x, y, w: size, h: size, radius: size / 2, color: AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]! }, region);
        const initials = n.name
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((p) => String.fromCodePoint(p.codePointAt(0)!).toUpperCase())
          .join('');
        const fs = Math.max(8, Math.round(size * 0.42));
        this.textOp(initials, this.font({}, 600, fs), '#ffffff', x, y, size, size, 'center');
        if (n.src) this.op({ k: 'image', x, y, w: size, h: size, src: n.src, radius: size / 2 }, region);
        break;
      }
      case 'badge': {
        const color = this.color(n.tone, t.mutedForeground);
        const region = this.region(n, x, y, w, h);
        this.op({ k: 'rect', x, y, w, h, radius: 4, color, alpha: 0.14 }, region);
        const font = this.badgeFont();
        const label = this.env.text.fit(n.label, font, Math.max(0, w - 2 * BADGE_PAD));
        this.textOp(label, font, color, x + BADGE_PAD, y, w - 2 * BADGE_PAD, h, 'center', region);
        break;
      }
      case 'button': {
        const solid = n.variant === 'solid';
        const tone = this.color(n.tone, solid ? t.accent : t.foreground);
        const region = this.region(n, x, y, w, h);
        this.op(
          { k: 'rect', x, y, w, h, radius: 4, color: tone, alpha: solid ? 1 : 0 },
          region,
          { alpha: solid ? 0.88 : 0.08 },
          { alpha: solid ? 0.76 : 0.16 },
        );
        const fg = solid ? t.accentForeground : n.label ? tone : t.mutedForeground;
        const hoverFg = solid ? undefined : { color: tone };
        if (n.label) {
          const font = this.font({}, 500);
          let cx = x + BUTTON_PAD;
          if (n.icon) {
            this.iconOp(n.icon, cx, y + (h - 16) / 2, 16, fg, region, hoverFg);
            cx += 16 + 6;
          }
          const label = this.env.text.fit(n.label, font, Math.max(0, x + w - BUTTON_PAD - cx));
          this.textOp(label, font, fg, cx, y, x + w - BUTTON_PAD - cx, h, 'left', region, hoverFg);
        } else if (n.icon) {
          this.iconOp(n.icon, x + (w - 16) / 2, y + (h - 16) / 2, 16, fg, region, hoverFg);
        }
        break;
      }
      case 'link': {
        const href = n.href;
        const click =
          n.onClick ?? (href ? () => void globalThis.open?.(href, '_blank', 'noopener,noreferrer') : undefined);
        const font = t.cellFont;
        const label = this.env.text.fit(n.label, font, Math.max(0, w));
        const tw = this.textWidth(label, font);
        const region = this.region(click ? { ...n, onClick: click } : n, x, y, Math.min(w, tw), h);
        this.textOp(label, font, t.accent, x, y, w, h, 'left', region, { underline: true });
        break;
      }
      case 'progress': {
        const color = this.color(n.tone, t.accent);
        const bh = n._h!;
        const value = Math.max(0, Math.min(1, Number.isFinite(n.value) ? n.value : 0));
        const region = this.region(n, x, y, w, bh);
        this.op({ k: 'rect', x, y, w, h: bh, radius: bh / 2, color: t.mutedForeground, alpha: 0.2 }, region);
        if (value > 0) this.op({ k: 'rect', x, y, w: Math.max(bh, w * value), h: bh, radius: bh / 2, color }, region);
        break;
      }
      case 'checkbox': {
        const size = n.size ?? 16;
        const cx = x + (w - size) / 2;
        const cy = y + (h - size) / 2;
        const region = this.region(n, cx, cy, size, size);
        if (n.checked) {
          this.op({ k: 'rect', x: cx, y: cy, w: size, h: size, radius: 3, color: t.accent }, region, { alpha: 0.88 });
          this.iconOp('check', cx, cy, size, t.accentForeground);
        } else {
          this.op({ k: 'rect', x: cx, y: cy, w: size, h: size, radius: 3, color: t.mutedForeground, line: 1 }, region, { color: t.accent });
        }
        break;
      }
      case 'custom': {
        const region = this.region(n, x, y, w, h);
        this.op({ k: 'custom', x, y, w, h, draw: n.draw }, region);
        break;
      }
      case 'spacer':
        break;
    }
  }
}

/** The name a clickable primitive gets by default. */
function nameOf(n: CellNode): string {
  const icon = (i: IconNode['icon'] | undefined) => (typeof i === 'string' ? i : '');
  switch (n.type) {
    case 'text':
      return n.text;
    case 'badge':
    case 'link':
      return n.label;
    case 'button':
      return n.label ?? n.tooltip ?? icon(n.icon);
    case 'icon':
      return n.tooltip ?? icon(n.icon);
    case 'avatar':
      return n.tooltip ?? n.name;
    case 'custom':
      return n.tooltip ?? n.text ?? '';
    default:
      return n.tooltip ?? '';
  }
}

/** Whether a primitive is a control (read from the control itself, not the cell text). */
const isControl = (n: CellNode) => 'onClick' in n && !!n.onClick;

/**
 * What a screen reader reads for a tree: its text and the state of non-interactive parts
 * (unticked checkboxes, progress), leaving out controls, which are read on their own.
 */
export function accessibleTextOf(n: CellNode | null | undefined | false): string {
  if (!n || isControl(n)) return '';
  switch (n.type) {
    case 'checkbox':
      return n.checked ? 'checked' : 'not checked';
    case 'progress':
      return `${Math.round(Math.max(0, Math.min(1, n.value)) * 100)}%`;
    case 'avatar':
      return '';
    case 'icon':
    case 'image':
      return n.tooltip ?? '';
    case 'row':
    case 'stack': {
      let s = '';
      for (const c of n.children) {
        const t = accessibleTextOf(c);
        if (t) s = s ? `${s} ${t}` : t;
      }
      return s;
    }
    default:
      return textOf(n);
  }
}

/** Plain text of a tree, for copying: text, labels and custom text, space separated. */
export function textOf(n: CellNode | null | undefined | false): string {
  if (!n) return '';
  switch (n.type) {
    case 'text':
      return n.text;
    case 'badge':
    case 'link':
      return n.label;
    case 'button':
      return n.label ?? '';
    case 'custom':
      return n.text ?? '';
    case 'row':
    case 'stack': {
      let s = '';
      for (const c of n.children) {
        const t = textOf(c);
        if (t) s = s ? `${s} ${t}` : t;
      }
      return s;
    }
    default:
      return '';
  }
}
