import { LIMITS } from '../limits.js';
import type { Moment } from '../v2/moment.js';
import { beatsOfV3, type ScrollDocumentV3 } from './document.js';

/**
 * A moment of a document v3 Scroll (Share a moment, D-292): one beat, its text as the card quotes it. Every beat is
 * shareable because a document v3 has no call whose answer a card could give away. The same shape as a v2 moment, with
 * the beat's id where a stop's would be, so the anchor and the card are built the same way.
 */
export function momentOfBeat(document: Pick<ScrollDocumentV3, 'sections'>, beatId: string): Moment | undefined {
  const beat = beatsOfV3(document).find((candidate) => candidate.id === beatId);
  if (beat === undefined) return undefined;
  return beat.text.length >= 1 && beat.text.length <= LIMITS.passageChars
    ? { stopId: beat.id, quote: beat.text }
    : undefined;
}
