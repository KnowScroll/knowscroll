/**
 * The only path from a recorded Ask to an answer Job (ADR-0033 §1). It runs in the caller's
 * authenticated transaction; a retried request key replays its receipt, and the same key for another
 * Ask is refused. Never sends anything: it queues the Job.
 */
import { createHash, randomUUID } from 'node:crypto';
import { serializeAskAnswerRequest } from '@knowscroll/core/reasoning/ask-answer';
import type pg from 'pg';
import { z } from 'zod';
import type { AuthScope } from '../../identity.ts';
import { isRecordingPaused } from '../../sql/recording-paused.ts';
import { compileDirectAskContext } from '../ask-context.ts';
import { enqueueFairInTransaction } from '../fairness.ts';
import { resolveAnswerPolicy, sourceOf } from './route.ts';
import { AskAnswerError, type RequestRow, type Route } from './shared.ts';

export const askAnswerRequestInput = z
  .object({
    clientRequestId: z.string().uuid(),
    expectedPrivacyEpoch: z.number().int().min(0).max(2147483647),
  })
  .strict();
export type AnswerRequestReceipt = {
  requestId: string;
  askId: string;
  jobId: string;
  status: 'queued';
};
/**
 * The fresh authority (ADR-0033 §1). The caller holds the authenticated universe lock
 * (`authenticateAndLock`); this acquires the original session, Job and asset locks in ADR-0017 order.
 */
