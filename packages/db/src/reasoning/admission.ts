// Owns the Job/Attempt/Permit admission lifecycle: claim, reserve, authorize dispatch, withdraw,
// recover and mark-unknown. Each method owns its transaction and takes locks in the order
// universe, session, Job, children, fairness, bucket; reordering them risks deadlock or double spend.
// Helpers live in admission/ (types, guards, reserve).
import type pg from 'pg';
import {
  assertBucketBindings,
  deny,
  hashPattern,
  lockCurrentJob,
  lockPolicyBuckets,
  lockUniverse,
  ownerPattern,
  resolveAndValidatePolicy,
  transaction,
  validateFence,
  validateOwnerAndDuration,
  validateUuid,
  validBoundedInteger,
} from './admission/guards.ts';
import {
  releaseUnconsumed,
  reserveAttemptInTransaction,
} from './admission/reserve.ts';
import type {
  ClaimedJob,
  JobRow,
  ReasoningAdmission,
  RecoveryResult,
  ReservationRow,
} from './admission/types.ts';
import { lockBoundContextSession } from './context-session.ts';
import { lockFairnessResources } from './fairness-accounting.ts';
import type { ReasoningAuthority } from './runtime-policy.ts';

export {
  preflightAttemptInTransaction,
  releaseUnconsumed,
  reserveAttemptInTransaction,
} from './admission/reserve.ts';
export type {
  ClaimedJob,
  ClaimJobInput,
  ReasoningAdmission,
  ReserveAttemptInput,
  ReservedAttempt,
} from './admission/types.ts';
export { REASONING_ADMISSION_LIMITS } from './admission/types.ts';

