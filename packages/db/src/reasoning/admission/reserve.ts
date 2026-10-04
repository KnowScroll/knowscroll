import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { lockBoundContextSession } from '../context-session.ts';
import {
  lockFairnessResources,
  releaseNotSentFairness,
} from '../fairness-accounting.ts';
import {
  reservationAmount,
  type ReasoningAuthority,
  type ResolvedReasoningPolicy,
} from '../runtime-policy.ts';
import {
  hashPattern,
  deny,
  validBoundedInteger,
  validateUuid,
  validateFence,
  transaction,
  validateOwnerAndDuration,
  lockUniverse,
  lockCurrentJob,
  resolveAndValidatePolicy,
  lockPolicyBuckets,
  assertBucketBindings,
} from './guards.ts';
import type {
  ReserveAttemptInput,
  ReservedAttempt,
  JobRow,
  ReasoningPreflightInput,
  ReasoningPreflight,
} from './types.ts';

/** Internal closure primitive; caller owns universe/Job/Attempt/accounting locks.
 * When bucketsAlreadyLocked, caller also owns the complete fairness/bucket union. */
export async function releaseUnconsumed(
  client: pg.PoolClient,
  attemptId: string,
  permitId: string,
  bucketsAlreadyLocked = false,
): Promise<void> {
  if (!bucketsAlreadyLocked) await lockFairnessResources(client, [attemptId]);
  const reservations = await client.query<{
    bucket_id: string;
    amount: string;
  }>(
    `
      SELECT
        bucket_id,
        amount
      FROM
        reasoning_reservation
      WHERE
        attempt_id = $1
        AND state = 'held'
      ORDER BY
        bucket_id
      FOR UPDATE
    `,
    [attemptId],
  );
  if (reservations.rows.length > 0) {
    const bucketIds = reservations.rows.map((row) => row.bucket_id);
    if (!bucketsAlreadyLocked) {
      await client.query(
        'SELECT id FROM reasoning_bucket WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [bucketIds],
      );
    }
    for (const reservation of reservations.rows) {
      const released = await client.query(
        'UPDATE reasoning_bucket SET reserved=reserved-$2::bigint WHERE id=$1 AND reserved >= $2::bigint',
        [reservation.bucket_id, reservation.amount],
      );
      if (released.rowCount !== 1) deny('reservation_counter_mismatch');
    }
    await client.query(
      "UPDATE reasoning_reservation SET state='released' WHERE attempt_id=$1 AND state='held'",
      [attemptId],
    );
  }
  const permit = await client.query(
    `
      UPDATE reasoning_permit
      SET
        state = 'revoked',
        closed_at = clock_timestamp()
      WHERE
        id = $1
        AND attempt_id = $2
        AND state = 'reserved'
    `,
    [permitId, attemptId],
  );
  if (permit.rowCount !== 1) deny('permit_not_releasable');
  await client.query(
    `
      UPDATE reasoning_accounting
      SET
        state = 'not_sent',
        output_authority = 'withdrawn',
        liability_state = 'settled',
        remote_state = 'released',
        remote_disposition = 'not_sent',
        reconciliation_hold = FALSE,
        idempotency_hold = FALSE,
        closure_basis = 'evidence',
        all_duties_closed_at = clock_timestamp()
      WHERE
        attempt_id = $1
        AND state = 'reserved'
        AND dispatch_id IS NULL
    `,
    [attemptId],
  );
  await releaseNotSentFairness(client, attemptId);
  await client.query(
    'UPDATE reasoning_attempt SET active=false WHERE id=$1 AND active',
    [attemptId],
  );
}

/** Prepare a service opportunity, never a lease or permit. Caller owns the
 * transaction. Shared scheduler locks belong in the hook, before bucket locks.
 * This repeats live authority checks and may be used only for queued work.
 */
