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
      if (run.recording) {
        // Schema43 is a separately frozen prerequisite. Bind all proof fields in the first INSERT;
        // never admit an unproved row then relabel it to a resumed generation.
        const proof = run.recording;
        await sql`insert into reasoning.business_runs
          (universe_id,id,owner_module,purpose,privacy_epoch,role_id,role_version,policy_version,
           provider,model,context_bundle_ref,context_refs,recording_account_id,recording_generation,
           recording_context_sha256,recording_model_context_sha256)
          values(${universeId}::uuid,${run.id}::uuid,${run.ownerModule},${run.purpose},${scope.authority.privacyEpoch},
            ${run.roleId},${run.roleVersion},${run.policyVersion},${run.provider},${run.model},${run.contextBundleRef},
            ${JSON.stringify(run.contextRefs)}::jsonb,${proof.accountId}::uuid,${proof.generation},
            ${proof.contextSha256},${proof.modelContextSha256}) on conflict(universe_id,id) do nothing`.execute(trx);
      } else {
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
      }
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
      if (run.recording) {
        const proof = (
          await sql<{
            account: string | null;
            generation: number | null;
            context: string | null;
            model_context: string | null;
          }>`
          select recording_account_id as account,recording_generation as generation,
            recording_context_sha256 as context,recording_model_context_sha256 as model_context
          from reasoning.business_runs where universe_id=${universeId}::uuid and id=${run.id}::uuid`.execute(trx)
        ).rows[0];
        if (
          !proof ||
          proof.account?.toLowerCase() !== run.recording.accountId.toLowerCase() ||
          proof.generation !== run.recording.generation ||
          proof.context !== run.recording.contextSha256 ||
          proof.model_context !== run.recording.modelContextSha256
        )
          return { kind: 'mismatch' };
      }
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
      const integrity = await sql<{ valid: boolean }>`select not exists (
        select 1 from reasoning.external_attempts attempt
        left join reasoning.usage_receipts receipt on receipt.attempt_id = attempt.id
        where attempt.universe_id = ${scope.authority.universeId} and attempt.budget_window = ${today}
          and (receipt.attempt_id is null or
            (receipt.role_id, receipt.role_version, receipt.provider, receipt.model,
             receipt.budget_window, receipt.reserved_tokens) is distinct from
            (attempt.role_id, attempt.role_version, attempt.provider, attempt.model,
             attempt.budget_window, attempt.reserved_tokens))
      ) as valid`.execute(trx);
      if (integrity.rows[0]?.valid !== true) throw new Error('Reasoning accounting receipt unavailable');
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
      const backgroundGlobal = await sql<{ requests: string; tokens: string }>`
        select ${receiptSpend} from reasoning.usage_receipts where budget_window = ${today} and background`.execute(
        trx,
      );
      const backgroundPersonal = await sql<{ requests: string; tokens: string }>`
        select ${receiptSpend} from reasoning.usage_receipts
        where budget_window = ${today} and background and attempt_id in (
          select id from reasoning.external_attempts
          where universe_id = ${scope.authority.universeId} and budget_window = ${today}
        )`.execute(trx);
      return {
        global: spendOf(global.rows[0]),
        role: spendOf(role.rows[0]),
        scope: spendOf(personal.rows[0]),
        background: { global: spendOf(backgroundGlobal.rows[0]), scope: spendOf(backgroundPersonal.rows[0]) },
      };
    },

    async canStartRun(scope, roleId) {
      return canStartRoleRun(transactionOf(scope), roleId);
    },

    async reserve(scope, reservation) {
      const trx = transactionOf(scope);
      const universeId = scope.authority.universeId;
      const run = await trx
        .selectFrom('reasoning.business_runs')
        .select(['privacy_erased_at', 'state'])
        .where('universe_id', '=', universeId)
        .where('id', '=', reservation.runId)
        .forUpdate()
        .executeTakeFirst();
      // The idle sweep takes no personal root lock, so it can close a run between `admitRun` and here.
      // An attempt reserved under a closed run would be an orphan; the next delivery finds `run_closed`.
      if (run === undefined || run.privacy_erased_at !== null || run.state !== 'admitted')
        throw new Error('Reasoning run is unavailable');
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
          background: reservation.budgetClass === 'background',
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

    async releaseUndispatchedPersonal(input) {
      const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
      if (
        !uuid.test(input.scopeId) ||
        !uuid.test(input.run.id) ||
        (input.attemptId !== undefined && !uuid.test(input.attemptId)) ||
        !Number.isInteger(input.privacyEpoch) ||
        input.privacyEpoch < 1 ||
        input.privacyEpoch > 2147483647 ||
        !['primary', 'repair'].includes(input.step) ||
        !/^[a-f0-9]{64}$/u.test(input.requestHash)
      )
        return 'unavailable';
      return withTransaction(db, 'attempt-ledger', async (trx) => {
        // Accounting only: exact original descriptor comparison is a Boolean, not a private read.
        // No root/account/generation is adopted and no collection/dispatch authority is issued.
        const proof = input.run.recording;
        const header = await sql<{ matches: boolean }>`select (
          privacy_epoch=${input.privacyEpoch} and privacy_erased_at is null and state='admitted'
          and owner_module=${input.run.ownerModule} and purpose=${input.run.purpose}
          and role_id=${input.run.roleId} and role_version=${input.run.roleVersion}
          and policy_version=${input.run.policyVersion} and provider=${input.run.provider} and model=${input.run.model}
          and context_bundle_ref=${input.run.contextBundleRef} and context_refs=${JSON.stringify(input.run.contextRefs)}::jsonb
          and recording_account_id is not distinct from ${proof?.accountId ?? null}::uuid
          and recording_generation is not distinct from ${proof?.generation ?? null}::integer
          and recording_context_sha256 is not distinct from ${proof?.contextSha256 ?? null}
          and recording_model_context_sha256 is not distinct from ${proof?.modelContextSha256 ?? null}
        ) as matches from reasoning.business_runs
        where universe_id=${input.scopeId}::uuid and id=${input.run.id}::uuid for update`.execute(trx);
        if (header.rows[0]?.matches !== true) return 'unavailable';
        // Raw sentinel precedes selection of the logical step; the unique run/step index bounds it.
        const raw = await trx
          .selectFrom('reasoning.external_attempts')
          .select([
            'id',
            'step',
            'state',
            'role_id',
            'role_version',
            'provider',
            'model',
            'budget_window',
            'reserved_tokens',
            'dispatch_id',
            'dispatched_at',
            'privacy_erased_at',
            'settled_at',
          ])
          .select(sql<boolean>`request_hash=${input.requestHash}`.as('request_matches'))
          .where('universe_id', '=', input.scopeId)
          .where('run_id', '=', input.run.id)
          .orderBy('step')
          .limit(9)
          .forUpdate()
          .execute();
        if (
          raw.length === 0 ||
          raw.length > 8 ||
          raw.some(
            (r) =>
              !/^(?:primary|repair)(?:\.[234])?$/u.test(r.step) || r.state === 'dispatched' || r.state === 'unknown',
          )
        )
          return 'unavailable';
        for (const prefix of ['primary', 'repair']) {
          const sequence = raw.filter((r) => r.step === prefix || r.step.startsWith(prefix + '.'));
          if (sequence.some((r, i) => r.step !== (i === 0 ? prefix : `${prefix}.${i + 1}`))) return 'unavailable';
        }
        if (raw.some((r) => r.step === 'repair') && !raw.some((r) => r.step === 'primary')) return 'unavailable';
        const logical = raw.filter((r) => r.step === input.step || r.step.startsWith(input.step + '.'));
        const row = logical.at(-1);
        if (
          !row ||
          row.state !== 'reserved' ||
          row.privacy_erased_at !== null ||
          row.settled_at !== null ||
          (input.attemptId !== undefined && row.id !== input.attemptId) ||
          row.dispatch_id !== null ||
          row.dispatched_at !== null ||
          !row.request_matches ||
          row.role_id !== input.run.roleId ||
          row.role_version !== input.run.roleVersion ||
          row.provider !== input.run.provider ||
          row.model !== input.run.model ||
          logical
            .slice(0, -1)
            .some((r) => r.state !== 'not_sent' || r.dispatch_id !== null || r.dispatched_at !== null) ||
          raw.some((r) => r.id !== row.id && r.state === 'reserved')
        )
          return 'unavailable';
        const receipt = await trx
          .selectFrom('reasoning.usage_receipts')
          .select([
            'state',
            'role_id',
            'role_version',
            'provider',
            'model',
            'budget_window',
            'reserved_tokens',
            'settled_at',
            'input_tokens',
            'output_tokens',
            'reasoning_tokens',
            'cached_tokens',
            'late_usage',
          ])
          .where('attempt_id', '=', row.id)
          .forUpdate()
          .executeTakeFirst();
        if (
          !receipt ||
          receipt.state !== 'held' ||
          receipt.settled_at !== null ||
          receipt.late_usage ||
          receipt.input_tokens !== null ||
          receipt.output_tokens !== null ||
          receipt.reasoning_tokens !== null ||
          receipt.cached_tokens !== null ||
          receipt.role_id !== row.role_id ||
          receipt.role_version !== row.role_version ||
          receipt.provider !== row.provider ||
          receipt.model !== row.model ||
          String(receipt.budget_window) !== String(row.budget_window) ||
          receipt.reserved_tokens !== row.reserved_tokens
        )
          return 'unavailable';
        // commitDispatch locks/CASes this same attempt. If it won, the state/dispatch checks above
        // refuse; if cancellation wins, that CAS cannot send. Receipt locks follow attempt locks.
        const stopped = await trx
          .updateTable('reasoning.external_attempts')
          .set({ state: 'not_sent', outcome_code: 'AUTHORITY_REFUSED', settled_at: sql<Date>`now()` })
          .where('universe_id', '=', input.scopeId)
          .where('id', '=', row.id)
          .where('state', '=', 'reserved')
          .where('dispatch_id', 'is', null)
          .where('dispatched_at', 'is', null)
          .executeTakeFirst();
        const released = await trx
          .updateTable('reasoning.usage_receipts')
          .set({ state: 'released', settled_at: sql<Date>`now()` })
          .where('attempt_id', '=', row.id)
          .where('state', '=', 'held')
          .executeTakeFirst();
        if (stopped.numUpdatedRows !== 1n || released.numUpdatedRows !== 1n)
          throw new Error('REASONING_UNDISPATCHED_RELEASE_CARDINALITY');
        return 'released';
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

    closeIdleRuns(olderThanSeconds, limit) {
      return withTransaction(db, 'attempt-ledger', async (trx) => {
        const closed = await sql<{ id: string }>`
          update reasoning.business_runs run
          set state = 'cancelled', fence = fence + 1, closed_at = now(), updated_at = now()
          where (run.universe_id, run.id) in (
            select r.universe_id, r.id from reasoning.business_runs r
            where r.state = 'admitted' and r.privacy_erased_at is null
              and r.updated_at < now() - make_interval(secs => ${olderThanSeconds}::double precision)
              and not exists (
                select 1 from reasoning.external_attempts a
                where a.universe_id = r.universe_id and a.run_id = r.id
                  and (a.state in ('reserved', 'dispatched', 'unknown')
                    or a.settled_at >= now() - make_interval(secs => ${olderThanSeconds}::double precision)))
            order by r.updated_at
            limit ${limit}
            for update of r skip locked
          ) and run.state = 'admitted'
          returning run.id`.execute(trx);
        return closed.rows.length;
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
