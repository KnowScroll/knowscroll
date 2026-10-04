/**
 * The background-inquiry route (ADR-0038 §4, ADR-0042): operator setup, the request shape the route
 * fixes, the policy and authorities an inquiry Job resolves to, and which family a Job belongs to.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { resolveAnswerPolicy } from '../answers.ts';
import { createSealedContextAuthority } from '../context-authority.ts';
import { fairnessCharge, validateFairnessPolicy } from '../fairness-policy.ts';
import type {
  ResolvedReasoningPolicy,
  ReasoningAuthority,
} from '../runtime-policy.ts';
import type { InquiryRoute } from './shared.ts';

/** Operator/test setup, like `installAskAnswerRoute`. The fairness policy of the same version must
 * already be installed, and must admit this route's largest request as at most one quantum. */
export async function installBackgroundInquiryRoute(
  client: pg.PoolClient,
  input: {
    policyVersion: string;
    routeId: string;
    routeProfileVersion: string;
    transport: 'fixture' | 'minimax';
    model: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    requestCap: number;
    tokenBudget: number;
    ownerCapacity: number;
    jobCapacity: number;
    coalescingDelaySeconds: number;
    jobTtlSeconds: number;
    remoteSlots: number;
    /** ADR-0042: the thinking mode its requests ask for (default disabled), and its bounds on continuation steps (default 1) and children (default none). */
    thinking?: 'disabled' | 'adaptive';
    maxContinuationSteps?: number;
    maxChildren?: 0 | 2 | 3;
  },
): Promise<void> {
  const policy = (
    await client.query<{ config: unknown }>(
      'SELECT config FROM reasoning_fairness_policy WHERE version=$1',
      [input.policyVersion],
    )
  ).rows[0];
  if (!policy)
    throw new Error('Install the fairness policy of this version first');
  fairnessCharge(
    validateFairnessPolicy(policy.config).policy,
    input.maxInputTokens,
    input.maxOutputTokens,
  );
  const bucket = async (dimension: string, unit: string, capacity: number) => {
    const id = randomUUID();
    await client.query(
      'INSERT INTO reasoning_bucket(id,dimension,unit,capacity) VALUES($1,$2,$3,$4)',
      [id, dimension, unit, capacity],
    );
    return id;
  };
  const global = await bucket('global_budget', 'tokens', input.tokenBudget);
  const account = await bucket(
    'provider_account',
    'requests',
    input.requestCap,
  );
  const quota = await bucket('route_quota', 'requests', input.requestCap);
  const remote = await bucket('remote_concurrency', 'slots', input.remoteSlots);
  await client.query(
    'UPDATE background_inquiry_route SET enabled=false WHERE enabled',
  );
  await client.query(
    `
      INSERT INTO
        background_inquiry_route (
          policy_version,
          route_id,
          route_profile_version,
          transport,
          model,
          max_input_tokens,
          max_output_tokens,
          global_bucket_id,
          provider_account_bucket_id,
          route_quota_bucket_id,
          remote_concurrency_bucket_id,
          owner_capacity,
          job_capacity,
          coalescing_delay_seconds,
          job_ttl_seconds,
          thinking,
          max_continuation_steps,
          max_children,
          enabled
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
          $15,
          $16,
          $17,
          $18,
          TRUE
        )
    `,
    [
      input.policyVersion,
      input.routeId,
      input.routeProfileVersion,
      input.transport,
      input.model,
      input.maxInputTokens,
      input.maxOutputTokens,
      global,
      account,
      quota,
      remote,
      input.ownerCapacity,
      input.jobCapacity,
      input.coalescingDelaySeconds,
      input.jobTtlSeconds,
      input.thinking ?? 'disabled',
      input.maxContinuationSteps ?? 1,
      input.maxChildren ?? 0,
    ],
  );
}
export async function inquiryRouteFor(
  client: pg.PoolClient | pg.Pool,
  policyVersion: string,
): Promise<InquiryRoute | undefined> {
  return (
    await client.query<InquiryRoute>(
      'SELECT * FROM background_inquiry_route WHERE policy_version=$1',
      [policyVersion],
    )
  ).rows[0];
}
/** What of the route shapes the request bytes. */
export const requestRoute = (route: InquiryRoute) => ({
  model: route.model,
  maxOutputTokens: route.max_output_tokens,
  thinking: route.thinking,
});
/** The same resolved shape as an answer Job's: the route's shared buckets plus its owner and Job buckets. */
function policyOf(
  route: InquiryRoute,
  universeId: string,
  jobId: string,
  ownerBucket: string,
  jobBucket: string,
): ResolvedReasoningPolicy {
  const b = (
    bucketId: string,
    dimension: string,
    unit: string,
    basis: string,
    scope: 'shared' | 'owner' | 'job',
    handling: 'budget' | 'remote',
  ) => ({
    bucketId,
    dimension,
    unit,
    windowId: null,
    scope,
    scopeId: scope === 'owner' ? universeId : scope === 'job' ? jobId : null,
    basis,
    handling,
  });
  return {
    version: 1,
    routeId: route.route_id,
    routeProfileVersion: route.route_profile_version,
    policyVersion: route.policy_version,
    maxInputTokens: route.max_input_tokens,
    maxOutputTokens: route.max_output_tokens,
    priceBasis: null,
    requiredDimensions: [
      'global_budget',
      'owner_budget',
      'job_budget',
      'provider_account',
      'route_quota',
      'remote_concurrency',
    ],
    buckets: [
      b(
        route.global_bucket_id,
        'global_budget',
        'tokens',
        'total_tokens',
        'shared',
        'budget',
      ),
      b(
        ownerBucket,
        'owner_budget',
        'tokens',
        'total_tokens',
        'owner',
        'budget',
      ),
      b(jobBucket, 'job_budget', 'tokens', 'total_tokens', 'job', 'budget'),
      b(
        route.provider_account_bucket_id,
        'provider_account',
        'requests',
        'requests',
        'shared',
        'budget',
      ),
      b(
        route.route_quota_bucket_id,
        'route_quota',
        'requests',
        'requests',
        'shared',
        'budget',
      ),
      b(
        route.remote_concurrency_bucket_id,
        'remote_concurrency',
        'slots',
        'remote_slots',
        'shared',
        'remote',
      ),
    ],
  } as ResolvedReasoningPolicy;
}
/** Trusted local SQL only: resolves an inquiry Job's policy from its inquiry row. A child binds its
 * parent's Job budget: a family never opens more than one (ADR-0042 §4). */
