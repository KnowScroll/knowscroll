import { sql, type Kysely, type Transaction } from 'kysely';
import type {
  AuthorityHolds,
  PersonalAuthority,
  PersonalScopeTx,
  ResolvedScopeOutcome,
  RootResolution,
  RootResolutionTx,
  ScopeOutcome,
  ScopeRefusal,
  ScopeWork,
  SharedScopeTx,
  WithPersonalScope,
  WithResolvedPersonalScope,
} from '../../modules/identity/public.js';
import type { Database } from './database.js';
import { runMarkedTransaction } from './transaction-marker.js';

/** Raised when a `PersonalScopeTx` is used after its transaction ended. */
export class ScopeClosedError extends Error {
  override readonly name = 'ScopeClosedError';
  readonly code = 'SCOPE_CLOSED';
}

/** Raised when the personal root lock is not granted within the lock timeout (retryable). */
export class ScopeBusyError extends Error {
  override readonly name = 'ScopeBusyError';
  readonly code = 'SCOPE_BUSY';
}

const openScopes = new WeakMap<PersonalScopeTx, Transaction<Database>>();
const accountFences = new WeakMap<PersonalScopeTx, 'own' | 'pair'>();
const sharedRoots = new WeakMap<PersonalScopeTx, SharedScopeTx>();
const openSharedScopes = new WeakMap<SharedScopeTx, PersonalScopeTx>();

export interface PersonalScopeOptions {
  /** Longest wait for the personal root lock before `ScopeBusyError`. */
  readonly lockTimeoutMs: number;
}

/**
 * Creates `withPersonalScope` (blueprint §19) over one database.
 *
 * Purpose: the way to obtain a `PersonalScopeTx`, the capability personal-write ports need (the
 *   only other one is `makeWithResolvedPersonalScope`, for sign-in, which shares its lock and
 *   rechecks).
 * Inputs: the claimed `PersonalAuthority` and the work to run.
 * Steps: BEGIN; `SET LOCAL lock_timeout`; `SELECT … FROM identity.universes WHERE id = $1 FOR NO
 *   KEY UPDATE` (waits behind any other holder); then recheck existence, status, privacy epoch and,
 *   for an account actor, ownership and account status — all *after* the wait.
 * Outputs: `entered` with the work's value (committed), or `refused` with a typed reason (nothing
 *   written). An exception from `work` rolls everything back and propagates.
 * Failure/retry: lock wait beyond `lockTimeoutMs` → `ScopeBusyError` (retryable, nothing written).
 * Invariants: lock order is personal root first; nested guarded transactions are refused; the
 *   scope capability is unusable after the transaction ends; no network call may run inside
 *   (`assertOutsideTransaction`).
 */
export function makeWithPersonalScope(db: Kysely<Database>, options: PersonalScopeOptions): WithPersonalScope {
  return <T>(claimed: PersonalAuthority, work: (scope: PersonalScopeTx) => Promise<T>): Promise<ScopeOutcome<T>> => {
    // Copied and frozen at entry: the universe that is locked and checked is the one the scope
    // writes for, whatever the caller does with its object meanwhile.
    const authority = freezeAuthority(claimed);
    return runMarkedTransaction('personal-scope', () =>
      db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<ScopeOutcome<T>> => {
          await setLockTimeout(trx, options.lockTimeoutMs);
          const entry = await lockAndRecheck(trx, authority);
          if (entry.kind === 'refused') return entry;
          return { kind: 'entered', value: await runInScope(trx, authority, entry.revision, work) };
        }),
    );
  };
}

/** Carries a stop or refusal out of a resolved-scope transaction, so that it rolls back. Never escapes. */
class RollbackWith<O> extends Error {
  override readonly name = 'RollbackWith';
  constructor(readonly outcome: O) {
    super('Resolved scope rolled back with a typed outcome');
  }
}

const openResolutions = new WeakMap<RootResolutionTx, Transaction<Database>>();

