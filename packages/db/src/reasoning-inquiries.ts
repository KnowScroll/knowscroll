/**
 * #132 — background bridge inquiries (ADR-0038), on the same reasoning primitives as Ask answers.
 *
 * Standing consent (`setInquiryConsent`, from a live session) lets the Cartographer post mail
 * (`postInquiryMail`, called by `applyDeltas`) into at most one pending inquiry per universe and
 * kind. The worker opens a due inquiry (`openDueInquiries`) with fresh authority under the universe
 * lock: consent, recording, route and today's limit, then either `nothing_to_ask` with no Job, or the
 * background Job, its sealed context, one Step and the exact request bytes, enqueued fairly.
 * Execution, application and recovery live in `reasoning-inquiry-execution.ts`. Turning consent off
 * and pausing withdraw what has not been sent (`withdrawInquiries`); Clear/Reset erase it all.
 */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { INQUIRY_DAILY_LIMIT, INQUIRY_LIST_LIMIT, inquiryConsentInput, type InquiriesResponse, type InquiryConsentResponse, type InquiryConsentView, type InquiryWire } from '../../contracts/src/inquiries.ts';
import { INQUIRY_CONTEXT_LIMITS, INQUIRY_DIRTY_SCOPE, INQUIRY_KIND } from '../../contracts/src/reasoning-inquiry-context.ts';
import { selectInquiryPairs, serializeBridgeInquiryRequest, type InquiryPair } from '../../core/src/reasoning/bridge-inquiry.ts';
import type { AuthScope } from './identity.ts';
import { resolveAnswerPolicy } from './reasoning-answers.ts';
import { createSealedContextAuthority } from './reasoning-context-authority.ts';
import { enqueueFairInTransaction } from './reasoning-fairness.ts';
import { fairnessCharge, validateFairnessPolicy } from './reasoning-fairness-policy.ts';
import { isIdleWithdrawalIneligible, withdrawIdleBackgroundJob } from './reasoning-idle-lifecycle.ts';
import { readInquiryInputs, sealInquiryContext } from './reasoning-inquiry-context.ts';
import { ReasoningDenied, type ReasoningAuthority, type ResolvedReasoningPolicy } from './reasoning-runtime-policy.ts';

export class InquiryError extends Error {
  constructor(readonly statusCode: 400 | 404 | 409 | 503, message: string) { super(message); this.name = 'InquiryError'; }
}

export type InquiryRoute = {
  policy_version: string; route_id: string; route_profile_version: string; transport: 'fixture' | 'minimax'; model: string;
  max_input_tokens: number; max_output_tokens: number; global_bucket_id: string; provider_account_bucket_id: string;
  route_quota_bucket_id: string; remote_concurrency_bucket_id: string; owner_capacity: string; job_capacity: string;
  coalescing_delay_seconds: number; job_ttl_seconds: number; enabled: boolean;
  thinking: 'disabled' | 'adaptive'; max_continuation_steps: number; max_children: number;
};
export type InquiryRow = {
  id: string; universe_id: string; privacy_epoch: number; kind: string; status: string; first_mail_at: Date;
  policy_version: string | null; job_id: string | null; step_id: string | null; context_id: string | null; request_id: string | null;
  job_bucket_id: string | null; through_sequence: string | null; pairs: { a: { code: string; name: string }; b: { code: string; name: string } }[] | null;
  opened_at: Date | null; request_hash: string | null; input_bytes: number | null; attempt_id: string | null; proposal_id: string | null;
  reasons: string[]; closed_at: Date | null; role: 'single' | 'parent' | 'child'; parent_id: string | null; sent: boolean | null;
};

/** Operator/test setup, like `installAskAnswerRoute`. The fairness policy of the same version must
 * already be installed, and must admit this route's largest request as at most one quantum. */
export async function installBackgroundInquiryRoute(client: pg.PoolClient, input: {
  policyVersion: string; routeId: string; routeProfileVersion: string; transport: 'fixture' | 'minimax'; model: string;
  maxInputTokens: number; maxOutputTokens: number; requestCap: number; tokenBudget: number; ownerCapacity: number; jobCapacity: number;
  coalescingDelaySeconds: number; jobTtlSeconds: number; remoteSlots: number;
  /** ADR-0042: the thinking mode its requests ask for (default disabled), and its bounds on continuation steps (default 1) and children (default none). */
  thinking?: 'disabled' | 'adaptive'; maxContinuationSteps?: number; maxChildren?: 0 | 2 | 3;
}): Promise<void> {
  const policy = (await client.query<{ config: unknown }>('SELECT config FROM reasoning_fairness_policy WHERE version=$1', [input.policyVersion])).rows[0];
  if (!policy) throw new Error('Install the fairness policy of this version first');
  fairnessCharge(validateFairnessPolicy(policy.config).policy, input.maxInputTokens, input.maxOutputTokens);
  const bucket = async (dimension: string, unit: string, capacity: number) => {
    const id = randomUUID();
    await client.query('INSERT INTO reasoning_bucket(id,dimension,unit,capacity) VALUES($1,$2,$3,$4)', [id, dimension, unit, capacity]);
    return id;
  };
  const global = await bucket('global_budget', 'tokens', input.tokenBudget);
  const account = await bucket('provider_account', 'requests', input.requestCap);
  const quota = await bucket('route_quota', 'requests', input.requestCap);
  const remote = await bucket('remote_concurrency', 'slots', input.remoteSlots);
  await client.query('UPDATE background_inquiry_route SET enabled=false WHERE enabled');
  await client.query(
    `INSERT INTO background_inquiry_route(policy_version,route_id,route_profile_version,transport,model,max_input_tokens,max_output_tokens,
       global_bucket_id,provider_account_bucket_id,route_quota_bucket_id,remote_concurrency_bucket_id,owner_capacity,job_capacity,
       coalescing_delay_seconds,job_ttl_seconds,thinking,max_continuation_steps,max_children,enabled)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,true)`,
    [input.policyVersion, input.routeId, input.routeProfileVersion, input.transport, input.model, input.maxInputTokens, input.maxOutputTokens,
      global, account, quota, remote, input.ownerCapacity, input.jobCapacity, input.coalescingDelaySeconds, input.jobTtlSeconds,
      input.thinking ?? 'disabled', input.maxContinuationSteps ?? 1, input.maxChildren ?? 0],
  );
}

