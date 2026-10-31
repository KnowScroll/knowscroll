import type { Aside, ScrollDocumentV2 } from '@knowscroll/scroll-model';

/** The longest piece of the selected words that is echoed back as the question of a Quick answer. */
const PASSAGE_LIMIT = 90;

/** What a Quick answer shows: the passage it is about, the Scroll's own plainer words for it, and what the Scroll says beside it. */
export interface QuickAnswer {
  readonly stopId: string;
  /** The reader's selected words, trimmed to a line. */
  readonly passage: string;
  /** The stop's own `simple` text, written and checked with the Scroll (D-085). */
  readonly body: string;
  /** The Scroll's definitions and tangents anchored to the stop, which say more about the same words. */
  readonly beside: readonly Pick<Aside, 'id' | 'title' | 'text'>[];
}

/** The selected words as one line of a sensible length; empty when nothing but space was selected. */
export function passageOf(selected: string): string {
  const line = selected.replace(/\s+/gu, ' ').trim();
  const letters = [...line];
  return letters.length <= PASSAGE_LIMIT ? line : `${letters.slice(0, PASSAGE_LIMIT - 1).join('')}…`;
}

/**
 * A Quick answer for words selected in one stop (D-244). It is made from the document alone, with no model and no
 * network: the stop's own plainer words and the asides anchored to it. Only a read stop has one. A call stop never does,
 * because its words could give away the answer before the person has locked it in; the limits aside is the Scroll's
 * "Small print" and is never offered as an answer. Nothing later in the Scroll is used, so a Quick answer cannot spoil
 * a call or the Final call.
 */
export function quickAnswerFor(
  document: Pick<ScrollDocumentV2, 'stops' | 'asides'>,
  stopId: string,
  selected: string,
): QuickAnswer | undefined {
  const stop = document.stops.find((candidate) => candidate.id === stopId);
  const passage = passageOf(selected);
  if (stop?.kind !== 'read' || passage === '') return undefined;
  const beside = document.asides
    .filter((aside) => aside.anchorStop === stopId && aside.kind !== 'limits')
    .map(({ id, title, text }) => ({ id, title, text }));
  return { stopId, passage, body: stop.simple, beside };
}
