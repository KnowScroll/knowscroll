import { OFFER_COVER_SCHEMA, OFFER_COVER_V2_SCHEMA } from '@knowscroll/contracts';
import { capabilitiesFor, EVERY_READER } from '../scroll/scroll-readers';

const SCROLLS = capabilitiesFor(EVERY_READER);

/**
 * Formats this encounter controller can actually render: v1, v2 and v3 Scrolls, and its Reel media player. It also draws
 * a Scroll offer as a cover, so the server sends each Scroll offer's cover with it: `offer-cover.v2` (whose figure may be
 * a document v3 picture) and `offer-cover.v1` (a stage frame), the newest the server can make for the Scroll winning.
 */
export const ENCOUNTER_CAPABILITIES = {
  ...SCROLLS,
  documentSchemas: [...SCROLLS.documentSchemas, 'reel-document.v1', OFFER_COVER_SCHEMA, OFFER_COVER_V2_SCHEMA],
};
