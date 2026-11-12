/**
 * Built-in icons on a 16-unit grid. Stroked icons use a 1.5px line at 16px; filled ones have no
 * `stroke`. Pass `{ path, box, stroke? }` to `icon()` for your own.
 */
export const icons = {
  more: { path: 'M4 8m-1.25 0a1.25 1.25 0 1 0 2.5 0a1.25 1.25 0 1 0-2.5 0M8 8m-1.25 0a1.25 1.25 0 1 0 2.5 0a1.25 1.25 0 1 0-2.5 0M12 8m-1.25 0a1.25 1.25 0 1 0 2.5 0a1.25 1.25 0 1 0-2.5 0', box: 16 },
  check: { path: 'M3.5 8.5l3 3 6-7', box: 16, stroke: 1.5 },
  x: { path: 'M4 4l8 8M12 4l-8 8', box: 16, stroke: 1.5 },
  plus: { path: 'M8 3v10M3 8h10', box: 16, stroke: 1.5 },
  minus: { path: 'M3 8h10', box: 16, stroke: 1.5 },
  'chevron-right': { path: 'M6 3.5l4.5 4.5-4.5 4.5', box: 16, stroke: 1.5 },
  'chevron-down': { path: 'M3.5 6l4.5 4.5 4.5-4.5', box: 16, stroke: 1.5 },
  external: { path: 'M9.5 2.5h4v4M13.5 2.5L7.5 8.5M11.5 9.5v3.5a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5h3.5', box: 16, stroke: 1.5 },
  edit: { path: 'M10.5 2.5l3 3-8 8H2.5v-3z', box: 16, stroke: 1.5 },
  trash: { path: 'M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4', box: 16, stroke: 1.5 },
  star: { path: 'M8 1.5l1.9 4.1 4.4.5-3.3 3 .9 4.4L8 11.3l-3.9 2.2.9-4.4-3.3-3 4.4-.5z', box: 16 },
  dot: { path: 'M8 8m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0', box: 16 },
  mail: { path: 'M2 3.5h12v9H2zM2 4l6 5 6-5', box: 16, stroke: 1.5 },
  link: { path: 'M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1', box: 16, stroke: 1.5 },
} as const satisfies Record<string, { path: string; box: number; stroke?: number }>;

export type IconName = keyof typeof icons;
