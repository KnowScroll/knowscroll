/**
 * The two judgements code makes about a message before a resident may think about it (D-081): is it a question, and
 * is it a claim stated more strongly than it can be? Both are lexical pre-filters, deliberately blunt. They only
 * decide whether a resident is *asked* to consider the message; the resident's own `nothing_to_add` is the real
 * judgement, and the caps decide whether it may speak at all. No model, no state.
 */

/** What set a resident going. `asked` is a member's ask and is not decided here. */
export type SpeechTrigger = 'unanswered_question' | 'overstated_claim' | 'answer_overstated';

/**
 * Why a message exists when nobody asked for it: a reply the router allowed, a find the residents' heartbeat posted (v3 R-8), or a
 * find a member's scout posted (v3 R-9).
 */
export type MessageTrigger = SpeechTrigger | 'feed_find' | 'scout_find';

const wordCount = (text: string): number => text.split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;

const INTERROGATIVE =
  /^(?:who|whom|whose|what|when|where|which|why|how|is|are|was|were|do|does|did|can|could|would|should|will|has|have|had|isn't|aren't|doesn't|don't|didn't|can't|won't)\b/iu;

/**
 * Whether a message reads as a question to the room: it ends in a question mark (three words or more), or opens
 * with an interrogative word and runs to five words or more. A link or a pasted line of code is not a question.
 */
export function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (/^https?:\/\//iu.test(trimmed)) return false;
  const words = wordCount(trimmed);
  if (/\?["'”’)\]]*$/u.test(trimmed)) return words >= 3;
  return INTERROGATIVE.test(trimmed) && words >= 5;
}

/** Words that state a claim as settled. A match asks the Skeptic to look; it is not a finding that the claim is wrong. */
const STRONG_CLAIM =
  /\b(?:proven|proved|prove[sd]? (?:it|that|this)|proof that|always|never|everyone knows|everybody knows|nobody|no one|obviously|clearly|definitely|certainly|undeniabl[ey]|without (?:a )?doubt|guaranteed|impossible|the only reason|for sure|it'?s a fact|scientists (?:agree|all|know)|all experts|case closed|settled)\b|\b100 ?%/iu;

/**
 * Whether a message states something as settled: not a question, five words or more, and with a strong-claim
 * word. "So we've proven it" qualifies; "I think it might" does not.
 */
export function looksOverstated(text: string): boolean {
  const trimmed = text.trim();
  return !looksLikeQuestion(trimmed) && wordCount(trimmed) >= 4 && STRONG_CLAIM.test(trimmed);
}

/** The trigger a person's message sets off, if any. A question comes first: a message is never both. */
export function triggerOfPersonMessage(text: string): 'unanswered_question' | 'overstated_claim' | undefined {
  if (looksLikeQuestion(text)) return 'unanswered_question';
  return looksOverstated(text) ? 'overstated_claim' : undefined;
}