export const resolveInquiryPolicy: ReasoningAuthority['resolvePolicy'] = async (
  client,
  scope,
) => {
  const inquiry = (
    await client.query<{
      policy_version: string | null;
      job_bucket_id: string | null;
    }>(
      `
      SELECT
        i.policy_version,
        COALESCE(i.job_bucket_id, p.job_bucket_id) AS job_bucket_id
      FROM
        background_inquiry i
        LEFT JOIN background_inquiry p ON p.id = i.parent_id
      WHERE
        i.job_id = $1
        AND i.universe_id = $2
        AND i.privacy_epoch = $3
    `,
      [scope.jobId, scope.universeId, scope.privacyEpoch],
    )
  ).rows[0];
  if (!inquiry?.policy_version || !inquiry.job_bucket_id) return undefined;
  const route = await inquiryRouteFor(client, inquiry.policy_version);
  const owner = (
    await client.query<{ bucket_id: string }>(
      'SELECT bucket_id FROM background_inquiry_owner_bucket WHERE policy_version=$1 AND universe_id=$2',
      [inquiry.policy_version, scope.universeId],
    )
  ).rows[0];
  if (!route || !owner) return undefined;
  return policyOf(
    route,
    scope.universeId,
    scope.jobId,
    owner.bucket_id,
    inquiry.job_bucket_id,
  );
};
export function inquiryAuthority(): ReasoningAuthority {
  return createSealedContextAuthority(resolveInquiryPolicy);
}
/** ADR-0038 §4: when the inquiry route shares the answer route's scheduler, fair admission may pick
 * either family's Job, so one authority resolves both (each family still validates its own context). */
export function sharedReasoningAuthority(): ReasoningAuthority {
  return createSealedContextAuthority(
    async (client, scope) =>
      (await resolveAnswerPolicy(client, scope)) ??
      resolveInquiryPolicy(client, scope),
  );
}
/** Which product family an admitted Job belongs to. */
export async function jobFamily(
  db: pg.Pool | pg.PoolClient,
  jobId: string,
): Promise<'answer' | 'inquiry' | null> {
  const row = (
    await db.query<{ answer: boolean; inquiry: boolean }>(
      `
      SELECT
        EXISTS (
          SELECT
            1
          FROM
            ask_answer_request
          WHERE
            job_id = $1
        ) AS answer,
        EXISTS (
          SELECT
            1
          FROM
            background_inquiry
          WHERE
            job_id = $1
        ) AS inquiry
    `,
      [jobId],
    )
  ).rows[0]!;
  return row.answer ? 'answer' : row.inquiry ? 'inquiry' : null;
}
