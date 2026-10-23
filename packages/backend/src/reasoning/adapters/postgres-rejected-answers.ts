import { sql, type Kysely } from 'kysely';
import type { Database } from '../../infrastructure/postgres/database.js';
import type { OutputIssue } from '../domain/output.js';
import type { RejectedAnswer, RejectedAnswerReader } from '../application/ports.js';
import { redactProviderText } from './recording.js';

/** Most characters of a refused answer kept (about 64 KiB of text). */
export const REJECTED_ANSWER_MAX_CHARS = 65_536;
/** Kept refused answers expire after this many days (migration 0045). */
export const REJECTED_ANSWER_RETENTION_DAYS = 30;

/** Redacts provider text at the recording boundary, then cuts it without splitting a surrogate pair. */
function boundedRedacted(text: string): { readonly text: string; readonly chars: number; readonly truncated: boolean } {
  const redacted = redactProviderText(text);
  if (redacted.length <= REJECTED_ANSWER_MAX_CHARS) return { text: redacted, chars: redacted.length, truncated: false };
  const last = redacted.charCodeAt(REJECTED_ANSWER_MAX_CHARS - 1);
  const cut = last >= 0xd800 && last <= 0xdbff ? REJECTED_ANSWER_MAX_CHARS - 1 : REJECTED_ANSWER_MAX_CHARS;
  return { text: redacted.slice(0, cut), chars: redacted.length, truncated: true };
}

/**
 * Diagnostics for refused answers of nonpersonal Scroll production (migration 0045). Written by the
 * production ledger after an attempt settled with an unusable answer; read and expired by the
 * operator. Never constructed for personal roles, so no personal answer text is kept.
 */
export function makeRejectedAnswerStore(db: Kysely<Database>) {
  return {
    /** Keeps one refused answer (redacted, at most 64 KiB) with the validator's findings; idempotent per attempt. */
    async record(answer: RejectedAnswer): Promise<void> {
      const kept = boundedRedacted(answer.text);
      await db
        .insertInto('reasoning.production_rejected_answers')
        .values({
          scope_id: answer.attempt.scopeId,
          attempt_id: answer.attempt.attemptId,
          reason: answer.reason,
          issues: JSON.stringify(answer.issues),
          answer_text: kept.text,
          answer_chars: kept.chars,
          truncated: kept.truncated,
          expires_at: sql<Date>`now() + make_interval(days => ${REJECTED_ANSWER_RETENTION_DAYS})`,
        })
        .onConflict((conflict) => conflict.columns(['scope_id', 'attempt_id']).doNothing())
        .execute();
    },

    /** Deletes up to `limit` expired rows; returns how many. */
    async purgeExpired(limit: number): Promise<number> {
      const result = await sql`
        delete from reasoning.production_rejected_answers
        where (scope_id, attempt_id) in (
          select scope_id, attempt_id from reasoning.production_rejected_answers
          where expires_at <= now()
          order by expires_at
          limit ${limit}
          for update skip locked
        )`.execute(db);
      return Number(result.numAffectedRows ?? 0n);
    },
  };
}

const detailColumns = [
  'rejected.attempt_id',
  'attempt.run_id',
  'attempt.step',
  'attempt.role_id',
  'attempt.role_version',
  'attempt.model',
  'rejected.reason',
  'rejected.answer_chars',
  'rejected.truncated',
  'rejected.recorded_at',
  'rejected.expires_at',
] as const;

/** The operator's reads of kept refused answers, newest first. */
export function makeRejectedAnswerReader(db: Kysely<Database>): RejectedAnswerReader {
  const base = () =>
    db
      .selectFrom('reasoning.production_rejected_answers as rejected')
      .innerJoin('reasoning.production_attempts as attempt', (join) =>
        join.onRef('attempt.scope_id', '=', 'rejected.scope_id').onRef('attempt.id', '=', 'rejected.attempt_id'),
      );
  return {
    async list(limit) {
      const rows = await base()
        .select([...detailColumns, sql<number>`jsonb_array_length(rejected.issues)`.as('issue_count')])
        .where('rejected.expires_at', '>', sql<Date>`now()`)
        .orderBy('rejected.recorded_at', 'desc')
        .limit(Math.min(Math.max(1, Math.trunc(limit)), 200))
        .execute();
      return rows.map((row) => ({
        attemptId: row.attempt_id,
        runId: row.run_id,
        step: row.step,
        roleId: row.role_id,
        roleVersion: row.role_version,
        model: row.model,
        reason: row.reason,
        issueCount: row.issue_count,
        answerChars: row.answer_chars,
        truncated: row.truncated,
        recordedAt: row.recorded_at,
        expiresAt: row.expires_at,
      }));
    },

    async read(attemptId) {
      const row = await base()
        .select([...detailColumns, 'rejected.issues', 'rejected.answer_text'])
        .where('rejected.attempt_id', '=', attemptId)
        .where('rejected.expires_at', '>', sql<Date>`now()`)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      return {
        attemptId: row.attempt_id,
        runId: row.run_id,
        step: row.step,
        roleId: row.role_id,
        roleVersion: row.role_version,
        model: row.model,
        reason: row.reason,
        issues: row.issues as unknown as readonly OutputIssue[],
        answerText: row.answer_text,
        answerChars: row.answer_chars,
        truncated: row.truncated,
        recordedAt: row.recorded_at,
        expiresAt: row.expires_at,
      };
    },
  };
}
