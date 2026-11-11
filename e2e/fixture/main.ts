import { createDataset } from '@falcon-grid/datagen';
import { createGrid, type ColumnDef, type FrameInfo } from '@falcon-grid/core';
import { createPretextWrapper } from '@falcon-grid/text';

const q = new URLSearchParams(location.search);
const data = createDataset(Number(q.get('rows') ?? 100_000), Number(q.get('cols') ?? 40));
const wrap = q.has('wrap');
// In wrap mode, medium and long text columns wrap and rows grow to fit.
const columns: ColumnDef[] = data.columns.map((c) =>
  wrap && (c.kind === 'medium' || c.kind === 'long') ? { ...c, wrap: true } : c,
);
const paintLog: (Pick<FrameInfo, 'paint' | 'blitX' | 'blitY' | 'flags' | 'rowsMeasured'> & { cells: number })[] = [];

const grid = createGrid(document.getElementById('root')!, {
  columns,
  rowCount: data.rowCount,
  getCell: (r, c) => data.get(r, c),
  frozenColumns: Number(q.get('frozenColumns') ?? 0),
  frozenRows: Number(q.get('frozenRows') ?? 0),
  rowSizing: wrap ? 'auto' : 'fixed',
  ...(wrap ? { textWrapper: createPretextWrapper() } : {}),
  theme: q.has('zebra') ? { rowAltBackground: '#f3f5f8', rowHeight: 27 } : {},
  onFrame: (f) =>
    paintLog.push({ paint: f.paint, blitX: f.blitX, blitY: f.blitY, flags: f.flags, cells: f.cellsPainted, rowsMeasured: f.rowsMeasured }),
});

/**
 * Diffs two PNG screenshots (as data URLs) on a scratch canvas. The grid's own canvas is never
 * read back: Chrome moves canvases that are read from to the CPU, which changes how text is
 * rasterised and would make the comparison meaningless on GPU.
 */
async function diffImages(a: string, b: string) {
  const load = async (src: string) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    return { w: img.width, data: ctx.getImageData(0, 0, img.width, img.height).data };
  };
  const [x, y] = await Promise.all([load(a), load(b)]);
  let diff = 0;
  let first: [number, number] | null = null;
  let colors = '';
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < x.data.length; i += 4) {
    if (x.data[i] !== y.data[i] || x.data[i + 1] !== y.data[i + 1] || x.data[i + 2] !== y.data[i + 2]) {
      diff++;
      const px = (i / 4) % x.w;
      const py = Math.floor(i / 4 / x.w);
      if (!first) {
        first = [px, py];
        colors = `${x.data.slice(i, i + 3).join(',')} vs full ${y.data.slice(i, i + 3).join(',')}`;
      }
      box[0] = Math.min(box[0]!, px);
      box[1] = Math.min(box[1]!, py);
      box[2] = Math.max(box[2]!, px);
      box[3] = Math.max(box[3]!, py);
    }
  }
  return { diff, first, colors, box, total: x.data.length / 4 };
}

function fullRepaint() {
  grid.invalidate();
  grid.flush();
}

Object.assign(window, { grid, data, columns, paintLog, diffImages, fullRepaint, ready: true });
