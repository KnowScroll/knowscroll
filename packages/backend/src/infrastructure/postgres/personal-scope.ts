import { sql, type Kysely, type Transaction } from 'kysely';
import type {
  PersonalAuthority,
  PersonalScopeTx,
  ScopeOutcome,
  WithPersonalScope,
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

export interface PersonalScopeOptions {
  /** Longest wait for the personal root lock before `ScopeBusyError`. */
  readonly lockTimeoutMs: number;
}

/**
 * Creates `withPersonalScope` (blueprint §19) over one database.
 *
 * Purpose: the only way to obtain a `PersonalScopeTx`, the capability personal-write ports need.
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
  return <T>(authority: PersonalAuthority, work: (scope: PersonalScopeTx) => Promise<T>): Promise<ScopeOutcome<T>> =>
    runMarkedTransaction('personal-scope', () =>
      db.transaction().execute(async (trx): Promise<ScopeOutcome<T>> => {
        await sql`select set_config('lock_timeout', ${`${options.lockTimeoutMs}ms`}, true)`.execute(trx);
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
        if (universe === undefined) return { kind: 'refused', refusal: { kind: 'universe_missing' } };
        if (universe.status !== 'active') return { kind: 'refused', refusal: { kind: 'universe_suspended' } };
        if (universe.privacy_epoch !== authority.privacyEpoch) {
          return { kind: 'refused', refusal: { kind: 'epoch_changed', currentEpoch: universe.privacy_epoch } };
        }
        if (authority.actor.kind === 'account') {
          if (universe.account_id !== authority.actor.accountId)
            return { kind: 'refused', refusal: { kind: 'account_mismatch' } };
          const account = await trx
            .selectFrom('identity.accounts')
            .select('status')
            .where('id', '=', universe.account_id)
            .forKeyShare()
            .executeTakeFirst();
          if (account?.status !== 'active') return { kind: 'refused', refusal: { kind: 'universe_suspended' } };
        }
        const scope = { authority, revisionAtEntry: universe.revision } as unknown as PersonalScopeTx;
        openScopes.set(scope, trx);
        try {
          return { kind: 'entered', value: await work(scope) };
        } finally {
          openScopes.delete(scope);
        }
      }),
    );
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
