import type { ProposeInput, ProposeOutcome, ReasoningRun } from './propose.js';
import type { AttemptState } from '../domain/attempts.js';
import type { ReportedUsage } from '../domain/budgets.js';

/**
 * The world-local nonpersonal roots: Scroll supply, and the rooms scope (D-162) that pays for the residents
 * speaking on their own. Each is one row of `reasoning.production_scopes`.
 */
export type ProductionScopeId = 'scroll-supply' | 'rooms';

/** One world-local, nonpersonal root. Never a personal universe or account. */
export interface ProductionAuthority {
  readonly scopeId: ProductionScopeId;
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

/** Minimal accounting identity of one attempt; never request bytes, output, context or diagnostics. */
export interface ProductionAttemptAccounting {
  readonly attemptId: string;
  readonly step: string;
  readonly state: AttemptState;
  readonly provider: string;
  readonly model: string;
  readonly usage: ReportedUsage;
}

export type ProductionRunAccounting =
  | { readonly kind: 'accounted'; readonly attempts: readonly ProductionAttemptAccounting[] }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'refused'; readonly reason: 'generation_changed' | 'accounting_limit' };

/** Named read port, callable only with a live production capability at the run's current generation. */
export type ReadProductionRunAccounting = (scope: ProductionScopeTx, runId: string) => Promise<ProductionRunAccounting>;

/** Same execution engine and configured transport, with a separately enabled nonpersonal boundary. */
export interface ProductionReasoningHarness {
  /** At most 32 attempt identities and reported usage, under the current root; no private payload fields. */
  readonly readProductionRunAccounting: ReadProductionRunAccounting;
  proposeProduction<T>(input: ProductionProposeInput<T>, signal: AbortSignal): Promise<ProposeOutcome<T>>;
  /** Call within WithProductionScope in the transaction applying/rejecting the result. Rollback leaves it open. */
  closeProductionRun(
    scope: ProductionScopeTx,
    run: { readonly runId: string; readonly state: 'completed' | 'failed' | 'cancelled' },
  ): Promise<'closed' | 'not_open'>;
}
