import type { Kysely } from 'kysely';
import type { Database } from '../../infrastructure/postgres/database.js';
import { transactionOf, withTransaction } from '../../infrastructure/postgres/personal-scope.js';
import { canTransition, type AttemptState } from '../domain/attempts.js';
import type { AttemptLedger, AttemptRow } from '../application/ports.js';

function toRow(row: { id: string; state: string; request_hash: string; outcome_code: string | null }): AttemptRow {
  return { id: row.id, state: row.state as AttemptState, requestHash: row.request_hash, outcomeCode: row.outcome_code };
}

/**
 * The PostgreSQL attempt ledger. Admission, reservation and dispatch intent use the personal
 * scope's transaction; reads and settlement are ledger-owned and use their own short guarded
 * transaction keyed by `(universe_id, id)`, independent of current authority. Every transition is
 * conditional on the expected state, so concurrent deliveries cannot both win.
 */
export function makeAttemptLedger(db: Kysely<Database>): AttemptLedger {
  return {
    async find(universeId, runId, step) {
      const row = await db
        .selectFrom('reasoning.external_attempts')
        .select(['id', 'state', 'request_hash', 'outcome_code'])
        .where('universe_id', '=', universeId)
        .where('run_id', '=', runId)
        .where('step', '=', step)
        .executeTakeFirst();
      return row === undefined ? undefined : toRow(row);
    },
    async admitRun(scope, run) {
      await transactionOf(scope)
        .insertInto('reasoning.business_runs')
        .values({
          universe_id: scope.authority.universeId,
          id: run.id,
          owner_module: run.ownerModule,
          purpose: run.purpose,
          privacy_epoch: scope.authority.privacyEpoch,
        })
        .onConflict((conflict) => conflict.columns(['universe_id', 'id']).doNothing())
        .execute();
    },
    async findLocked(scope, runId, step) {
      const row = await transactionOf(scope)
        .selectFrom('reasoning.external_attempts')
        .select(['id', 'state', 'request_hash', 'outcome_code'])
        .where('universe_id', '=', scope.authority.universeId)
        .where('run_id', '=', runId)
        .where('step', '=', step)
        .executeTakeFirst();
      return row === undefined ? undefined : toRow(row);
    },
    async reserve(scope, attempt) {
      await transactionOf(scope)
        .insertInto('reasoning.external_attempts')
        .values({
          universe_id: scope.authority.universeId,
          id: attempt.id,
          run_id: attempt.runId,
          step: attempt.step,
          provider: attempt.provider,
          model: attempt.model,
          request_hash: attempt.requestHash,
        })
        .execute();
    },
    async commitDispatch(scope, attemptId) {
      const result = await transactionOf(scope)
        .updateTable('reasoning.external_attempts')
        .set({ state: 'dispatched', dispatched_at: new Date() })
        .where('universe_id', '=', scope.authority.universeId)
        .where('id', '=', attemptId)
        .where('state', '=', 'reserved')
        .executeTakeFirst();
      return result.numUpdatedRows === 1n;
    },
    async settle(attempt, from, to, details = {}) {
      if (!canTransition(from, to)) throw new Error(`Attempt transition ${from} → ${to} is not allowed`);
      return withTransaction(db, 'attempt-ledger', async (trx) => {
        const result = await trx
          .updateTable('reasoning.external_attempts')
          .set({
            state: to,
            settled_at: new Date(),
            ...(details.remoteId === undefined ? {} : { remote_id: details.remoteId }),
            ...(details.outcomeCode === undefined ? {} : { outcome_code: details.outcomeCode }),
          })
          .where('universe_id', '=', attempt.universeId)
          .where('id', '=', attempt.attemptId)
          .where('state', '=', from)
          .executeTakeFirst();
        return result.numUpdatedRows === 1n;
      });
    },
  };
}
