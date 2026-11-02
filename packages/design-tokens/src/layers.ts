/**
 * Stacking layers. The export has no z-index (stacking is by DOM order); these name the order it
 * implies, bottom to top. Banners are inline and need no layer.
 */
export const layer = {
  content: 0,
  mediaOverlay: 10,
  actionRail: 20,
  topBar: 30,
  navigation: 40,
  miniPlayer: 40,
  scrim: 50,
  sheet: 60,
  /** Reserved: the export draws no toast. */
  toast: 70,
} as const;

/**
 * Focus rings (D-006 n), chosen by the surface the ring is drawn on: cobalt on paper; yellow on
 * ink, space and cobalt media, where cobalt would vanish. Selection highlight is a different
 * thing and never stands in for focus.
 */
export const focusRing = {
  onLight: { width: 3, offset: 3, color: '#2C46E8' },
  onDark: { width: 3, offset: 3, color: '#FFE44D' },
} as const;

export type FocusTone = keyof typeof focusRing;

/**
 * Where cobalt alone cannot reach 3:1 (a dark or mid-tone ground such as a room's), the same ring is drawn between two bands of
 * a halo, `extra` px wide, that does: white on a dark ground, black on a mid one. On paper the halo is not drawn.
 */
export const focusHalo = { light: '#FFFFFF', dark: '#000000', extra: 2 } as const;
export type FocusHalo = 'light' | 'dark';

export const highlightRing = { width: 3, color: '#FFE44D' } as const;
