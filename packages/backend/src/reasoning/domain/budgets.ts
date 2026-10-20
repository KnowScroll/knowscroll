/**
 * Budget arithmetic for external attempts (blueprint §15, §20): pure rules, no I/O.
 *
 * A reservation charges one request and `reservedTokens` tokens against three daily caps (UTC
 * day): the whole process (`global`), the role (`role`, across universes) and the personal scope
 * (`scope`, one universe). A reservation is admitted only when it fits all three. Settlement never
 * refunds an uncertain attempt: until a provider reports usage, the reservation is what it costs.
 */

/** Daily limits for one dimension. */
export interface BudgetCap {
  readonly requestsPerDay: number;
  readonly tokensPerDay: number;
}

/** The three caps a reservation must fit. */
export interface BudgetCaps {
  readonly global: BudgetCap;
  readonly role: BudgetCap;
  readonly scope: BudgetCap;
}

/** What has already been charged today in one dimension. */
export interface BudgetSpend {
  readonly requests: number;
  readonly tokens: number;
}

export interface BudgetUsage {
  readonly global: BudgetSpend;
  readonly role: BudgetSpend;
  readonly scope: BudgetSpend;
}

export type BudgetDimension = 'global' | 'role' | 'scope';

export type BudgetDecision =
  | { readonly kind: 'within' }
  | { readonly kind: 'exhausted'; readonly dimension: BudgetDimension; readonly limit: 'requests' | 'tokens' };

/** Dimensions in the order they are checked (and reported): widest first. */
const dimensions: readonly BudgetDimension[] = ['global', 'role', 'scope'];

/**
 * Whether one more request reserving `tokens` fits every cap. Purpose: admission refuses before
 * anything is reserved or sent. Inputs: caps, today's spend, the reservation's token charge.
 * Output: `within`, or the first exhausted dimension and which limit it hit. Invariant: a
 * reservation larger than a cap on its own is always refused.
 */
export function decideReservation(caps: BudgetCaps, usage: BudgetUsage, tokens: number): BudgetDecision {
  for (const dimension of dimensions) {
    const cap = caps[dimension];
    const spent = usage[dimension];
    if (spent.requests + 1 > cap.requestsPerDay) return { kind: 'exhausted', dimension, limit: 'requests' };
    if (spent.tokens + tokens > cap.tokensPerDay) return { kind: 'exhausted', dimension, limit: 'tokens' };
  }
  return { kind: 'within' };
}

/**
 * The token charge of a reservation: the request's size in bytes (an upper bound of its input
 * tokens for any byte-level tokenizer) plus the most the provider may produce. Conservative by
 * design; settlement replaces it with reported usage when the provider reports it.
 */
export function reservedTokensFor(requestBytes: number, maxOutputTokens: number): number {
  return requestBytes + maxOutputTokens;
}

/** Usage a provider reported for one attempt; `null` means not reported (never estimated). */
export interface ReportedUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly cachedTokens: number | null;
}

/** Usage with nothing reported. */
export const NO_USAGE: ReportedUsage = Object.freeze({
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  cachedTokens: null,
});

/**
 * What a reservation finally costs: nothing when it was never sent; the reported input + cached +
 * output tokens when both input and output were reported; otherwise the full reservation (unknown
 * usage stays charged at its upper bound). The same rule is applied in SQL by the ledger.
 */
export function chargedTokens(sent: boolean, reservedTokens: number, usage: ReportedUsage): number {
  if (!sent) return 0;
  if (usage.inputTokens === null || usage.outputTokens === null) return reservedTokens;
  return usage.inputTokens + usage.outputTokens + (usage.cachedTokens ?? 0);
}
