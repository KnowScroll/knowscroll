import type { Breakpoint } from '@knowscroll/design-tokens';

/** A tablet or a desktop: the essay is a centred column and a held figure sits beside its beats. */
export function isWide(breakpoint: Breakpoint): boolean {
  return breakpoint === 'tablet' || breakpoint === 'desktop';
}

/**
 * A figure's height: big enough to read a picture, small enough that a held figure leaves room to read under it (a
 * pinned figure plus about twelve lines of text on a phone, folio README 5.3). Beside the text on a wide screen it can
 * be taller.
 */
export function figureHeightFor(viewportHeight: number, wide: boolean): number {
  const share = wide ? 0.44 : 0.34;
  const [least, most] = wide ? [260, 380] : [190, 300];
  return Math.round(Math.min(most, Math.max(least, viewportHeight * share)));
}

/**
 * The band of the viewport where a beat counts as on screen, as insets from its top and bottom (D-135 measured a stop
 * that filled the screen; an essay shows several beats at once). The band starts under where a held figure pins, so a
 * beat hidden behind the figure is never counted, and stops short of the bottom, where a beat has only just appeared.
 * Fewer beats count at once than the whole viewport would allow; the server's rule for what was read is unchanged.
 */
export function readingBandOf(viewportHeight: number): { readonly top: number; readonly bottom: number } {
  return { top: Math.round(viewportHeight * 0.42), bottom: Math.round(viewportHeight * 0.12) };
}
