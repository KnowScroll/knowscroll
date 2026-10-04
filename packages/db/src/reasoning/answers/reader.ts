import type pg from 'pg';
import { z } from 'zod';
import type { AuthScope } from '../../identity.ts';
import {
  cancelIdleDirectJob,
  isIdleWithdrawalIneligible,
} from '../idle-lifecycle.ts';
import { AskAnswerError, type RequestRow } from './shared.ts';
import { insertAnswer } from './worker.ts';

export type AskAnswerView = {
  askId: string;
  status:
    | 'queued'
    | 'running'
    | 'answered'
    | 'not_in_source'
    | 'rejected'
    | 'failed'
    | 'cancelled'
    | 'unavailable';
  answer: string | null;
  basis: { quote: string }[];
  limits: string | null;
  reasons: string[];
  requestedAt: string;
  answeredAt: string | null;
  /** ADR-0044: whether the reader kept this answer as a Relic, and whether they said it seems wrong. */
  kept: boolean;
  seemsWrong: boolean;
};
/** The reader's view of an answer request, from this universe only. */
export async function readAskAnswer(
  client: pg.PoolClient,
  scope: AuthScope,
  askId: string,
): Promise<AskAnswerView | null> {
  if (!z.string().uuid().safeParse(askId).success) return null;
  const request = (
    await client.query<RequestRow>(
      'SELECT * FROM ask_answer_request WHERE ask_id=$1 AND universe_id=$2 AND privacy_epoch=$3',
      [askId, scope.universeId, scope.privacyEpoch],
    )
  ).rows[0];
  if (!request) return null;
  const answer = (
    await client.query<{
      status: AskAnswerView['status'];
      answer: string | null;
      basis: { quote: string }[];
      limits: string | null;
      reasons: string[];
      created_at: Date;
    }>(
      'SELECT status,answer,basis,limits,reasons,created_at FROM ask_answer WHERE ask_id=$1',
      [askId],
    )
  ).rows[0];
  const marks = (
    await client.query<{ kept: boolean; seems_wrong: boolean }>(
      `
      SELECT
        EXISTS (
          SELECT
            1
          FROM
            relic
          WHERE
            universe_id = $1
            AND privacy_epoch = $2
            AND kind = 'answer'
            AND ask_id = $3
        ) AS kept,
        EXISTS (
          SELECT
            1
          FROM
            reader_objection
          WHERE
            universe_id = $1
            AND privacy_epoch = $2
            AND kind = 'answer'
            AND ask_id = $3
        ) AS seems_wrong
    `,
      [scope.universeId, scope.privacyEpoch, askId],
    )
  ).rows[0]!;
  const base = {
    askId,
    requestedAt: request.requested_at.toISOString(),
    kept: marks.kept,
    seemsWrong: marks.seems_wrong,
  };
  if (answer)
    return {
      ...base,
      status: answer.status,
      answer: answer.answer,
      basis: answer.basis,
      limits: answer.limits,
      reasons: answer.reasons,
      answeredAt: answer.created_at.toISOString(),
    };
  const job = (
    await client.query<{ status: string; past: boolean }>(
      'SELECT status, deadline <= clock_timestamp() AS past FROM reasoning_job WHERE id=$1',
      [request.job_id],
    )
  ).rows[0];
  // Past its deadline an unfinished answer will not arrive (a worker may have stopped mid-call, and a
  // possibly-sent request is never repeated): say so instead of "running" forever.
  const status: AskAnswerView['status'] =
    !job || job.past
      ? job?.status === 'cancelled'
        ? 'cancelled'
        : 'unavailable'
      : job.status === 'queued'
        ? 'queued'
        : ['running', 'waiting'].includes(job.status)
          ? 'running'
          : job.status === 'cancelled'
            ? 'cancelled'
            : 'unavailable';
  return {
    ...base,
    status,
    answer: null,
    basis: [],
    limits: null,
    reasons: [],
    answeredAt: null,
  };
}
/**
 * Withdraw an answer that has not started (ADR-0018 idle withdrawal, original session only). A
 * running answer ends by its own outcome or deadline; asking to cancel it is a 409, not a hidden race.
 */
export async function cancelAskAnswer(
  client: pg.PoolClient,
  scope: AuthScope,
  askId: string,
  raw: unknown,
): Promise<AskAnswerView> {
  const parsed = z
    .object({ expectedPrivacyEpoch: z.number().int().min(0).max(2147483647) })
    .strict()
    .safeParse(raw);
  if (!parsed.success || !z.string().uuid().safeParse(askId).success)
    throw new AskAnswerError(400, 'Invalid cancel request');
  if (parsed.data.expectedPrivacyEpoch !== scope.privacyEpoch)
    throw new AskAnswerError(409, 'Cancel privacy epoch is stale');
  const request = (
    await client.query<RequestRow>(
      'SELECT * FROM ask_answer_request WHERE ask_id=$1 AND universe_id=$2 AND privacy_epoch=$3',
      [askId, scope.universeId, scope.privacyEpoch],
    )
  ).rows[0];
  if (!request)
    throw new AskAnswerError(404, 'No answer was requested for this Ask');
  const settled = (
    await client.query('SELECT 1 FROM ask_answer WHERE ask_id=$1', [askId])
  ).rowCount;
  if (!settled) {
    try {
      const result = await cancelIdleDirectJob(client, scope, {
        jobId: request.job_id,
      });
      if (result.status !== 'cancelled')
        throw new AskAnswerError(409, 'This answer is no longer waiting');
      await insertAnswer(client, request, null, {
        status: 'cancelled',
        reasons: ['cancelled_by_reader'],
      });
    } catch (error) {
      if (isIdleWithdrawalIneligible(error))
        throw new AskAnswerError(409, 'This answer has already started');
      throw error;
    }
  }
  return (await readAskAnswer(client, scope, askId))!;
}
