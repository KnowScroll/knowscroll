import type { ReadScrollQuickAnswerFacts } from '../public.js';
import { readStoredDocumentV2 } from './scroll-ask-facts.js';

/** More passages than this are not offered: the nearest ones before the reader's stop are the ones a question is about. */
const MAX_PASSAGES = 24;

/**
 * See `ReadScrollQuickAnswerFacts`. The reader's stop must be a read stop. The passages are the words of the read
 * stops from the start of the Scroll up to and including that stop, nothing after it: a Quick answer cannot spoil a call
 * or a later stop it never saw. Calls, their options and explanations, the stops' simpler words, guide lines and play
 * blocks are never offered. A revision the review gate holds, a v1 document or an anchor that is not a read stop of it
 * reads as absent.
 */
export const readScrollQuickAnswerFacts: ReadScrollQuickAnswerFacts = async (scope, ref, stopId) => {
  const document = await readStoredDocumentV2(scope, ref);
  if (document === undefined) return undefined;
  const anchorIndex = document.stops.findIndex((stop) => stop.id === stopId);
  const anchor = document.stops[anchorIndex];
  if (anchor?.kind !== 'read') return undefined;
  const passages = document.stops
    .slice(0, anchorIndex + 1)
    .flatMap((stop) =>
      stop.kind === 'read' ? [{ stopId: stop.id, text: stop.blocks.map((block) => block.text).join(' ') }] : [],
    )
    .slice(-MAX_PASSAGES);
  return { title: document.title, passages, anchorSimple: anchor.simple };
};
