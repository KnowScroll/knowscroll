import {
  OFFER_COVER_V2_SCHEMA,
  OfferCoverSchema,
  type OFFER_COVER_SCHEMA,
  type OfferCover,
} from '@knowscroll/contracts';
import { coverFrameOfV3, firstFrameOf, type ScrollDocumentV2, type ScrollDocumentV3 } from '@knowscroll/scroll-model';
import { isScrollDocumentV2, isScrollDocumentV3 } from './render-scroll.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The cover of a stored Scroll document of any version, under the cover version the session declared: its kicker and
 * reading minutes and, for an essay, the number of read stops (a v2's paragraphs, a v3's beats) and the first figure
 * when it has one. A v3's figure is a picture frame, which only `offer-cover.v2` can carry; a session that declared
 * only `offer-cover.v1` gets the count and no figure. Read structurally from the revision admission already
 * validated, then checked against the wire schema, so a stored shape this code does not expect gives no cover (the
 * client then opens the offer as it always did) instead of a reply the contract would refuse. Not a Scroll document:
 * no cover.
 */
export function coverOfDocument(
  document: unknown,
  version: typeof OFFER_COVER_SCHEMA | typeof OFFER_COVER_V2_SCHEMA,
): OfferCover | undefined {
  if (!isRecord(document) || typeof document['kicker'] !== 'string' || !isRecord(document['measures']))
    return undefined;
  const base = { version, kicker: document['kicker'], readingMinutes: document['measures']['readingMinutes'] };
  const candidate = isScrollDocumentV3(document)
    ? { ...base, ...beatFacts(document as unknown as ScrollDocumentV3, version) }
    : isScrollDocumentV2(document)
      ? { ...base, ...essayFacts(document as ScrollDocumentV2) }
      : base;
  const parsed = OfferCoverSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/** What only a v2 essay has: its paragraphs (read stops) and the picture its stage opens on. */
function essayFacts(document: ScrollDocumentV2): Record<string, unknown> {
  const readStops = Array.isArray(document.stops) ? document.stops.filter((stop) => stop.kind === 'read').length : 0;
  const figure = firstFrameOf(document);
  return { ...(readStops > 0 ? { readStops } : {}), ...(figure ? { figure } : {}) };
}

/** What a v3 essay has: its beats, and the picture its first beats show, for a session that can draw a picture. */
function beatFacts(
  document: ScrollDocumentV3,
  version: typeof OFFER_COVER_SCHEMA | typeof OFFER_COVER_V2_SCHEMA,
): Record<string, unknown> {
  if (!Array.isArray(document.sections) || !document.sections.every((section) => Array.isArray(section?.beats)))
    return {};
  const readStops = document.sections.reduce((total, section) => total + section.beats.length, 0);
  const figure =
    version === OFFER_COVER_V2_SCHEMA && Array.isArray(document.pictures) ? coverFrameOfV3(document) : undefined;
  return { ...(readStops > 0 ? { readStops } : {}), ...(figure ? { figure } : {}) };
}
