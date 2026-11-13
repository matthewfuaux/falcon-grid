import type { CellActionEvent } from '@falcon-grid/core';
import type { IconName } from './icons';

/**
 * Cell primitives. Each is a function returning a plain object; a cell is a small tree of them.
 * Nothing here draws: `cell()` lays the tree out and compiles it to a display list.
 */

/** Theme colours a primitive can take by name; any CSS colour works too. */
export type Tone = 'default' | 'muted' | 'accent' | 'success' | 'warning' | 'danger';

/** Main-axis sizing, shared by every primitive. */
export interface Sizing {
  /** Share of the row's leftover space. A flex item starts from zero, like CSS `flex: n`. */
  flex?: number;
  /** Fixed main-axis size in CSS pixels, instead of the natural size. */
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  /** Shown as a native tooltip while the pointer is over the primitive. */
  tooltip?: string;
}

export interface Interactive {
  onClick?: (e: CellActionEvent) => void;
  /**
   * Accessible name when the primitive is clickable (it becomes a button, link or checkbox for
   * screen readers). Default: its text, label, tooltip or icon name.
   */
  ariaLabel?: string;
  /** CSS cursor while hovered (default 'pointer' when there is an `onClick`). */
  cursor?: string;
}

export interface TextOptions extends Sizing {
  weight?: number | string;
  /** Font size in CSS pixels (default the theme's). Line height scales with it. */
  size?: number;
  italic?: boolean;
  /** A tone or any CSS colour (default the theme's foreground). */
  color?: Tone | (string & {});
  /** Cut overflow with an ellipsis (default true). Without it, overflow is clipped. */
  truncate?: boolean;
  /** Wrap onto several lines (needs the grid's `textWrapper`). */
  wrap?: boolean;
  /** With `wrap`: most lines shown; the last one ends with an ellipsis if text is left over. */
  maxLines?: number;
  /** Alignment within the space the text gets. */
  align?: 'left' | 'center' | 'right';
}

export interface TextNode extends TextOptions {
  type: 'text';
  text: string;
}

export interface BoxOptions extends Sizing {
  /** Space between children in CSS pixels. */
  gap?: number;
  /** Cross-axis alignment (default 'center' in a row, 'stretch' in a stack). */
  align?: 'start' | 'center' | 'end' | 'stretch';
  /** Main-axis distribution of leftover space (default 'start'). */
  justify?: 'start' | 'center' | 'end' | 'between';
  /**
   * What happens when children do not fit a row: 'clip' (default) shrinks truncatable children
   * (text, badges, links) and lets the cell clip the rest; 'hide' keeps natural sizes and drops
   * every child from the first one that does not fit entirely.
   */
  overflow?: 'clip' | 'hide';
}

export interface BoxNode extends BoxOptions {
  type: 'row' | 'stack';
  children: CellNode[];
}

export interface SpacerNode extends Sizing {
  type: 'spacer';
  /** Fixed size; without one the spacer takes leftover space (flex 1). */
  size?: number;
}

export interface IconOptions extends Sizing, Interactive {
  size?: number;
  color?: Tone | (string & {});
}

export interface IconNode extends IconOptions {
  type: 'icon';
  icon: IconName | { path: string; box: number; stroke?: number };
}

export interface ImageOptions extends Sizing, Interactive {
  src: string;
  width: number;
  height: number;
  /** Corner radius; half the size for a circle. */
  radius?: number;
}

export interface ImageNode extends ImageOptions {
  type: 'image';
}

export interface AvatarOptions extends Sizing, Interactive {
  /** Used for the initials shown until (or instead of) the image, and their colour. */
  name: string;
  src?: string;
  size?: number;
}

export interface AvatarNode extends AvatarOptions {
  type: 'avatar';
}

export interface BadgeOptions extends Sizing, Interactive {
  tone?: Tone | (string & {});
}

export interface BadgeNode extends BadgeOptions {
  type: 'badge';
  label: string;
}

export interface ButtonOptions extends Sizing, Interactive {
  label?: string;
  icon?: IconNode['icon'];
  /** 'ghost' (default): transparent until hovered. 'solid': filled with the tone. */
  variant?: 'ghost' | 'solid';
  tone?: Tone | (string & {});
}

