import type { OfferCover } from '@knowscroll/contracts';
import { pictureFigureOf, type Figure } from '@knowscroll/ui';
import type { CoveredOffer } from '../encounter/encounter-session';

/**
 * The figure a cover shows, drawn on this device: a document v3 Scroll's first picture (`offer-cover.v2`) by the general
 * renderer, and nothing for a cover that carries none, or whose figure is a stage frame (it has a `kit`). No drawing kit
 * is left in this build (the last went with #835), so a stored stage frame, which an older server may still send, is
 * accepted and drawn as nothing: the cover still reads, as words. The key names what the cover is for, so turning to the
 * next cover never glides one Scroll's picture into another's.
 */
export function figureOfCover(cover: Pick<OfferCover, 'figure'>, key: string): Figure | undefined {
  const frame = cover.figure;
  if (frame === undefined) return undefined;
  return 'kit' in frame ? undefined : { ...pictureFigureOf(frame.picture, frame.state), key };
}

/** The figure of an Explore offer's cover, keyed by the offer. */
export function coverFigureOf(offer: CoveredOffer): Figure | undefined {
  return figureOfCover(offer.cover, `cover-${offer.offerId}`);
}
