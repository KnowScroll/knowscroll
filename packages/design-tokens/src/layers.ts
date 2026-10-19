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

export const highlightRing = { width: 3, color: '#FFE44D' } as const;