export async function inquiryRouteFor(client: pg.PoolClient | pg.Pool, policyVersion: string): Promise<InquiryRoute | undefined> {
  return (await client.query<InquiryRoute>('SELECT * FROM background_inquiry_route WHERE policy_version=$1', [policyVersion])).rows[0];
}

/** What of the route shapes the request bytes. */
export const requestRoute = (route: InquiryRoute) => ({ model: route.model, maxOutputTokens: route.max_output_tokens, thinking: route.thinking });

/** The same resolved shape as an answer Job's: the route's shared buckets plus its owner and Job buckets. */
function policyOf(route: InquiryRoute, universeId: string, jobId: string, ownerBucket: string, jobBucket: string): ResolvedReasoningPolicy {
  const b = (bucketId: string, dimension: string, unit: string, basis: string, scope: 'shared' | 'owner' | 'job', handling: 'budget' | 'remote') =>
    ({ bucketId, dimension, unit, windowId: null, scope, scopeId: scope === 'owner' ? universeId : scope === 'job' ? jobId : null, basis, handling });
  return {
    version: 1, routeId: route.route_id, routeProfileVersion: route.route_profile_version, policyVersion: route.policy_version,
    maxInputTokens: route.max_input_tokens, maxOutputTokens: route.max_output_tokens, priceBasis: null,
    requiredDimensions: ['global_budget', 'owner_budget', 'job_budget', 'provider_account', 'route_quota', 'remote_concurrency'],
    buckets: [
      b(route.global_bucket_id, 'global_budget', 'tokens', 'total_tokens', 'shared', 'budget'),
      b(ownerBucket, 'owner_budget', 'tokens', 'total_tokens', 'owner', 'budget'),
      b(jobBucket, 'job_budget', 'tokens', 'total_tokens', 'job', 'budget'),
      b(route.provider_account_bucket_id, 'provider_account', 'requests', 'requests', 'shared', 'budget'),
      b(route.route_quota_bucket_id, 'route_quota', 'requests', 'requests', 'shared', 'budget'),
      b(route.remote_concurrency_bucket_id, 'remote_concurrency', 'slots', 'remote_slots', 'shared', 'remote'),
    ],
  } as ResolvedReasoningPolicy;
}

/** Trusted local SQL only: resolves an inquiry Job's policy from its inquiry row. A child binds its
 * parent's Job budget: a family never opens more than one (ADR-0042 §4). */
export const resolveInquiryPolicy: ReasoningAuthority['resolvePolicy'] = async (client, scope) => {
  const inquiry = (await client.query<{ policy_version: string | null; job_bucket_id: string | null }>(
    `SELECT i.policy_version, COALESCE(i.job_bucket_id, p.job_bucket_id) AS job_bucket_id FROM background_inquiry i
     LEFT JOIN background_inquiry p ON p.id = i.parent_id WHERE i.job_id=$1 AND i.universe_id=$2 AND i.privacy_epoch=$3`,
    [scope.jobId, scope.universeId, scope.privacyEpoch])).rows[0];
  if (!inquiry?.policy_version || !inquiry.job_bucket_id) return undefined;
  const route = await inquiryRouteFor(client, inquiry.policy_version);
  const owner = (await client.query<{ bucket_id: string }>('SELECT bucket_id FROM background_inquiry_owner_bucket WHERE policy_version=$1 AND universe_id=$2',
    [inquiry.policy_version, scope.universeId])).rows[0];
  if (!route || !owner) return undefined;
  return policyOf(route, scope.universeId, scope.jobId, owner.bucket_id, inquiry.job_bucket_id);
};

export function inquiryAuthority(): ReasoningAuthority {
  return createSealedContextAuthority(resolveInquiryPolicy);
}

/** ADR-0038 §4: when the inquiry route shares the answer route's scheduler, fair admission may pick
 * either family's Job, so one authority resolves both (each family still validates its own context). */
