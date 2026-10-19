/**
 * Spacing, layout measures, touch targets and breakpoints. Spacing is on a 4 px base
 * (Tokens.html: 4 · 8 · 12 · 16 · 20 · 24 · 32 · 48). The half steps 2/6/10/14 are the
 * component insets the shared library classes use (`.seg` gap 2, `.tag` gap 6, `.banner` gap 10,
 * panel and rail gaps 14); they are named so no component carries a raw number.
 */
export const spacing = {
  0: 0,
  '0.5': 2,
  1: 4,
  '1.5': 6,
  2: 8,
  '2.5': 10,
  3: 12,
  '3.5': 14,
  4: 16,
  5: 20,
  6: 24,
  7: 28,
  8: 32,
  9: 36,
  12: 48,
  14: 56,
  18: 72,
  24: 96,
} as const;

/** Touch targets: 48 logical px, never below 44 (D-006 n). */
export const target = { comfortable: 48, minimum: 44 } as const;

export const layout = {
  /** Phone side gutter. */
  gutter: 20,
  /** Floating top controls inset (left/right) on phones. */
  topControlsInset: 16,
  /** Reading measure: ≤ 34 em; 500 px on tablet, 680 px on desktop; interactive blocks 880. */
  measureTablet: 500,
  measureDesktop: 680,
  blockDesktop: 880,
  /** In-app horizontal swipes start this far from the screen edge (OS back edge, N01). */
  swipeEdgeInset: 24,
  /** Height of the phone tab-bar slot the floating pill sits in. */
  tabBarSlot: 96,
  /** Nav rail widths. */
  railTablet: 76,
  railDesktop: 88,
  /** Side panel ("This thread", outline) widths. */
  asideTablet: 212,
  asideDesktop: 368,
  /** Desktop entry card width (A01 on desktop). */
  entryCard: 480,
} as const;

export type Breakpoint = 'compact' | 'phone' | 'tablet' | 'desktop';

/** V01: ≤ 360 compact · 361–599 phone · 600–1023 tablet · ≥ 1024 desktop. */
export const breakpoints = { compactMax: 360, phoneMax: 599, tabletMax: 1023, desktopMin: 1024 } as const;

export function breakpointFor(width: number): Breakpoint {
  if (width <= breakpoints.compactMax) return 'compact';
  if (width <= breakpoints.phoneMax) return 'phone';
  if (width <= breakpoints.tabletMax) return 'tablet';
  return 'desktop';
}

/** Reference frames the export draws (logical px). */
export const frames = {
  compact: { width: 320, height: 690 },
  phone: { width: 390, height: 844 },
  tablet: { width: 834, height: 1112 },
  landscape: { width: 844, height: 390 },
  desktop: { width: 1440, height: 900 },
} as const;
