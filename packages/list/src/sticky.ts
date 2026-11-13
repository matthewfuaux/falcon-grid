import { rowY, type GridPluginFactory, type GridPluginHost } from '@falcon-grid/core';

/**
 * Where the sticky header is: its row and its screen top (pushed up when the next group's
 * header arrives), or null when the current group's header is on screen in its own place.
 */
export function stickyHeaderAt(host: GridPluginHost, groupOf: (row: number) => number): { row: number; top: number; bottom: number } | null {
  const { vp, rows } = host.viewport();
  if (rows.count === 0 || vp.height <= vp.bodyTop) return null;
  const first = Math.max(vp.frozenRows, rows.rowAt(vp.scrollTop + vp.frozenHeight));
  if (first >= rows.count) return null;
  const g = groupOf(first);
  if (!(g >= vp.frozenRows && g < rows.count && g <= first)) return null;
  if (rowY(g, rows, vp) >= vp.bodyTop) return null;
  const h = rows.heightOf(g);
  let top = vp.bodyTop;
  // The next group's header pushes this one up as it arrives.
  for (let r = first + 1; r < rows.count; r++) {
    const y = rowY(r, rows, vp);
    if (y >= vp.bodyTop + h) break;
    if (groupOf(r) === r) {
      top = Math.min(top, y - h);
      break;
    }
  }
  return top + h > vp.bodyTop ? { row: g, top, bottom: top + h } : null;
}

/**
 * Sticky group headers: the header of the group at the top of the view stays pinned there,
 * drawn over the rows scrolling under it, until the next group's header pushes it out.
 *
 * `groupOf(row)` returns the row index of the header of the group `row` belongs to (a header
 * returns itself), or -1 for rows outside any group. It is called for the top row and the few
 * rows below it each frame, so keep it cheap: a lookup, not a scan.
 */
export function stickyGroups(groupOf: (row: number) => number): GridPluginFactory {
  return (host) => ({
    paintOverlay(ctx) {
      const at = stickyHeaderAt(host, groupOf);
      if (!at) return;
      const { vp } = host.viewport();
      host.paintRow(ctx, at.row, at.top, vp.bodyTop);
      // A divider under it, so it reads as floating over the rows.
      const dpr = ctx.getTransform().a || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = host.theme().frozenDivider;
      const y = Math.round(at.bottom * dpr) - 1;
      if (y / dpr > vp.bodyTop) ctx.fillRect(0, y / dpr, vp.width, 1 / dpr);
    },
    hitTest(_x, y, hit) {
      if (hit.region !== 'cell') return;
      const at = stickyHeaderAt(host, groupOf);
      if (!at || y < host.viewport().vp.bodyTop || y >= at.bottom) return;
      hit.row = at.row;
      hit.y0 = at.top;
      hit.y1 = at.bottom;
    },
  });
}