export async function preflightAttemptInTransaction(
  client: pg.PoolClient,
  authority: ReasoningAuthority,
  input: ReasoningPreflightInput,
  beforeResourceLocks?: (
    client: pg.PoolClient,
    resolved: { policy: ResolvedReasoningPolicy; bindingHash: string },
  ) => Promise<void>,
): Promise<ReasoningPreflight> {
  validateOwnerAndDuration('fairness', input.permitTtlMs, 'permit');
  for (const [value, code] of [
    [input.universeId, 'invalid_universe_id'],
    [input.jobId, 'invalid_job_id'],
    [input.stepId, 'invalid_step_id'],
    [input.contextId, 'invalid_context_id'],
    [input.requestId, 'invalid_request_id'],
  ] as const)
    validateUuid(value, code);
  if (!hashPattern.test(input.requestHash)) deny('invalid_request_hash');
  if (
    !validBoundedInteger(input.inputTokensUpperBound, 1) ||
    !validBoundedInteger(input.maxOutputTokens, 1)
  )
    deny('invalid_token_bound');
  if (
    input.costCeilingMicroUsd !== null &&
    !validBoundedInteger(input.costCeilingMicroUsd, 1)
  )
    deny('invalid_cost_ceiling');
  if (!Number.isFinite(Date.parse(input.deadline))) deny('invalid_deadline');
  await lockUniverse(client, input.universeId, input.privacyEpoch);
  await lockBoundContextSession(client, input);
  const job = (
    await client.query<JobRow>(
      `SELECT * FROM reasoning_job WHERE id=$1 AND universe_id=$2 AND privacy_epoch=$3 FOR UPDATE`,
      [input.jobId, input.universeId, input.privacyEpoch],
    )
  ).rows[0];
  if (!job || job.status !== 'queued') deny('job_not_queued');
  const step = (
    await client.query(
      `
    SELECT
      status,
      context_id
    FROM
      reasoning_step
    WHERE
      id = $1
      AND job_id = $2
      AND universe_id = $3
      AND privacy_epoch = $4
    FOR UPDATE
  `,
      [input.stepId, input.jobId, input.universeId, input.privacyEpoch],
    )
  ).rows[0];
  if (!step || step.context_id !== input.contextId) deny('unknown_step');
  if (step.status !== 'pending') deny('step_not_pending');
  if (
    (
      await client.query(
        'SELECT 1 FROM reasoning_attempt WHERE step_id=$1 LIMIT 1',
        [input.stepId],
      )
    ).rowCount
  )
    deny('retry_not_supported');
  const scope = {
    universeId: input.universeId,
    privacyEpoch: input.privacyEpoch,
    jobId: input.jobId,
  };
  const context = {
    ...scope,
    stepId: input.stepId,
    contextId: input.contextId,
    policyVersion: job.policy_version,
  };
  if (!(await authority.validateContext(client, context, 'lock')))
    deny('stale_context');
  const { policy, bindingHash } = await resolveAndValidatePolicy(
    client,
    authority,
    scope,
  );
  if (policy.policyVersion !== job.policy_version)
    deny('policy_version_mismatch');
  if (
    input.inputTokensUpperBound > policy.maxInputTokens ||
    input.maxOutputTokens > policy.maxOutputTokens
  )
    deny('policy_limit_exceeded');
  await beforeResourceLocks?.(client, { policy, bindingHash });
  const buckets = await lockPolicyBuckets(client, policy);
  for (const binding of policy.buckets) {
    const bucket = buckets.get(binding.bucketId)!;
    if (
      bucket.dimension !== binding.dimension ||
      bucket.unit !== binding.unit ||
      bucket.window_id !== binding.windowId
    )
      deny('bucket_binding_changed');
  }
  if (
    (await resolveAndValidatePolicy(client, authority, scope)).bindingHash !==
    bindingHash
  )
    deny('policy_binding_changed');
  if (!(await authority.validateContext(client, context, 'recheck')))
    deny('stale_context');
  const valid = (
    await client.query(
      `
    SELECT
      1
    FROM
      reasoning_job
    WHERE
      id = $1
      AND status = 'queued'
      AND deadline > clock_timestamp()
      AND $2::timestamptz > clock_timestamp()
      AND $2::timestamptz <= deadline
  `,
      [input.jobId, input.deadline],
    )
  ).rowCount;
  if (!valid) deny('invalid_deadline');
  const demands = policy.buckets.map((binding) => ({
    bucket: buckets.get(binding.bucketId)!,
    amount: BigInt(
      reservationAmount(
        binding,
        input.inputTokensUpperBound,
        input.maxOutputTokens,
        input.costCeilingMicroUsd,
      ),
    ),
  }));
  const physicallyFits = demands.some(
    ({ bucket, amount }) => amount > BigInt(bucket.capacity),
  )
    ? 'impossible'
    : demands.some(({ bucket }) => bucket.paused)
      ? 'paused'
      : demands.some(
            ({ bucket, amount }) =>
              BigInt(bucket.reserved) + BigInt(bucket.consumed) + amount >
              BigInt(bucket.capacity),
          )
        ? 'capacity_exhausted'
        : 'fit';
  return { policy, bindingHash, physicallyFits };
}

/** Internal composition seam. Caller owns BEGIN/COMMIT and rolls back on every denial.
 * The optional scheduler hook runs after private locks and before shared physical
 * resources. It must perform only short SQL work, never commit or call a provider.
 */
