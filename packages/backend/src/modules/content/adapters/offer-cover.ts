import { OFFER_COVER_SCHEMA, OfferCoverSchema, type OfferCover } from '@knowscroll/contracts';
import { firstFrameOf, type ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { isScrollDocumentV2 } from './render-scroll.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The cover of a stored Scroll document of either version: its kicker and reading minutes, and for a v2
 * essay the number of read stops and the first figure, when it has a stage. Read structurally from the
 * revision admission already validated, then checked against the wire schema, so a stored shape this code
 * does not expect gives no cover (the client then opens the offer as it always did) instead of a reply the
 * contract would refuse. Not a Scroll document: no cover.
 */
export function coverOfDocument(document: unknown): OfferCover | undefined {
  if (!isRecord(document) || typeof document['kicker'] !== 'string' || !isRecord(document['measures']))
    return undefined;
  const base = {
    version: OFFER_COVER_SCHEMA,
    kicker: document['kicker'],
    readingMinutes: document['measures']['readingMinutes'],
  };
  const candidate = isScrollDocumentV2(document) ? { ...base, ...essayFacts(document as ScrollDocumentV2) } : base;
  const parsed = OfferCoverSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/** What only a v2 essay has: its paragraphs (read stops) and the picture its stage opens on. */
function essayFacts(document: ScrollDocumentV2): Pick<OfferCover, 'readStops' | 'figure'> {
  const readStops = Array.isArray(document.stops) ? document.stops.filter((stop) => stop.kind === 'read').length : 0;
  const figure = firstFrameOf(document);
  return { ...(readStops > 0 ? { readStops } : {}), ...(figure ? { figure } : {}) };
}
