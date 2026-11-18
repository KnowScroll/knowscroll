import type { Breakpoint } from '@knowscroll/design-tokens';

/** A tablet or a desktop: the essay is a centred column at the reading measure. */
export function isWide(breakpoint: Breakpoint): boolean {
  return breakpoint === 'tablet' || breakpoint === 'desktop';
}

/** The least width of the reader for a held figure to sit beside its beats rather than above them. */
const BESIDE_WIDTH = 900;

/**
 * Whether a held figure sits beside its beats: only where the reader itself is wide enough for a column of text and the
 * figure (a desktop next to a thread's side panel is not), whatever the screen's breakpoint.
 */
export function holdsBeside(readerWidth: number): boolean {
  return readerWidth >= BESIDE_WIDTH;
}

/**
 * A figure's height: big enough to read a picture, small enough that a held figure leaves room to read under it (a
 * pinned figure plus about twelve lines of text on a phone, folio README 5.3). Beside the text on a wide screen it can
 * be taller.
 */
export function figureHeightFor(viewportHeight: number, wide: boolean): number {
  const share = wide ? 0.44 : 0.34;
  const [least, most] = wide ? [260, 380] : [190, 300];
  const height = Math.min(most, Math.max(least, viewportHeight * share));
  // On a short screen (a phone held sideways) a figure never takes more than three quarters of it.
  return Math.round(viewportHeight > 0 ? Math.min(height, viewportHeight * 0.75) : height);
}

/**
 * Whether a hold can pin and still leave room to read (folio README 5.3): above the text on a phone a pinned figure
 * takes at most about half the screen; beside it on a wide screen, most of its height. Text at 150 % or more stacks
 * instead, as does a phone held sideways: each beat is then followed by its own figure.
 */
export function canPinHolds(viewportHeight: number, figureHeight: number, wide: boolean, textScale: number): boolean {
  if (textScale >= 1.5) return false;
  return figureHeight <= viewportHeight * (wide ? 0.8 : 0.45);
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