export function sharedReasoningAuthority(): ReasoningAuthority {
  return createSealedContextAuthority(async (client, scope) => (await resolveAnswerPolicy(client, scope)) ?? resolveInquiryPolicy(client, scope));
}

/** Which product family an admitted Job belongs to. */
export async function jobFamily(db: pg.Pool | pg.PoolClient, jobId: string): Promise<'answer' | 'inquiry' | null> {
  const row = (await db.query<{ answer: boolean; inquiry: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ask_answer_request WHERE job_id=$1) AS answer, EXISTS (SELECT 1 FROM background_inquiry WHERE job_id=$1) AS inquiry`, [jobId])).rows[0]!;
  return row.answer ? 'answer' : row.inquiry ? 'inquiry' : null;
}

async function inTransaction<T>(pool: pg.Pool, body: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const value = await body(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

// Consent -------------------------------------------------------------------------------------

/** Inquiries the mailbox opened today (UTC): a family counts once, its children never (ADR-0042 §4). */
async function openedToday(client: pg.PoolClient, universeId: string, privacyEpoch: number): Promise<number> {
  return (await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM background_inquiry WHERE universe_id=$1 AND privacy_epoch=$2 AND parent_id IS NULL
       AND opened_at >= (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`, [universeId, privacyEpoch])).rows[0]!.n;
}

export async function readInquiryConsent(client: pg.PoolClient, scope: { universeId: string; privacyEpoch: number }): Promise<InquiryConsentView> {
  const row = (await client.query<{ enabled: boolean; daily_limit: number; changed_at: Date }>(
    'SELECT enabled, daily_limit, changed_at FROM background_inquiry_consent WHERE universe_id=$1 AND privacy_epoch=$2', [scope.universeId, scope.privacyEpoch])).rows[0];
  const available = (await client.query('SELECT 1 FROM background_inquiry_route WHERE enabled')).rowCount === 1;
  const used = await openedToday(client, scope.universeId, scope.privacyEpoch);
  return { enabled: row?.enabled ?? false, dailyLimit: row?.daily_limit ?? INQUIRY_DAILY_LIMIT.default, changedAt: row ? row.changed_at.toISOString() : null, available, usedToday: used };
}

/**
 * ADR-0038 §1: set or clear the standing consent. The caller holds the authenticated universe lock
 * (`authenticateAndLock`), so the request comes from a live session of this universe; the schema
 * refuses a consent change without its recorded request. An exact retry replays; a reused key with
 * other content is a conflict. Turning it off withdraws everything not yet sent.
 */
