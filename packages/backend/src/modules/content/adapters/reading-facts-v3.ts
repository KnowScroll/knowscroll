import { beatsOfV3, beatWords, WORDS_PER_MINUTE_V3, type Beat, type ScrollDocumentV3 } from '@knowscroll/scroll-model';
import { READING_FACTS_V4_VERSION, type ReadingFacts } from '../domain/reading-facts.js';
import { MIN_STOP_VISIBLE_MS, STOP_READ_SHARE } from './reading-facts-v2.js';

/** The one unit kind of reading facts v4: what the recorder's block ids and the beat coverage rule name. */
export const BEAT_UNIT_TYPE = 'beat';

/**
 * Time a beat needs to count as read: the same bar as a v2 stop (D-128), 40 % of the time its own words take at 230
 * words a minute and never under half a second. Under the shared clock (#761) the bar applies to the beat's share of
 * the time it was on screen, not to the time itself.
 */
export function minVisibleMsOfBeat(beat: Pick<Beat, 'text'>): number {
  const nominalMs = (beatWords(beat) * 60_000) / WORDS_PER_MINUTE_V3;
  return Math.max(MIN_STOP_VISIBLE_MS, Math.round(nominalMs * STOP_READ_SHARE));
}

/**
 * The reading facts of a stored `scroll-document.v3` (facts v4). One unit per beat, in reading order, with the weight
 * the document's code-set measures give it (its words and the asides beside it) and the rule for when it counts. The
 * reading estimate is the measures' reading time, the seconds for figures and controls included. Sections and the
 * takeaway are not units: a section is a heading over beats, and the takeaway is the end plate.
 *
 * `readingFactsOfV2` is a separate function and stays unchanged: a coverage head pins the hash of the facts it was
 * decided for.
 */
export function readingFactsOfV3(document: ScrollDocumentV3): ReadingFacts {
  const weights = new Map(document.measures.beats.map((entry) => [entry.beatId, entry.weight]));
  const blocks = beatsOfV3(document).map((beat) => ({
    id: beat.id,
    weight: weights.get(beat.id) ?? 0,
    type: BEAT_UNIT_TYPE,
    seen: { kind: 'visible' as const, minVisibleMs: minVisibleMsOfBeat(beat) },
  }));
  return {
    v: READING_FACTS_V4_VERSION,
    measuresVersion: document.measures.version,
    totalWeight: blocks.reduce((total, block) => total + block.weight, 0),
    estimatedReadingMs: document.measures.readingSeconds * 1000,
    blocks,
    nested: [],
  };
}
