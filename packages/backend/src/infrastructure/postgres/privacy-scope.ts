import { sql, type Kysely, type Transaction } from 'kysely';
import type {
  ClearAccountingTx,
  ClearBinding,
  ClearCoreTx,
  ClearLiability,
  PrivacyScopeTx,
  WithClearMaintenance,
  WithPrivacyScope,
} from '../../modules/identity/public.js';
import type { Database } from './database.js';
import { ScopeClosedError, withTransaction } from './personal-scope.js';

const acceptedOperations = new WeakMap<PrivacyScopeTx, ClearBinding>();
const privacy = new WeakMap<PrivacyScopeTx, Transaction<Database>>();
const core = new WeakMap<ClearCoreTx, Transaction<Database>>();
const accounting = new WeakMap<ClearAccountingTx, Transaction<Database>>();
export function privacyTransactionOf(scope: PrivacyScopeTx): Transaction<Database> {
  const trx = privacy.get(scope);
  if (!trx) throw new ScopeClosedError('Privacy capability unavailable');
  return trx;
}
export function clearCoreTransactionOf(scope: ClearCoreTx): Transaction<Database> {
  const trx = core.get(scope);
  if (!trx) throw new ScopeClosedError('Clear core capability unavailable');
  return trx;
}
export function clearAccountingTransactionOf(scope: ClearAccountingTx): Transaction<Database> {
  const trx = accounting.get(scope);
  if (!trx) throw new ScopeClosedError('Clear accounting capability unavailable');
  return trx;
}
export function isClearCore(scope: ClearCoreTx | ClearAccountingTx): scope is ClearCoreTx {
  if (core.has(scope as ClearCoreTx)) return true;
  clearAccountingTransactionOf(scope as ClearAccountingTx);
  return false;
}
async function timeouts(trx: Transaction<Database>, lockTimeoutMs: number) {
  await sql`select set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true),
 set_config('statement_timeout', '60000ms', true)`.execute(trx);
}
/** Root first, own account UPDATE gate, then a fresh account read. Historical receipts are later. */
export function makeWithPrivacyScope(
  db: Kysely<Database>,
  options: { readonly lockTimeoutMs: number },
): WithPrivacyScope {
  return (claimed, work) => {
    const authority = Object.freeze({ ...claimed });
    return withTransaction(db, 'privacy-scope', async (trx) => {
      await timeouts(trx, options.lockTimeoutMs);
      const root = await trx
        .selectFrom('identity.universes')
        .select(['account_id', 'privacy_epoch', 'revision', 'status', 'clear_operation_id'])
        .where('id', '=', authority.universeId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!root) return { kind: 'refused', refusal: { kind: 'universe_missing' } };
      if (root.account_id !== authority.accountId) return { kind: 'refused', refusal: { kind: 'account_mismatch' } };
      await trx
        .selectFrom('identity.accounts')
        .select('id')
        .where('id', '=', authority.accountId)
        .forUpdate()
        .executeTakeFirst();
      const account = await trx
        .selectFrom('identity.accounts')
        .select('status')
        .where('id', '=', authority.accountId)
        .executeTakeFirst();
      if (account?.status !== 'active' || root.status !== 'active')
        return { kind: 'refused', refusal: { kind: 'universe_suspended' } };
      if (root.privacy_epoch !== authority.privacyEpoch)
        return { kind: 'refused', refusal: { kind: 'epoch_changed', currentEpoch: root.privacy_epoch } };
      const scope = Object.freeze({
        authority,
        revisionAtEntry: root.revision,
        barrierId: root.clear_operation_id,
      }) as unknown as PrivacyScopeTx;
      privacy.set(scope, trx);
      try {
        return { kind: 'entered', value: await work(scope) };
      } finally {
        privacy.delete(scope);
        acceptedOperations.delete(scope);
      }
    });
  };
}
/** Existing-operation maintenance can finish for suspended owners; no caller/paid work authority. */
export function makeWithClearMaintenance(
  db: Kysely<Database>,
  options: { readonly lockTimeoutMs: number },
): WithClearMaintenance {
  return async (accountId, commandId, work) =>
    withTransaction(db, 'clear-maintenance', async (trx) => {
      await timeouts(trx, options.lockTimeoutMs);
      const locator = await trx
        .selectFrom('identity.clear_operations')
        .select(['id', 'scope_id'])
        .where('account_id', '=', accountId)
        .where('command_id', '=', commandId)
        .executeTakeFirst();
      if (!locator) return undefined;
      const root = await trx
        .selectFrom('identity.universes')
        .select(['account_id', 'privacy_epoch', 'revision', 'clear_operation_id'])
        .where('id', '=', locator.scope_id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!root || root.account_id !== accountId) throw new Error('CLEAR_BINDING_INVALID');
      await trx
        .selectFrom('identity.accounts')
        .select('id')
        .where('id', '=', accountId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const op = await trx
        .selectFrom('identity.clear_operations')
        .selectAll()
        .where('id', '=', locator.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const binding: ClearBinding = Object.freeze({
        operationId: op.id,
        accountId,
        universeId: op.scope_id,
        commandId: op.command_id,
        fromEpoch: op.from_epoch,
        toEpoch: op.to_epoch,
      });
      if (op.core_done_at === null) {
        if (root.clear_operation_id !== op.id || root.privacy_epoch !== op.to_epoch)
          throw new Error('CLEAR_BARRIER_INVALID');
        const scope = Object.freeze({ binding }) as unknown as ClearCoreTx;
        core.set(scope, trx);
        try {
          return await work(scope);
        } finally {
          core.delete(scope);
        }
      }
      const rows = await trx
        .selectFrom('identity.clear_liabilities')
        .select([
          'attempt_id',
          'run_id',
          'role_id',
          'role_version',
          'provider',
          'model',
          'reserved_tokens',
          sql<string>`budget_window::text`.as('budget_window'),
        ])
        .where('operation_id', '=', op.id)
        .orderBy('attempt_id')
        .limit(1001)
        .execute();
      if (rows.length > 1000) throw new Error('CLEAR_SNAPSHOT_INVALID');
      const liabilities: readonly ClearLiability[] = Object.freeze(
        rows.map((r) =>
          Object.freeze({
            attemptId: r.attempt_id,
            runId: r.run_id,
            roleId: r.role_id,
            roleVersion: r.role_version,
            provider: r.provider,
            model: r.model,
            budgetWindow: String(r.budget_window),
            reservedTokens: r.reserved_tokens,
          }),
        ),
      );
      const scope = Object.freeze({ binding, liabilities }) as unknown as ClearAccountingTx;
      accounting.set(scope, trx);
      try {
        return await work(scope);
      } finally {
        accounting.delete(scope);
      }
    });
}

export function closeClearCore(scope: ClearCoreTx): void {
  clearCoreTransactionOf(scope);
  core.delete(scope);
}

/** Installed by Identity's store only after operation and barrier writes in this same live transaction. */
export function bindPrivacyOperation(scope: PrivacyScopeTx, binding: ClearBinding): void {
  privacyTransactionOf(scope);
  if (
    acceptedOperations.has(scope) ||
    binding.accountId !== scope.authority.accountId ||
    binding.universeId !== scope.authority.universeId ||
    binding.fromEpoch !== scope.authority.privacyEpoch ||
    binding.toEpoch !== binding.fromEpoch + 1
  )
    throw new ScopeClosedError('Privacy operation binding unavailable');
  acceptedOperations.set(scope, Object.freeze({ ...binding }));
}
export function privacyOperationOf(scope: PrivacyScopeTx): ClearBinding {
  privacyTransactionOf(scope);
  const binding = acceptedOperations.get(scope);
  if (!binding) throw new ScopeClosedError('Privacy operation binding unavailable');
  return binding;
}