export async function requestAskAnswer(
  client: pg.PoolClient,
  scope: AuthScope,
  askId: string,
  raw: unknown,
): Promise<AnswerRequestReceipt> {
  const parsed = askAnswerRequestInput.safeParse(raw);
  if (!parsed.success || !z.string().uuid().safeParse(askId).success)
    throw new AskAnswerError(400, 'Invalid answer request');
  const input = parsed.data;
  if (input.expectedPrivacyEpoch !== scope.privacyEpoch)
    throw new AskAnswerError(409, 'Answer request privacy epoch is stale');

  const receipt = (r: RequestRow): AnswerRequestReceipt => ({
    requestId: r.id,
    askId: r.ask_id,
    jobId: r.job_id,
    status: 'queued',
  });
  const byKey = (
    await client.query<RequestRow>(
      'SELECT * FROM ask_answer_request WHERE universe_id=$1 AND client_request_id=$2',
      [scope.universeId, input.clientRequestId],
    )
  ).rows[0];
  if (byKey) {
    if (byKey.ask_id !== askId)
      throw new AskAnswerError(
        409,
        'Answer request key reused for another Ask',
      );
    return receipt(byKey);
  }
  if (
    (
      await client.query('SELECT 1 FROM ask_answer_request WHERE ask_id=$1', [
        askId,
      ])
    ).rowCount
  )
    throw new AskAnswerError(
      409,
      'An answer was already requested for this Ask',
    );

  const paused = await isRecordingPaused(client, scope.universeId);
  if (paused) throw new AskAnswerError(409, 'Recording is paused');
  const route = (
    await client.query<Route>('SELECT * FROM ask_answer_route WHERE enabled')
  ).rows[0];
  if (!route)
    throw new AskAnswerError(503, 'Answers are not enabled on this deployment');

  const ask = (
    await client.query<{ session_id: string }>(
      'SELECT session_id FROM explicit_ask WHERE id=$1 AND universe_id=$2 AND privacy_epoch=$3',
      [askId, scope.universeId, scope.privacyEpoch],
    )
  ).rows[0];
  if (!ask) throw new AskAnswerError(404, 'No such Ask');
  // ADR-0017: the authority is the Ask's own original session; another valid session cannot substitute.
  if (ask.session_id !== scope.sessionId)
    throw new AskAnswerError(
      409,
      'Only the session that asked can request its answer',
    );

  (
    await client.query<{ bucket_id: string }>(
      'SELECT bucket_id FROM ask_answer_owner_bucket WHERE policy_version=$1 AND universe_id=$2',
      [route.policy_version, scope.universeId],
    )
  ).rows[0]?.bucket_id ??
    (await (async () => {
      const id = randomUUID();
      await client.query(
        "INSERT INTO reasoning_bucket(id,dimension,unit,capacity) VALUES($1,'owner_budget','tokens',$2)",
        [id, route.owner_capacity],
      );
      await client.query(
        'INSERT INTO ask_answer_owner_bucket(policy_version,universe_id,bucket_id) VALUES($1,$2,$3)',
        [route.policy_version, scope.universeId, id],
      );
      return id;
    })());
  const jobId = randomUUID(),
    contextId = randomUUID(),
    stepId = randomUUID(),
    requestId = randomUUID(),
    rowId = randomUUID(),
    jobBucket = randomUUID();
  await client.query(
    "INSERT INTO reasoning_bucket(id,dimension,unit,capacity) VALUES($1,'job_budget','tokens',$2)",
    [jobBucket, route.job_capacity],
  );
  const deadline = (
    await client.query<{ at: Date }>(
      `SELECT clock_timestamp() + ($1 * interval '1 second') AS at`,
      [route.answer_ttl_seconds],
    )
  ).rows[0]!.at;
  await client.query(
    `
      INSERT INTO
        reasoning_job (
          id,
          universe_id,
          privacy_epoch,
          status,
          class,
          budget_owner_id,
          policy_version,
          deadline,
          wake_kind,
          intent_id
        )
      VALUES
        (
          $1,
          $2,
          $3,
          'queued',
          'interactive',
          $2,
          $4,
          $5,
          'direct',
          $6
        )
    `,
    [
      jobId,
      scope.universeId,
      scope.privacyEpoch,
      route.policy_version,
      deadline,
      askId,
    ],
  );
  // The request row first, so the policy resolver can see the Job's buckets while compiling.
  await client.query(
    `
      INSERT INTO
        ask_answer_request (
          id,
          ask_id,
          universe_id,
          privacy_epoch,
          session_id,
          client_request_id,
          policy_version,
          job_id,
          step_id,
          context_id,
          request_id,
          request_hash,
          input_bytes,
          job_bucket_id
        )
      VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13,
          $14
        )
    `,
    [
      rowId,
      askId,
      scope.universeId,
      scope.privacyEpoch,
      scope.sessionId,
      input.clientRequestId,
      route.policy_version,
      jobId,
      stepId,
      contextId,
      requestId,
      null,
      null,
      jobBucket,
    ],
  );
  await compileDirectAskContext(
    client,
    scope,
    { contextId, jobId, askId },
    resolveAnswerPolicy,
  );
  await client.query(
    `
    INSERT INTO
      reasoning_step (
        id,
        job_id,
        universe_id,
        privacy_epoch,
        context_id,
        ordinal,
        status
      )
    VALUES
      ($1, $2, $3, $4, $5, 1, 'pending')
  `,
    [stepId, jobId, scope.universeId, scope.privacyEpoch, contextId],
  );

  const payload = (
    await client.query<{ canonical_payload: string }>(
      'SELECT canonical_payload FROM reasoning_context_payload WHERE context_id=$1',
      [contextId],
    )
  ).rows[0]!;
  const bytes = serializeAskAnswerRequest(sourceOf(payload.canonical_payload), {
    model: route.model,
    maxOutputTokens: route.max_output_tokens,
  });
  if (bytes.byteLength > route.max_input_tokens)
    throw new AskAnswerError(
      409,
      'This Scroll is too long to answer within the configured request bound',
    );
  const requestHash = createHash('sha256').update(bytes).digest('hex');
  // The one permitted completion of the request row (migration 0028 refuses any other update).
  await client.query(
    'UPDATE ask_answer_request SET request_hash=$2,input_bytes=$3 WHERE id=$1',
    [rowId, requestHash, bytes.byteLength],
  );

  await enqueueFairInTransaction(client, {
    universeId: scope.universeId,
    privacyEpoch: scope.privacyEpoch,
    jobId,
    stepId,
    contextId,
    requestId,
    requestHash,
    inputTokensUpperBound: bytes.byteLength,
    maxOutputTokens: route.max_output_tokens,
    costCeilingMicroUsd: null,
    deadline: deadline.toISOString(),
    permitTtlMs: 60_000,
    policyVersion: route.policy_version,
    class: 'interactive',
  });
  return { requestId: rowId, askId, jobId, status: 'queued' };
}
