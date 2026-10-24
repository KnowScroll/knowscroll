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

export const formatWord = { reel: 'Reel', scroll: 'Scroll', either: 'Reel or Scroll' } as const;
