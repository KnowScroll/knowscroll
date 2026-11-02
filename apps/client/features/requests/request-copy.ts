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
};

const CLOSED = 'Your request is closed, so nothing is waiting.';

/**
 * The words for a closed request. A question refused by a daily limit says which one (D-387): the person's own, the
 * day's shared one (nothing about anyone else), or ask orders being off. Every other closing keeps its general words.
 */
export function unavailableMessage(status: Extract<ContentRequestStatus, { status: 'unavailable' }>): string {
  const { limit } = status;
  if (status.reason !== 'budget_unavailable' || limit === undefined) return unavailableCopy[status.reason];
  switch (limit.kind) {
    case 'person':
      return `You've asked for ${limit.perDay} new ${limit.perDay === 1 ? 'explanation' : 'explanations'} today, the most for one day. You can ask again tomorrow. ${CLOSED}`;
    case 'world':
      return `New explanations are full for today. You can ask again tomorrow. ${CLOSED}`;
    case 'off':
      return `New explanations are switched off right now. ${CLOSED}`;
  }
}

export const formatWord = { reel: 'Reel', scroll: 'Scroll', either: 'Reel or Scroll' } as const;