export async function setInquiryConsent(client: pg.PoolClient, scope: AuthScope, raw: unknown): Promise<InquiryConsentResponse> {
  const parsed = inquiryConsentInput.safeParse(raw);
  if (!parsed.success) throw new InquiryError(400, 'Invalid consent request');
  const input = parsed.data;
  const respond = async () => ({ privacyEpoch: scope.privacyEpoch, consent: await readInquiryConsent(client, scope) });
  const old = (await client.query<{ privacy_epoch: number; enabled: boolean; daily_limit: number }>(
    'SELECT privacy_epoch, enabled, daily_limit FROM background_inquiry_consent_request WHERE universe_id=$1 AND client_request_id=$2', [scope.universeId, input.clientRequestId])).rows[0];
  if (old) {
    if (old.privacy_epoch !== input.expectedPrivacyEpoch || old.enabled !== input.enabled || (input.dailyLimit !== undefined && input.dailyLimit !== old.daily_limit)) {
      throw new InquiryError(409, 'Consent request key reused with different content');
    }
    return respond();
  }
  if (input.expectedPrivacyEpoch !== scope.privacyEpoch) throw new InquiryError(409, 'Consent privacy epoch is stale');
  const current = (await client.query<{ daily_limit: number }>(
    'SELECT daily_limit FROM background_inquiry_consent WHERE universe_id=$1 AND privacy_epoch=$2 FOR UPDATE', [scope.universeId, scope.privacyEpoch])).rows[0];
  const dailyLimit = input.dailyLimit ?? current?.daily_limit ?? INQUIRY_DAILY_LIMIT.default;
  const requestId = randomUUID();
  await client.query(
    `INSERT INTO background_inquiry_consent_request(id,universe_id,privacy_epoch,session_id,client_request_id,enabled,daily_limit) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [requestId, scope.universeId, scope.privacyEpoch, scope.sessionId, input.clientRequestId, input.enabled, dailyLimit]);
  if (current) {
    await client.query('UPDATE background_inquiry_consent SET enabled=$3, daily_limit=$4, revision=revision+1, request_id=$5 WHERE universe_id=$1 AND privacy_epoch=$2',
      [scope.universeId, scope.privacyEpoch, input.enabled, dailyLimit, requestId]);
  } else {
    await client.query('INSERT INTO background_inquiry_consent(universe_id,privacy_epoch,enabled,daily_limit,revision,request_id) VALUES($1,$2,$3,$4,1,$5)',
      [scope.universeId, scope.privacyEpoch, input.enabled, dailyLimit, requestId]);
  }
  if (!input.enabled) await withdrawInquiries(client, scope.universeId, scope.privacyEpoch, 'consent_off');
  return respond();
}

// Mail ----------------------------------------------------------------------------------------

/** Why a look is worth it (ADR-0042 §5): a planet or region formed, a bridge between two live places
 * revoked, or a personal hypothesis about a live place created or changed. */
export type InquiryMailCause =
  | { kind: 'place_formed'; deltaId: string }
  | { kind: 'bridge_revoked'; bridgeId: string }
  | { kind: 'hypothesis_changed'; hypothesisId: string; revision: number };

/**
 * ADR-0038 §3: called for each cause, in its transaction and under its universe lock (`applyDeltas` for
 * a place the Cartographer forms). Only with consent in this epoch and while recording; later mail joins
 * the pending inquiry (at most 16 causes: the inquiry reads every live place when it runs anyway).
 * Nothing earlier is ever mailed: the schema requires this transaction's delta, or a revocation or
 * hypothesis revision since consent was turned on (ADR-0042 §5).
 */
export async function postInquiryMail(client: pg.PoolClient, universeId: string, cause: InquiryMailCause): Promise<boolean> {
  const state = (await client.query<{ privacy_epoch: number; recording: boolean; enabled: boolean | null }>(
    `SELECT u.privacy_epoch, u.recording_paused_at IS NULL AS recording, c.enabled FROM universe u
     LEFT JOIN background_inquiry_consent c ON c.universe_id = u.id AND c.privacy_epoch = u.privacy_epoch WHERE u.id=$1`, [universeId])).rows[0];
  if (!state?.recording || !state.enabled) return false;
  let pending = (await client.query<{ id: string; causes: number }>(
    `SELECT i.id, (SELECT count(*)::int FROM inquiry_mail m WHERE m.inquiry_id = i.id) AS causes FROM background_inquiry i
     WHERE i.universe_id=$1 AND i.kind=$2 AND i.status='pending' FOR UPDATE`, [universeId, INQUIRY_KIND])).rows[0];
  if (!pending) {
    pending = { id: randomUUID(), causes: 0 };
    await client.query(`INSERT INTO background_inquiry(id,universe_id,privacy_epoch,kind,status) VALUES($1,$2,$3,$4,'pending')`,
      [pending.id, universeId, state.privacy_epoch, INQUIRY_KIND]);
  }
  if (pending.causes >= INQUIRY_CONTEXT_LIMITS.maxCausesPerInquiry) return false;
  await client.query(
    `INSERT INTO inquiry_mail(id,universe_id,privacy_epoch,kind,inquiry_id,cause_kind,cause_delta_id,cause_bridge_id,cause_hypothesis_id,cause_hypothesis_revision)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [randomUUID(), universeId, state.privacy_epoch, INQUIRY_KIND, pending.id, cause.kind, cause.kind === 'place_formed' ? cause.deltaId : null,
      cause.kind === 'bridge_revoked' ? cause.bridgeId : null, cause.kind === 'hypothesis_changed' ? cause.hypothesisId : null,
      cause.kind === 'hypothesis_changed' ? cause.revision : null]);
  return true;
}

/** Revoked bridges (shared, or the reader's own) between two of a consenting, recording reader's live
 * planets or regions, revoked since that reader's consent was turned on (or recording resumed), not yet mailed. */
const REVOKED_CONNECTIONS = `SELECT u.id AS universe_id, b.id AS bridge_id FROM bridge b
  JOIN atlas_place f ON f.anchor_concept_id = b.from_concept_id AND f.state = 'live' AND f.kind IN ('planet','region')
  JOIN atlas_place t ON t.universe_id = f.universe_id AND t.anchor_concept_id = b.to_concept_id AND t.state = 'live' AND t.kind IN ('planet','region')
  JOIN universe u ON u.id = f.universe_id AND u.recording_paused_at IS NULL
  JOIN background_inquiry_consent c ON c.universe_id = u.id AND c.privacy_epoch = u.privacy_epoch AND c.enabled
  WHERE b.status = 'revoked' AND (b.universe_id IS NULL OR b.universe_id = u.id)
    AND b.status_changed_at > inquiry_mail_since(u.id, u.privacy_epoch)
    AND NOT EXISTS (SELECT 1 FROM inquiry_mail m WHERE m.universe_id = u.id AND m.cause_bridge_id = b.id)`;

/**
 * ADR-0042 §5.3: a source correction that revoked a connection between two of a reader's live places asks
 * for a look again, from current evidence. The correction holds the exclusive substrate lock, which
 * follows universe locks (ADR-0031 §7), so its own transaction cannot mail: the worker does, each pass,
 * under each universe's lock with the facts checked again, once per universe and bridge.
 */
export async function mailRevokedConnections(pool: pg.Pool, input: { limit?: number } = {}): Promise<number> {
  const found = (await pool.query<{ universe_id: string; bridge_id: string }>(
    `${REVOKED_CONNECTIONS} ORDER BY b.status_changed_at, b.id LIMIT $1`, [input.limit ?? 10])).rows;
  let mailed = 0;
  for (const row of found) {
    try {
      const posted = await inTransaction(pool, async client => {
        await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE', [row.universe_id]);
        const still = (await client.query(`${REVOKED_CONNECTIONS} AND u.id=$1 AND b.id=$2`, [row.universe_id, row.bridge_id])).rowCount;
        return still ? postInquiryMail(client, row.universe_id, { kind: 'bridge_revoked', bridgeId: row.bridge_id }) : false;
      });
      if (posted) mailed += 1;
    } catch { /* a pause or a Clear moved it meanwhile; the next pass sees its new state */ }
  }
  return mailed;
}

