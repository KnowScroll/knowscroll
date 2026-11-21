import type { OfferCover } from '@knowscroll/contracts';
import { pictureFigureOf, type Figure } from '@knowscroll/ui';
import type { CoveredOffer } from '../encounter/encounter-session';

/**
 * The figure a cover shows, drawn on this device: a v2 Scroll's first stage frame (it has a `kit`) by the kits, a document
 * v3 Scroll's first picture (`offer-cover.v2`) by the general renderer, and nothing for a cover that carries none. The key
 * names what the cover is for, so turning to the next cover never glides one Scroll's picture into another's.
 */
export function figureOfCover(cover: Pick<OfferCover, 'figure'>, key: string): Figure | undefined {
  const frame = cover.figure;
  if (frame === undefined) return undefined;
  return 'kit' in frame
    ? { kind: 'state', kit: frame.kit, state: frame.state, alt: frame.alt, key }
    : { ...pictureFigureOf(frame.picture, frame.state), key };
}

/** The figure of an Explore offer's cover, keyed by the offer. */
export function coverFigureOf(offer: CoveredOffer): Figure | undefined {
  return figureOfCover(offer.cover, `cover-${offer.offerId}`);
}
