import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { withTransaction } from '../../../infrastructure/postgres/personal-scope.js';
import { hasLivePrivacyJob, enqueueClearRecoveryContinuation } from '../../../infrastructure/jobs/enqueue-privacy.js';
import type { PgBoss } from 'pg-boss';
import { ClearRecoveryJobSchema, type ClearRecoveryJob } from '../events.js';
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
      .set({
        core_done_at: sql`now()`,
        phase: 'waiting_for_accounting',
        failure_code: null,
        recovery_after: sql`now()+interval '15 minutes'`,
      })
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
  async accountingDone(scope, result) {
    const trx = clearAccountingTransactionOf(scope);
    if (result === 'pending') {
      const updated = await trx
        .updateTable('identity.clear_operations')
        .set({ phase: 'waiting_for_accounting', failure_code: null, recovery_after: sql`now()+interval '15 minutes'` })
        .where('id', '=', scope.binding.operationId)
        .where('core_done_at', 'is not', null)
        .where('completed_at', 'is', null)
        .returning(sql<Date>`now()+interval '5 minutes'`.as('wake_at'))
        .executeTakeFirstOrThrow();
      return updated.wake_at;
    }
    const updated = await trx
      .updateTable('identity.clear_operations')
      .set({
        phase: 'verifying_live_removal',
        failure_code: null,
        completed_at: sql`coalesce(completed_at,now())`,
        recovery_after: null,
        cleanup_due_at:
          result === 'verified_retained'
            ? sql`(date_trunc('day',now() at time zone 'UTC')+interval '1 day') at time zone 'UTC'`
            : null,
      })
      .where('id', '=', scope.binding.operationId)
      .where('core_done_at', 'is not', null)
      .where('completed_at', 'is', null)
      .returning('cleanup_due_at')
      .executeTakeFirstOrThrow();
    return updated.cleanup_due_at ?? undefined;
  },
  async cleanupDone(scope) {
    await clearAccountingTransactionOf(scope)
      .updateTable('identity.clear_operations')
      .set({ cleanup_due_at: null, cleanup_recovery_after: null })
      .where('id', '=', scope.binding.operationId)
      .where('completed_at', 'is not', null)
      .where('cleanup_due_at', 'is not', null)
      .execute();
  },
  async claimRecovery(scope) {
    const trx = isClearCore(scope) ? clearCoreTransactionOf(scope) : clearAccountingTransactionOf(scope);
    const op = await trx
      .selectFrom('identity.clear_operations')
      .select([
        'completed_at',
        'failure_code',
        'recorded_at',
        'recovery_after',
        'recovery_attempts',
        'cleanup_due_at',
        'cleanup_recovery_after',
        'cleanup_recovery_attempts',
        sql<Date>`now()`.as('clock'),
      ])
      .where('id', '=', scope.binding.operationId)
      .executeTakeFirstOrThrow();
    if (op.completed_at !== null) {
      if (
        op.cleanup_due_at === null ||
        op.cleanup_recovery_attempts >= 3 ||
        op.cleanup_due_at > op.clock ||
        (op.cleanup_recovery_after !== null && op.cleanup_recovery_after > op.clock)
      )
        return false;
    } else if ((op.recovery_after ?? new Date(op.recorded_at.getTime() + 900000)) > op.clock) return false;
    if (await hasLivePrivacyJob(scope)) return false;
    if (op.completed_at !== null) {
      await trx
        .updateTable('identity.clear_operations')
        .set({
          cleanup_recovery_after: sql`now()+interval '15 minutes'`,
          cleanup_recovery_attempts: sql`cleanup_recovery_attempts+1`,
        })
        .where('id', '=', scope.binding.operationId)
        .execute();
    } else {
      if (op.recovery_attempts >= 3) {
        await trx
          .updateTable('identity.clear_operations')
          .set({ failure_code: 'temporarily_unavailable' })
          .where('id', '=', scope.binding.operationId)
          .where('failure_code', 'is', null)
          .execute();
        return false;
      }
      await trx
        .updateTable('identity.clear_operations')
        .set({
          failure_code: 'temporarily_unavailable',
          recovery_after: sql`now()+interval '15 minutes'`,
          recovery_attempts: sql`recovery_attempts+1`,
        })
        .where('id', '=', scope.binding.operationId)
        .execute();
    }
    return true;
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

/** Global maintenance discovery is a bounded IDs-only read; all mutation re-enters the exact root. */
export function readClearRecoveryCandidates(db: Kysely<Database>, boss: PgBoss) {
  return (input: ClearRecoveryJob) =>
    withTransaction(db, 'clear-recovery-index', async (trx) => {
      const job = ClearRecoveryJobSchema.parse(input);
      await sql`select set_config('statement_timeout','2000ms',true),set_config('lock_timeout','250ms',true)`.execute(
        trx,
      );
      const through =
        'cursor' in job
          ? job.cursor.throughOperationId
          : (
              await trx
                .selectFrom('identity.clear_operations')
                .select('id')
                .orderBy('id', 'desc')
                .limit(1)
                .executeTakeFirst()
            )?.id;
      if (!through) return [];
      const after = 'cursor' in job ? job.cursor.afterOperationId : null;
      const result = await sql<{
        operationId: string;
        accountId: string;
        commandId: string;
      }>`select id as "operationId",account_id as "accountId",command_id as "commandId"
   from identity.clear_operations where id<=${through}::uuid and (${after}::uuid is null or id>${after}::uuid) and (
    (completed_at is null and (recovery_attempts<3 or failure_code is null) and coalesce(recovery_after,recorded_at+interval '15 minutes')<=now())
    or (completed_at is not null and cleanup_due_at<=now() and cleanup_recovery_attempts<3
      and coalesce(cleanup_recovery_after,cleanup_due_at)<=now()))
   order by id limit 26`.execute(trx);
      const page = result.rows.slice(0, 25);
      if (result.rows.length > 25)
        await enqueueClearRecoveryContinuation(boss, trx, {
          v: 1,
          cursor: { afterOperationId: page[24]!.operationId, throughOperationId: through },
        });
      return page.map(({ accountId, commandId }) => ({ accountId, commandId }));
    });
}
