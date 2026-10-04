import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { askContextPayload } from '@knowscroll/contracts/reasoning-ask-context';
import type { AskAnswerSource } from '@knowscroll/core/reasoning/ask-answer';
import { createSealedContextAuthority } from '../context-authority.ts';
import type {
  ResolvedReasoningPolicy,
  ReasoningAuthority,
} from '../runtime-policy.ts';
import type { RequestRow, Route } from './shared.ts';

/** The fairness policy an answer route is scheduled under: its basis is the route's own bounds, so
 * any request the route admits costs at most one quantum (ADR-0013 charges the largest fraction). */
export function answerFairnessPolicy(
  version: string,
  bounds: { maxInputTokens: number; maxOutputTokens: number },
) {
  return {
    version,
    quantum: 100,
    maxCharge: 100,
    scale: 100,
    maxProbes: 8,
    maxAdmissions: 1,
    basis: {
      input_tokens: bounds.maxInputTokens,
      output_tokens: bounds.maxOutputTokens,
      total_tokens: bounds.maxInputTokens + bounds.maxOutputTokens,
      requests: 1,
    },
  };
}
/** Operator/test setup: one route with its shared buckets and fairness policy. Nothing else enables answers. */
export async function installAskAnswerRoute(
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
    answerTtlSeconds: number;
    /** Concurrent remote calls. An unconfirmed outcome keeps its slot until evidence or an operator
     * decision (ADR-0012), so this also bounds how many unknowns can accumulate before the route stops. */
    remoteSlots: number;
  },
): Promise<void> {
  // The fairness policy of the same version must already be installed (`createReasoningFairness(pool).installPolicy`).
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
  await client.query('UPDATE ask_answer_route SET enabled=false WHERE enabled');
  await client.query(
    `
      INSERT INTO
        ask_answer_route (
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
          answer_ttl_seconds,
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
      input.answerTtlSeconds,
    ],
  );
}
export async function routeFor(
  client: pg.PoolClient | pg.Pool,
  policyVersion: string,
): Promise<Route | undefined> {
  return (
    await client.query<Route>(
      'SELECT * FROM ask_answer_route WHERE policy_version=$1',
      [policyVersion],
    )
  ).rows[0];
}
/** The reasoning policy an answer Job resolves to: the route's shared buckets plus its owner and job buckets. */
function policyOf(
  route: Route,
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
/** Trusted local SQL only: resolves an answer Job's policy from its request row. */
export const resolveAnswerPolicy: ReasoningAuthority['resolvePolicy'] = async (
  client,
  scope,
) => {
  const request = (
    await client.query<RequestRow>(
      'SELECT * FROM ask_answer_request WHERE job_id=$1 AND universe_id=$2 AND privacy_epoch=$3',
      [scope.jobId, scope.universeId, scope.privacyEpoch],
    )
  ).rows[0];
  if (!request) return undefined;
  const route = await routeFor(client, request.policy_version);
  const owner = (
    await client.query<{ bucket_id: string }>(
      'SELECT bucket_id FROM ask_answer_owner_bucket WHERE policy_version=$1 AND universe_id=$2',
      [request.policy_version, request.universe_id],
    )
  ).rows[0];
  if (!route || !owner) return undefined;
  return policyOf(
    route,
    request.universe_id,
    request.job_id,
    owner.bucket_id,
    request.job_bucket_id,
  );
};
/** The authority fair admission and dispatch use for answer Jobs (ADR-0017 family routing). */
export function answerAuthority(): ReasoningAuthority {
  return createSealedContextAuthority(resolveAnswerPolicy);
}
export function sourceOf(canonicalPayload: string): AskAnswerSource {
  const payload = askContextPayload.parse(JSON.parse(canonicalPayload));
  const a = payload.asset;
  return {
    question: payload.fact.question,
    scroll: {
      title: a.title,
      summary: a.summary,
      body: a.body,
      sourceTitle: a.sourceTitle,
      sourceUrl: a.sourceUrl,
      truthState: a.truthState,
    },
  };
}
