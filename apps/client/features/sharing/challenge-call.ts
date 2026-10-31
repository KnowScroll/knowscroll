import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';

/** The question a challenge asks: the stop, what it asks and the words of its options, as the Scroll shows them. */
export interface ChallengeCall {
  readonly stopId: string;
  readonly prompt: string;
  readonly options: readonly string[];
  readonly kind: 'call_it' | 'final_call';
}

/**
 * The call of a Scroll a person challenges a friend with (V3 "Challenge a friend": send your Final call): the Final
 * call when the Scroll has one, else its first Call it. A Scroll with no call has nothing to challenge with. Only the
 * question and the options are read: the right answer is never sent anywhere from the device (D-245).
 */
export function challengeCallOf(document: Pick<ScrollDocumentV2, 'stops'>): ChallengeCall | undefined {
  const calls = document.stops.flatMap((stop) => (stop.kind === 'read' ? [] : [stop]));
  const chosen = calls.find((stop) => stop.kind === 'final_call') ?? calls[0];
  return chosen === undefined
    ? undefined
    : { stopId: chosen.id, prompt: chosen.prompt, options: chosen.options, kind: chosen.kind };
}
