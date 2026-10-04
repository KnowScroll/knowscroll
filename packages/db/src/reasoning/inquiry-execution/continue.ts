/** The ADR-0042 §1 continuation: supersede a refused Step and queue the next, never sending from here. */
import { randomUUID } from 'node:crypto';
import {
  type InquiryContextPayload,
  inquiryAssistantTurn,
} from '@knowscroll/contracts/reasoning-inquiry-context';
import {
  type ContinuationTurn,
  serializeBridgeInquiryRequest,
} from '@knowscroll/core/reasoning/bridge-inquiry';
import type pg from 'pg';
import { enqueueFairInTransaction } from '../fairness.ts';
import {
  type InquiryRow,
  inquiryRouteFor,
  requestRoute,
} from '../inquiries.ts';
import { continuationTurns, type InquiryFence, sha } from './load.ts';

/**
 * ADR-0042 §1: the validator refused this Step's proposal (already recorded). Within the route's bound,
 * and only if the next request still fits it, the refused Step is superseded, the next Step is created on
 * the same sealed context with its exact request (the refused turn is kept as protected runtime data),
 * the lease is released and the Step is queued fairly. Returns its ordinal, or null: the refusal stands.
 */
export async function continueInquiry(
  client: pg.PoolClient,
  f: InquiryFence,
  inquiry: InquiryRow,
  payload: InquiryContextPayload,
  refused: ContinuationTurn,
): Promise<number | null> {
  const route = await inquiryRouteFor(client, inquiry.policy_version!);
  const step = (
    await client.query<{ ordinal: number; deadline: Date }>(
      `
      SELECT
        s.ordinal,
        j.deadline
      FROM
        reasoning_step s
        JOIN reasoning_job j ON j.id = s.job_id
      WHERE
        s.id = $1
    `,
      [f.stepId],
    )
  ).rows[0]!;
  const turn = inquiryAssistantTurn.safeParse(refused.assistant);
  if (!route || step.ordinal > route.max_continuation_steps || !turn.success)
    return null;
  const { turns } = await continuationTurns(client, f.jobId, step.ordinal);
  const body = serializeBridgeInquiryRequest(
    payload.pairs,
    requestRoute(route),
    [...turns, { assistant: turn.data, reasons: refused.reasons }],
  );
  if (body.byteLength > route.max_input_tokens) return null;
  const next = {
    stepId: randomUUID(),
    requestId: randomUUID(),
    ordinal: step.ordinal + 1,
    requestHash: sha(body),
  };
  await client.query(
    "UPDATE reasoning_accounting SET output_authority='withdrawn' WHERE attempt_id=$1",
    [f.attemptId],
  );
  await client.query('UPDATE reasoning_attempt SET active=false WHERE id=$1', [
    f.attemptId,
  ]);
  await client.query(
    "UPDATE reasoning_step SET status='superseded' WHERE id=$1",
    [f.stepId],
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
      ($1, $2, $3, $4, $5, $6, 'pending')
  `,
    [
      next.stepId,
      f.jobId,
      f.universeId,
      f.privacyEpoch,
      inquiry.context_id,
      next.ordinal,
    ],
  );
  await client.query(
    `
      INSERT INTO
        background_inquiry_continuation (
          step_id,
          job_id,
          context_id,
          universe_id,
          privacy_epoch,
          inquiry_id,
          ordinal,
          previous_attempt_id,
          request_id,
          request_hash,
          input_bytes,
          reasons,
          assistant_turn
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
          $13
        )
    `,
    [
      next.stepId,
      f.jobId,
      inquiry.context_id,
      f.universeId,
      f.privacyEpoch,
      inquiry.id,
      next.ordinal,
      f.attemptId,
      next.requestId,
      next.requestHash,
      body.byteLength,
      JSON.stringify(refused.reasons),
      JSON.stringify(turn.data),
    ],
  );
  await client.query(
    `UPDATE reasoning_job SET status='queued',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`,
    [f.jobId],
  );
  await enqueueFairInTransaction(client, {
    universeId: f.universeId,
    privacyEpoch: f.privacyEpoch,
    jobId: f.jobId,
    stepId: next.stepId,
    contextId: inquiry.context_id!,
    requestId: next.requestId,
    requestHash: next.requestHash,
    inputTokensUpperBound: body.byteLength,
    maxOutputTokens: route.max_output_tokens,
    costCeilingMicroUsd: null,
    deadline: step.deadline.toISOString(),
    permitTtlMs: 60_000,
    policyVersion: route.policy_version,
    class: 'background_inquiry',
  });
  return next.ordinal;
}
