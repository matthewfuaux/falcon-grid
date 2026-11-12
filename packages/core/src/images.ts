interface Entry {
  image: CanvasImageSource | null;
  failed: boolean;
  /** Cells waiting for this image, as [row, col] pairs. */
  owners: number[];
}

/** Cells remembered per pending image; beyond this the load repaints everything. */
const MAX_OWNERS = 512;

/**
 * Images for display lists, loaded once per URL and decoded off the main thread with
 * `createImageBitmap` where available. Painting asks for an image; until it is ready the cell
 * paints without it and is remembered, and `onLoad` gets those cells to repaint.
 */
export class ImageCache {
  private readonly entries = new Map<string, Entry>();
  private destroyed = false;

  constructor(
    /** Cells to repaint as [row, col] pairs, or null to repaint everything. */
    private readonly onLoad: (cells: readonly number[] | null) => void,
    private readonly capacity = 1000,
  ) {}

  /** The image if loaded; otherwise starts loading it and returns null. */
  get(src: string): CanvasImageSource | null {
    const e = this.entries.get(src);
    if (e) return e.image;
    this.load(src);
    return null;
  }

  /** Records that a cell is waiting for `src`, so it repaints when the image arrives. */
  want(src: string, row: number, col: number): void {
    const e = this.entries.get(src);
    if (!e || e.image || e.failed) return;
    if (e.owners.length < MAX_OWNERS * 2) e.owners.push(row, col);
    else e.owners.length = MAX_OWNERS * 2 + 1; // overflowed: repaint everything on load
  }

  private load(src: string): void {
    if (this.entries.size >= this.capacity) {
      // Drop the oldest loaded entry; Map keeps insertion order.
      for (const [k, v] of this.entries) {
        if (v.image || v.failed) {
          this.entries.delete(k);
          break;
        }
      }
    }
    const e: Entry = { image: null, failed: false, owners: [] };
    this.entries.set(src, e);
    if (typeof Image === 'undefined') {
      e.failed = true;
      return;
    }
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    img
      .decode()
      .then((): Promise<CanvasImageSource> | CanvasImageSource =>
        typeof createImageBitmap === 'function' ? createImageBitmap(img) : img,
      )
      .then(
        (image) => {
          if (this.destroyed) return;
          e.image = image;
          this.done(e);
        },
        () => {
          e.failed = true;
          e.owners.length = 0;
        },
      );
  }

  private done(e: Entry): void {
    const owners = e.owners;
    e.owners = [];
    if (owners.length === 0) return;
    this.onLoad(owners.length > MAX_OWNERS * 2 ? null : owners);
  }

  destroy(): void {
    this.destroyed = true;
    this.entries.clear();
  }
}