/**
 * Creates identity's `WithResolvedPersonalScope` (blueprint §19, S1.3): one marked transaction in
 * which `resolve` first finds or creates the personal root (with the lock timeout already set),
 * then the root is locked and rechecked exactly as `withPersonalScope` does, then `work` runs with
 * the scope.
 *
 * Purpose: sign-in, whose universe is known only after the sign-in link is read and is created on
 *   first sign-in, still writes its receipt and session inside a real `PersonalScopeTx`.
 * Steps: BEGIN; `SET LOCAL lock_timeout`; `resolve(tx)` (identity's earlier locks, inserts of a new
 *   account and universe); `SELECT … FOR NO KEY UPDATE` on the named universe and the same
 *   rechecks; `work(scope, context)`; commit.
 * Outputs: `entered` (committed), `stopped` (the resolver's or the work's rollback result) or
 *   `refused` (a recheck failed). A stop, a refusal, a rollback or an exception rolls back
 *   everything, including what `resolve` wrote, so a refusal never consumes a link or leaves an
 *   account behind.
 * Failure/retry: a root lock wait beyond `lockTimeoutMs` throws `ScopeBusyError`; any other lock
 *   wait beyond it surfaces as PostgreSQL `55P03` (both retryable).
 */
export function makeWithResolvedPersonalScope(
  db: Kysely<Database>,
  options: PersonalScopeOptions,
): WithResolvedPersonalScope {
  return async <C, R, T>(
    resolve: (tx: RootResolutionTx) => Promise<RootResolution<C, R>>,
    work: (scope: PersonalScopeTx, context: C) => Promise<ScopeWork<T, R>>,
  ): Promise<ResolvedScopeOutcome<T, R>> => {
    try {
      return await runMarkedTransaction('personal-scope', () =>
        db
          .transaction()
          .setIsolationLevel('read committed')
          .execute(async (trx): Promise<ResolvedScopeOutcome<T, R>> => {
            await setLockTimeout(trx, options.lockTimeoutMs);
            const tx = Object.freeze({}) as unknown as RootResolutionTx;
            openResolutions.set(tx, trx);
            let resolution: RootResolution<C, R>;
            try {
              resolution = await resolve(tx);
            } finally {
              openResolutions.delete(tx);
            }
            if (resolution.kind === 'stop') throw new RollbackWith({ kind: 'stopped', result: resolution.result });
            const authority = freezeAuthority(resolution.authority);
            const entry = await lockAndRecheck(trx, authority);
            if (entry.kind === 'refused') throw new RollbackWith(entry);
            const { context } = resolution;
            const done = await runInScope(trx, authority, entry.revision, (scope) => work(scope, context));
            if (done.kind === 'rollback') throw new RollbackWith({ kind: 'stopped', result: done.result });
            return { kind: 'entered', value: done.value };
          }),
      );
    } catch (error) {
      if (error instanceof RollbackWith) return error.outcome as ResolvedScopeOutcome<T, R>;
      throw error;
    }
  };
}

/**
 * The transaction behind an open root resolution, for identity's adapters only. Throws
 * `ScopeClosedError` once the resolution phase ended.
 */
export function resolutionTransactionOf(tx: RootResolutionTx): Transaction<Database> {
  const trx = openResolutions.get(tx);
  if (trx === undefined) throw new ScopeClosedError('Root resolution used after its phase ended');
  return trx;
}

async function setLockTimeout(trx: Transaction<Database>, lockTimeoutMs: number): Promise<void> {
  await sql`select set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`.execute(trx);
}

/**
 * Locks the personal root (`FOR NO KEY UPDATE`, waiting behind any other holder) and rechecks
 * existence, status, privacy epoch and, for an account actor, ownership and account status, all
 * after the wait.
 */
async function lockAndRecheck(
  trx: Transaction<Database>,
  authority: PersonalAuthority,
): Promise<
  { readonly kind: 'locked'; readonly revision: number } | { readonly kind: 'refused'; readonly refusal: ScopeRefusal }
