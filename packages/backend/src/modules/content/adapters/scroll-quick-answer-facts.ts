import { beatsOfV3, SCROLL_DOCUMENT_V3_SCHEMA_VERSION } from '@knowscroll/scroll-model';
import type { ReadScrollQuickAnswerFacts } from '../public.js';
import { readStoredEssay } from './scroll-ask-facts.js';

/** More passages than this are not offered: the nearest ones before the reader's stop are the ones a question is about. */
const MAX_PASSAGES = 24;

/**
 * See `ReadScrollQuickAnswerFacts`. The reader's stop must be a read stop (for a document v3, any beat). The passages are
 * the words of the read stops (the beats) from the start of the Scroll up to and including that one, nothing after it: a
 * Quick answer cannot spoil a call or a later stop it never saw. Calls, their options and explanations, the stops' simpler
 * words, guide lines and play blocks are never offered. A revision the review gate holds, a v1 document or an anchor that
 * is not a read stop of it reads as absent.
 */
export const readScrollQuickAnswerFacts: ReadScrollQuickAnswerFacts = async (scope, ref, stopId) => {
  const document = await readStoredEssay(scope, ref);
  if (document === undefined) return undefined;
  if (document.schemaVersion === SCROLL_DOCUMENT_V3_SCHEMA_VERSION) {
    const beats = beatsOfV3(document);
    const anchorIndex = beats.findIndex((beat) => beat.id === stopId);
    const anchor = beats[anchorIndex];
    if (anchor === undefined) return undefined;
    return {
      title: document.title,
      passages: beats
        .slice(0, anchorIndex + 1)
        .map((beat) => ({ stopId: beat.id, text: beat.text }))
        .slice(-MAX_PASSAGES),
      anchorSimple: anchor.simple,
    };
  }
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