export interface ButtonNode extends ButtonOptions {
  type: 'button';
}

export interface LinkOptions extends Sizing, Interactive {
  /** Opened in a new tab on click when there is no `onClick`. */
  href?: string;
}

export interface LinkNode extends LinkOptions {
  type: 'link';
  label: string;
}

export interface ProgressOptions extends Sizing {
  tone?: Tone | (string & {});
  /** Bar thickness (default 6). */
  height?: number;
}

export interface ProgressNode extends ProgressOptions {
  type: 'progress';
  /** 0 to 1. */
  value: number;
}

export interface CheckboxOptions extends Sizing, Interactive {
  size?: number;
}

export interface CheckboxNode extends CheckboxOptions {
  type: 'checkbox';
  checked: boolean;
}

export interface CustomOptions extends Sizing, Interactive {
  /** Height in CSS pixels. Width comes from `width`, or leftover space (flex 1) without one. */
  height: number;
  draw: (ctx: CanvasRenderingContext2D, rect: { x: number; y: number; width: number; height: number }) => void;
  /** Finer hit test for `onClick` and `tooltip`, relative to the rectangle's top-left. */
  hitTest?: (x: number, y: number) => boolean;
  /** Text for copying. */
  text?: string;
}

export interface CustomNode extends CustomOptions {
  type: 'custom';
}

export type CellNode =
  | TextNode
  | BoxNode
  | SpacerNode
  | IconNode
  | ImageNode
  | AvatarNode
  | BadgeNode
  | ButtonNode
  | LinkNode
  | ProgressNode
  | CheckboxNode
  | CustomNode;

/** Children may include null, undefined and false for conditional content. */
export type Child = CellNode | null | undefined | false;

const kids = (children: readonly Child[]): CellNode[] => children.filter((c): c is CellNode => !!c);

export const text = (value: string, options: TextOptions = {}): TextNode => ({ ...options, type: 'text', text: value });

/** Children side by side. */
export function row(children: readonly Child[]): BoxNode;
export function row(options: BoxOptions, children: readonly Child[]): BoxNode;
export function row(a: BoxOptions | readonly Child[], b?: readonly Child[]): BoxNode {
  return Array.isArray(a)
    ? { type: 'row', children: kids(a) }
    : { ...(a as BoxOptions), type: 'row', children: kids(b ?? []) };
}

/** Children on top of each other. */
export function stack(children: readonly Child[]): BoxNode;
export function stack(options: BoxOptions, children: readonly Child[]): BoxNode;
export function stack(a: BoxOptions | readonly Child[], b?: readonly Child[]): BoxNode {
  return Array.isArray(a)
    ? { type: 'stack', children: kids(a) }
    : { ...(a as BoxOptions), type: 'stack', children: kids(b ?? []) };
}

/** Leftover space, or a fixed gap with a size. */
export const spacer = (size?: number): SpacerNode => (size === undefined ? { type: 'spacer' } : { type: 'spacer', size });

export const icon = (name: IconNode['icon'], options: IconOptions = {}): IconNode => ({ ...options, type: 'icon', icon: name });

export const image = (options: ImageOptions): ImageNode => ({ ...options, type: 'image' });

export const avatar = (options: AvatarOptions): AvatarNode => ({ ...options, type: 'avatar' });

export const badge = (label: string, options: BadgeOptions = {}): BadgeNode => ({ ...options, type: 'badge', label });

export const button = (options: ButtonOptions): ButtonNode => ({ ...options, type: 'button' });

export const link = (label: string, options: LinkOptions = {}): LinkNode => ({ ...options, type: 'link', label });

export const progress = (value: number, options: ProgressOptions = {}): ProgressNode => ({ ...options, type: 'progress', value });

export const checkbox = (checked: boolean, options: CheckboxOptions = {}): CheckboxNode => ({ ...options, type: 'checkbox', checked });

/** Escape hatch: draw with the canvas API directly. */
export const custom = (options: CustomOptions): CustomNode => ({ ...options, type: 'custom' });