// Stopping -------------------------------------------------------------------------------------

/**
 * ADR-0038 §8: consent off or pause withdraws every pending inquiry and every queued Job not yet
 * admitted (ADR-0018 withdrawal, the cause recorded on the inquiry first, as the schema requires).
 * A call in flight holds a live lease and is left alone: its reply is discarded at apply, because
 * the sealed consent/recording facts no longer hold. Caller holds the universe lock.
 */
export async function withdrawInquiries(client: pg.PoolClient, universeId: string, privacyEpoch: number, cause: 'consent_off' | 'recording_paused'): Promise<number> {
  const reasons = JSON.stringify([cause]);
  let withdrawn = (await client.query(`UPDATE background_inquiry SET status='withdrawn', reasons=$3 WHERE universe_id=$1 AND privacy_epoch=$2 AND status='pending'`,
    [universeId, privacyEpoch, reasons])).rowCount ?? 0;
  const queued = (await client.query<{ id: string; job_id: string }>(
    `SELECT i.id, i.job_id FROM background_inquiry i JOIN reasoning_job j ON j.id = i.job_id
     WHERE i.universe_id=$1 AND i.privacy_epoch=$2 AND i.status='queued' AND j.status IN ('queued','waiting')
       AND (j.lease_owner IS NULL OR j.lease_expires_at <= clock_timestamp()) ORDER BY i.id`, [universeId, privacyEpoch])).rows;
  for (const q of queued) {
    await client.query('SAVEPOINT inquiry_withdrawal');
    try {
      await client.query(`UPDATE background_inquiry SET status='withdrawn', reasons=$2 WHERE id=$1 AND status='queued'`, [q.id, reasons]);
      await withdrawIdleBackgroundJob(client, { jobId: q.job_id, universeId, privacyEpoch }, 'cancelled');
      await client.query('RELEASE SAVEPOINT inquiry_withdrawal');
      withdrawn += 1;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT inquiry_withdrawal');
      if (!isIdleWithdrawalIneligible(error)) throw error;
    }
  }
  return withdrawn;
}

// Opening a due inquiry (worker) ---------------------------------------------------------------

export type OpenResult = 'opened' | 'nothing_to_ask' | 'waiting' | 'withdrawn' | 'failed' | 'gone';

/** The worker's intake: every pending inquiry whose first mail is older than the route's coalescing
 * delay, while none of its universe's is already in flight, is opened in its own transaction. */
