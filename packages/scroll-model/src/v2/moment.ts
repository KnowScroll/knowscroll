import { LIMITS } from '../limits.js';
import { quoteHash } from '../locators.js';
import type { ScrollDocumentV2 } from './document.js';

/**
 * A moment of a v2 Scroll (Share a moment, D-292): one read stop, the words of its blocks one to a line. A call stop is
 * not a moment, because sharing it would give its answer away; the way to share a call is a challenge.
 */
export interface Moment {
  readonly stopId: string;
  /** What the stop says, as the card quotes it. */
  readonly quote: string;
}

/** The moment a stop is, or nothing for a call, an unknown stop or a stop whose words run past one passage. */
export function momentOf(document: Pick<ScrollDocumentV2, 'stops'>, stopId: string): Moment | undefined {
  const stop = document.stops.find((candidate) => candidate.id === stopId);
  if (stop?.kind !== 'read') return undefined;
  const quote = stop.blocks.map((block) => block.text).join('\n');
  return quote.length >= 1 && quote.length <= LIMITS.passageChars ? { stopId, quote } : undefined;
}

/**
 * The passage anchor of a moment, in the shape v1 snippets already have: the stop's id as the block, the whole text as the
 * range and the hash of what the sender saw. It carries no words; the card's quote is read from the exact revision.
 */
export function momentAnchorOf(moment: Moment) {
  return {
    kind: 'scroll_passage' as const,
    blockId: moment.stopId,
    start: 0,
    end: moment.quote.length,
    quoteHash: quoteHash(moment.quote),
  };
}

/** Whether a passage anchor is exactly the moment of the stop it names. */
export function anchorIsMoment(
  moment: Moment,
  anchor: { readonly start: number; readonly end: number; readonly quoteHash: string },
): boolean {
  return anchor.start === 0 && anchor.end === moment.quote.length && anchor.quoteHash === quoteHash(moment.quote);
}
