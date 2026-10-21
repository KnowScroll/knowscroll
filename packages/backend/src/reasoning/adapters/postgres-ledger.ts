import { sql, type Kysely } from 'kysely';
import type { Database } from '../../infrastructure/postgres/database.js';
import { transactionOf, withTransaction } from '../../infrastructure/postgres/personal-scope.js';
import { OUTCOME_NOT_RECORDED, canTransition, isSettled, type AttemptState } from '../domain/attempts.js';
import type { AttemptLedger } from '../application/ports.js';

import {
  BUDGET_LOCK_KEY,
  today,
  attemptColumns,
  toRow,
  quotaJson,
  receiptState,
  usageColumns,
  receiptSpend,
  spendOf,
  canStartRoleRun,
  privacyOutcome,
} from './ledger-values.js';

/**
 * The PostgreSQL attempt ledger (migrations 0006 + 0009). Admission, reservation and dispatch
 * intent use the personal scope's transaction; reads and settlement are ledger-owned and use their
 * own short marked transaction keyed by `(universe_id, id)`, independent of current authority.
 * Every transition is conditional on the expected state, so concurrent deliveries cannot both win.
 * Protected request bytes are written with the attempt and read only by the harness.
 */
export function makeAttemptLedger(db: Kysely<Database>): AttemptLedger {
  return {
    async find(universeId, runId, step) {
      const row = await db
        .selectFrom('reasoning.external_attempts as attempt')
        .innerJoin('reasoning.business_runs as run', (join) =>
          join.onRef('run.universe_id', '=', 'attempt.universe_id').onRef('run.id', '=', 'attempt.run_id'),
        )
        .select(attemptColumns)
        .select(
          sql<boolean>`attempt.privacy_erased_at is not null or run.privacy_erased_at is not null`.as('privacy_erased'),
        )
        .where('attempt.universe_id', '=', universeId)
        .where('attempt.run_id', '=', runId)
        .where((eb) => eb.or([eb('attempt.step', '=', step), eb('attempt.step', 'like', `${step}.%`)]))
        .orderBy('attempt.reserved_at', 'desc')
        .orderBy('attempt.id', 'desc')
        .limit(1)
        .executeTakeFirst();
      return row === undefined ? undefined : toRow(row);
    },

    async admitRun(scope, run) {
      const trx = transactionOf(scope);
      const universeId = scope.authority.universeId;
      await trx
        .insertInto('reasoning.business_runs')
        .values({
          universe_id: universeId,
          id: run.id,
          owner_module: run.ownerModule,
          purpose: run.purpose,
          privacy_epoch: scope.authority.privacyEpoch,
          role_id: run.roleId,
          role_version: run.roleVersion,
          policy_version: run.policyVersion,
          provider: run.provider,
          model: run.model,
          context_bundle_ref: run.contextBundleRef,
          context_refs: JSON.stringify(run.contextRefs),
        })
        .onConflict((conflict) => conflict.columns(['universe_id', 'id']).doNothing())
        .execute();
      const row = await trx
        .selectFrom('reasoning.business_runs')
        .select([
          'owner_module',
          'purpose',
          'role_id',
          'role_version',
          'policy_version',
          'provider',
          'model',
          'context_bundle_ref',
          'privacy_epoch',
          'state',
          'fence',
          'privacy_erased_at',
        ])
        .where('universe_id', '=', universeId)
        .where('id', '=', run.id)
        .executeTakeFirstOrThrow();
      if (row.privacy_epoch !== scope.authority.privacyEpoch) return { kind: 'mismatch' };
      if (row.privacy_erased_at !== null) return { kind: 'closed' };
      const same =
        row.owner_module === run.ownerModule &&
        row.purpose === run.purpose &&
        row.role_id === run.roleId &&
        row.role_version === run.roleVersion &&
        row.policy_version === run.policyVersion &&
        row.provider === run.provider &&
        row.model === run.model &&
        row.context_bundle_ref === run.contextBundleRef &&
        // A run admitted at epoch N is not the same run at epoch N+1 (a privacy reset in between).
        row.privacy_epoch === scope.authority.privacyEpoch;
      if (!same) return { kind: 'mismatch' };
      if (row.state !== 'admitted') return { kind: 'closed' };
      return { kind: 'admitted', fence: row.fence };
    },

    async findLocked(scope, runId, step) {
      const row = await transactionOf(scope)
        .selectFrom('reasoning.external_attempts as attempt')
        .innerJoin('reasoning.business_runs as run', (join) =>
          join.onRef('run.universe_id', '=', 'attempt.universe_id').onRef('run.id', '=', 'attempt.run_id'),
        )
        .select(attemptColumns)
        .select(
          sql<boolean>`attempt.privacy_erased_at is not null or run.privacy_erased_at is not null`.as('privacy_erased'),
        )
        .where('attempt.universe_id', '=', scope.authority.universeId)
        .where('attempt.run_id', '=', runId)
        .where((eb) => eb.or([eb('attempt.step', '=', step), eb('attempt.step', 'like', `${step}.%`)]))
        .orderBy('attempt.reserved_at', 'desc')
        .orderBy('attempt.id', 'desc')
        .limit(1)
        .executeTakeFirst();
      return row === undefined ? undefined : toRow(row);
    },

    async budgetUsage(scope, roleId) {
      const trx = transactionOf(scope);
      await sql`select pg_advisory_xact_lock(${BUDGET_LOCK_KEY}::bigint)`.execute(trx);
      const global = await sql<{ requests: string; tokens: string }>`
        select ${receiptSpend} from reasoning.usage_receipts where budget_window = ${today}`.execute(trx);
      const role = await sql<{ requests: string; tokens: string }>`
        select ${receiptSpend} from reasoning.usage_receipts where budget_window = ${today} and role_id = ${roleId}`.execute(
        trx,
      );
      // Charge comes from the receipt, never from whether erased output/issues still exist.
      // Existing eventual deletion of personal attempt IDs still resets that scope allowance.
      const personal = await sql<{ requests: string; tokens: string }>`
        select ${receiptSpend} from reasoning.usage_receipts
        where budget_window = ${today} and attempt_id in (
          select id from reasoning.external_attempts
          where universe_id = ${scope.authority.universeId} and budget_window = ${today}
        )`.execute(trx);
      return { global: spendOf(global.rows[0]), role: spendOf(role.rows[0]), scope: spendOf(personal.rows[0]) };
    },

    async canStartRun(scope, roleId) {
      return canStartRoleRun(transactionOf(scope), roleId);
    },

    async reserve(scope, reservation) {
      const trx = transactionOf(scope);
      const universeId = scope.authority.universeId;
      const run = await trx
        .selectFrom('reasoning.business_runs')
        .select('privacy_erased_at')
        .where('universe_id', '=', universeId)
        .where('id', '=', reservation.runId)
        .forUpdate()
        .executeTakeFirst();
      if (run === undefined || run.privacy_erased_at !== null) throw new Error('Reasoning run is unavailable');
      await trx
        .insertInto('reasoning.external_attempts')
        .values({
          universe_id: universeId,
          id: reservation.id,
          run_id: reservation.runId,
          step: reservation.step,
          provider: reservation.provider,
          model: reservation.model,
          request_hash: reservation.requestHash,
          role_id: reservation.roleId,
          role_version: reservation.roleVersion,
          prompt_version: reservation.promptVersion,
          causation_attempt_id: reservation.causationAttemptId ?? null,
          max_output_tokens: reservation.maxOutputTokens,
          request_bytes: reservation.requestBody.byteLength,
          reserved_tokens: reservation.reservedTokens,
          budget_window: today,
        })
        .execute();
      await trx
        .insertInto('reasoning.protected_requests')
        .values({
          universe_id: universeId,
          attempt_id: reservation.id,
          body: Buffer.from(reservation.requestBody),
          body_sha256: reservation.requestHash,
          expires_at: sql<Date>`now() + make_interval(secs => ${reservation.requestRetentionSeconds}::double precision)`,
        })
        .execute();
      await trx
        .insertInto('reasoning.usage_receipts')
        .values({
          attempt_id: reservation.id,
          role_id: reservation.roleId,
          role_version: reservation.roleVersion,
          provider: reservation.provider,
          model: reservation.model,
          budget_window: today,
          reserved_tokens: reservation.reservedTokens,
        })
        .execute();
    },

    async commitDispatch(scope, attemptId, dispatch) {
      const result = await transactionOf(scope)
        .updateTable('reasoning.external_attempts')
        .set({
          state: 'dispatched',
          dispatched_at: sql<Date>`now()`,
          dispatch_id: dispatch.dispatchId,
          dispatched_by: dispatch.dispatchedBy,
          quota_observation: quotaJson(dispatch.quota),
        })
        .where('universe_id', '=', scope.authority.universeId)
        .where('id', '=', attemptId)
        .where('state', '=', 'reserved')
        .where('privacy_erased_at', 'is', null)
        .where(
          sql<boolean>`exists (select 1 from reasoning.business_runs run
          where run.universe_id = ${scope.authority.universeId}
            and run.id = reasoning.external_attempts.run_id and run.privacy_erased_at is null)`,
        )
        .executeTakeFirst();
      return result.numUpdatedRows === 1n;
    },

    async settle(attempt, from, to, details = {}) {
      if (!canTransition(from, to)) throw new Error(`Attempt transition ${from} → ${to} is not allowed`);
      return withTransaction(db, 'attempt-ledger', async (trx) => {
        const row = await trx
          .selectFrom('reasoning.external_attempts')
          .select(['state', 'privacy_erased_at', 'outcome_code'])
          .where('universe_id', '=', attempt.scopeId)
          .where('id', '=', attempt.attemptId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined || row.state !== from) return false;
        const erased = row.privacy_erased_at !== null;
        // Classify ORIGINAL evidence before stripping payload. Redaction is never a refund.
        const receipt = receiptState(to, details);
        const conclusiveFailure =
          to === 'failed' || (to === 'reconciled' && details.output === undefined && details.issues === undefined);
        const result = await trx
          .updateTable('reasoning.external_attempts')
          .set({
            state: to,
            ...(isSettled(to) ? { settled_at: sql<Date>`now()` } : {}),
            ...(erased
              ? {
                  output: null,
                  output_issues: null,
                  outcome_code: privacyOutcome(details.outcomeCode ?? row.outcome_code),
                  quota_observation: null,
                  dispatched_by: null,
                  ...(details.remoteId === undefined
                    ? {}
                    : {
                        remote_id:
                          /^[A-Za-z0-9_.:-]{1,128}$/.exec(details.remoteId)?.[0] === details.remoteId
                            ? details.remoteId
                            : null,
                      }),
                }
              : {
                  ...(details.remoteId === undefined ? {} : { remote_id: details.remoteId }),
                  ...(details.outcomeCode === undefined ? {} : { outcome_code: details.outcomeCode }),
                  ...(details.output === undefined ? {} : { output: JSON.stringify(details.output) }),
                  ...(details.issues === undefined ? {} : { output_issues: JSON.stringify(details.issues) }),
                  ...(details.quota === undefined ? {} : { quota_observation: quotaJson(details.quota) }),
                }),
            ...usageColumns(details.usage),
          })
          .where('universe_id', '=', attempt.scopeId)
          .where('id', '=', attempt.attemptId)
          .where('state', '=', from)
          .executeTakeFirst();
        if (result.numUpdatedRows !== 1n) return false;
        await trx
          .updateTable('reasoning.usage_receipts')
          .set({
            state: receipt,
            conclusive_failure: conclusiveFailure,
            ...(isSettled(to) ? { settled_at: sql<Date>`now()` } : {}),
            ...usageColumns(details.usage),
          })
          .where('attempt_id', '=', attempt.attemptId)
          .execute();
        return true;
      });
    },

    async recordLateUsage(attemptId, usage) {
      await withTransaction(db, 'attempt-ledger', (trx) =>
        trx
          .updateTable('reasoning.usage_receipts')
          .set((eb) => ({
            input_tokens: eb.fn.coalesce('input_tokens', eb.val(usage.inputTokens)),
            output_tokens: eb.fn.coalesce('output_tokens', eb.val(usage.outputTokens)),
            reasoning_tokens: eb.fn.coalesce('reasoning_tokens', eb.val(usage.reasoningTokens)),
            cached_tokens: eb.fn.coalesce('cached_tokens', eb.val(usage.cachedTokens)),
            late_usage: true,
          }))
          .where('attempt_id', '=', attemptId)
          .where('state', '=', 'written_off')
          .execute(),
      );
    },

    async readProtectedRequest(attempt) {
      const row = await db
        .selectFrom('reasoning.protected_requests as request')
        .innerJoin('reasoning.external_attempts as attempt', (join) =>
          join.onRef('attempt.universe_id', '=', 'request.universe_id').onRef('attempt.id', '=', 'request.attempt_id'),
        )
        .innerJoin('reasoning.business_runs as run', (join) =>
          join.onRef('run.universe_id', '=', 'attempt.universe_id').onRef('run.id', '=', 'attempt.run_id'),
        )
        .select(['request.body'])
        .where('request.universe_id', '=', attempt.scopeId)
        .where('request.attempt_id', '=', attempt.attemptId)
        .where('attempt.privacy_erased_at', 'is', null)
        .where('run.privacy_erased_at', 'is', null)
        .where('expires_at', '>', sql<Date>`now()`)
        .executeTakeFirst();
      return row === undefined ? undefined : new Uint8Array(row.body);
    },

    async closeRun(scope, run) {
      const result = await transactionOf(scope)
        .updateTable('reasoning.business_runs')
        .set((eb) => ({
          state: run.state,
          fence: eb('fence', '+', 1),
          closed_at: sql<Date>`now()`,
          updated_at: sql<Date>`now()`,
        }))
        .where('universe_id', '=', scope.authority.universeId)
        .where('id', '=', run.runId)
        .where('state', '=', 'admitted')
        .where('privacy_erased_at', 'is', null)
        .executeTakeFirst();
      return result.numUpdatedRows === 1n ? 'closed' : 'not_open';
    },

    writeOff(attemptId, reason, source) {
      return withTransaction(db, 'attempt-ledger', async (trx) => {
        const row = await trx
          .selectFrom('reasoning.external_attempts')
          .select(['universe_id', 'state', 'privacy_erased_at'])
          .where('id', '=', attemptId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return { kind: 'missing' } as const;
        if (row.state !== 'unknown')
          return { kind: 'not_unknown', attemptId, state: row.state as AttemptState } as const;
        await trx
          .updateTable('reasoning.external_attempts')
          .set({
            state: 'written_off',
            settled_at: sql<Date>`now()`,
            written_off_at: sql<Date>`now()`,
            written_off_reason: row.privacy_erased_at === null ? reason : 'privacy-erased',
            written_off_by: row.privacy_erased_at === null ? source : 'privacy-erased',
          })
          .where('universe_id', '=', row.universe_id)
          .where('id', '=', attemptId)
          .where('state', '=', 'unknown')
          .execute();
        await trx
          .updateTable('reasoning.usage_receipts')
          .set({ state: 'written_off', settled_at: sql<Date>`now()` })
          .where('attempt_id', '=', attemptId)
          .execute();
        return { kind: 'written_off', attemptId } as const;
      });
    },

    async listUnknown(limit) {
      const rows = await db
        .selectFrom('reasoning.external_attempts')
        .select(['id', 'provider', 'model', 'role_id', 'outcome_code', 'dispatched_at'])
        .where('state', '=', 'unknown')
        .orderBy('dispatched_at', 'asc')
        .orderBy('id', 'asc')
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        attemptId: row.id,
        provider: row.provider,
        model: row.model,
        roleId: row.role_id,
        outcomeCode: row.outcome_code,
        dispatchedAt: row.dispatched_at,
      }));
    },

    purgeExpiredRequests(limit) {
      return withTransaction(db, 'protected-request-expiry', async (trx) => {
        // An expired `reserved` attempt will never be sent (its bytes are about to go): settle it
        // `not_sent` first and release its reservation. A redelivery reserves a fresh attempt.
        const expired = await sql<{ id: string }>`
          update reasoning.external_attempts attempt
          set state = 'not_sent', outcome_code = 'REQUEST_EXPIRED', settled_at = now()
          where (attempt.universe_id, attempt.id) in (
            select x.universe_id, x.id from reasoning.external_attempts x
            join reasoning.protected_requests p on p.universe_id = x.universe_id and p.attempt_id = x.id
            where x.state = 'reserved' and p.expires_at <= now()
            order by p.expires_at
            limit ${limit}
            for update of x skip locked
          ) and attempt.state = 'reserved'
          returning attempt.id`.execute(trx);
        if (expired.rows.length > 0)
          await sql`
            update reasoning.usage_receipts set state = 'released', settled_at = now()
            where state = 'held' and attempt_id in (${sql.join(expired.rows.map((row) => row.id))})`.execute(trx);
        // Never the bytes of a `dispatched` attempt: the sweep resolves it first.
        const result = await sql`
          delete from reasoning.protected_requests
          where (universe_id, attempt_id) in (
            select p.universe_id, p.attempt_id from reasoning.protected_requests p
            join reasoning.external_attempts x on x.universe_id = p.universe_id and x.id = p.attempt_id
            where p.expires_at <= now() and x.state <> 'dispatched'
            order by p.expires_at
            limit ${limit}
            for update of p skip locked
          )`.execute(trx);
        return Number(result.numAffectedRows ?? 0n);
      });
    },

    sweepStaleDispatched(olderThanSeconds, limit) {
      return withTransaction(db, 'attempt-ledger', async (trx) => {
        const moved = await sql<{ id: string }>`
          update reasoning.external_attempts attempt
          set state = 'unknown', outcome_code = ${OUTCOME_NOT_RECORDED}
          where (attempt.universe_id, attempt.id) in (
            select x.universe_id, x.id from reasoning.external_attempts x
            where x.state = 'dispatched'
              and x.dispatched_at < now() - make_interval(secs => ${olderThanSeconds}::double precision)
            order by x.dispatched_at
            limit ${limit}
            for update skip locked
          ) and attempt.state = 'dispatched'
          returning attempt.id`.execute(trx);
        if (moved.rows.length > 0)
          await sql`
            update reasoning.usage_receipts set state = 'unknown'
            where state = 'held' and attempt_id in (${sql.join(moved.rows.map((row) => row.id))})`.execute(trx);
        return moved.rows.length;
      });
    },
  };
}