export async function reserveAttemptInTransaction(
  client: pg.PoolClient,
  authority: ReasoningAuthority,
  input: ReserveAttemptInput,
  beforeResourceLocks?: (
    client: pg.PoolClient,
    resolved: { policy: ResolvedReasoningPolicy; bindingHash: string },
  ) => Promise<void>,
  contextPhase: 'lock' | 'recheck' = 'lock',
): Promise<ReservedAttempt> {
  validateOwnerAndDuration(input.owner, input.permitTtlMs, 'permit');
  validateFence(input.leaseFence);
  for (const [value, code] of [
    [input.universeId, 'invalid_universe_id'],
    [input.jobId, 'invalid_job_id'],
    [input.stepId, 'invalid_step_id'],
    [input.contextId, 'invalid_context_id'],
    [input.requestId, 'invalid_request_id'],
  ] as const) {
    validateUuid(value, code);
  }
  if (!hashPattern.test(input.requestHash)) deny('invalid_request_hash');
  if (
    !validBoundedInteger(input.inputTokensUpperBound, 1) ||
    !validBoundedInteger(input.maxOutputTokens, 1)
  )
    deny('invalid_token_bound');
  if (
    input.costCeilingMicroUsd !== null &&
    !validBoundedInteger(input.costCeilingMicroUsd, 1)
  )
    deny('invalid_cost_ceiling');
  const deadlineMs = Date.parse(input.deadline);
  if (!Number.isFinite(deadlineMs)) deny('invalid_deadline');

  await lockUniverse(client, input.universeId, input.privacyEpoch);
  if (contextPhase === 'lock') await lockBoundContextSession(client, input);
  const job = await lockCurrentJob(client, input);
  if (job.status !== 'running') deny('job_not_running');
  const stepResult = await client.query<{ context_id: string; status: string }>(
    `
      SELECT
        context_id,
        status
      FROM
        reasoning_step
      WHERE
        id = $1
        AND job_id = $2
        AND universe_id = $3
        AND privacy_epoch = $4
      FOR UPDATE
    `,
    [input.stepId, input.jobId, input.universeId, input.privacyEpoch],
  );
  const step = stepResult.rows[0];
  if (!step || step.context_id !== input.contextId) deny('unknown_step');
  if (step.status !== 'pending') deny('step_not_pending');
  if (
    (
      await client.query(
        'SELECT 1 FROM reasoning_attempt WHERE step_id=$1 LIMIT 1',
        [input.stepId],
      )
    ).rowCount
  )
    deny('retry_not_supported');
  const deadline = await client.query<{ valid: boolean }>(
    'SELECT $1::timestamptz>clock_timestamp() AND $1::timestamptz<=$2::timestamptz AS valid',
    [input.deadline, job.deadline],
  );
  if (!deadline.rows[0]?.valid) deny('invalid_deadline');
  const scope = {
    universeId: input.universeId,
    privacyEpoch: input.privacyEpoch,
    jobId: input.jobId,
  };
  if (
    !(await authority.validateContext(
      client,
      {
        ...scope,
        stepId: input.stepId,
        contextId: input.contextId,
        policyVersion: job.policy_version,
      },
      contextPhase,
    ))
  ) {
    deny('stale_context');
  }
  const { policy, bindingHash } = await resolveAndValidatePolicy(
    client,
    authority,
    scope,
  );
  if (policy.policyVersion !== job.policy_version)
    deny('policy_version_mismatch');
  if (
    input.inputTokensUpperBound > policy.maxInputTokens ||
    input.maxOutputTokens > policy.maxOutputTokens
  )
    deny('policy_limit_exceeded');
  await beforeResourceLocks?.(client, { policy, bindingHash });
  const buckets = await lockPolicyBuckets(client, policy);
  assertBucketBindings(policy, buckets);
  if (
    (await resolveAndValidatePolicy(client, authority, scope)).bindingHash !==
    bindingHash
  )
    deny('policy_binding_changed');
  if (
    !(await authority.validateContext(
      client,
      {
        ...scope,
        stepId: input.stepId,
        contextId: input.contextId,
        policyVersion: job.policy_version,
      },
      'recheck',
    ))
  ) {
    deny('stale_context');
  }
  const stillCurrent = await client.query(
    `
      SELECT
        1
      FROM
        reasoning_job
      WHERE
        id = $1
        AND status = 'running'
        AND lease_owner = $2
        AND lease_fence = $3::bigint
        AND lease_expires_at > clock_timestamp()
        AND deadline > clock_timestamp()
        AND $4::timestamptz > clock_timestamp()
    `,
    [input.jobId, input.owner, input.leaseFence, input.deadline],
  );
  if (stillCurrent.rowCount !== 1) deny('expired_lease_or_job');
  const reservations = policy.buckets
    .map((binding) => ({
      binding,
      amount: reservationAmount(
        binding,
        input.inputTokensUpperBound,
        input.maxOutputTokens,
        input.costCeilingMicroUsd,
      ),
    }))
    .sort((a, b) => a.binding.bucketId.localeCompare(b.binding.bucketId));
  for (const reservation of reservations) {
    const bucket = buckets.get(reservation.binding.bucketId);
    if (!bucket || BigInt(reservation.amount) > BigInt(bucket.capacity))
      deny('impossible_capacity');
  }
  for (const reservation of reservations) {
    const updated = await client.query(
      `
        UPDATE reasoning_bucket
        SET
          reserved = reserved + $2::bigint
        WHERE
          id = $1
          AND NOT paused
          AND reserved + consumed + $2::bigint <= capacity
      `,
      [reservation.binding.bucketId, reservation.amount],
    );
    if (updated.rowCount !== 1) deny('insufficient_capacity');
  }

  const attemptId = randomUUID();
  const permitId = randomUUID();
  const reservationSetId = randomUUID();
  const permitExpiry = await client.query<{ expires_at: Date }>(
    `
      SELECT
        LEAST(
          clock_timestamp() + ($1::bigint * interval '1 millisecond'),
          $2::timestamptz,
          $3::timestamptz
        ) AS expires_at
    `,
    [input.permitTtlMs, input.deadline, job.deadline],
  );
  await client.query(
    `
      INSERT INTO
        reasoning_accounting (
          attempt_id,
          universe_id,
          privacy_epoch,
          request_id,
          route_id,
          route_profile_version,
          max_output_tokens,
          deadline,
          binding_hash,
          input_reservation_ceiling,
          runtime_policy_version,
          price_basis
        )
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `,
    [
      attemptId,
      input.universeId,
      input.privacyEpoch,
      input.requestId,
      policy.routeId,
      policy.routeProfileVersion,
      input.maxOutputTokens,
      input.deadline,
      bindingHash,
      input.inputTokensUpperBound,
      policy.policyVersion,
      policy.priceBasis,
    ],
  );
  await client.query(
    `
      INSERT INTO
        reasoning_permit (
          id,
          attempt_id,
          universe_id,
          privacy_epoch,
          reservation_set_id,
          expires_at
        )
      VALUES
        ($1, $2, $3, $4, $5, $6)
    `,
    [
      permitId,
      attemptId,
      input.universeId,
      input.privacyEpoch,
      reservationSetId,
      permitExpiry.rows[0]?.expires_at,
    ],
  );
  for (const reservation of reservations) {
    await client.query(
      `
        INSERT INTO
          reasoning_reservation (
            id,
            attempt_id,
            reservation_set_id,
            bucket_id,
            dimension,
            unit,
            amount,
            usage_basis,
            handling
          )
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        randomUUID(),
        attemptId,
        reservationSetId,
        reservation.binding.bucketId,
        reservation.binding.dimension,
        reservation.binding.unit,
        reservation.amount,
        reservation.binding.basis,
        reservation.binding.handling,
      ],
    );
  }
  await client.query(
    `
      INSERT INTO
        reasoning_attempt (
          id,
          job_id,
          step_id,
          context_id,
          universe_id,
          privacy_epoch,
          ordinal,
          lease_fence,
          request_hash,
          permit_id,
          reservation_set_id
        )
      VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          1,
          $7::bigint,
          $8,
          $9,
          $10
        )
    `,
    [
      attemptId,
      input.jobId,
      input.stepId,
      input.contextId,
      input.universeId,
      input.privacyEpoch,
      input.leaseFence,
      input.requestHash,
      permitId,
      reservationSetId,
    ],
  );
  const activated = await client.query(
    `
      UPDATE reasoning_step
      SET
        status = 'active'
      WHERE
        id = $1
        AND status = 'pending'
        AND EXISTS (
          SELECT
            1
          FROM
            reasoning_job
          WHERE
            id = $2
            AND status = 'running'
            AND lease_owner = $3
            AND lease_fence = $4::bigint
            AND lease_expires_at > clock_timestamp()
            AND deadline > clock_timestamp()
        )
        AND $5::timestamptz > clock_timestamp()
    `,
    [input.stepId, input.jobId, input.owner, input.leaseFence, input.deadline],
  );
  if (activated.rowCount !== 1) deny('expired_lease_or_job');
  return {
    attemptId,
    permitId,
    reservationSetId,
    bindingHash,
    routeId: policy.routeId,
    routeProfileVersion: policy.routeProfileVersion,
    permitExpiresAt: permitExpiry.rows[0]?.expires_at ?? new Date(0),
  };
}
