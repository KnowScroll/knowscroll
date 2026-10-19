/**
 * Identity's framework-free public surface: who may act on a personal universe, and the
 * capability a protected personal transaction carries. Infrastructure (`withPersonalScope`)
 * implements the lock protocol; identity owns the meaning of the personal root.
 */
export { readAccountUniverse, type AccountUniverse } from './adapters/postgres-store.js';

/** Who is acting. Workers act as `system` on behalf of a universe; they never borrow a caller. */
export type Actor =
  { readonly kind: 'account'; readonly accountId: string } | { readonly kind: 'system'; readonly purpose: string };

/**
 * The authority a personal mutation claims. `withPersonalScope` rechecks every field against the
 * locked universe row after waiting for the lock; nothing here is trusted on its own.
 */
export interface PersonalAuthority {
  readonly universeId: string;
  readonly privacyEpoch: number;
  readonly actor: Actor;
}

declare const personalScopeBrand: unique symbol;

/**
 * The capability of one open, locked personal transaction. Only `withPersonalScope` creates it,
 * and it stops working when that transaction ends. Personal-write ports require it. The brand is
 * a compile-time aid; the row lock and the runtime rechecks establish authority.
 */
export interface PersonalScopeTx {
  readonly [personalScopeBrand]: true;
  readonly authority: PersonalAuthority;
  /** The universe revision observed under the lock, before this transaction's changes. */
  readonly revisionAtEntry: number;
}

/** Why a personal scope could not be entered. */
export type ScopeRefusal =
  | { readonly kind: 'universe_missing' }
  | { readonly kind: 'universe_suspended' }
  | { readonly kind: 'account_mismatch' }
  | { readonly kind: 'epoch_changed'; readonly currentEpoch: number };

export type ScopeOutcome<T> =
  { readonly kind: 'entered'; readonly value: T } | { readonly kind: 'refused'; readonly refusal: ScopeRefusal };

/**
 * Runs `work` inside one transaction holding the personal root lock (`FOR NO KEY UPDATE` on
 * `identity.universes`), after rechecking status, epoch and actor. Lock order: personal root
 * first, then this universe's rows; never another person's root inside `work`.
 */
export type WithPersonalScope = <T>(
  authority: PersonalAuthority,
  work: (scope: PersonalScopeTx) => Promise<T>,
) => Promise<ScopeOutcome<T>>;