export async function openDueInquiries(pool: pg.Pool, input: { limit?: number } = {}): Promise<Record<OpenResult, number>> {
  const counts: Record<OpenResult, number> = { opened: 0, nothing_to_ask: 0, waiting: 0, withdrawn: 0, failed: 0, gone: 0 };
  const route = (await pool.query<InquiryRoute>('SELECT * FROM background_inquiry_route WHERE enabled')).rows[0];
  if (!route) return counts;
  const due = (await pool.query<{ id: string }>(
    `SELECT i.id FROM background_inquiry i WHERE i.status='pending' AND i.first_mail_at <= clock_timestamp() - ($1 * interval '1 second')
       AND NOT EXISTS (SELECT 1 FROM background_inquiry q WHERE q.universe_id = i.universe_id AND q.kind = i.kind AND q.status = 'queued')
     ORDER BY i.first_mail_at, i.id LIMIT $2`, [route.coalescing_delay_seconds, input.limit ?? 10])).rows;
  for (const row of due) {
    try { counts[await inTransaction(pool, client => openInquiry(client, row.id))] += 1; }
    catch { /* another worker or a Clear moved it; the next pass sees its new state */ }
  }
  return counts;
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** The offered pairs' codes and names, as the inquiry records them for the reader's list. */
const pairsView = (pairs: readonly InquiryPair[]) => JSON.stringify(pairs.map(p => ({ a: { code: p.a.code, name: p.a.name }, b: { code: p.b.code, name: p.b.name } })));

/** What every Job an opening creates shares: the universe and epoch, the route, the cause and the deadline. */
type InquiryJobShape = { universeId: string; privacyEpoch: number; route: InquiryRoute; through: string; deadline: Date };

async function insertInquiryJob(client: pg.PoolClient, jobId: string, job: InquiryJobShape, status: 'queued' | 'waiting'): Promise<void> {
  await client.query(
    `INSERT INTO reasoning_job(id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,dirty_scope,through_sequence)
     VALUES($1,$2,$3,$4,'background_inquiry',$2,$5,$6,'dirty',$7,$8)`,
    [jobId, job.universeId, job.privacyEpoch, status, job.route.policy_version, job.deadline, INQUIRY_DIRTY_SCOPE, job.through]);
}

/** One inquiry's own Job, sealed context, Step and exact request bytes, enqueued fairly (ADR-0038 §4).
 * `bind` names the Job on the inquiry's row first, so the policy resolver can see its buckets while sealing. */
async function openInquiryJob(client: pg.PoolClient, job: InquiryJobShape, inquiryId: string, pairs: readonly InquiryPair[],
  bind: (ids: { jobId: string; stepId: string; contextId: string; requestId: string }) => Promise<unknown>): Promise<void> {
  const ids = { jobId: randomUUID(), stepId: randomUUID(), contextId: randomUUID(), requestId: randomUUID() };
  const scope = { universeId: job.universeId, privacyEpoch: job.privacyEpoch };
  await insertInquiryJob(client, ids.jobId, job, 'queued');
  await bind(ids);
  const payload = await sealInquiryContext(client, { ...scope, jobId: ids.jobId, contextId: ids.contextId, inquiryId }, pairs, resolveInquiryPolicy);
  await client.query(`INSERT INTO reasoning_step(id,job_id,universe_id,privacy_epoch,context_id,ordinal,status) VALUES($1,$2,$3,$4,$5,1,'pending')`,
    [ids.stepId, ids.jobId, scope.universeId, scope.privacyEpoch, ids.contextId]);
  // The reserved bytes are rebuilt from the sealed pairs, exactly as the worker will rebuild them.
  const bytes = serializeBridgeInquiryRequest(payload.pairs, requestRoute(job.route));
  const requestHash = sha(bytes);
  await client.query('UPDATE background_inquiry SET request_hash=$2, input_bytes=$3 WHERE id=$1', [inquiryId, requestHash, bytes.byteLength]);
  await enqueueFairInTransaction(client, {
    ...scope, jobId: ids.jobId, stepId: ids.stepId, contextId: ids.contextId, requestId: ids.requestId, requestHash,
    inputTokensUpperBound: bytes.byteLength, maxOutputTokens: job.route.max_output_tokens, costCeilingMicroUsd: null,
    deadline: job.deadline.toISOString(), permitTtlMs: 60_000, policyVersion: job.route.policy_version, class: 'background_inquiry',
  });
}

/** ADR-0038 §4: one due inquiry, with fresh authority, in the caller's transaction. */
export async function openInquiry(client: pg.PoolClient, inquiryId: string): Promise<OpenResult> {
  const head = (await client.query<{ universe_id: string }>('SELECT universe_id FROM background_inquiry WHERE id=$1', [inquiryId])).rows[0];
  if (!head) return 'gone';
  // ADR-0017 order: the universe row first, then the inquiry, then everything it creates.
  const universe = (await client.query<{ privacy_epoch: number; paused: boolean }>(
    'SELECT privacy_epoch, recording_paused_at IS NOT NULL AS paused FROM universe WHERE id=$1 FOR UPDATE', [head.universe_id])).rows[0];
  const inquiry = (await client.query<InquiryRow>('SELECT * FROM background_inquiry WHERE id=$1 FOR UPDATE', [inquiryId])).rows[0];
  if (!universe || !inquiry || inquiry.status !== 'pending' || inquiry.privacy_epoch !== universe.privacy_epoch) return 'gone';
  const close = async (status: 'nothing_to_ask' | 'withdrawn' | 'failed', reasons: string[]) => {
    await client.query('UPDATE background_inquiry SET status=$2, reasons=$3 WHERE id=$1', [inquiryId, status, JSON.stringify(reasons)]);
  };
  const consent = (await client.query<{ enabled: boolean; daily_limit: number }>(
    'SELECT enabled, daily_limit FROM background_inquiry_consent WHERE universe_id=$1 AND privacy_epoch=$2', [inquiry.universe_id, inquiry.privacy_epoch])).rows[0];
  if (!consent?.enabled) { await close('withdrawn', ['consent_off']); return 'withdrawn'; }
  if (universe.paused) { await close('withdrawn', ['recording_paused']); return 'withdrawn'; }
  const route = (await client.query<InquiryRoute & { due: boolean }>(
    `SELECT *, $1::timestamptz <= clock_timestamp() - (coalescing_delay_seconds * interval '1 second') AS due FROM background_inquiry_route WHERE enabled`,
    [inquiry.first_mail_at])).rows[0];
  if (!route?.due) return 'waiting';
  const busy = (await client.query(`SELECT 1 FROM background_inquiry WHERE universe_id=$1 AND kind=$2 AND status='queued'`, [inquiry.universe_id, inquiry.kind])).rowCount;
  const used = await openedToday(client, inquiry.universe_id, inquiry.privacy_epoch);
  // Today's limit reached: it stays pending (the reader sees `waiting`) until tomorrow.
  if (busy || used >= consent.daily_limit) return 'waiting';

  let pairs = selectInquiryPairs(await readInquiryInputs(client, inquiry.universe_id, inquiry.privacy_epoch));
  if (pairs.length === 0) { await close('nothing_to_ask', ['no_candidate_pair']); return 'nothing_to_ask'; }
  const bytesFor = (offered: readonly InquiryPair[]) => serializeBridgeInquiryRequest(offered, requestRoute(route));
  // The request must fit the route's input bound: the last pairs give way first.
  while (pairs.length > 1 && bytesFor(pairs).byteLength > route.max_input_tokens) pairs = pairs.slice(0, -1);
  if (bytesFor(pairs).byteLength > route.max_input_tokens) { await close('failed', ['request_too_large']); return 'failed'; }

  const scope = { universeId: inquiry.universe_id, privacyEpoch: inquiry.privacy_epoch };
  const owner = (await client.query<{ bucket_id: string }>('SELECT bucket_id FROM background_inquiry_owner_bucket WHERE policy_version=$1 AND universe_id=$2',
    [route.policy_version, scope.universeId])).rows[0]?.bucket_id ?? await (async () => {
    const id = randomUUID();
    await client.query("INSERT INTO reasoning_bucket(id,dimension,unit,capacity) VALUES($1,'owner_budget','tokens',$2)", [id, route.owner_capacity]);
    await client.query('INSERT INTO background_inquiry_owner_bucket(policy_version,universe_id,bucket_id) VALUES($1,$2,$3)', [route.policy_version, scope.universeId, id]);
    return id;
  })();
  await client.query('SAVEPOINT inquiry_open');
  try {
    const jobBucket = randomUUID();
    await client.query("INSERT INTO reasoning_bucket(id,dimension,unit,capacity) VALUES($1,'job_budget','tokens',$2)", [jobBucket, route.job_capacity]);
    const through = (await client.query<{ n: string }>('SELECT max(sequence)::text AS n FROM inquiry_mail WHERE inquiry_id=$1', [inquiryId])).rows[0]!.n;
    const deadline = (await client.query<{ at: Date }>(`SELECT clock_timestamp() + ($1 * interval '1 second') AS at`, [route.job_ttl_seconds])).rows[0]!.at;
    const job: InquiryJobShape = { ...scope, route, through, deadline };
    if (route.max_children >= 2 && pairs.length >= 2) {
      // ADR-0042 §4: the inquiry becomes a parent. Its Job only waits for its children and holds the
      // family's one budget; each pair is asked by a child with its own Job, binding that budget.
      const offered = pairs.slice(0, route.max_children);
      const parentJob = randomUUID();
      await insertInquiryJob(client, parentJob, job, 'waiting');
      await client.query(
        `UPDATE background_inquiry SET status='queued', role='parent', policy_version=$2, job_id=$3, job_bucket_id=$4, through_sequence=$5, pairs=$6 WHERE id=$1`,
        [inquiryId, route.policy_version, parentJob, jobBucket, through, pairsView(offered)]);
      for (const pair of offered) {
        const childId = randomUUID();
        // A child keeps its parent's identity: universe, epoch, kind, first mail, route and cause.
        await openInquiryJob(client, job, childId, [pair], ids => client.query(
          `INSERT INTO background_inquiry(id,universe_id,privacy_epoch,kind,status,role,parent_id,first_mail_at,policy_version,job_id,step_id,context_id,request_id,through_sequence,pairs)
           SELECT $1,universe_id,privacy_epoch,kind,'queued','child',id,first_mail_at,policy_version,$3,$4,$5,$6,through_sequence,$7 FROM background_inquiry WHERE id=$2`,
          [childId, inquiryId, ids.jobId, ids.stepId, ids.contextId, ids.requestId, pairsView([pair])]));
      }
    } else {
      await openInquiryJob(client, job, inquiryId, pairs, ids => client.query(
        `UPDATE background_inquiry SET status='queued', policy_version=$2, job_id=$3, step_id=$4, context_id=$5, request_id=$6, job_bucket_id=$7,
           through_sequence=$8, pairs=$9 WHERE id=$1`,
        [inquiryId, route.policy_version, ids.jobId, ids.stepId, ids.contextId, ids.requestId, jobBucket, through, pairsView(pairs)]));
    }
    await client.query('RELEASE SAVEPOINT inquiry_open');
    return 'opened';
  } catch (error) {
    if (!(error instanceof ReasoningDenied)) throw error;
    // A context that cannot be sealed now will not seal on retry either: close it, never loop.
    await client.query('ROLLBACK TO SAVEPOINT inquiry_open');
    await close('failed', ['context_refused']);
    return 'failed';
  }
}

// The reader's view -----------------------------------------------------------------------------

const READER_STATUS: Record<string, InquiryWire['status']> = {
  pending: 'waiting', queued: 'looking', admitted: 'found', none: 'nothing_found', rejected: 'did_not_hold_up',
  nothing_to_ask: 'nothing_to_ask', failed: 'failed', withdrawn: 'withdrawn',
};

async function foundBridge(client: pg.PoolClient, proposalId: string): Promise<InquiryWire['found']> {
  return connectionView(client, 'b.proposal_id', proposalId);
}

/** ADR-0039: the same view of any bridge by id (a Relic's connection, a correction on return). */
export async function bridgeConnection(client: pg.PoolClient, bridgeId: string): Promise<InquiryWire['found']> {
  return connectionView(client, 'b.id', bridgeId);
}

async function connectionView(client: pg.PoolClient, column: 'b.id' | 'b.proposal_id', value: string): Promise<InquiryWire['found']> {
  const b = (await client.query<{ id: string; status: 'admitted' | 'revoked' | 'superseded'; relation_type: string; mechanism: string; from_code: string; from_name: string; to_code: string; to_name: string }>(
    `SELECT b.id, b.status, b.relation_type, b.mechanism, f.code AS from_code, f.name AS from_name, t.code AS to_code, t.name AS to_name
     FROM bridge b JOIN concept f ON f.id = b.from_concept_id JOIN concept t ON t.id = b.to_concept_id WHERE ${column}=$1`, [value])).rows[0];
  if (!b) return null;
  // The evidence it was admitted on, even if a source was corrected since (current snapshots first),
  // each saying whether it has since lost its current support (ADR-0044 M4).
  const evidence = (await client.query<{ key: string; statement: string; supports: 'from' | 'to' | 'mechanism' | 'limitation'; source_title: string; source_url: string; withdrawn: boolean }>(
    `SELECT DISTINCT ON (cl.key, e.supports) cl.key, cl.statement, e.supports, s.title AS source_title, s.url AS source_url, NOT claim_is_supported(cl.id) AS withdrawn
     FROM bridge_evidence e JOIN claim cl ON cl.id = e.claim_id JOIN claim_support cs ON cs.claim_id = cl.id AND cs.support_kind = 'supports'
     JOIN source_snapshot ss ON ss.id = cs.snapshot_id JOIN semantic_source s ON s.id = ss.source_id
     WHERE e.bridge_id=$1 ORDER BY cl.key, e.supports, (ss.status = 'current') DESC, s.key`, [b.id])).rows;
  return {
    bridgeId: b.id, bridgeStatus: b.status, relationType: b.relation_type as NonNullable<InquiryWire['found']>['relationType'],
    fromConcept: { code: b.from_code, name: b.from_name }, toConcept: { code: b.to_code, name: b.to_name }, sentence: b.mechanism,
    evidence: evidence.map(e => ({ claimKey: e.key, statement: e.statement, supports: e.supports, sourceTitle: e.source_title, sourceUrl: e.source_url, withdrawn: e.withdrawn })),
  };
}

/** `GET /v1/inquiries`: this universe's inquiries in the current epoch, newest first. A family is its
 * children, each with its own pair and outcome; the parent that only waited for them is not listed. */
export async function listInquiries(client: pg.PoolClient, scope: AuthScope): Promise<InquiriesResponse> {
  const rows = (await client.query<InquiryRow>(
    `SELECT * FROM background_inquiry WHERE universe_id=$1 AND privacy_epoch=$2 AND role <> 'parent' ORDER BY first_mail_at DESC, id DESC LIMIT $3`,
    [scope.universeId, scope.privacyEpoch, INQUIRY_LIST_LIMIT])).rows;
  const inquiries: InquiryWire[] = [];
  for (const r of rows) {
    inquiries.push({
      inquiryId: r.id, status: READER_STATUS[r.status]!, requestedAt: r.first_mail_at.toISOString(), closedAt: r.closed_at ? r.closed_at.toISOString() : null,
      pairs: r.pairs ?? [], reasons: r.reasons, found: r.status === 'admitted' && r.proposal_id ? await foundBridge(client, r.proposal_id) : null,
    });
  }
  return { privacyEpoch: scope.privacyEpoch, consent: await readInquiryConsent(client, scope), inquiries };
}

// Privacy -------------------------------------------------------------------------------------

/** Clear/Reset (after the epoch advanced): mail, inquiries and consent go before the atlas deltas and
 * semantic proposals they reference. The Jobs themselves go with the rest of the reasoning graph. */
export async function eraseInquiries(client: pg.PoolClient, universeId: string): Promise<void> {
  await client.query('DELETE FROM inquiry_mail WHERE universe_id=$1', [universeId]);
  await client.query('DELETE FROM background_inquiry WHERE universe_id=$1', [universeId]);
  await client.query('DELETE FROM background_inquiry_consent WHERE universe_id=$1', [universeId]);
  await client.query('DELETE FROM background_inquiry_consent_request WHERE universe_id=$1', [universeId]);
}

export async function exportInquiries(client: pg.PoolClient, universeId: string) {
  const q = async (sql: string) => (await client.query(sql, [universeId])).rows;
  return {
    consent: await q('SELECT privacy_epoch, enabled, daily_limit, revision, changed_at FROM background_inquiry_consent WHERE universe_id=$1 ORDER BY privacy_epoch'),
    consentRequests: await q('SELECT id, privacy_epoch, enabled, daily_limit, requested_at FROM background_inquiry_consent_request WHERE universe_id=$1 ORDER BY requested_at, id'),
    mail: await q(`SELECT id, privacy_epoch, kind, inquiry_id, cause_kind, cause_delta_id, cause_bridge_id, cause_hypothesis_id, cause_hypothesis_revision, sequence, created_at
      FROM inquiry_mail WHERE universe_id=$1 ORDER BY sequence`),
    inquiries: await q(`SELECT id, privacy_epoch, kind, role, parent_id, status, first_mail_at, opened_at, closed_at, pairs, input_bytes, sent, reasons, proposal_id
      FROM background_inquiry WHERE universe_id=$1 ORDER BY first_mail_at, id`),
  };
}
