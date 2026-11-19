import {
  beatsOfV3,
  momentOf,
  momentOfBeat,
  whyNoMoment,
  SCROLL_DOCUMENT_V3_SCHEMA_VERSION,
  type Moment,
  type NoMoment,
} from '@knowscroll/scroll-model';
import type { OpenedScrollFolio } from './scroll-session';

/**
 * The moment (Share a moment, D-292) a place of an opened Folio Scroll is: a v2 Scroll's read stop or a v3 Scroll's beat,
 * whose id is what the shared snippet's anchor names. `undefined` for a call, a place the Scroll does not have, or words
 * that run past one passage.
 */
export function momentOfPlace(scroll: OpenedScrollFolio, placeId: string): Moment | undefined {
  const { document } = scroll;
  return document.schemaVersion === SCROLL_DOCUMENT_V3_SCHEMA_VERSION
    ? momentOfBeat(document, placeId)
    : momentOf(document, placeId);
}

/**
 * Why the place on screen cannot be shared as a moment, or `undefined` when it can. A v3 Scroll has no call to give
 * away, so a beat is always a moment unless its words run past one passage.
 */
export function whyNoMomentAt(scroll: OpenedScrollFolio, placeId: string | undefined): NoMoment | undefined {
  const { document } = scroll;
  if (document.schemaVersion !== SCROLL_DOCUMENT_V3_SCHEMA_VERSION) return whyNoMoment(document, placeId);
  if (placeId === undefined || !beatsOfV3(document).some((beat) => beat.id === placeId)) return 'no_stop';
  return momentOfBeat(document, placeId) === undefined ? 'too_long' : undefined;
}
