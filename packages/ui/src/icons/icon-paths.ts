/**
 * The export's 24 × 24 line icons, copied path for path from the v2.1 sources (stroke
 * `currentColor`, round caps and joins). `filled` shapes are painted instead of stroked. The
 * `person` glyph is not drawn in the export; it is composed from the Members icon's geometry for
 * the signed-out account button.
 */
export type IconShape =
  | { readonly kind: 'path'; readonly d: string; readonly filled?: boolean }
  | { readonly kind: 'circle'; readonly cx: number; readonly cy: number; readonly r: number; readonly filled?: boolean }
  | {
      readonly kind: 'rect';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly rx: number;
    }
  | {
      readonly kind: 'ellipse';
      readonly cx: number;
      readonly cy: number;
      readonly rx: number;
      readonly ry: number;
      readonly rotate: number;
    }
  | { readonly kind: 'polygon'; readonly points: string; readonly filled?: boolean };

const path = (d: string, filled = false): IconShape => ({ kind: 'path', d, filled });
const circle = (cx: number, cy: number, r: number, filled = false): IconShape => ({
  kind: 'circle',
  cx,
  cy,
  r,
  filled,
});

export const iconShapes = {
  // Navigation destinations.
  explore: [{ kind: 'rect', x: 3, y: 7, width: 18, height: 13, rx: 3 }, path('M8 3l4 4 4-4')],
  universe: [circle(12, 12, 3.5), { kind: 'ellipse', cx: 12, cy: 12, rx: 10, ry: 4.5, rotate: -20 }],
  talk: [path('M4 5h16v11H9l-5 4z')],
  keep: [path('M6 3h12v18l-6-4-6 4z')],
  // Direction.
  back: [path('M15 5l-7 7 7 7')],
  forward: [path('M9 5l7 7-7 7')],
  chevronUp: [path('M6 15l6-6 6 6')],
  chevronDown: [path('M6 9l6 6 6-6')],
  arrowRight: [path('M5 12h14'), path('M13 6l6 6-6 6')],
  arrowLeft: [path('M19 12H5'), path('M11 6l-6 6 6 6')],
  arrowUp: [path('M12 19V5'), path('M6 11l6-6 6 6')],
  arrowDown: [path('M12 5v14'), path('M6 13l6 6 6-6')],
  close: [path('M6 6l12 12M18 6L6 18')],
  menu: [path('M4 7h16M4 12h16M4 17h16')],
  // Encounter actions (same order everywhere: Like · Save · Share · Ask, then More).
  like: [path('M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z')],
  save: [path('M6 3h12v18l-6-4-6 4z')],
  share: [path('M4 12v7h16v-7'), path('M12 3v12'), path('M7 8l5-5 5 5')],
  ask: [path('M4 5h16v11H9l-5 4z'), path('M10 9.2a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9'), path('M12 13.6v.1')],
  more: [circle(5, 12, 2, true), circle(12, 12, 2, true), circle(19, 12, 2, true)],
  send: [path('M4 12l16-8-6 16-3-7z')],
  shareMoment: [path('M4 12h16'), path('M8 7v10M16 7v10')],
  fullScreen: [path('M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5')],
  // Media.
  play: [path('M7 4l13 8-13 8z', true)],
  pause: [path('M8 5v14M16 5v14')],
  reel: [path('M7 4l13 8-13 8z', true)],
  scroll: [path('M5 6h14M5 12h14M5 18h9')],
  // Status.
  check: [path('M5 12.5l4.5 4.5L19 7')],
  spinner: [path('M12 3a9 9 0 0 1 9 9')],
  retry: [path('M20 12a8 8 0 1 1-2.3-5.7'), path('M20 4v5h-5')],
  clock: [circle(12, 12, 9), path('M12 7v5l3 2')],
  offline: [path('M3 3l18 18'), path('M7 18H6a4 4 0 0 1-.6-8'), path('M10.5 6.2A6 6 0 0 1 18 10a4 4 0 0 1 2 7')],
  alert: [circle(12, 12, 9), path('M12 7v6M12 16.5v.1')],
  info: [circle(12, 12, 9), path('M12 8v5M12 16v.1')],
  // Semantics.
  hypothetical: [path('M6 3v18'), path('M6 14c0-5 12-3 12-9')],
  corrected: [path('M4 20h4L19 9l-4-4L4 16z')],
  lock: [{ kind: 'rect', x: 5, y: 11, width: 14, height: 10, rx: 2 }, path('M8 11V8a4 4 0 0 1 8 0v3')],
  shield: [path('M12 3l8 3v6c0 4.5-3.5 8-8 9-4.5-1-8-4.5-8-9V6z')],
  plus: [path('M12 5v14M5 12h14')],
  minus: [path('M5 12h14')],
  search: [circle(11, 11, 7), path('M20 20l-4-4')],
  link: [
    path('M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1'),
    path('M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'),
  ],
  list: [path('M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01')],
  person: [circle(12, 8, 3.5), path('M5 20c.9-3.5 3.6-5.5 7-5.5s6.1 2 7 5.5')],
} as const satisfies Record<string, readonly IconShape[]>;

export type IconName = keyof typeof iconShapes;

/** Icons that switch to a filled glyph when their control is pressed (Like, Save). */
export const fillWhenPressed: ReadonlySet<IconName> = new Set<IconName>(['like', 'save']);
