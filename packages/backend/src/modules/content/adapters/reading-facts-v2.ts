import {
  CALL_READ_INTERACTIONS,
  stopWords,
  WORDS_PER_MINUTE_V2,
  type ScrollDocumentV2,
  type Stop,
} from '@knowscroll/scroll-model';
import { READING_FACTS_V3_VERSION, type ReadingFacts } from '../domain/reading-facts.js';

/**
 * A stop counts as read once it was visible for this share of the time its words take at the v2
 * measures (230 words a minute). Skimming at up to two and a half times the pace still reads it;
 * tapping through the spine does not (D-128). The unit is the stop's own words, so a long stop asks
 * for more than a one-line stop.
 */
export const STOP_READ_SHARE = 0.4;

/** No stop counts as read in less than this: the qualification policy's own visibility floor. */
export const MIN_STOP_VISIBLE_MS = 500;

/** The unit kinds of reading facts v3: what the recorder's block ids and the coverage rule name. */
export const READING_UNIT_TYPES = ['stop', 'call_it', 'final_call'] as const;

const unitType = (stop: Stop): (typeof READING_UNIT_TYPES)[number] => (stop.kind === 'read' ? 'stop' : stop.kind);

/** Visible time a stop needs to count as read. Pure. */
export function minVisibleMsOf(stop: Stop): number {
  const nominalMs = (stopWords(stop) * 60_000) / WORDS_PER_MINUTE_V2;
  return Math.max(MIN_STOP_VISIBLE_MS, Math.round(nominalMs * STOP_READ_SHARE));
}

/**
 * The reading facts of a stored `scroll-document.v2` (facts v3). Coverage comes from reading: only a
 * read stop weighs, with the weight the document's code-set measures give it (an aside weighs with the
 * stop it opens beside), and it counts when it was visible long enough for its words.
 *
 * A call is a unit so that locking it in or seeing its reveal is accepted and stored as engagement,
 * but it weighs nothing: playing never stands in for reading, and not playing never blocks it
 * (D-063, D-128). The option picked is not an interaction at all. A call still takes its ten seconds in
 * the reading estimate, so honest play does not look like under-reading. The recap is the payoff
 * screen, not a unit.
 */
export function readingFactsOfV2(document: ScrollDocumentV2): ReadingFacts {
  const weights = new Map(document.measures.stops.map((entry) => [entry.stopId, entry.weight]));
  const blocks = document.stops.map((stop) => ({
    id: stop.id,
    weight: stop.kind === 'read' ? (weights.get(stop.id) ?? 0) : 0,
    type: unitType(stop),
    seen:
      stop.kind === 'read'
        ? { kind: 'visible' as const, minVisibleMs: minVisibleMsOf(stop) }
        : { kind: 'interaction' as const, interactions: [...CALL_READ_INTERACTIONS] },
  }));
  return {
    v: READING_FACTS_V3_VERSION,
    measuresVersion: document.measures.version,
    totalWeight: blocks.reduce((total, block) => total + block.weight, 0),
    estimatedReadingMs: document.measures.readingSeconds * 1000,
    blocks,
    nested: [],
  };
}
