import type { OfferCover } from '@knowscroll/contracts';
import { isKitPictureId, pictureFigureOf, type Figure } from '@knowscroll/ui';
import type { CoveredOffer } from '../encounter/encounter-session';

/**
 * The figure a cover shows, drawn on this device: a v2 Scroll's first stage frame (it has a `kit`) by the kits, a document
 * v3 Scroll's first picture (`offer-cover.v2`) by the general renderer, and nothing for a cover that carries none, or
 * whose kit this build does not draw (a kit since removed; the cover still reads, as words). The key names what the cover
 * is for, so turning to the next cover never glides one Scroll's picture into another's.
 */
export function figureOfCover(cover: Pick<OfferCover, 'figure'>, key: string): Figure | undefined {
  const frame = cover.figure;
  if (frame === undefined) return undefined;
  if (!('kit' in frame)) return { ...pictureFigureOf(frame.picture, frame.state), key };
  return isKitPictureId(frame.kit)
    ? { kind: 'state', kit: frame.kit, state: frame.state, alt: frame.alt, key }
    : undefined;
}

/** The figure of an Explore offer's cover, keyed by the offer. */
export function coverFigureOf(offer: CoveredOffer): Figure | undefined {
  return figureOfCover(offer.cover, `cover-${offer.offerId}`);
}
