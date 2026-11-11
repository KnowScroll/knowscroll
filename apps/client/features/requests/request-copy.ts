import type { ContentRequestStatus } from '@knowscroll/contracts';

export type UnavailableReason = Extract<ContentRequestStatus, { status: 'unavailable' }>['reason'];

/**
 * What a closed request says, in the words of E04 and E07: honest, short, and nothing about prompts,
 * models, budgets or machinery. Every one says the request is closed, so nothing is left waiting.
 */
export const unavailableCopy: Record<UnavailableReason, string> = {
  unsupported_request:
    "We can't make that one right now. KnowScroll explains ideas, and this isn't one it covers yet. Your request is closed, so nothing is waiting.",
  no_compatible_supply: "There isn't a compatible explanation available for this request. Your request is closed.",
  not_permitted: "This explanation can't be prepared for you right now. Your request is closed.",
  budget_unavailable: "We can't prepare new explanations right now. Your request is closed, so nothing is waiting.",
  could_not_prepare:
    "We couldn't prepare this one. Your request is closed, so nothing is waiting. Ask a little differently, or try another subject.",
  source_unavailable: 'The original encounter is no longer available for this request.',
  no_production_path:
    "We can't make a new Reel, or another format of an explanation, on request yet. Your request is closed, so nothing is waiting.",
  no_recipe_left:
    "We don't have an explanation of this ready yet, and can't prepare one on request right now. Your request is closed, so nothing is waiting.",
};

const CLOSED = 'Your request is closed, so nothing is waiting.';

const utcDay = (when: Date | string): string => new Date(when).toISOString().slice(0, 10);

/**
 * The words for a closed request. A question refused by a daily limit says which one (D-387): the person's own, the
 * day's shared one (nothing about anyone else), or ask orders being off. "Today", "tomorrow" and "right now" are true only
 * on the UTC day the request closed (`updatedAt`); on any later day, such as in the requests list, the same cause is told
 * without a time. Every other closing keeps its general words. `now` is a parameter so tests need no clock.
 */
export function unavailableMessage(
  status: Extract<ContentRequestStatus, { status: 'unavailable' }>,
  now: Date = new Date(),
): string {
  const { limit } = status;
  if (status.reason !== 'budget_unavailable' || limit === undefined) return unavailableCopy[status.reason];
  const sameDay = utcDay(status.updatedAt) === utcDay(now);
  const some = (count: number) => `${count} new ${count === 1 ? 'explanation' : 'explanations'}`;
  switch (limit.kind) {
    case 'person':
      return sameDay
        ? `You've asked for ${some(limit.perDay)} today, the most for one day. You can ask again tomorrow. ${CLOSED}`
        : `This was closed because you had asked for ${some(limit.perDay)} that day, the most for one day. ${CLOSED}`;
    case 'world':
      return sameDay
        ? `New explanations are full for today. You can ask again tomorrow. ${CLOSED}`
        : `This was closed because new explanations were full that day. ${CLOSED}`;
    case 'off':
      return sameDay
        ? `New explanations are switched off right now. ${CLOSED}`
        : `This was closed because new explanations were switched off. ${CLOSED}`;
  }
}

export const formatWord = { reel: 'Reel', scroll: 'Scroll', either: 'Reel or Scroll' } as const;
