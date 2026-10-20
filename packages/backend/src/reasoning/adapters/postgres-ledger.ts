import { sql, type Expression, type ExpressionBuilder, type Kysely, type SqlBool } from 'kysely';
import type { Database } from '../../infrastructure/postgres/database.js';
import { transactionOf, withTransaction } from '../../infrastructure/postgres/personal-scope.js';
import { canTransition, isSettled, type AttemptState } from '../domain/attempts.js';
import type { ReportedUsage } from '../domain/budgets.js';
import type { OutputIssue } from '../domain/output.js';
import type {
  AttemptLedger,
  AttemptRow,
  QuotaObservation,
  StoredModelOutput,
  StoredOutputIssues,
} from '../application/ports.js';

/**
 * Key of the transaction advisory lock that serialises budget checks across universes. Taken
 * after the personal root lock (blueprint §19 lock order: personal root → subordinate rows); no
 * code takes it first, so it cannot deadlock with the personal lock.
 */
const BUDGET_LOCK_KEY = 2_231_001;

/** The UTC day a reservation counts against (computed by the database, never by a JS Date). */
const today = sql<string>`(now() at time zone 'UTC')::date`;

const attemptColumns = [
  'id',
  'step',
  'state',
  'request_hash',
  'outcome_code',
  'output',
  'output_issues',
  'input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'cached_tokens',
] as const;

interface AttemptSelection {
  id: string;
  step: string;
  state: string;
  request_hash: string;
  outcome_code: string | null;
  output: unknown;
  output_issues: unknown;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cached_tokens: number | null;
}

function toRow(row: AttemptSelection): AttemptRow {
  return {
    id: row.id,
    step: row.step,
    state: row.state as AttemptState,
    requestHash: row.request_hash,
    outcomeCode: row.outcome_code,
    output: storedOutput(row.output),
    issues: storedIssues(row.output_issues),
    usage: {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      reasoningTokens: row.reasoning_tokens,
      cachedTokens: row.cached_tokens,
    },
  };
}

/** The stored output, if it has the shape this release writes; anything else counts as absent. */
function storedOutput(value: unknown): StoredModelOutput | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { v?: unknown; text?: unknown };
  return candidate.v === 1 && typeof candidate.text === 'string' ? { v: 1, text: candidate.text } : null;
}

function storedIssues(value: unknown): StoredOutputIssues | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { v?: unknown; reason?: unknown; issues?: unknown };
  if (candidate.v !== 1 || typeof candidate.reason !== 'string' || !Array.isArray(candidate.issues)) return null;
  const issues: OutputIssue[] = [];
  for (const item of candidate.issues as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const issue = item as { path?: unknown; code?: unknown; detail?: unknown };
    if (typeof issue.path !== 'string' || typeof issue.code !== 'string') continue;
    issues.push({
      path: issue.path,
      code: issue.code,
      ...(typeof issue.detail === 'string' ? { detail: issue.detail } : {}),
    });
  }
  return { v: 1, reason: candidate.reason, issues };
}

function quotaJson(quota: QuotaObservation): string {
  return JSON.stringify({
    v: 1,
    verdict: quota.verdict,
    intervalRemainingPercent: quota.intervalRemainingPercent,
    weeklyRemainingPercent: quota.weeklyRemainingPercent,
    ...(quota.reasonCode === undefined ? {} : { reasonCode: quota.reasonCode }),
  });
}

/** The receipt state that goes with an attempt state. */
function receiptState(state: AttemptState): 'held' | 'settled' | 'released' | 'unknown' | 'written_off' {
  switch (state) {
    case 'reserved':
    case 'dispatched':
      return 'held';
    case 'not_sent':
      return 'released';
    case 'succeeded':
    case 'failed':
    case 'reconciled':
      return 'settled';
    case 'unknown':
      return 'unknown';
    case 'written_off':
      return 'written_off';
  }
}

/** The usage columns of a settlement (only reported values; `null` stays unreported). */
function usageColumns(usage: ReportedUsage | undefined) {
  if (usage === undefined) return {};
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    reasoning_tokens: usage.reasoningTokens,
    cached_tokens: usage.cachedTokens,
  };
}

/** Attempts of a logical step: `step` itself and its later sequences `step.2`, `step.3`, … */
function ofLogicalStep(step: string) {
  return (eb: ExpressionBuilder<Database, 'reasoning.external_attempts'>): Expression<SqlBool> =>
    eb.or([eb('step', '=', step), eb('step', 'like', `${step}.%`)]);
}

