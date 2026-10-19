/**
 * Identity's framework-free public surface: who may act on a personal universe, the capabilities
 * a protected transaction carries, and the read ports other code uses to resolve callers. The
 * lock protocol itself is implemented by `infrastructure/postgres` (`withPersonalScope`,
 * `enterSharedRoot`); the read ports are implemented by `adapters/` and bound by the apps'
 * composition roots through `adapters/nest-providers.ts`.
 */

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
declare const sharedScopeBrand: unique symbol;

/**
 * The capability of one open, locked personal transaction. Only `withPersonalScope` creates it,
 * and it stops working when that transaction ends. Personal-write ports require it. The brand is
 * a compile-time aid; the row lock and the runtime rechecks establish authority. Its `authority`
 * is a frozen copy: nothing can change which universe a scope writes to.
 */
export interface PersonalScopeTx {
  readonly [personalScopeBrand]: true;
  readonly authority: PersonalAuthority;
  /** The universe revision observed under the lock, before this transaction's changes. */
  readonly revisionAtEntry: number;
}

/**
 * The capability of one shared root (conversation, room, exploration) locked *after* the actor's
 * personal root, inside the same transaction (blueprint §19 lock order: personal root → this
 * universe's rows → at most one shared root → its subordinate rows). Only `enterSharedRoot` creates
 * it, at most once per personal scope.
 */
export interface SharedScopeTx {
  readonly [sharedScopeBrand]: true;
  readonly personal: PersonalScopeTx;
  readonly root: { readonly kind: string; readonly id: string };
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
 * first, then this universe's rows, then at most one shared root (`enterSharedRoot`); never
 * another person's root inside `work`.
 */
export type WithPersonalScope = <T>(
  authority: PersonalAuthority,
  work: (scope: PersonalScopeTx) => Promise<T>,
) => Promise<ScopeOutcome<T>>;

/** An account with its personal universe, as authentication resolves a caller. */
export interface AccountUniverse {
  readonly accountId: string;
  readonly accountStatus: string;
  readonly universeId: string;
  readonly universeStatus: string;
  readonly privacyEpoch: number;
}

/**
 * Port: read an account and its universe (no lock). The result is a claim that
 * `withPersonalScope` rechecks under the lock. `undefined` when either is missing.
 */
export type ReadAccountUniverse = (accountId: string) => Promise<AccountUniverse | undefined>;

/** Current access of an account to one of its universes, read without a lock. */
export interface UniverseAccess {
  readonly revision: number;
  readonly privacyEpoch: number;
  /** Universe and account both active. */
  readonly active: boolean;
}

/** Port: does `accountId` own `universeId`, and is it usable? `undefined` when not owned. */
export type ReadUniverseAccess = (accountId: string, universeId: string) => Promise<UniverseAccess | undefined>;

/** Injection tokens of identity's read ports (bound by the composition roots). */
export const READ_ACCOUNT_UNIVERSE = Symbol('identity.readAccountUniverse');
export const READ_UNIVERSE_ACCESS = Symbol('identity.readUniverseAccess');
