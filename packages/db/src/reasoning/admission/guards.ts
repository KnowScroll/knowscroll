import type pg from 'pg';
import {
  ReasoningDenied,
  validateReasoningPolicy,
  type ReasoningAuthority,
  type ResolvedReasoningPolicy,
} from '../runtime-policy.ts';
import { REASONING_ADMISSION_LIMITS, type JobRow } from './types.ts';

export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const hashPattern = /^[0-9a-f]{64}$/;
export const ownerPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/;

export function deny(code: string): never {
  throw new ReasoningDenied(code);
}

export function validBoundedInteger(
  value: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function validateUuid(value: string, code: string): void {
  if (!uuidPattern.test(value)) deny(code);
}

export function validateFence(value: string): void {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) deny('invalid_lease_fence');
}

export async function rollbackQuietly(client: pg.PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // A lost COMMIT acknowledgement can leave no transaction to roll back.
  }
}

export async function transaction<T>(
  db: pg.Pool,
  body: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await body(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await rollbackQuietly(client);
    if (
      !(error instanceof ReasoningDenied) &&
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      ['23503', '23505', '23514', '23P01'].includes(String(error.code))
    ) {
      throw new ReasoningDenied('storage_constraint');
    }
    throw error;
  } finally {
    client.release();
  }
}

export function validateOwnerAndDuration(
  owner: string,
  value: number,
  kind: 'lease' | 'permit',
): void {
  if (!ownerPattern.test(owner)) deny('invalid_owner');
  const maximum =
    kind === 'lease'
      ? REASONING_ADMISSION_LIMITS.maxLeaseMs
      : REASONING_ADMISSION_LIMITS.maxPermitTtlMs;
  if (!validBoundedInteger(value, 1, maximum)) deny(`invalid_${kind}_duration`);
}

export async function lockUniverse(
  client: pg.PoolClient,
  universeId: string,
  privacyEpoch: number,
): Promise<void> {
  const result = await client.query<{ privacy_epoch: number }>(
    'SELECT privacy_epoch FROM universe WHERE id=$1 FOR UPDATE',
    [universeId],
  );
  if (result.rowCount !== 1) deny('unknown_universe');
  if (result.rows[0]?.privacy_epoch !== privacyEpoch) deny('stale_epoch');
}

export async function lockCurrentJob(
  client: pg.PoolClient,
  input: {
    jobId: string;
    universeId: string;
    privacyEpoch: number;
    owner: string;
    leaseFence: string;
  },
  allowExpiredJob = false,
): Promise<JobRow> {
  const result = await client.query<JobRow>(
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
  const job = result.rows[0];
  if (!job) deny('unknown_job');
  if (job.lease_owner !== input.owner || job.lease_fence !== input.leaseFence)
    deny('stale_lease');
  if (!job.lease_expires_at) deny('stale_lease');
  const current = await client.query<{ valid: boolean }>(
    `
      SELECT
        clock_timestamp() < $1::timestamptz
        AND (
          $3::boolean
          OR clock_timestamp() < $2::timestamptz
        ) AS valid
    `,
    [job.lease_expires_at, job.deadline, allowExpiredJob],
  );
  if (!current.rows[0]?.valid) deny('expired_lease_or_job');
  return job;
}

export async function resolveAndValidatePolicy(
  client: pg.PoolClient,
  authority: ReasoningAuthority,
  scope: { universeId: string; privacyEpoch: number; jobId: string },
): Promise<{ policy: ResolvedReasoningPolicy; bindingHash: string }> {
  return validateReasoningPolicy(
    await authority.resolvePolicy(client, scope),
    scope,
  );
}

export async function lockPolicyBuckets(
  client: pg.PoolClient,
  policy: ResolvedReasoningPolicy,
): Promise<
  Map<
    string,
    {
      dimension: string;
      unit: string;
      window_id: string | null;
      capacity: string;
      reserved: string;
      consumed: string;
      paused: boolean;
    }
  >
> {
  const ids = policy.buckets.map((binding) => binding.bucketId).sort();
  const result = await client.query<{
    id: string;
    dimension: string;
    unit: string;
    window_id: string | null;
    capacity: string;
    reserved: string;
    consumed: string;
    paused: boolean;
  }>(
    `
      SELECT
        id,
        dimension,
        unit,
        window_id,
        capacity,
        reserved,
        consumed,
        paused
      FROM
        reasoning_bucket
      WHERE
        id = ANY ($1::UUID[])
      ORDER BY
        id
      FOR UPDATE
    `,
    [ids],
  );
  if (result.rowCount !== ids.length) deny('missing_bucket');
  return new Map(result.rows.map((row) => [row.id, row]));
}

export function assertBucketBindings(
  policy: ResolvedReasoningPolicy,
  buckets: Map<
    string,
    {
      dimension: string;
      unit: string;
      window_id: string | null;
      paused: boolean;
    }
  >,
): void {
  for (const binding of policy.buckets) {
    const bucket = buckets.get(binding.bucketId);
    if (!bucket) deny('missing_bucket');
    if (
      bucket.dimension !== binding.dimension ||
      bucket.unit !== binding.unit ||
      bucket.window_id !== binding.windowId
    ) {
      deny('bucket_binding_changed');
    }
    if (bucket.paused) deny('bucket_paused');
  }
}
