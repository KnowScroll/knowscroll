/**
 * Budget arithmetic for external attempts (blueprint §15, §20): pure rules, no I/O.
 *
 * A reservation charges one request and `reservedTokens` tokens against three daily caps (UTC
 * day): the whole process (`global`), the role (`role`, across universes) and the personal scope
 * (`scope`, one universe). A reservation is admitted only when it fits all three. Settlement never
 * refunds an uncertain attempt: until a provider reports usage, the reservation is what it costs.
 *
 * A role is `interactive` (a person asked for it: What-if, a room ask, request matching),
 * `background` (it runs because the person read or swiped: Jev, Cartographer, Planner) or `ambient`
 * (a room's resident speaks on its own, D-162). A background reservation must also fit a share of the
 * global and the scope caps, counted over background spend only. An ambient reservation must also
 * fit a share of the global cap, counted over ambient spend only; its own scope's cap bounds it as it
 * does any role. Background and ambient spend can therefore never exceed their shares, so the rest of
 * every cap is always left for what a person asked for.
 */

/** Who set a role's work going: a person's explicit ask, their reading, or a room's resident on its own. */
export type BudgetClass = 'interactive' | 'background' | 'ambient';

/** Daily limits for one dimension. */
export interface BudgetCap {
  readonly requestsPerDay: number;
  readonly tokensPerDay: number;
}

/** The ceilings a background reservation must also fit: its share of the global and the scope cap. */
export interface BackgroundCaps {
  readonly global: BudgetCap;
  readonly scope: BudgetCap;
}

/** The ceiling an ambient reservation must also fit: its share of the global cap. */
export interface AmbientCaps {
  readonly global: BudgetCap;
}

/** The caps a reservation must fit; `background` and `ambient` are present only for a role of that class. */
export interface BudgetCaps {
  readonly global: BudgetCap;
  readonly role: BudgetCap;
  readonly scope: BudgetCap;
  readonly background?: BackgroundCaps;
  readonly ambient?: AmbientCaps;
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
  /** Spend of background roles only, process-wide and in this scope. */
  readonly background: { readonly global: BudgetSpend; readonly scope: BudgetSpend };
  /** Spend of ambient roles only, process-wide. */
  readonly ambient: { readonly global: BudgetSpend };
}

/**
 * `background_global` and `background_scope` are the background share of `global` and `scope`;
 * `ambient_global` is the ambient share of `global`.
 */
export type BudgetDimension = 'global' | 'role' | 'scope' | 'background_global' | 'background_scope' | 'ambient_global';

export type BudgetDecision =
  | { readonly kind: 'within' }
  | { readonly kind: 'exhausted'; readonly dimension: BudgetDimension; readonly limit: 'requests' | 'tokens' };

/**
 * Whether one more request reserving `tokens` fits a cap, given what is already spent. The requests
 * limit is reported before the tokens limit.
 */
function limitHit(cap: BudgetCap, spent: BudgetSpend, tokens: number): 'requests' | 'tokens' | undefined {
  if (spent.requests + 1 > cap.requestsPerDay) return 'requests';
  if (spent.tokens + tokens > cap.tokensPerDay) return 'tokens';
  return undefined;
}

/**
 * Whether one more request reserving `tokens` fits every cap. Purpose: admission refuses before
 * anything is reserved or sent. Inputs: caps, today's spend, the reservation's token charge.
 * Output: `within`, or the first exhausted dimension and which limit it hit. The hard caps are
 * checked first, widest first (`global`, `role`, `scope`), then the background share of `global`
 * and of `scope` and the ambient share of `global` when the caps carry them, so a refusal keeps the
 * code it had before the split.
 * Invariant: a reservation larger than a cap on its own is always refused.
 */
export function decideReservation(caps: BudgetCaps, usage: BudgetUsage, tokens: number): BudgetDecision {
  const checks: readonly { dimension: BudgetDimension; cap: BudgetCap | undefined; spent: BudgetSpend }[] = [
    { dimension: 'global', cap: caps.global, spent: usage.global },
    { dimension: 'role', cap: caps.role, spent: usage.role },
    { dimension: 'scope', cap: caps.scope, spent: usage.scope },
    { dimension: 'background_global', cap: caps.background?.global, spent: usage.background.global },
    { dimension: 'background_scope', cap: caps.background?.scope, spent: usage.background.scope },
    { dimension: 'ambient_global', cap: caps.ambient?.global, spent: usage.ambient.global },
  ];
  for (const { dimension, cap, spent } of checks) {
    if (cap === undefined) continue;
    const limit = limitHit(cap, spent, tokens);
    if (limit !== undefined) return { kind: 'exhausted', dimension, limit };
  }
  return { kind: 'within' };
}

/**
 * The part of a daily cap that background or ambient roles may use: `sharePercent` of it, rounded
 * down. 100 leaves the cap whole (no share is kept back); 0 gives those roles nothing.
 */
export function shareOf(cap: BudgetCap, sharePercent: number): BudgetCap {
  return {
    requestsPerDay: Math.floor((cap.requestsPerDay * sharePercent) / 100),
    tokensPerDay: Math.floor((cap.tokensPerDay * sharePercent) / 100),
  };
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
