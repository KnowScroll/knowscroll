import { sql, type Transaction } from 'kysely';
import type { Database } from '../../infrastructure/postgres/database.js';
import type { AttemptState } from '../domain/attempts.js';
import type { ReportedUsage } from '../domain/budgets.js';
import type { OutputIssue } from '../domain/output.js';
import type {
  AttemptRow,
  QuotaObservation,
  SettlementDetails,
  StoredModelOutput,
  StoredOutputIssues,
} from '../application/ports.js';

/**
 * Key of the transaction advisory lock that serialises budget checks across universes. Taken
 * after the personal root lock (blueprint §19 lock order: personal root → subordinate rows); no
 * code takes it first, so it cannot deadlock with the personal lock.
 */
export const BUDGET_LOCK_KEY = 2_231_001;

/** The UTC day a reservation counts against (computed by the database, never by a JS Date). */
export const today = sql<string>`(now() at time zone 'UTC')::date`;

export const attemptColumns = [
  'attempt.id',
  'attempt.step',
  'attempt.state',
  'attempt.request_hash',
  'attempt.outcome_code',
  'attempt.output',
  'attempt.output_issues',
  'attempt.input_tokens',
  'attempt.output_tokens',
  'attempt.reasoning_tokens',
  'attempt.cached_tokens',
  'run.privacy_epoch as run_generation',
  'run.state as run_state',
] as const;

export const productionAttemptColumns = [
  ...attemptColumns.filter((column) => column !== 'run.privacy_epoch as run_generation'),
  'run.generation as run_generation',
] as const;

interface AttemptSelection {
  run_generation: number;
  run_state: string;
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

export function toRow(row: AttemptSelection): AttemptRow {
  return {
    runGeneration: row.run_generation,
    runState: row.run_state,
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

export function quotaJson(quota: QuotaObservation): string {
  return JSON.stringify({
    v: 1,
    verdict: quota.verdict,
    intervalRemainingPercent: quota.intervalRemainingPercent,
    weeklyRemainingPercent: quota.weeklyRemainingPercent,
    ...(quota.reasonCode === undefined ? {} : { reasonCode: quota.reasonCode }),
  });
}

/** Whether the provider reported any input or output count. */
function reportsUsage(usage: ReportedUsage | undefined): boolean {
  return usage !== undefined && (usage.inputTokens !== null || usage.outputTokens !== null);
}

/**
 * The receipt state that goes with an attempt state. A conclusive failure that reported no usage
 * (a refused connection, a 429 or 5xx before any work, an abort before the bytes left) is
 * `released`: it charges nothing, like `not_sent`. The same holds for a late conclusive rejection
 * that reconciled an `unknown` attempt. Anything that returned an answer (usable or not), or
 * reported usage, is `settled` and charged what it used.
 */
export function receiptState(
  state: AttemptState,
  details: SettlementDetails,
): 'held' | 'settled' | 'released' | 'unknown' | 'written_off' {
  switch (state) {
    case 'reserved':
    case 'dispatched':
      return 'held';
    case 'not_sent':
      return 'released';
    case 'failed':
    case 'reconciled':
      return details.output === undefined && details.issues === undefined && !reportsUsage(details.usage)
        ? 'released'
        : 'settled';
    case 'succeeded':
      return 'settled';
    case 'unknown':
      return 'unknown';
    case 'written_off':
      return 'written_off';
  }
}

/** The usage columns of a settlement (only reported values; `null` stays unreported). */
export function usageColumns(usage: ReportedUsage | undefined) {
  if (usage === undefined) return {};
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    reasoning_tokens: usage.reasoningTokens,
    cached_tokens: usage.cachedTokens,
  };
}

/** Today's spend: requests not released, and their charge (reported usage, or the reservation). */
export const receiptSpend = sql<{ requests: string; tokens: string }>`
  count(*) filter (where state <> 'released') as requests,
  coalesce(sum(case
    when state = 'released' then 0
    when input_tokens is not null and output_tokens is not null then input_tokens + output_tokens + coalesce(cached_tokens, 0)
    else reserved_tokens end), 0)::bigint as tokens`;

/**
 * Attempts that charge nothing: never sent, or concluded without an answer and without reported
 * usage (the same rule `receiptState` applies to the receipt).
 */
const attemptFree = sql`(state = 'not_sent' or (state in ('failed', 'reconciled')
  and input_tokens is null and output_tokens is null and output is null and output_issues is null))`;

export const attemptSpend = sql<{ requests: string; tokens: string }>`
  count(*) filter (where not ${attemptFree}) as requests,
  coalesce(sum(case
    when ${attemptFree} then 0
    when input_tokens is not null and output_tokens is not null then input_tokens + output_tokens + coalesce(cached_tokens, 0)
    else reserved_tokens end), 0)::bigint as tokens`;

export function spendOf(row: { requests: string; tokens: string } | undefined) {
  return { requests: Number(row?.requests ?? 0), tokens: Number(row?.tokens ?? 0) };
}

/** Policy v1: five unresolved/conclusively failed business runs per role and reservation UTC day.
 * The advisory lock is shared with budgets and held until attempt+receipt reservation commits.
 * A refunded failure keeps its slot. Successful/not-sent receipts release it; unknown/write-off
 * liabilities keep it. Existing run IDs, repairs and ledger reads never need another slot.
 */
export const ROLE_FAILURE_BRAKE_RUNS_PER_DAY = 5;

export async function canStartRoleRun(trx: Transaction<Database>, roleId: string): Promise<boolean> {
  await sql`select pg_advisory_xact_lock(${BUDGET_LOCK_KEY}::bigint)`.execute(trx);
  const result = await sql<{ runs: string }>`
    select count(*)::text as runs
    from reasoning.usage_receipts
    where role_id = ${roleId} and budget_window = ${today}
      and (conclusive_failure or state in ('held', 'unknown', 'written_off'))`.execute(trx);
  return Number(result.rows[0]?.runs ?? 0) < ROLE_FAILURE_BRAKE_RUNS_PER_DAY;
}