> {
  let universe;
  try {
    universe = await trx
      .selectFrom('identity.universes')
      .select(['account_id', 'privacy_epoch', 'status', 'revision'])
      .where('id', '=', authority.universeId)
      .forNoKeyUpdate()
      .executeTakeFirst();
  } catch (error) {
    if ((error as { code?: unknown }).code === '55P03')
      throw new ScopeBusyError('Personal scope lock not granted in time', { cause: error });
    throw error;
  }
  const universeRefusal = refusalForUniverse(authority, universe);
  if (universeRefusal !== undefined) return { kind: 'refused', refusal: universeRefusal };
  if (universe === undefined) return { kind: 'refused', refusal: { kind: 'universe_missing' } };
  if (authority.actor.kind === 'account') {
    const account = await trx
      .selectFrom('identity.accounts')
      .select('status')
      .where('id', '=', universe.account_id)
      .forKeyShare()
      .executeTakeFirst();
    if (account?.status !== 'active') return { kind: 'refused', refusal: { kind: 'universe_suspended' } };
  }
  return { kind: 'locked', revision: universe.revision };
}

/** Creates the scope capability for the locked root and runs `work`; the capability dies with it. */
async function runInScope<T>(
  trx: Transaction<Database>,
  authority: PersonalAuthority,
  revisionAtEntry: number,
  work: (scope: PersonalScopeTx) => Promise<T>,
): Promise<T> {
  const scope = Object.freeze({ authority, revisionAtEntry }) as unknown as PersonalScopeTx;
  openScopes.set(scope, trx);
  try {
    return await work(scope);
  } finally {
    openScopes.delete(scope);
    sharedRoots.delete(scope);
    accountFences.delete(scope);
  }
}

function freezeAuthority(authority: PersonalAuthority): PersonalAuthority {
  return Object.freeze({
    universeId: authority.universeId,
    privacyEpoch: authority.privacyEpoch,
    actor: Object.freeze({ ...authority.actor }),
  });
}

/** The universe-row checks `withPersonalScope` makes after the lock wait (and `authorityHolds` without a lock). */
function refusalForUniverse(
  authority: PersonalAuthority,
  universe: { readonly account_id: string; readonly privacy_epoch: number; readonly status: string } | undefined,
): ScopeRefusal | undefined {
  if (universe === undefined) return { kind: 'universe_missing' };
  if (universe.status !== 'active') return { kind: 'universe_suspended' };
  if (universe.privacy_epoch !== authority.privacyEpoch)
    return { kind: 'epoch_changed', currentEpoch: universe.privacy_epoch };
  if (authority.actor.kind === 'account' && universe.account_id !== authority.actor.accountId)
    return { kind: 'account_mismatch' };
  return undefined;
}

/**
 * Creates the identity port `AuthorityHolds`: the same checks as `withPersonalScope` (universe
 * exists and is active, privacy epoch unchanged, for an account actor ownership and account
 * status) read **without** a lock and without writing. For decisions that change nothing, such
 * as whether a finished model call's output may still be applied; whatever applies it later
 * rechecks under the lock.
 */
export function makeAuthorityHolds(db: Kysely<Database>): AuthorityHolds {
  return async (claimed) => {
    const authority = freezeAuthority(claimed);
    const row = await db
      .selectFrom('identity.universes as universe')
      .innerJoin('identity.accounts as account', 'account.id', 'universe.account_id')
      .select(['universe.account_id', 'universe.privacy_epoch', 'universe.status', 'account.status as account_status'])
      .where('universe.id', '=', authority.universeId)
      .executeTakeFirst();
    if (refusalForUniverse(authority, row) !== undefined || row === undefined) return false;
    return authority.actor.kind !== 'account' || row.account_status === 'active';
  };
}

/**
 * The transaction behind an open scope, for adapters (never for application code). Throws
 * `ScopeClosedError` once the scope's transaction has ended.
 */
