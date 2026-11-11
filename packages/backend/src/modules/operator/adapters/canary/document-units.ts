import type { ExposureDocumentResponse } from '@knowscroll/contracts';
import {
  FULL_V1_CAPABILITIES,
  SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
  stopWords,
  WORDS_PER_MINUTE,
  WORDS_PER_MINUTE_V2,
  type ClientCapabilities,
} from '@knowscroll/scroll-model';
import type { ReadingUnit } from '../../domain/canary/reading-plan.js';

/**
 * What the canary says it can render when it opens: every v1 block, `scroll-document.v2` and the Reel player,
 * as the app's own encounter controller declares (`ENCOUNTER_CAPABILITIES`).
 */
export const CANARY_CAPABILITIES: ClientCapabilities = {
  ...FULL_V1_CAPABILITIES,
  documentSchemas: [...FULL_V1_CAPABILITIES.documentSchemas, SCROLL_DOCUMENT_V2_SCHEMA_VERSION, 'reel-document.v1'],
};

/**
 * The reading units of the consumer document the exposure presented, with the time their words take at the
 * document's own measures: a v2 stop at 230 words a minute, a v1 block by its weight at 200. A call is a unit that
 * counts by interaction. The same document the reader would be shown, so no stored reading fact is needed.
 */
export function readingUnitsOf(document: ExposureDocumentResponse['document']): readonly ReadingUnit[] {
  if (document.schemaVersion === SCROLL_DOCUMENT_V2_SCHEMA_VERSION)
    return document.stops.map((stop) => ({
      id: stop.id,
      kind: stop.kind === 'read' ? ('read' as const) : ('call' as const),
      nominalMs: Math.round((stopWords(stop) * 60_000) / WORDS_PER_MINUTE_V2),
    }));
  return document.measures.blocks.map((block) => ({
    id: block.blockId,
    kind: 'read' as const,
    nominalMs: Math.round((block.weight * 60_000) / WORDS_PER_MINUTE),
  }));
}
