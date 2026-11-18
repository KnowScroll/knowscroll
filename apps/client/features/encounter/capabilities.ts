import { OFFER_COVER_SCHEMA } from '@knowscroll/contracts';
import { capabilitiesFor, EVERY_READER } from '../scroll/scroll-readers';

const SCROLLS = capabilitiesFor(EVERY_READER);

/**
 * Formats this encounter controller can actually render: v1 and v2 Scrolls, and its Reel media player. It also draws a
 * Scroll offer as a cover (`offer-cover.v1`), so the server sends each Scroll offer's cover with it.
 */
export const ENCOUNTER_CAPABILITIES = {
  ...SCROLLS,
  documentSchemas: [...SCROLLS.documentSchemas, 'reel-document.v1', OFFER_COVER_SCHEMA],
};
