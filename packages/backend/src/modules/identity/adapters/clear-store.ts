import { sql } from 'kysely';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import { revokeAccountSockets } from '../../../infrastructure/notices/index.js';
import {
  privacyTransactionOf,
  assertClearRemovalVerified,
  bindPrivacyOperation,
  clearCoreTransactionOf,
  clearAccountingTransactionOf,
  closeClearCore,
  isClearCore,
} from '../../../infrastructure/postgres/privacy-scope.js';
import type { ClearStore, ClearOperation } from '../application/clear-ports.js';
import type { Selectable } from 'kysely';
import type { IdentityClearOperations } from '../../../infrastructure/postgres/database.generated.js';
function operation(row: Selectable<IdentityClearOperations>): ClearOperation {
  return {
    operationId: row.id,
    accountId: row.account_id,
    universeId: row.scope_id,
    commandId: row.command_id,
    fromEpoch: row.from_epoch,
    toEpoch: row.to_epoch,
    requestHash: row.request_hash,
    outcomeVersion: row.outcome_version,
    recordedAt: row.recorded_at.toISOString(),
    coreDone: row.core_done_at !== null,
    completed: row.completed_at !== null,
    phase: row.phase as ClearOperation['phase'],
    failureCode: row.failure_code as ClearOperation['failureCode'],
  };
}
export const clearStore: ClearStore = {
  async read(scope, target) {
    let query = privacyTransactionOf(scope)
      .selectFrom('identity.clear_operations')
      .selectAll()
      .where('account_id', '=', scope.authority.accountId)
      .where('scope_id', '=', scope.authority.universeId);
    if (target.kind === 'command') query = query.where('command_id', '=', target.commandId);
    const row = await query.orderBy('to_epoch', 'desc').limit(1).executeTakeFirst();
    return row ? operation(row) : undefined;
  },
  async create(scope, commandId, hash, liabilities) {
    const trx = privacyTransactionOf(scope),
      a = scope.authority,
      id = uuidv7();
    if (liabilities.length > 1000) throw new Error('CLEAR_ACCOUNTING_UNVERIFIED');
    const row = await trx
      .insertInto('identity.clear_operations')
      .values({
        id,
        account_id: a.accountId,
        scope_id: a.universeId,
        command_id: commandId,
        request_hash: hash,
        from_epoch: a.privacyEpoch,
        to_epoch: a.privacyEpoch + 1,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    if (liabilities.length)
      await trx
        .insertInto('identity.clear_liabilities')
        .values(
          liabilities.map((l) => ({
            operation_id: id,
            account_id: a.accountId,
            scope_id: a.universeId,
            attempt_id: l.attemptId,
            run_id: l.runId,
            role_id: l.roleId,
            role_version: l.roleVersion,
            provider: l.provider,
            model: l.model,
            budget_window: l.budgetWindow,
            reserved_tokens: l.reservedTokens,
          })),
        )
        .execute();
    const updated = await trx
      .updateTable('identity.universes')
      .set({ privacy_epoch: a.privacyEpoch + 1, revision: sql`revision+1`, clear_operation_id: id })
      .where('id', '=', a.universeId)
      .where('privacy_epoch', '=', a.privacyEpoch)
      .where('clear_operation_id', 'is', null)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) throw new Error('CLEAR_BARRIER_INVALID');
    await revokeAccountSockets(trx, a.accountId);
    const accepted = operation(row);
    bindPrivacyOperation(scope, accepted);
    return accepted;
  },
  async coreDone(scope) {
    assertClearRemovalVerified(scope);
    const trx = clearCoreTransactionOf(scope),
      b = scope.binding;
    const updated = await trx
      .updateTable('identity.clear_operations')
      .set({ core_done_at: sql`now()`, phase: 'waiting_for_accounting', failure_code: null })
      .where('id', '=', b.operationId)
      .where('core_done_at', 'is', null)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) throw new Error('CLEAR_CORE_INVALID');
    const root = await trx
      .updateTable('identity.universes')
      .set({ clear_operation_id: null, revision: sql`revision+1` })
      .where('id', '=', b.universeId)
      .where('clear_operation_id', '=', b.operationId)
      .where('privacy_epoch', '=', b.toEpoch)
      .executeTakeFirst();
    if (root.numUpdatedRows !== 1n) throw new Error('CLEAR_BARRIER_INVALID');
    await revokeAccountSockets(trx, b.accountId);
    closeClearCore(scope);
  },
  async accountingDone(scope, verified) {
    const trx = clearAccountingTransactionOf(scope);
    await trx
      .updateTable('identity.clear_operations')
      .set({
        phase: verified ? 'verifying_live_removal' : 'waiting_for_accounting',
        failure_code: null,
        ...(verified ? { completed_at: sql`coalesce(completed_at,now())` } : {}),
      })
      .where('id', '=', scope.binding.operationId)
      .where('core_done_at', 'is not', null)
      .execute();
  },
  async fail(scope, code) {
    const trx = isClearCore(scope) ? clearCoreTransactionOf(scope) : clearAccountingTransactionOf(scope);
    await trx
      .updateTable('identity.clear_operations')
      .set({ failure_code: code })
      .where('id', '=', scope.binding.operationId)
      .where('completed_at', 'is', null)
      .execute();
  },
};