export function createReasoningAdmission(
  db: pg.Pool,
  authority: ReasoningAuthority,
): ReasoningAdmission {
  return {
    async claimJob(input) {
      validateOwnerAndDuration(input.owner, input.leaseMs, 'lease');
      for (let scan = 0; scan < 100; scan += 1) {
        const result = await transaction<ClaimedJob | 'continue' | null>(
          db,
          async (client) => {
            const universe = await client.query<{
              id: string;
              privacy_epoch: number;
            }>(
              `
              SELECT
                u.id,
                u.privacy_epoch
              FROM
                universe u
              WHERE
                EXISTS (
                  SELECT
                    1
                  FROM
                    reasoning_job j
                  WHERE
                    j.universe_id = u.id
                    AND j.status = 'queued'
                )
              ORDER BY
                (
                  SELECT
                    min(j.created_at)
                  FROM
                    reasoning_job j
                  WHERE
                    j.universe_id = u.id
                    AND j.status = 'queued'
                ),
                u.id
              FOR UPDATE OF
                u SKIP LOCKED
              LIMIT
                1
            `,
            );
            const candidate = universe.rows[0];
            if (!candidate) return null;
            await client.query(
              `
              UPDATE reasoning_job
              SET
                status = 'cancelled',
                lease_owner = NULL,
                lease_expires_at = NULL
              WHERE
                universe_id = $1
                AND status = 'queued'
                AND privacy_epoch <> $2
            `,
              [candidate.id, candidate.privacy_epoch],
            );
            await client.query(
              `
              UPDATE reasoning_job
              SET
                status = 'expired',
                lease_owner = NULL,
                lease_expires_at = NULL
              WHERE
                universe_id = $1
                AND status = 'queued'
                AND privacy_epoch = $2
                AND deadline <= clock_timestamp()
            `,
              [candidate.id, candidate.privacy_epoch],
            );
            const job = await client.query<JobRow>(
              `
              SELECT
                id,
                universe_id,
                privacy_epoch,
                status,
                policy_version,
                deadline,
                lease_owner,
                lease_fence,
                lease_expires_at
              FROM
                reasoning_job
              WHERE
                universe_id = $1
                AND privacy_epoch = $2
                AND status = 'queued'
                AND deadline > clock_timestamp()
              ORDER BY
                created_at,
                id
              FOR UPDATE
              LIMIT
                1
            `,
              [candidate.id, candidate.privacy_epoch],
            );
            const row = job.rows[0];
            if (!row) return 'continue';
            const claimed = await client.query<
              ClaimedJob & { lease_fence: string; lease_expires_at: Date }
            >(
              `
              UPDATE reasoning_job
              SET
                status = 'running',
                lease_owner = $2,
                lease_fence = lease_fence + 1,
                lease_expires_at = clock_timestamp() + ($3::bigint * interval '1 millisecond')
              WHERE
                id = $1
                AND status = 'queued'
                AND lease_fence < 9223372036854775807
              RETURNING
                id AS "jobId",
                universe_id AS "universeId",
                privacy_epoch AS "privacyEpoch",
                lease_fence,
                lease_expires_at
            `,
              [row.id, input.owner, input.leaseMs],
            );
            const value = claimed.rows[0];
            if (!value) deny('lease_fence_exhausted');
            return {
              jobId: value.jobId,
              universeId: value.universeId,
              privacyEpoch: value.privacyEpoch,
              leaseFence: value.lease_fence,
              leaseExpiresAt: value.lease_expires_at,
            };
          },
        );
        if (result !== 'continue') return result;
      }
      deny('claim_scan_exhausted');
    },

    async reserveAttempt(input) {
      return transaction(db, (client) =>
        reserveAttemptInTransaction(client, authority, input),
      );
    },

    async authorizeDispatch(input) {
      validateFence(input.leaseFence);
      for (const [value, code] of [
        [input.universeId, 'invalid_universe_id'],
        [input.jobId, 'invalid_job_id'],
        [input.stepId, 'invalid_step_id'],
        [input.attemptId, 'invalid_attempt_id'],
        [input.requestId, 'invalid_request_id'],
        [input.dispatchId, 'invalid_dispatch_id'],
      ] as const) {
        validateUuid(value, code);
      }
      if (
        !hashPattern.test(input.requestHash) ||
        !validBoundedInteger(input.inputTokensUpperBound, 1) ||
        !validBoundedInteger(input.maxOutputTokens, 1)
      )
        deny('invalid_dispatch_binding');
      return transaction(db, async (client) => {
        await lockUniverse(client, input.universeId, input.privacyEpoch);
        await lockBoundContextSession(client, input);
        const job = await lockCurrentJob(client, input);
        if (job.status !== 'running') deny('job_not_running');
        const step = await client.query<{ context_id: string; status: string }>(
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
        const stepRow = step.rows[0];
        if (!stepRow || stepRow.status !== 'active') deny('step_not_active');
        const attempt = await client.query<{
          context_id: string;
          request_hash: string;
          active: boolean;
          permit_id: string;
          reservation_set_id: string;
        }>(
          `
            SELECT
              context_id,
              request_hash,
              active,
              permit_id,
              reservation_set_id
            FROM
              reasoning_attempt
            WHERE
              id = $1
              AND job_id = $2
              AND step_id = $3
              AND universe_id = $4
              AND privacy_epoch = $5
            FOR UPDATE
          `,
          [
            input.attemptId,
            input.jobId,
            input.stepId,
            input.universeId,
            input.privacyEpoch,
          ],
        );
        const attemptRow = attempt.rows[0];
        if (!attemptRow || !attemptRow.active) deny('attempt_not_active');
        const accounting = await client.query<{
          request_id: string;
          state: string;
          route_id: string;
          route_profile_version: string;
          max_output_tokens: string;
          deadline: Date;
          output_authority: string;
          binding_hash: string | null;
          dispatch_id: string | null;
          input_reservation_ceiling: string | null;
        }>(
          'SELECT * FROM reasoning_accounting WHERE attempt_id=$1 FOR UPDATE',
          [input.attemptId],
        );
        const account = accounting.rows[0];
        if (
          !account ||
          account.state !== 'reserved' ||
          account.dispatch_id !== null
        )
          deny('dispatch_already_decided');
        if (account.output_authority !== 'eligible') deny('output_withdrawn');
        if (
          account.request_id !== input.requestId ||
          attemptRow.request_hash !== input.requestHash ||
          Number(account.input_reservation_ceiling) !==
            input.inputTokensUpperBound ||
          Number(account.max_output_tokens) !== input.maxOutputTokens
        ) {
          deny('request_binding_mismatch');
        }
        const permit = await client.query<{
          state: string;
          expires_at: Date;
          reservation_set_id: string;
        }>(
          `
            SELECT
              state,
              expires_at,
              reservation_set_id
            FROM
              reasoning_permit
            WHERE
              id = $1
              AND attempt_id = $2
            FOR UPDATE
          `,
          [attemptRow.permit_id, input.attemptId],
        );
        const permitRow = permit.rows[0];
        if (
          !permitRow ||
          permitRow.state !== 'reserved' ||
          permitRow.reservation_set_id !== attemptRow.reservation_set_id
        )
          deny('permit_unavailable');
        const time = await client.query<{ valid: boolean }>(
          'SELECT clock_timestamp()<$1::timestamptz AND clock_timestamp()<$2::timestamptz AS valid',
          [permitRow.expires_at, account.deadline],
        );
        if (!time.rows[0]?.valid) deny('permit_or_request_expired');
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
              contextId: attemptRow.context_id,
              policyVersion: job.policy_version,
            },
            'lock',
          ))
        )
          deny('stale_context');
        const { policy, bindingHash } = await resolveAndValidatePolicy(
          client,
          authority,
          scope,
        );
        if (
          bindingHash !== account.binding_hash ||
          policy.routeId !== account.route_id ||
          policy.routeProfileVersion !== account.route_profile_version
        ) {
          deny('policy_binding_changed');
        }
        const reservations = await client.query<ReservationRow>(
          `
            SELECT
              bucket_id,
              dimension,
              unit,
              amount,
              state,
              usage_basis,
              handling
            FROM
              reasoning_reservation
            WHERE
              attempt_id = $1
              AND reservation_set_id = $2
            ORDER BY
              bucket_id
            FOR UPDATE
          `,
          [input.attemptId, attemptRow.reservation_set_id],
        );
        if (reservations.rowCount !== policy.buckets.length)
          deny('reservation_set_mismatch');
        const reservationByBucket = new Map(
          reservations.rows.map((row) => [row.bucket_id, row]),
        );
        for (const binding of policy.buckets) {
          const reservation = reservationByBucket.get(binding.bucketId);
          if (
            !reservation ||
            reservation.state !== 'held' ||
            reservation.dimension !== binding.dimension ||
            reservation.unit !== binding.unit ||
            reservation.usage_basis !== binding.basis ||
            reservation.handling !== binding.handling
          )
            deny('reservation_set_mismatch');
        }
        const buckets = await lockPolicyBuckets(client, policy);
        assertBucketBindings(policy, buckets);
        if (
          (await resolveAndValidatePolicy(client, authority, scope))
            .bindingHash !== bindingHash
        )
          deny('policy_binding_changed');
        if (
          !(await authority.validateContext(
            client,
            {
              ...scope,
              stepId: input.stepId,
              contextId: attemptRow.context_id,
              policyVersion: job.policy_version,
            },
            'recheck',
          ))
        ) {
          deny('stale_context');
        }
        const stillAuthorized = await client.query(
          `
            SELECT
              1
            FROM
              reasoning_job j
              JOIN reasoning_permit p ON p.attempt_id = $4
              JOIN reasoning_accounting a ON a.attempt_id = $4
            WHERE
              j.id = $1
              AND j.status = 'running'
              AND j.lease_owner = $2
              AND j.lease_fence = $3::bigint
              AND j.lease_expires_at > clock_timestamp()
              AND j.deadline > clock_timestamp()
              AND p.state = 'reserved'
              AND p.expires_at > clock_timestamp()
              AND a.state = 'reserved'
              AND a.deadline > clock_timestamp()
              AND a.output_authority = 'eligible'
          `,
          [input.jobId, input.owner, input.leaseFence, input.attemptId],
        );
        if (stillAuthorized.rowCount !== 1) deny('authorization_expired');
        const accountUpdate = await client.query(
          `
            UPDATE reasoning_accounting
            SET
              state = 'dispatch_committed',
              dispatch_id = $2,
              dispatch_committed_at = clock_timestamp()
            WHERE
              attempt_id = $1
              AND state = 'reserved'
              AND dispatch_id IS NULL
              AND deadline > clock_timestamp()
              AND output_authority = 'eligible'
              AND EXISTS (
                SELECT
                  1
                FROM
                  reasoning_job
                WHERE
                  id = $3
                  AND status = 'running'
                  AND lease_owner = $4
                  AND lease_fence = $5::bigint
                  AND lease_expires_at > clock_timestamp()
                  AND deadline > clock_timestamp()
              )
              AND EXISTS (
                SELECT
                  1
                FROM
                  reasoning_permit
                WHERE
                  id = $6
                  AND attempt_id = $1
                  AND state = 'reserved'
                  AND dispatch_id IS NULL
                  AND expires_at > clock_timestamp()
              )
          `,
          [
            input.attemptId,
            input.dispatchId,
            input.jobId,
            input.owner,
            input.leaseFence,
            attemptRow.permit_id,
          ],
        );
        const permitUpdate = await client.query(
          `
            UPDATE reasoning_permit
            SET
              state = 'consumed',
              dispatch_id = $2,
              consumed_at = clock_timestamp()
            WHERE
              id = $1
              AND state = 'reserved'
              AND dispatch_id IS NULL
              AND expires_at > clock_timestamp()
              AND EXISTS (
                SELECT
                  1
                FROM
                  reasoning_accounting
                WHERE
                  attempt_id = $3
                  AND state = 'dispatch_committed'
                  AND dispatch_id = $2
              )
          `,
          [attemptRow.permit_id, input.dispatchId, input.attemptId],
        );
        if (accountUpdate.rowCount !== 1 || permitUpdate.rowCount !== 1)
          deny('dispatch_race_lost');
        return {
          attemptId: input.attemptId,
          requestId: input.requestId,
          dispatchId: input.dispatchId,
          routeId: account.route_id,
          routeProfileVersion: account.route_profile_version,
          requestHash: input.requestHash,
          inputTokensUpperBound: Number(account.input_reservation_ceiling),
          maxOutputTokens: Number(account.max_output_tokens),
          deadline: account.deadline.toISOString(),
        };
      });
    },

    async withdrawJob(input) {
      validateFence(input.leaseFence);
      return transaction(db, async (client) => {
        await lockUniverse(client, input.universeId, input.privacyEpoch);
        const job = await lockCurrentJob(
          client,
          input,
          input.reason === 'expired',
        );
        if (!['running', 'waiting'].includes(job.status))
          deny('job_not_withdrawable');
        await client.query(
          `
            SELECT
              id
            FROM
              reasoning_step
            WHERE
              job_id = $1
              AND universe_id = $2
              AND privacy_epoch = $3
            ORDER BY
              id
            FOR UPDATE
          `,
          [input.jobId, input.universeId, input.privacyEpoch],
        );
        const attempts = await client.query<{
          id: string;
          step_id: string;
          permit_id: string;
          state: string;
        }>(
          `
            SELECT
              a.id,
              a.step_id,
              a.permit_id,
              ac.state
            FROM
              reasoning_attempt a
              JOIN reasoning_accounting ac ON ac.attempt_id = a.id
            WHERE
              a.job_id = $1
            ORDER BY
              a.id
            FOR UPDATE OF
              a,
              ac
          `,
          [input.jobId],
        );
        await lockFairnessResources(
          client,
          attempts.rows.map((row) => row.id),
        );
        const heldBuckets = await client.query<{ bucket_id: string }>(
          `
            SELECT DISTINCT
              r.bucket_id
            FROM
              reasoning_reservation r
              JOIN reasoning_attempt a ON a.id = r.attempt_id
            WHERE
              a.job_id = $1
              AND r.state = 'held'
            ORDER BY
              r.bucket_id
          `,
          [input.jobId],
        );
        if (heldBuckets.rows.length > 0) {
          await client.query(
            'SELECT id FROM reasoning_bucket WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
            [heldBuckets.rows.map((row) => row.bucket_id)],
          );
        }
        let closedNotSent = 0;
        let preservedUnknown = 0;
        for (const attempt of attempts.rows) {
          if (attempt.state === 'reserved') {
            await releaseUnconsumed(
              client,
              attempt.id,
              attempt.permit_id,
              true,
            );
            closedNotSent += 1;
          } else if (attempt.state === 'dispatch_committed') {
            await client.query(
              `
                UPDATE reasoning_accounting
                SET
                  state = 'unknown',
                  output_authority = 'withdrawn'
                WHERE
                  attempt_id = $1
                  AND state = 'dispatch_committed'
              `,
              [attempt.id],
            );
            await client.query(
              'UPDATE reasoning_attempt SET active=false WHERE id=$1',
              [attempt.id],
            );
            preservedUnknown += 1;
          } else {
            await client.query(
              "UPDATE reasoning_accounting SET output_authority='withdrawn' WHERE attempt_id=$1",
              [attempt.id],
            );
            await client.query(
              'UPDATE reasoning_attempt SET active=false WHERE id=$1',
              [attempt.id],
            );
            if (attempt.state === 'unknown') preservedUnknown += 1;
          }
        }
        await client.query(
          `
            UPDATE reasoning_step
            SET
              status = 'cancelled'
            WHERE
              job_id = $1
              AND status NOT IN ('succeeded', 'cancelled', 'superseded')
          `,
          [input.jobId],
        );
        await client.query(
          `
            UPDATE reasoning_job
            SET
              status = $2,
              lease_owner = NULL,
              lease_expires_at = NULL,
              withdrawn_at = clock_timestamp()
            WHERE
              id = $1
          `,
          [input.jobId, input.reason],
        );
        return { closedNotSent, preservedUnknown };
      });
    },

    async recoverAttempt(input) {
      if (!ownerPattern.test(input.owner)) deny('invalid_owner');
      for (const [value, code] of [
        [input.universeId, 'invalid_universe_id'],
        [input.jobId, 'invalid_job_id'],
        [input.stepId, 'invalid_step_id'],
        [input.attemptId, 'invalid_attempt_id'],
      ] as const)
        validateUuid(value, code);
      return transaction(db, async (client) => {
        await lockUniverse(client, input.universeId, input.privacyEpoch);
        const jobResult = await client.query<JobRow>(
          `
            SELECT
              id,
              universe_id,
              privacy_epoch,
              status,
              policy_version,
              deadline,
              lease_owner,
              lease_fence,
              lease_expires_at
            FROM
              reasoning_job
            WHERE
              id = $1
              AND universe_id = $2
              AND privacy_epoch = $3
            FOR UPDATE
          `,
          [input.jobId, input.universeId, input.privacyEpoch],
        );
        const job = jobResult.rows[0];
        if (!job) deny('unknown_job');
        const expiredLease =
          job.lease_expires_at !== null &&
          (
            await client.query<{ expired: boolean }>(
              'SELECT $1::timestamptz<=clock_timestamp() AS expired',
              [job.lease_expires_at],
            )
          ).rows[0]?.expired === true;
        const continuingFencedRecovery =
          job.status === 'waiting' &&
          job.lease_owner === null &&
          job.lease_expires_at === null;
        if (!expiredLease && !continuingFencedRecovery) {
          deny('lease_still_healthy');
        }
        if (
          ['completed', 'failed', 'cancelled', 'expired'].includes(job.status)
        )
          deny('terminal_job');
        const step = await client.query<{ status: string }>(
          'SELECT status FROM reasoning_step WHERE id=$1 AND job_id=$2 FOR UPDATE',
          [input.stepId, input.jobId],
        );
        if (!step.rows[0]) deny('unknown_step');
        const attempt = await client.query<{
          permit_id: string;
          active: boolean;
        }>(
          `
            SELECT
              permit_id,
              active
            FROM
              reasoning_attempt
            WHERE
              id = $1
              AND job_id = $2
              AND step_id = $3
              AND universe_id = $4
              AND privacy_epoch = $5
            FOR UPDATE
          `,
          [
            input.attemptId,
            input.jobId,
            input.stepId,
            input.universeId,
            input.privacyEpoch,
          ],
        );
        const attemptRow = attempt.rows[0];
        if (!attemptRow || !attemptRow.active) deny('attempt_not_recoverable');
        const accounting = await client.query<{ state: string }>(
          'SELECT state FROM reasoning_accounting WHERE attempt_id=$1 FOR UPDATE',
          [input.attemptId],
        );
        const state = accounting.rows[0]?.state;
        let outcome: RecoveryResult['outcome'];
        if (state === 'reserved') {
          await releaseUnconsumed(
            client,
            input.attemptId,
            attemptRow.permit_id,
          );
          await client.query(
            "UPDATE reasoning_step SET status='failed' WHERE id=$1",
            [input.stepId],
          );
          outcome = 'not_sent';
        } else if (state === 'dispatch_committed' || state === 'unknown') {
          if (state === 'dispatch_committed') {
            await client.query(
              `
                UPDATE reasoning_accounting
                SET
                  state = 'unknown',
                  output_authority = 'withdrawn'
                WHERE
                  attempt_id = $1
                  AND state = 'dispatch_committed'
              `,
              [input.attemptId],
            );
          } else {
            await client.query(
              `
                UPDATE reasoning_accounting
                SET
                  output_authority = 'withdrawn'
                WHERE
                  attempt_id = $1
                  AND state = 'unknown'
              `,
              [input.attemptId],
            );
          }
          await client.query(
            'UPDATE reasoning_attempt SET active=false WHERE id=$1',
            [input.attemptId],
          );
          await client.query(
            "UPDATE reasoning_step SET status='awaiting_reconciliation' WHERE id=$1",
            [input.stepId],
          );
          outcome = 'unknown';
        } else {
          deny('attempt_not_recoverable');
        }
        const recovered = await client.query<{ lease_fence: string }>(
          `
            UPDATE reasoning_job
            SET
              status = 'waiting',
              lease_owner = NULL,
              lease_expires_at = NULL,
              lease_fence = lease_fence + 1
            WHERE
              id = $1
              AND lease_fence < 9223372036854775807
            RETURNING
              lease_fence
          `,
          [input.jobId],
        );
        const recoveryFence = recovered.rows[0]?.lease_fence;
        if (!recoveryFence) deny('lease_fence_exhausted');
        return { attemptId: input.attemptId, outcome, recoveryFence };
      });
    },

    async markAttemptUnknown(input) {
      validateFence(input.leaseFence);
      if (!ownerPattern.test(input.owner)) deny('invalid_owner');
      for (const [value, code] of [
        [input.universeId, 'invalid_universe_id'],
        [input.jobId, 'invalid_job_id'],
        [input.stepId, 'invalid_step_id'],
        [input.attemptId, 'invalid_attempt_id'],
      ] as const)
        validateUuid(value, code);
      return transaction(db, async (client) => {
        const universe = await client.query<{ privacy_epoch: number }>(
          'SELECT privacy_epoch FROM universe WHERE id=$1 FOR UPDATE',
          [input.universeId],
        );
        if (
          !universe.rows[0] ||
          universe.rows[0].privacy_epoch !== input.privacyEpoch
        ) {
          return {
            outcome: 'private_state_gone' as const,
            outputWithdrawn: true,
          };
        }
        const jobResult = await client.query<JobRow>(
          `
            SELECT
              id,
              universe_id,
              privacy_epoch,
              status,
              policy_version,
              deadline,
              lease_owner,
              lease_fence,
              lease_expires_at
            FROM
              reasoning_job
            WHERE
              id = $1
              AND universe_id = $2
              AND privacy_epoch = $3
            FOR UPDATE
          `,
          [input.jobId, input.universeId, input.privacyEpoch],
        );
        const job = jobResult.rows[0];
        if (!job)
          return {
            outcome: 'private_state_gone' as const,
            outputWithdrawn: true,
          };
        const currentLease =
          job.lease_owner === input.owner &&
          job.lease_fence === input.leaseFence &&
          job.lease_expires_at !== null &&
          (
            await client.query<{ valid: boolean }>(
              'SELECT clock_timestamp()<$1::timestamptz AS valid',
              [job.lease_expires_at],
            )
          ).rows[0]?.valid === true;
        const step = await client.query<{ status: string }>(
          'SELECT status FROM reasoning_step WHERE id=$1 AND job_id=$2 FOR UPDATE',
          [input.stepId, input.jobId],
        );
        if (!step.rows[0])
          return {
            outcome: 'private_state_gone' as const,
            outputWithdrawn: true,
          };
        const attempt = await client.query<{
          active: boolean;
          lease_fence: string;
        }>(
          `
            SELECT
              active,
              lease_fence
            FROM
              reasoning_attempt
            WHERE
              id = $1
              AND job_id = $2
              AND step_id = $3
              AND universe_id = $4
              AND privacy_epoch = $5
            FOR UPDATE
          `,
          [
            input.attemptId,
            input.jobId,
            input.stepId,
            input.universeId,
            input.privacyEpoch,
          ],
        );
        if (!attempt.rows[0])
          return {
            outcome: 'private_state_gone' as const,
            outputWithdrawn: true,
          };
        if (attempt.rows[0].lease_fence !== input.leaseFence)
          deny('stale_attempt_fence');
        const withdrawOutput =
          input.reason === 'deadline' ||
          input.reason === 'local_cancel' ||
          !currentLease;
        const accounting = await client.query(
          `
            UPDATE reasoning_accounting
            SET
              state = 'unknown',
              output_authority = CASE
                WHEN $2::boolean THEN 'withdrawn'
                ELSE output_authority
              END
            WHERE
              attempt_id = $1
              AND state = 'dispatch_committed'
              AND dispatch_id IS NOT NULL
          `,
          [input.attemptId, withdrawOutput],
        );
        if (accounting.rowCount !== 1) deny('attempt_not_dispatched');
        const mayChangePrivateCheckpoint =
          currentLease &&
          ['running', 'waiting'].includes(job.status) &&
          ['active', 'awaiting_reconciliation'].includes(step.rows[0].status);
        if (mayChangePrivateCheckpoint) {
          await client.query(
            'UPDATE reasoning_attempt SET active=false WHERE id=$1',
            [input.attemptId],
          );
          await client.query(
            "UPDATE reasoning_step SET status='awaiting_reconciliation' WHERE id=$1",
            [input.stepId],
          );
          await client.query(
            "UPDATE reasoning_job SET status='waiting' WHERE id=$1 AND status='running'",
            [input.jobId],
          );
        }
        return { outcome: 'unknown' as const, outputWithdrawn: withdrawOutput };
      });
    },
  };
}
