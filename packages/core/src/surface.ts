/**
 * DOM structure:
 *
 *   scroller   overflow: auto; native scrolling and scrollbars
 *     sizer    sized to the (scaled) content, sets the scroll range
 *       stack  position: sticky at 0,0, sized to the viewport
 *         base canvas     cells, gridlines, headers, frozen panes (opaque)
 *         overlay canvas  selection, hover, focus (transparent)
 *         dom layer       editors, tooltips, accessibility mirror
 */
export interface Surface {
  readonly scroller: HTMLDivElement;
  readonly sizer: HTMLDivElement;
  readonly stack: HTMLDivElement;
  readonly baseCanvas: HTMLCanvasElement;
  readonly overlayCanvas: HTMLCanvasElement;
  readonly domLayer: HTMLDivElement;
  readonly base: CanvasRenderingContext2D;
  readonly overlay: CanvasRenderingContext2D;
  /** Backing store size in device pixels, as last observed. */
  backingWidth: number;
  backingHeight: number;
  setScrollSize(width: number, height: number): void;
  setViewportSize(width: number, height: number): void;
  /** Resizes both canvases' backing stores. Returns true if anything changed. */
  applyBackingSize(): boolean;
  destroy(): void;
}

export interface SurfaceCallbacks {
  onScroll(left: number, top: number): void;
  /** Wheel, keyboard or touch input that scrolls relative to the current position. */
  onRelativeInput(): void;
  onViewport(width: number, height: number): void;
  /** Backing store or device pixel ratio changed. */
  onPixels(pixelRatio: number): void;
}

const RELATIVE_INPUT = ['wheel', 'keydown', 'touchstart', 'touchmove'] as const;

const css = (el: HTMLElement, styles: Partial<CSSStyleDeclaration>) => Object.assign(el.style, styles);

export function createSurface(container: HTMLElement, cb: SurfaceCallbacks): Surface {
  const doc = container.ownerDocument;
  const win = doc.defaultView ?? window;

  const scroller = doc.createElement('div');
  const sizer = doc.createElement('div');
  const stack = doc.createElement('div');
  const baseCanvas = doc.createElement('canvas');
  const overlayCanvas = doc.createElement('canvas');
  const domLayer = doc.createElement('div');

  scroller.dataset.falconGrid = '';
  css(scroller, {
    position: 'relative',
    overflow: 'auto',
    width: '100%',
    height: '100%',
    contain: 'strict',
    overscrollBehavior: 'contain',
    // The grid keeps content still itself; the browser's anchoring would pick a mirror element
    // as its anchor and fight it.
    overflowAnchor: 'none',
  });
  css(sizer, { position: 'relative' });
  css(stack, { position: 'sticky', top: '0', left: '0', overflow: 'hidden' });
  const layer = { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', display: 'block' };
  css(baseCanvas, layer);
  css(overlayCanvas, { ...layer, pointerEvents: 'none' });
  css(domLayer, { ...layer, pointerEvents: 'none', overflow: 'hidden' });
  baseCanvas.setAttribute('aria-hidden', 'true');
  overlayCanvas.setAttribute('aria-hidden', 'true');

  stack.append(baseCanvas, overlayCanvas, domLayer);
  sizer.append(stack);
  scroller.append(sizer);
  container.append(scroller);

  // Opaque base canvas: cheaper compositing and subpixel text antialiasing.
  const base = baseCanvas.getContext('2d', { alpha: false });
  const overlay = overlayCanvas.getContext('2d');
  if (!base || !overlay) throw new Error('falcon-grid: Canvas 2D is not available');

  let pendingW = 0;
  let pendingH = 0;

  const surface: Surface = {
    scroller,
    sizer,
    stack,
    baseCanvas,
    overlayCanvas,
    domLayer,
    base,
    overlay,
    backingWidth: 0,
    backingHeight: 0,
    setScrollSize(width, height) {
      sizer.style.width = `${width}px`;
      sizer.style.height = `${height}px`;
    },
    setViewportSize(width, height) {
      stack.style.width = `${width}px`;
      stack.style.height = `${height}px`;
    },
    applyBackingSize() {
      if (baseCanvas.width === pendingW && baseCanvas.height === pendingH) return false;
      baseCanvas.width = overlayCanvas.width = pendingW;
      baseCanvas.height = overlayCanvas.height = pendingH;
      return true;
    },
    destroy() {
      ro.disconnect();
      dprQuery?.removeEventListener('change', onDprChange);
      scroller.removeEventListener('scroll', onScroll);
      for (const type of RELATIVE_INPUT) scroller.removeEventListener(type, cb.onRelativeInput);
      scroller.remove();
    },
  };

  const onScroll = () => cb.onScroll(scroller.scrollLeft, scroller.scrollTop);
  scroller.addEventListener('scroll', onScroll, { passive: true });
  for (const type of RELATIVE_INPUT) scroller.addEventListener(type, cb.onRelativeInput, { passive: true });

  const ro = new ResizeObserver((entries) => {
    let pixels = false;
    for (const entry of entries) {
      if (entry.target === scroller) {
        cb.onViewport(scroller.clientWidth, scroller.clientHeight);
      } else if (entry.target === baseCanvas) {
        const dpb = entry.devicePixelContentBoxSize?.[0];
        if (dpb) {
          pendingW = dpb.inlineSize;
          pendingH = dpb.blockSize;
        } else {
          const dpr = win.devicePixelRatio || 1;
          pendingW = Math.round(entry.contentRect.width * dpr);
          pendingH = Math.round(entry.contentRect.height * dpr);
        }
        surface.backingWidth = pendingW;
        surface.backingHeight = pendingH;
        pixels = true;
      }
    }
    if (pixels) cb.onPixels(win.devicePixelRatio || 1);
  });
  ro.observe(scroller);
  try {
    ro.observe(baseCanvas, { box: 'device-pixel-content-box' });
  } catch {
    // Safari: no device-pixel-content-box; fall back to contentRect * devicePixelRatio.
    ro.observe(baseCanvas);
  }

  // Repaint when the pixel ratio changes (zoom, moving between monitors).
  let dprQuery: MediaQueryList | null = null;
  const onDprChange = () => {
    watchDpr();
    cb.onPixels(win.devicePixelRatio || 1);
  };
  const watchDpr = () => {
    dprQuery?.removeEventListener('change', onDprChange);
    dprQuery = win.matchMedia?.(`(resolution: ${win.devicePixelRatio || 1}dppx)`) ?? null;
    dprQuery?.addEventListener('change', onDprChange);
  };
  watchDpr();

  return surface;
}
