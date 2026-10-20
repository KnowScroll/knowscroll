import type { ProposeInput, ProposeOutcome, ReasoningRun } from './propose.js';

/** One world-local, nonpersonal supply root. Never a personal universe or account. */
export interface ProductionAuthority {
  readonly scopeId: 'scroll-supply';
  readonly generation: number;
}

declare const productionScopeBrand: unique symbol;

/** An open transaction holding the production root, with enabled/generation rechecked after waiting. */
export interface ProductionScopeTx {
  readonly [productionScopeBrand]: true;
  readonly authority: ProductionAuthority;
}

export type ProductionScopeOutcome<T> =
  | { readonly kind: 'entered'; readonly value: T }
  | { readonly kind: 'refused'; readonly refusal: { readonly kind: 'production_disabled' | 'generation_changed' } };

/** Shared-only protocol: production root -> production run/attempt/domain rows -> budget lock. No personal root. */
export type WithProductionScope = <T>(
  authority: ProductionAuthority,
  work: (scope: ProductionScopeTx) => Promise<T>,
) => Promise<ProductionScopeOutcome<T>>;

export type ProductionReasoningRun = ReasoningRun<ProductionAuthority>;
export type ProductionProposeInput<T> = ProposeInput<T, ProductionAuthority>;

/** Same execution engine and configured transport, with a separately enabled nonpersonal boundary. */
export interface ProductionReasoningHarness {
  proposeProduction<T>(input: ProductionProposeInput<T>, signal: AbortSignal): Promise<ProposeOutcome<T>>;
  /** Call within WithProductionScope in the transaction applying/rejecting the result. Rollback leaves it open. */
  closeProductionRun(
    scope: ProductionScopeTx,
    run: { readonly runId: string; readonly state: 'completed' | 'failed' | 'cancelled' },
  ): Promise<'closed' | 'not_open'>;
}
