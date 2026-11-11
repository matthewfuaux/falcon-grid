import { MAX_SCROLL_SIZE, domToVirtual, virtualToDom } from './layout';

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * One scroll axis, mapping native (DOM) scroll positions to virtual content offsets.
 *
 * Under the browser's element size limit the mapping is the identity. Past it the spacer is
 * capped and positions are scaled, but a pure proportional mapping makes every wheel tick move
 * the content `content / extent` times too far. So:
 *
 * - Relative input (wheel, keys, touch) moves the virtual offset 1:1 with the DOM delta.
 * - Absolute input (scrollbar drags, programmatic jumps) maps proportionally.
 * - When relative scrolling settles, or gets stuck at a DOM edge before the content edge,
 *   the thumb is moved to its proportional position without moving the content.
 */
export class ScrollAxis {
  /** Last observed DOM scroll position. */
  dom = 0;
  /** Virtual content offset in CSS pixels. */
  virtual = 0;
  private content = 0;
  private viewport = 0;
  private expected = Number.NaN;

  constructor(private readonly max = MAX_SCROLL_SIZE) {}

  get scaled(): boolean {
    return this.content > this.max;
  }
  /** Size for the spacer element. */
  get extent(): number {
    return Math.min(this.content, this.max);
  }
  get virtualMax(): number {
    return Math.max(0, this.content - this.viewport);
  }
  get domMax(): number {
    return Math.max(0, this.extent - this.viewport);
  }

  configure(content: number, viewport: number): void {
    this.content = content;
    this.viewport = viewport;
    this.virtual = clamp(this.virtual, 0, this.virtualMax);
  }

  /** Records the DOM position after a layout change (the browser may have clamped it). */
  observeDom(dom: number): void {
    this.dom = dom;
    if (!this.scaled) this.virtual = clamp(dom, 0, this.virtualMax);
  }

  /** Handles a native scroll event. `relative` is true for wheel, keyboard and touch input. */
  onScroll(dom: number, relative: boolean): void {
    if (!this.scaled) {
      this.expected = Number.NaN;
      this.dom = dom;
      this.virtual = clamp(dom, 0, this.virtualMax);
      return;
    }
    if (!Number.isNaN(this.expected)) {
      const ours = Math.abs(dom - this.expected) < 1.5;
      this.expected = Number.NaN;
      if (ours) {
        // Our own thumb re-sync: the content stays where it is.
        this.dom = dom;
        return;
      }
    }
    const delta = dom - this.dom;
    this.dom = dom;
    this.virtual = relative
      ? clamp(this.virtual + delta, 0, this.virtualMax)
      : domToVirtual(dom, this.content, this.viewport, this.max);
  }

  /** True when the DOM is at an edge but the content is not, so relative input can go no further. */
  get stuck(): boolean {
    if (!this.scaled) return false;
    return (this.dom <= 0 && this.virtual > 0) || (this.dom >= this.domMax - 0.5 && this.virtual < this.virtualMax);
  }

  /** The DOM position matching the current virtual offset, or null if the thumb is already there. */
  thumbTarget(): number | null {
    if (!this.scaled) return null;
    const target = virtualToDom(this.virtual, this.content, this.viewport, this.max);
    return Math.abs(target - this.dom) >= 1 ? target : null;
  }

  /** Call before writing `dom` to the scroller so the resulting scroll event leaves the content alone. */
  expect(dom: number): void {
    if (this.scaled) this.expected = dom;
  }

  /**
   * Moves the virtual offset without the user scrolling, e.g. to keep content in place when
   * row heights above it change. Returns the DOM position to write, or null when the axis is
   * scaled: then the thumb is left alone and re-synced later, so relative input carries on.
   */
  adjust(virtual: number): number | null {
    this.virtual = clamp(virtual, 0, this.virtualMax);
    if (!this.scaled) return this.virtual;
    return null;
  }

  /** Jumps to a virtual offset. Returns the DOM position to write. */
  scrollTo(virtual: number): number {
    this.virtual = clamp(virtual, 0, this.virtualMax);
    if (!this.scaled) return this.virtual;
    const dom = virtualToDom(this.virtual, this.content, this.viewport, this.max);
    this.expected = dom;
    return dom;
  }
}
