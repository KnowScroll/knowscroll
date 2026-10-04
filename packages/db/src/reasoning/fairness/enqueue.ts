import type pg from 'pg';
import { FAIRNESS_CLASSES, fairnessCharge } from '../fairness-policy.ts';
import type { FairnessReadyInput } from './types.ts';
import { deny, policyFor } from './shared.ts';

/** Enqueue inside the caller's transaction, so a Job's creation and its ready membership commit
 * together (ADR-0033). Same checks and lock order as `enqueue`. */
export async function enqueueFairInTransaction(
  client: pg.PoolClient,
  input: FairnessReadyInput,
): Promise<void> {
  const { policy } = await policyFor(client, input.policyVersion);
  if (!FAIRNESS_CLASSES.includes(input.class)) deny('invalid_fairness_class');
  const charge = fairnessCharge(
    policy,
    input.inputTokensUpperBound,
    input.maxOutputTokens,
  );
  const universe = (
    await client.query<{ privacy_epoch: number }>(
      'SELECT privacy_epoch FROM universe WHERE id=$1 FOR UPDATE',
      [input.universeId],
    )
  ).rows[0];
  if (universe?.privacy_epoch !== input.privacyEpoch) deny('stale_epoch');
  const job = (
    await client.query<{
      universe_id: string;
      privacy_epoch: number;
      class: string;
      status: string;
      policy_version: string;
    }>('SELECT * FROM reasoning_job WHERE id=$1 FOR UPDATE', [input.jobId])
  ).rows[0];
  if (
    !job ||
    job.universe_id !== input.universeId ||
    job.privacy_epoch !== input.privacyEpoch ||
    job.class !== input.class ||
    job.status !== 'queued' ||
    job.policy_version !== input.policyVersion
  )
    deny('fairness_not_queueable');
  if (
    !(
      await client.query(
        `
     SELECT
       1
     FROM
       reasoning_step
     WHERE
       id = $1
       AND job_id = $2
       AND context_id = $3
       AND universe_id = $4
       AND privacy_epoch = $5
       AND status = 'pending'
     FOR UPDATE
   `,
        [
          input.stepId,
          input.jobId,
          input.contextId,
          input.universeId,
          input.privacyEpoch,
        ],
      )
    ).rowCount
  )
    deny('fairness_not_queueable');
  await client.query(
    'SELECT policy_version FROM reasoning_fairness_scheduler WHERE policy_version=$1 FOR UPDATE',
    [input.policyVersion],
  );
  await client.query(
    `
     INSERT INTO
       reasoning_fairness_universe (policy_version, class, universe_id)
     VALUES
       ($1, $2, $3)
     ON CONFLICT DO NOTHING
   `,
    [input.policyVersion, input.class, input.universeId],
  );
  await client.query(
    `
     UPDATE reasoning_fairness_universe
     SET
       credit = LEAST(credit, 0)
     WHERE
       policy_version = $1
       AND class = $2
       AND universe_id = $3
       AND ready_count = 0
   `,
    [input.policyVersion, input.class, input.universeId],
  );
  if (
    !(
      await client.query(
        `
     SELECT
       1
     FROM
       reasoning_fairness_universe
     WHERE
       policy_version = $1
       AND class = $2
       AND ready_count > 0
     LIMIT
       1
   `,
        [input.policyVersion, input.class],
      )
    ).rowCount
  )
    await client.query(
      `
     UPDATE reasoning_fairness_class
     SET
       credit = LEAST(credit, 0),
       remaining = NULL,
       open_universe_id = NULL,
       universe_remaining = 0
     WHERE
       policy_version = $1
       AND class = $2
   `,
      [input.policyVersion, input.class],
    );
  await client.query(
    `
     INSERT INTO
       reasoning_fairness_ready (
         job_id,
         step_id,
         context_id,
         universe_id,
         privacy_epoch,
         class,
         policy_version,
         request_id,
         request_hash,
         input_tokens_upper_bound,
         max_output_tokens,
         cost_ceiling_micro_usd,
         deadline,
         permit_ttl_ms,
         charge
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
         $14,
         $15
       )
   `,
    [
      input.jobId,
      input.stepId,
      input.contextId,
      input.universeId,
      input.privacyEpoch,
      input.class,
      input.policyVersion,
      input.requestId,
      input.requestHash,
      input.inputTokensUpperBound,
      input.maxOutputTokens,
      input.costCeilingMicroUsd,
      input.deadline,
      input.permitTtlMs,
      charge,
    ],
  );
  await client.query(
    `
     UPDATE reasoning_fairness_universe
     SET
       ready_count = ready_count + 1
     WHERE
       policy_version = $1
       AND class = $2
       AND universe_id = $3
   `,
    [input.policyVersion, input.class, input.universeId],
  );
  await client.query(
    'UPDATE reasoning_fairness_scheduler SET generation=generation+1 WHERE policy_version=$1',
    [input.policyVersion],
  );
}
