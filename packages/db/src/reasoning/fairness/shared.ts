import type pg from 'pg';
import { ReasoningDenied } from '../runtime-policy.ts';
import {
  FAIRNESS_CLASSES,
  validateFairnessPolicy,
  type FairnessClass,
} from '../fairness-policy.ts';
import type { Ready } from './types.ts';

export const deny = (code: string): never => {
  throw new ReasoningDenied(code);
};
export const INELIGIBLE_HEAD = [
  'stale_context',
  'unknown_step',
  'step_not_pending',
  'retry_not_supported',
  'invalid_deadline',
  'policy_limit_exceeded',
  'policy_version_mismatch',
];
export const nextClass = (klass: FairnessClass) =>
  (FAIRNESS_CLASSES.indexOf(klass) + 1) % FAIRNESS_CLASSES.length;
export const cap = (value: bigint, maximum: number) =>
  value > BigInt(maximum) ? BigInt(maximum) : value;
export async function tx<T>(
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
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}
export async function policyFor(db: pg.Pool | pg.PoolClient, version: string) {
  const row = (
    await db.query(
      'SELECT config,policy_hash FROM reasoning_fairness_policy WHERE version=$1',
      [version],
    )
  ).rows[0];
  if (!row) return deny('fairness_policy_missing');
  const value = validateFairnessPolicy(row.config);
  if (value.hash !== row.policy_hash || value.policy.version !== version)
    deny('fairness_policy_changed');
  return value;
}
export const readyColumns = `r.job_id AS "jobId",r.step_id AS "stepId",r.context_id AS "contextId",r.universe_id AS "universeId",r.privacy_epoch AS "privacyEpoch",
 r.policy_version AS "policyVersion",r.class,r.request_id AS "requestId",r.request_hash AS "requestHash",r.input_tokens_upper_bound AS "inputTokensUpperBound",
 r.max_output_tokens AS "maxOutputTokens",r.cost_ceiling_micro_usd AS "costCeilingMicroUsd",r.deadline,r.permit_ttl_ms AS "permitTtlMs",r.seq,r.charge,
 GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-j.created_at))*1000)::double precision AS "queueAgeMs",
 (r.deadline<=clock_timestamp() OR j.deadline<=clock_timestamp()) AS "deadlineMissed"`;
export function decode(row: Ready): Ready {
  return {
    ...row,
    inputTokensUpperBound: Number(row.inputTokensUpperBound),
    maxOutputTokens: Number(row.maxOutputTokens),
    costCeilingMicroUsd:
      row.costCeilingMicroUsd === null ? null : Number(row.costCeilingMicroUsd),
    deadline: new Date(row.deadline).toISOString(),
  };
}