/** Today's spend: requests not released, and their charge (reported usage, or the reservation). */
const receiptSpend = sql<{ requests: string; tokens: string }>`
  count(*) filter (where state <> 'released') as requests,
  coalesce(sum(case
    when state = 'released' then 0
    when input_tokens is not null and output_tokens is not null then input_tokens + output_tokens + coalesce(cached_tokens, 0)
    else reserved_tokens end), 0)::bigint as tokens`;

const attemptSpend = sql<{ requests: string; tokens: string }>`
  count(*) filter (where state <> 'not_sent') as requests,
  coalesce(sum(case
    when state = 'not_sent' then 0
    when input_tokens is not null and output_tokens is not null then input_tokens + output_tokens + coalesce(cached_tokens, 0)
    else reserved_tokens end), 0)::bigint as tokens`;

function spendOf(row: { requests: string; tokens: string } | undefined) {
  return { requests: Number(row?.requests ?? 0), tokens: Number(row?.tokens ?? 0) };
}

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
        .selectFrom('reasoning.external_attempts')
        .select(attemptColumns)
        .where('universe_id', '=', universeId)
        .where('run_id', '=', runId)
        .where(ofLogicalStep(step))
        .orderBy('reserved_at', 'desc')
        .orderBy('id', 'desc')
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
          'state',
          'fence',
        ])
        .where('universe_id', '=', universeId)
        .where('id', '=', run.id)
        .executeTakeFirstOrThrow();
      const same =
        row.owner_module === run.ownerModule &&
        row.purpose === run.purpose &&
        row.role_id === run.roleId &&
        row.role_version === run.roleVersion &&
        row.policy_version === run.policyVersion &&
        row.provider === run.provider &&
        row.model === run.model &&
        row.context_bundle_ref === run.contextBundleRef;
      if (!same) return { kind: 'mismatch' };
      if (row.state !== 'admitted') return { kind: 'closed' };
      return { kind: 'admitted', fence: row.fence };
    },

    async findLocked(scope, runId, step) {
      const row = await transactionOf(scope)
        .selectFrom('reasoning.external_attempts')
        .select(attemptColumns)
        .where('universe_id', '=', scope.authority.universeId)
        .where('run_id', '=', runId)
        .where(ofLogicalStep(step))
        .orderBy('reserved_at', 'desc')
        .orderBy('id', 'desc')
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
      const personal = await sql<{ requests: string; tokens: string }>`
        select ${attemptSpend} from reasoning.external_attempts
        where universe_id = ${scope.authority.universeId} and budget_window = ${today}`.execute(trx);
      return { global: spendOf(global.rows[0]), role: spendOf(role.rows[0]), scope: spendOf(personal.rows[0]) };
    },

    async reserve(scope, reservation) {
      const trx = transactionOf(scope);
      const universeId = scope.authority.universeId;
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
            ...(isSettled(to) ? { settled_at: sql<Date>`now()` } : {}),
            ...(details.remoteId === undefined ? {} : { remote_id: details.remoteId }),
            ...(details.outcomeCode === undefined ? {} : { outcome_code: details.outcomeCode }),
            ...(details.output === undefined ? {} : { output: JSON.stringify(details.output) }),
            ...(details.issues === undefined ? {} : { output_issues: JSON.stringify(details.issues) }),
            ...(details.quota === undefined ? {} : { quota_observation: quotaJson(details.quota) }),
            ...usageColumns(details.usage),
          })
          .where('universe_id', '=', attempt.universeId)
          .where('id', '=', attempt.attemptId)
          .where('state', '=', from)
          .executeTakeFirst();
        if (result.numUpdatedRows !== 1n) return false;
        await trx
          .updateTable('reasoning.usage_receipts')
          .set({
            state: receiptState(to),
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
        .selectFrom('reasoning.protected_requests')
        .select(['body'])
        .where('universe_id', '=', attempt.universeId)
        .where('attempt_id', '=', attempt.attemptId)
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
        .executeTakeFirst();
      return result.numUpdatedRows === 1n ? 'closed' : 'not_open';
    },

    writeOff(attemptId, reason, source) {
      return withTransaction(db, 'attempt-ledger', async (trx) => {
        const row = await trx
          .selectFrom('reasoning.external_attempts')
          .select(['universe_id', 'state'])
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
            written_off_reason: reason,
            written_off_by: source,
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
        const result = await sql`
          delete from reasoning.protected_requests
          where (universe_id, attempt_id) in (
            select universe_id, attempt_id from reasoning.protected_requests
            where expires_at <= now()
            order by expires_at
            limit ${limit}
            for update skip locked
          )`.execute(trx);
        return Number(result.numAffectedRows ?? 0n);
      });
    },
  };
}