export function transactionOf(scope: PersonalScopeTx): Transaction<Database> {
  const trx = openScopes.get(scope);
  if (trx === undefined) throw new ScopeClosedError('Personal scope used after its transaction ended');
  return trx;
}

/**
 * Advances the universe revision inside the locked scope and returns the new value. Called once
 * per committed change that subscribers should refetch; sent in the `scope_changed` hint.
 */
export async function advanceScopeRevision(scope: PersonalScopeTx): Promise<number> {
  const row = await transactionOf(scope)
    .updateTable('identity.universes')
    .set((eb) => ({ revision: eb('revision', '+', 1) }))
    .where('id', '=', scope.authority.universeId)
    .returning('revision')
    .executeTakeFirstOrThrow();
  return row.revision;
}

/**
 * How to lock one shared root (conversation, room, exploration). The owning module provides it:
 * `lock` takes the root's row lock in the given transaction and reports whether the root exists.
 */
export interface SharedRootLock {
  readonly kind: string;
  readonly id: string;
  lock(trx: Transaction<Database>): Promise<boolean>;
}

/** Raised when the lock order would be broken: a second shared root in one personal scope. */
export class LockOrderError extends Error {
  override readonly name = 'LockOrderError';
  readonly code = 'LOCK_ORDER_VIOLATION';
}

/**
 * Takes the lock of at most one shared root *after* the personal root, in the same transaction
 * (blueprint §19 lock order: personal root → this universe's rows → one shared root → its
 * subordinate rows). Returns the `SharedScopeTx` capability shared-scope ports require, or
 * `undefined` when the root does not exist. A second call in the same personal scope throws
 * `LockOrderError`: work that needs several shared roots is split into durable steps.
 * Membership and access checks stay with the caller; this only orders the locks.
 */
export async function enterSharedRoot(
  scope: PersonalScopeTx,
  root: SharedRootLock,
): Promise<SharedScopeTx | undefined> {
  const trx = transactionOf(scope);
  if (sharedRoots.has(scope)) throw new LockOrderError('A personal scope may lock at most one shared root');
  const shared = Object.freeze({
    personal: scope,
    root: Object.freeze({ kind: root.kind, id: root.id }),
  }) as unknown as SharedScopeTx;
  sharedRoots.set(scope, shared);
  if (!(await root.lock(trx))) return undefined;
  openSharedScopes.set(shared, scope);
  return shared;
}

/** The transaction behind an open shared scope, for adapters only. Throws `ScopeClosedError` after it ended. */
export function sharedTransactionOf(shared: SharedScopeTx): Transaction<Database> {
  const personal = openSharedScopes.get(shared);
  if (personal === undefined || sharedRoots.get(personal) !== shared)
    throw new ScopeClosedError('Shared scope used after its transaction ended');
  return transactionOf(personal);
}

/**
 * A short guarded transaction that holds no personal root lock, for bookkeeping that must not
 * depend on current personal authority (for example the attempt ledger settling an outcome). It
 * is marked like a personal scope, so network adapters refuse to run inside it and nesting is
 * refused. Purpose names the caller in the refusal message.
 */
export function withTransaction<T>(
  db: Kysely<Database>,
  purpose: string,
  work: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return runMarkedTransaction(purpose, () => db.transaction().execute(work));
}

/** Identity adapters reserve one account gate before any account SQL or shared root.
 * An own UPDATE gate cannot follow a pair SHARE gate: upgrades can deadlock with its peer.
 * The scope must still be open; failed/incompatible entry cannot issue SQL.
 */
export function claimAccountFence(scope: PersonalScopeTx, kind: 'own' | 'pair'): void {
  transactionOf(scope);
  if (sharedRoots.has(scope) || accountFences.has(scope))
    throw new LockOrderError('Account fencing must precede the shared root and may be entered only once');
  accountFences.set(scope, kind);
}
