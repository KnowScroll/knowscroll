/** ADR-0023 storage: engines, editorial briefs, budget grants, one Cutroom attempt per job,
 * stored events and settlement. Mirrors ADR-0012's admission/dispatch/reconciliation pattern
 * against migration 0013's own guards; the database CHECK/trigger constraints are the final
 * authority and every function here is written to fail the same way the schema would. No
 * network I/O happens inside any transaction in this file. */
import {createHash, randomUUID} from 'node:crypto';
import type pg from 'pg';
import {briefSource, compileSubmitRequest, generationBrief, type GenerationBrief} from '../../../../packages/contracts/src/generation.ts';
import {prepareCutroomRequest} from '../cutroom/http-client.ts';
import {recordImportedReel, type RecordImportedReelInput, type RecordImportedReelOutcome} from './import.ts';

/** The Cutroom revision this worker is pinned to (ADR-0020/0021). An engine declaring a
 * different revision is refused at job creation: this worker only ever prepares bytes for the
 * revision its own client understands. */
export const CUTROOM_CONTRACT_REVISION = '86d6e2c8b74228db4a5a953e53c53a7b77cef46e';

export const GENERATION_LIMITS = Object.freeze({
  minLeaseMs: 1,
  maxLeaseMs: 300_000,
  maxResendCount: 3,
});

export class GenerationDenied extends Error {
  constructor(readonly code: string) {
    super(`Generation operation denied: ${code}`);
    this.name = 'GenerationDenied';
  }
}

function deny(code: string): never {
  throw new GenerationDenied(code);
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ownerPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/;

function validateUuid(value: string, code: string): void {
  if (!uuidPattern.test(value)) deny(code);
}
function validateOwner(owner: string): void {
  if (!ownerPattern.test(owner)) deny('invalid_owner');
}
function validateFence(value: string): void {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) deny('invalid_lease_fence');
}
function validBoundedInteger(value: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

/** Deterministic canonical JSON, so the same brief content always hashes the same way
 * regardless of key insertion order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function rollbackQuietly(client: pg.PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* a lost COMMIT ack can leave nothing to roll back */ }
}
async function transaction<T>(db: pg.Pool, body: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await body(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await rollbackQuietly(client);
    if (!(error instanceof GenerationDenied) && typeof error === 'object' && error !== null
      && 'code' in error && ['23503', '23505', '23514', '23P01'].includes(String((error as {code: unknown}).code))) {
      throw new GenerationDenied('storage_constraint');
    }
    throw error;
  } finally {
    client.release();
  }
}

// --- Engines -----------------------------------------------------------------------------

export type RegisterEngineInput = {
  id?: string;
  origin: string;
  contractRevision: string;
  artifactRoot: string;
  providerMode: 'standin' | 'live';
  declaredBy: string;
};
export async function registerEngine(db: pg.Pool, input: RegisterEngineInput): Promise<{id: string}> {
  const id = input.id ?? randomUUID();
  await db.query(
    `INSERT INTO cutroom_engine(id,origin,contract_revision,artifact_root,provider_mode,declared_by)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [id, input.origin, input.contractRevision, input.artifactRoot, input.providerMode, input.declaredBy],
  );
  return {id};
}

export async function retireEngine(db: pg.Pool, engineId: string): Promise<void> {
  validateUuid(engineId, 'invalid_engine_id');
  const result = await db.query(
    `UPDATE cutroom_engine SET retired_at=clock_timestamp() WHERE id=$1 AND retired_at IS NULL`,
    [engineId],
  );
  if (result.rowCount !== 1) deny('engine_not_active');
}

// --- Briefs --------------------------------------------------------------------------------

export type AddBriefInput = {id?: string; brief: GenerationBrief; authoredBy: string};
export async function addBrief(db: pg.Pool, input: AddBriefInput): Promise<{id: string; briefSha256: string}> {
  const parsed = generationBrief.parse(input.brief);
  const source = briefSource(parsed);
  const id = input.id ?? randomUUID();
  const briefSha256 = sha256(canonical(parsed));
  await db.query(
    `INSERT INTO generation_brief(id,source_asset_id,source_asset_revision,truth_state,brief,brief_sha256,authored_by,review_state)
     VALUES($1,$2,$3,'synthesis',$4,$5,$6,'draft')`,
    [id, source.assetId, source.assetRevision, JSON.stringify(parsed), briefSha256, input.authoredBy],
  );
  return {id, briefSha256};
}

export async function approveBrief(db: pg.Pool, briefId: string): Promise<void> {
  validateUuid(briefId, 'invalid_brief_id');
  const result = await db.query(
    `UPDATE generation_brief SET review_state='approved' WHERE id=$1 AND review_state='draft'`,
    [briefId],
  );
  if (result.rowCount !== 1) deny('brief_not_draft');
}

// --- Grants --------------------------------------------------------------------------------

export type CreateGrantInput = {
  id?: string;
  mode: 'standin' | 'live';
  capCents: number;
  authorizationRef?: string | null;
  expiresAt: string;
};
export async function createGrant(db: pg.Pool, input: CreateGrantInput): Promise<{id: string}> {
  if (!validBoundedInteger(input.capCents, 1)) deny('invalid_cap_cents');
  if (!Number.isFinite(Date.parse(input.expiresAt))) deny('invalid_expiry');
  if (input.mode === 'live') {
    // Owner decision 2026-09-20 (ADR-0023 sec. 2): no live grant may be created until upstream
    // ships real providers; the current runtime never authorizes one on its own initiative.
    if (!input.authorizationRef || input.authorizationRef.trim().length === 0) deny('live_grant_requires_authorization');
  }
  const id = input.id ?? randomUUID();
  await db.query(
    `INSERT INTO generation_budget_grant(id,mode,cap_cents,authorization_ref,expires_at)
     VALUES($1,$2,$3,$4,$5)`,
    [id, input.mode, input.capCents, input.authorizationRef ?? null, input.expiresAt],
  );
  return {id};
}

// --- Admission: createJob ------------------------------------------------------------------

export type CreateJobInput = {
  id?: string;
  briefId: string;
  engineId: string;
  grantId: string;
  until: 'plan' | 'stills' | 'video';
  budgetCents: number;
  deadlineAt: string;
};
export type CreatedJob = {jobId: string; attemptId: string; requestId: string; bodySha256: string};

/** One transaction: lock the grant row, reserve budgetCents against it (cap enforced by the
 * database CHECK reserved+spent<=cap as a backstop to the explicit guarded UPDATE below),
 * compile and prepare the exact request bytes, insert the job and its 'prepared' attempt.
 * Any failure — including the migration's own admission trigger denying an unapproved brief,
 * a retired engine or an expired/mismatched-mode grant — creates nothing at all. */
export async function createJob(db: pg.Pool, input: CreateJobInput): Promise<CreatedJob> {
  for (const [value, code] of [[input.briefId, 'invalid_brief_id'], [input.engineId, 'invalid_engine_id'], [input.grantId, 'invalid_grant_id']] as const) {
    validateUuid(value, code);
  }
  if (!validBoundedInteger(input.budgetCents, 1)) deny('invalid_budget_cents');
  if (!Number.isFinite(Date.parse(input.deadlineAt))) deny('invalid_deadline');

  return transaction(db, async (client) => {
    const engine = (await client.query<{provider_mode: string; contract_revision: string; retired_at: Date | null}>(
      'SELECT provider_mode,contract_revision,retired_at FROM cutroom_engine WHERE id=$1 FOR UPDATE', [input.engineId],
    )).rows[0];
    if (!engine) deny('unknown_engine');
    if (engine.retired_at !== null) deny('engine_retired');
    if (engine.contract_revision !== CUTROOM_CONTRACT_REVISION) deny('engine_contract_revision_mismatch');
    // No live spend is authorized by this runtime slice (ADR-0023 owner decision 2026-09-20).
    if (engine.provider_mode === 'live') deny('live_dispatch_not_authorized');

    const briefRow = (await client.query<{brief: GenerationBrief; review_state: string}>(
      'SELECT brief,review_state FROM generation_brief WHERE id=$1 FOR UPDATE', [input.briefId],
    )).rows[0];
    if (!briefRow) deny('unknown_brief');
    if (briefRow.review_state !== 'approved') deny('brief_not_approved');
    const brief = generationBrief.parse(briefRow.brief);

    const grant = (await client.query<{mode: string; expires_at: Date}>(
      'SELECT mode,expires_at FROM generation_budget_grant WHERE id=$1 FOR UPDATE', [input.grantId],
    )).rows[0];
    if (!grant) deny('unknown_grant');
    if (grant.mode !== engine.provider_mode) deny('grant_mode_mismatch');
    if (grant.expires_at.getTime() <= Date.now()) deny('grant_expired');

    // Reserve first: an atomic, guarded increment. Exactly-at-cap succeeds; one cent over fails
    // this WHERE clause (rowCount 0) before any job/attempt row is ever written.
    const reserved = await client.query(
      `UPDATE generation_budget_grant SET reserved_cents=reserved_cents+$2
       WHERE id=$1 AND reserved_cents+spent_cents+$2<=cap_cents`,
      [input.grantId, input.budgetCents],
    );
    if (reserved.rowCount !== 1) deny('grant_cap_exceeded');

    const jobId = input.id ?? randomUUID();
    const attemptId = randomUUID();
    const requestId = `ks-gen-${randomUUID()}`;
    const compiled = compileSubmitRequest({brief, requestId, until: input.until, budgetCents: input.budgetCents});
    const prepared = prepareCutroomRequest(compiled);

    // The admission trigger re-validates brief/engine/grant against the current row images;
    // it is the schema's own authority and this call trusts it rather than duplicating it.
    await client.query(
      `INSERT INTO generation_job(id,brief_id,engine_id,grant_id,until,budget_cents,deadline_at)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [jobId, input.briefId, input.engineId, input.grantId, input.until, input.budgetCents, input.deadlineAt],
    );
    await client.query(
      `INSERT INTO cutroom_attempt(id,job_id,ordinal,request_id,request_body,body_sha256,contract_revision)
       VALUES($1,$2,1,$3,$4,$5,$6)`,
      [attemptId, jobId, prepared.requestId, prepared.body, prepared.bodySha256, CUTROOM_CONTRACT_REVISION],
    );
    return {jobId, attemptId, requestId: prepared.requestId, bodySha256: prepared.bodySha256};
  });
}

// --- Claim / lease / fence -------------------------------------------------------------------

const RECLAIMABLE_STATUSES = ['dispatching', 'following', 'importing'] as const;
const TERMINAL_JOB_STATUSES = ['completed', 'refused', 'stopped', 'failed', 'cancelled'] as const;

export type ClaimedGenerationJob = {
  jobId: string;
  briefId: string;
  engineId: string;
  grantId: string;
  until: 'plan' | 'stills' | 'video';
  budgetCents: number;
  status: string;
  deadlineAt: Date;
  cancelRequestedAt: Date | null;
  fence: string;
  leaseExpiresAt: Date;
};

export async function claimJob(db: pg.Pool, input: {owner: string; leaseMs: number}): Promise<ClaimedGenerationJob | null> {
  validateOwner(input.owner);
  if (!validBoundedInteger(input.leaseMs, GENERATION_LIMITS.minLeaseMs, GENERATION_LIMITS.maxLeaseMs)) deny('invalid_lease_duration');
  const result = await db.query<{
    id: string; brief_id: string; engine_id: string; grant_id: string; until: 'plan' | 'stills' | 'video';
    budget_cents: number; status: string; deadline_at: Date; cancel_requested_at: Date | null;
    fence: string; lease_expires_at: Date;
  }>(
    `WITH candidate AS (
       SELECT id FROM generation_job
       WHERE (status='queued' AND lease_owner IS NULL AND deadline_at>clock_timestamp())
          OR (status=ANY($3::text[]) AND lease_expires_at<=clock_timestamp())
       ORDER BY created_at,id
       FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE generation_job j SET
       status=CASE WHEN j.status='queued' THEN 'dispatching' ELSE j.status END,
       lease_owner=$1,
       lease_expires_at=clock_timestamp()+($2::bigint*interval '1 millisecond'),
       fence=j.fence+1,
       updated_at=clock_timestamp()
     FROM candidate WHERE j.id=candidate.id
     RETURNING j.id,j.brief_id,j.engine_id,j.grant_id,j.until,j.budget_cents,j.status,j.deadline_at,
       j.cancel_requested_at,j.fence,j.lease_expires_at`,
    [input.owner, input.leaseMs, RECLAIMABLE_STATUSES],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    jobId: row.id, briefId: row.brief_id, engineId: row.engine_id, grantId: row.grant_id,
    until: row.until, budgetCents: row.budget_cents, status: row.status, deadlineAt: row.deadline_at,
    cancelRequestedAt: row.cancel_requested_at, fence: row.fence, leaseExpiresAt: row.lease_expires_at,
  };
}

type LeaseHolder = {jobId: string; owner: string; leaseFence: string};

/** Re-locks the job row and requires the caller to hold its current, unexpired lease fence.
 * Every worker-driven mutation past claimJob goes through this so a fenced-out or lease-expired
 * worker can never mutate state a newer claimant now owns. */
async function requireLeasedJob(client: pg.PoolClient, holder: LeaseHolder) {
  validateUuid(holder.jobId, 'invalid_job_id');
  validateOwner(holder.owner);
  validateFence(holder.leaseFence);
  const row = (await client.query<{
    engine_id: string; grant_id: string; budget_cents: number; until: 'plan' | 'stills' | 'video'; status: string;
    lease_owner: string | null; fence: string; lease_expires_at: Date | null; deadline_at: Date;
    cancel_requested_at: Date | null;
  }>(
    `SELECT engine_id,grant_id,budget_cents,until,status,lease_owner,fence,lease_expires_at,deadline_at,cancel_requested_at
     FROM generation_job WHERE id=$1 FOR UPDATE`, [holder.jobId],
  )).rows[0];
  if (!row) deny('unknown_job');
  if (row.lease_owner !== holder.owner || row.fence !== holder.leaseFence) deny('stale_lease');
  if (!row.lease_expires_at || row.lease_expires_at.getTime() <= Date.now()) deny('lease_expired');
  return row;
}

// --- Dispatch authorization ------------------------------------------------------------------

export type DispatchGrant = {attemptId: string; requestId: string; body: string; bodySha256: string; contractRevision: string; until: 'plan' | 'stills' | 'video'; budgetCents: number};

/** Short transaction, no network: re-checks lease fence, cancellation, engine and grant, moves
 * the attempt prepared -> dispatch_committed and returns the exact stored bytes. Only the caller
 * receiving this transaction's result may perform one POST. */
export async function authorizeDispatch(db: pg.Pool, holder: LeaseHolder): Promise<DispatchGrant> {
  return transaction(db, async (client) => {
    const job = await requireLeasedJob(client, holder);
    if (job.cancel_requested_at !== null) deny('cancel_requested');
    if (job.status !== 'dispatching') deny('job_not_dispatching');
    if (job.deadline_at.getTime() <= Date.now()) deny('deadline_passed');
    const engine = (await client.query<{retired_at: Date | null}>(
      'SELECT retired_at FROM cutroom_engine WHERE id=$1 FOR UPDATE', [job.engine_id],
    )).rows[0];
    if (!engine || engine.retired_at !== null) deny('engine_retired');
    const grant = (await client.query<{expires_at: Date}>(
      'SELECT expires_at FROM generation_budget_grant WHERE id=$1 FOR UPDATE', [job.grant_id],
    )).rows[0];
    if (!grant || grant.expires_at.getTime() <= Date.now()) deny('grant_expired');
    const attempt = (await client.query<{id: string; request_id: string; request_body: string; body_sha256: string; contract_revision: string; state: string}>(
      'SELECT id,request_id,request_body,body_sha256,contract_revision,state FROM cutroom_attempt WHERE job_id=$1 AND ordinal=1 FOR UPDATE',
      [holder.jobId],
    )).rows[0];
    if (!attempt || attempt.state !== 'prepared') deny('attempt_not_preparable');
    const updated = await client.query(
      `UPDATE cutroom_attempt SET state='dispatch_committed',dispatch_committed_at=clock_timestamp()
       WHERE id=$1 AND state='prepared'`, [attempt.id],
    );
    if (updated.rowCount !== 1) deny('dispatch_race_lost');
    return {
      attemptId: attempt.id, requestId: attempt.request_id, body: attempt.request_body,
      bodySha256: attempt.body_sha256, contractRevision: attempt.contract_revision,
      until: job.until, budgetCents: job.budget_cents,
    };
  });
}

// --- Closing before dispatch -------------------------------------------------------------------

export type CloseReason = 'cancelled' | 'deadline';
export async function closeNotSent(db: pg.Pool, holder: LeaseHolder, reason: CloseReason): Promise<void> {
  await transaction(db, async (client) => {
    const job = await requireLeasedJob(client, holder);
    const attempt = (await client.query<{id: string; state: string}>(
      'SELECT id,state FROM cutroom_attempt WHERE job_id=$1 AND ordinal=1 FOR UPDATE', [holder.jobId],
    )).rows[0];
    if (!attempt || attempt.state !== 'prepared') deny('attempt_not_closable');
    await client.query(`UPDATE cutroom_attempt SET state='not_sent',settlement='released' WHERE id=$1`, [attempt.id]);
    const released = await client.query(
      `UPDATE generation_budget_grant SET reserved_cents=reserved_cents-$2 WHERE id=$1 AND reserved_cents>=$2`,
      [job.grant_id, job.budget_cents],
    );
    if (released.rowCount !== 1) deny('grant_reservation_missing');
    const status = reason === 'cancelled' ? 'cancelled' : 'failed';
    const detail = reason === 'cancelled' ? 'closed not_sent: cancelled before dispatch' : 'closed not_sent: deadline exceeded before dispatch';
    await client.query(`UPDATE generation_job SET status=$2,status_detail=$3 WHERE id=$1`, [holder.jobId, status, detail]);
  });
}

// --- Recording HTTP outcomes -------------------------------------------------------------------

export async function recordAccepted(db: pg.Pool, holder: LeaseHolder, outcome: {runId: string; replayed: boolean | null}): Promise<void> {
  await transaction(db, async (client) => {
    await requireLeasedJob(client, holder);
    const attempt = (await client.query<{id: string; state: string}>(
      'SELECT id,state FROM cutroom_attempt WHERE job_id=$1 AND ordinal=1 FOR UPDATE', [holder.jobId],
    )).rows[0];
    if (!attempt || !['dispatch_committed', 'unknown'].includes(attempt.state)) deny('attempt_not_dispatched');
    await client.query(
      `UPDATE cutroom_attempt SET state='accepted',run_id=$2,replayed=$3,accepted_at=clock_timestamp() WHERE id=$1`,
      [attempt.id, outcome.runId, outcome.replayed],
    );
    await client.query(`UPDATE generation_job SET status='following',status_detail=NULL WHERE id=$1`, [holder.jobId]);
  });
}

export type Refusal = {reason: string; detail: string; httpStatus: 409 | 422};
export async function recordRefused(db: pg.Pool, holder: LeaseHolder, refusal: Refusal): Promise<void> {
  await transaction(db, async (client) => {
    const job = await requireLeasedJob(client, holder);
    const attempt = (await client.query<{id: string; state: string}>(
      'SELECT id,state FROM cutroom_attempt WHERE job_id=$1 AND ordinal=1 FOR UPDATE', [holder.jobId],
    )).rows[0];
    if (!attempt || !['dispatch_committed', 'unknown'].includes(attempt.state)) deny('attempt_not_dispatched');
    await client.query(
      `UPDATE cutroom_attempt SET state='refused',refusal=$2,settlement='released' WHERE id=$1`,
      [attempt.id, JSON.stringify(refusal)],
    );
    const released = await client.query(
      `UPDATE generation_budget_grant SET reserved_cents=reserved_cents-$2 WHERE id=$1 AND reserved_cents>=$2`,
      [job.grant_id, job.budget_cents],
    );
    if (released.rowCount !== 1) deny('grant_reservation_missing');
    await client.query(`UPDATE generation_job SET status='refused',status_detail=$2 WHERE id=$1`, [holder.jobId, refusal.detail]);
  });
}

export async function recordUnknown(db: pg.Pool, holder: LeaseHolder, detail: string): Promise<void> {
  await transaction(db, async (client) => {
    await requireLeasedJob(client, holder);
    const attempt = (await client.query<{id: string; state: string}>(
      'SELECT id,state FROM cutroom_attempt WHERE job_id=$1 AND ordinal=1 FOR UPDATE', [holder.jobId],
    )).rows[0];
    if (!attempt || attempt.state !== 'dispatch_committed') deny('attempt_not_dispatch_committed');
    await client.query(
      `UPDATE cutroom_attempt SET state='unknown',last_status=$2 WHERE id=$1`,
      [attempt.id, JSON.stringify({observedAt: new Date().toISOString(), detail})],
    );
    await client.query(`UPDATE generation_job SET status_detail=$2 WHERE id=$1`, [holder.jobId, detail]);
  });
}

/** One identical-bytes resend attempt against an unknown outcome. Bounded at 3 by the
 * migration's own CHECK; the caller must stop offering resends once this throws
 * `resend_bound_reached` and instead park the job with `parkNeedsOperator`. */
export async function recordResend(db: pg.Pool, holder: LeaseHolder): Promise<{resendCount: number}> {
  return transaction(db, async (client) => {
    await requireLeasedJob(client, holder);
    const attempt = (await client.query<{id: string; state: string; resend_count: number}>(
      'SELECT id,state,resend_count FROM cutroom_attempt WHERE job_id=$1 AND ordinal=1 FOR UPDATE', [holder.jobId],
    )).rows[0];
    if (!attempt || attempt.state !== 'unknown') deny('attempt_not_unknown');
    if (attempt.resend_count >= GENERATION_LIMITS.maxResendCount) deny('resend_bound_reached');
    const updated = await client.query<{resend_count: number}>(
      `UPDATE cutroom_attempt SET resend_count=resend_count+1 WHERE id=$1 RETURNING resend_count`, [attempt.id],
    );
    return {resendCount: updated.rows[0]?.resend_count ?? attempt.resend_count + 1};
  });
}

export async function parkNeedsOperator(db: pg.Pool, holder: LeaseHolder, detail: string): Promise<void> {
  await transaction(db, async (client) => {
    await requireLeasedJob(client, holder);
    const updated = await client.query(
      `UPDATE generation_job SET status='needs_operator',status_detail=$2 WHERE id=$1 AND status NOT IN ('completed','refused','stopped','failed','cancelled')`,
      [holder.jobId, detail],
    );
    if (updated.rowCount !== 1) deny('job_already_terminal');
  });
}

// --- Events ---------------------------------------------------------------------------------

export type IncomingEvent = {seq: number; event: unknown};
export async function appendEvents(db: pg.Pool, holder: LeaseHolder, page: {events: readonly IncomingEvent[]; nextSince: number}): Promise<{stored: number; nextSince: number}> {
  return transaction(db, async (client) => {
    await requireLeasedJob(client, holder);
    const attempt = (await client.query<{id: string; state: string; next_since: number}>(
      'SELECT id,state,next_since FROM cutroom_attempt WHERE job_id=$1 AND ordinal=1 FOR UPDATE', [holder.jobId],
    )).rows[0];
    if (!attempt || attempt.state !== 'accepted') deny('attempt_not_following');
    if (page.nextSince < attempt.next_since) deny('cursor_regression');
    let stored = 0;
    let cursor = attempt.next_since;
    for (const item of page.events) {
      if (item.seq <= cursor) deny('event_seq_regression');
      const inserted = await client.query(
        `INSERT INTO cutroom_event(attempt_id,seq,event) VALUES($1,$2,$3) ON CONFLICT(attempt_id,seq) DO NOTHING`,
        [attempt.id, item.seq, JSON.stringify(item.event)],
      );
      stored += inserted.rowCount ?? 0;
      cursor = item.seq; // A gap between the previous cursor and this seq is recorded, not hidden or rejected.
    }
    const advanced = await client.query(
      `UPDATE cutroom_attempt SET next_since=$2 WHERE id=$1 AND next_since<=$2`, [attempt.id, page.nextSince],
    );
    if (advanced.rowCount !== 1) deny('cursor_regression');
    return {stored, nextSince: page.nextSince};
  });
}

// --- Result / record / settlement ------------------------------------------------------------

export type ResultOutcome = {status: 'completed' | 'refused' | 'stopped' | 'failed' | 'cancelled'; costCents: number; body: unknown};
export async function recordResult(db: pg.Pool, holder: LeaseHolder, outcome: ResultOutcome): Promise<{jobStatus: string}> {
  return transaction(db, async (client) => {
    const job = await requireLeasedJob(client, holder);
    const attempt = (await client.query<{id: string; state: string}>(
      'SELECT id,state FROM cutroom_attempt WHERE job_id=$1 AND ordinal=1 FOR UPDATE', [holder.jobId],
    )).rows[0];
    if (!attempt || attempt.state !== 'accepted') deny('attempt_not_accepted');
    await client.query(
      `UPDATE cutroom_attempt SET state='finished',result=$2,reported_cost_cents=$3,finished_at=clock_timestamp() WHERE id=$1`,
      [attempt.id, JSON.stringify(outcome.body), outcome.costCents],
    );
    const jobStatus = outcome.status === 'completed' && job.until === 'video' ? 'importing' : outcome.status;
    await client.query(`UPDATE generation_job SET status=$2,status_detail=NULL WHERE id=$1`, [holder.jobId, jobStatus]);
    return {jobStatus};
  });
}

export async function recordRecordSummary(db: pg.Pool, holder: LeaseHolder, record: unknown): Promise<void> {
  await transaction(db, async (client) => {
    await requireLeasedJob(client, holder);
    const attempt = (await client.query<{id: string; state: string}>(
      'SELECT id,state FROM cutroom_attempt WHERE job_id=$1 AND ordinal=1 FOR UPDATE', [holder.jobId],
    )).rows[0];
    if (!attempt || attempt.state !== 'finished') deny('attempt_not_finished');
    await client.query(`UPDATE cutroom_attempt SET record_summary=$2 WHERE id=$1`, [attempt.id, JSON.stringify(record)]);
  });
}

export type SettleResult = {releasedCents: number; spentCents: number};
/** A terminal result's reported cost moves from reserved to spent; the rest of the reservation
 * is released. Never called for a job that never reached a recorded result: an unresolved
 * attempt keeps its whole reservation held, by simply never calling this function. */
export async function settle(db: pg.Pool, holder: LeaseHolder): Promise<SettleResult> {
  return transaction(db, async (client) => {
    const job = await requireLeasedJob(client, holder);
    const attempt = (await client.query<{id: string; state: string; settlement: string; reported_cost_cents: number | null}>(
      'SELECT id,state,settlement,reported_cost_cents FROM cutroom_attempt WHERE job_id=$1 AND ordinal=1 FOR UPDATE', [holder.jobId],
    )).rows[0];
    if (!attempt || attempt.state !== 'finished' || attempt.settlement !== 'held' || attempt.reported_cost_cents === null) {
      deny('attempt_not_settleable');
    }
    const reportedCostCents = attempt.reported_cost_cents as number;
    const updatedGrant = await client.query(
      `UPDATE generation_budget_grant SET reserved_cents=reserved_cents-$2,spent_cents=spent_cents+$3
       WHERE id=$1 AND reserved_cents>=$2`,
      [job.grant_id, job.budget_cents, reportedCostCents],
    );
    if (updatedGrant.rowCount !== 1) deny('grant_reservation_missing');
    const updatedAttempt = await client.query(
      `UPDATE cutroom_attempt SET settlement='settled' WHERE id=$1 AND state='finished' AND settlement='held'`, [attempt.id],
    );
    if (updatedAttempt.rowCount !== 1) deny('settlement_race_lost');
    return {releasedCents: job.budget_cents - reportedCostCents, spentCents: reportedCostCents};
  });
}

// --- Operator: cancellation --------------------------------------------------------------------

/** Operator-initiated: sets the cancellation request. Does not require an active worker lease,
 * because a job may sit queued (no worker holding it yet) when an operator cancels it. */
export async function requestCancel(db: pg.Pool, jobId: string): Promise<void> {
  validateUuid(jobId, 'invalid_job_id');
  const result = await db.query(
    `UPDATE generation_job SET cancel_requested_at=clock_timestamp()
     WHERE id=$1 AND cancel_requested_at IS NULL AND status NOT IN ('completed','refused','stopped','failed','cancelled')`,
    [jobId],
  );
  if (result.rowCount !== 1) deny('job_not_cancellable');
}

/** A queued job (never claimed, so it holds no lease) can be closed directly: no dispatch
 * authority was ever issued, so this mirrors closeNotSent without requiring a lease holder. */
export async function closeQueuedCancelled(db: pg.Pool, jobId: string): Promise<void> {
  validateUuid(jobId, 'invalid_job_id');
  await transaction(db, async (client) => {
    const job = (await client.query<{grant_id: string; budget_cents: number; status: string; cancel_requested_at: Date | null}>(
      'SELECT grant_id,budget_cents,status,cancel_requested_at FROM generation_job WHERE id=$1 FOR UPDATE', [jobId],
    )).rows[0];
    if (!job) deny('unknown_job');
    if (job.status !== 'queued') deny('job_not_queued');
    if (job.cancel_requested_at === null) deny('cancel_not_requested');
    const attempt = (await client.query<{id: string; state: string}>(
      'SELECT id,state FROM cutroom_attempt WHERE job_id=$1 AND ordinal=1 FOR UPDATE', [jobId],
    )).rows[0];
    if (!attempt || attempt.state !== 'prepared') deny('attempt_not_closable');
    await client.query(`UPDATE cutroom_attempt SET state='not_sent',settlement='released' WHERE id=$1`, [attempt.id]);
    const released = await client.query(
      `UPDATE generation_budget_grant SET reserved_cents=reserved_cents-$2 WHERE id=$1 AND reserved_cents>=$2`,
      [job.grant_id, job.budget_cents],
    );
    if (released.rowCount !== 1) deny('grant_reservation_missing');
    await client.query(`UPDATE generation_job SET status='cancelled',status_detail='closed not_sent: cancelled while queued' WHERE id=$1`, [jobId]);
  });
}

// --- Reads for the worker loop and operator status -------------------------------------------

export type AttemptSnapshot = {
  id: string; state: string; requestId: string; body: string; bodySha256: string; contractRevision: string;
  runId: string | null; replayed: boolean | null; nextSince: number; resendCount: number;
  result: unknown; recordSummary: unknown; reportedCostCents: number | null; settlement: string;
};
export async function loadAttempt(db: pg.Pool, jobId: string): Promise<AttemptSnapshot | null> {
  const row = (await db.query<{
    id: string; state: string; request_id: string; request_body: string; body_sha256: string; contract_revision: string;
    run_id: string | null; replayed: boolean | null; next_since: number; resend_count: number;
    result: unknown; record_summary: unknown; reported_cost_cents: number | null; settlement: string;
  }>(
    `SELECT id,state,request_id,request_body,body_sha256,contract_revision,run_id,replayed,next_since,resend_count,
      result,record_summary,reported_cost_cents,settlement
     FROM cutroom_attempt WHERE job_id=$1 AND ordinal=1`, [jobId],
  )).rows[0];
  if (!row) return null;
  return {
    id: row.id, state: row.state, requestId: row.request_id, body: row.request_body, bodySha256: row.body_sha256,
    contractRevision: row.contract_revision, runId: row.run_id, replayed: row.replayed, nextSince: row.next_since,
    resendCount: row.resend_count, result: row.result, recordSummary: row.record_summary,
    reportedCostCents: row.reported_cost_cents, settlement: row.settlement,
  };
}

export type JobSnapshot = {
  id: string; briefId: string; engineId: string; grantId: string; until: 'plan' | 'stills' | 'video';
  budgetCents: number; status: string; statusDetail: string | null; cancelRequestedAt: Date | null;
  deadlineAt: Date; leaseOwner: string | null; fence: string;
};
export async function loadJob(db: pg.Pool, jobId: string): Promise<JobSnapshot | null> {
  const row = (await db.query<{
    id: string; brief_id: string; engine_id: string; grant_id: string; until: 'plan' | 'stills' | 'video';
    budget_cents: number; status: string; status_detail: string | null; cancel_requested_at: Date | null;
    deadline_at: Date; lease_owner: string | null; fence: string;
  }>(
    `SELECT id,brief_id,engine_id,grant_id,until,budget_cents,status,status_detail,cancel_requested_at,deadline_at,lease_owner,fence
     FROM generation_job WHERE id=$1`, [jobId],
  )).rows[0];
  if (!row) return null;
  return {
    id: row.id, briefId: row.brief_id, engineId: row.engine_id, grantId: row.grant_id, until: row.until,
    budgetCents: row.budget_cents, status: row.status, statusDetail: row.status_detail,
    cancelRequestedAt: row.cancel_requested_at, deadlineAt: row.deadline_at, leaseOwner: row.lease_owner, fence: row.fence,
  };
}

export async function engineOrigin(db: pg.Pool, engineId: string): Promise<{origin: string; artifactRoot: string; providerMode: string} | null> {
  const row = (await db.query<{origin: string; artifact_root: string; provider_mode: string}>(
    'SELECT origin,artifact_root,provider_mode FROM cutroom_engine WHERE id=$1', [engineId],
  )).rows[0];
  return row ? {origin: row.origin, artifactRoot: row.artifact_root, providerMode: row.provider_mode} : null;
}

// --- Verified import (ADR-0023 section 4, issue #94 stage A2) --------------------------------

/** The brief's own content digest, for the `generated_reel.lineage` this job's import records.
 * Never the brief body itself (sources/claim text must never cross into a generated record). */
export async function briefSha256Of(db: pg.Pool, briefId: string): Promise<string> {
  const row = (await db.query<{brief_sha256: string}>('SELECT brief_sha256 FROM generation_brief WHERE id=$1', [briefId])).rows[0];
  if (!row) throw new Error('generation_worker_defect: brief vanished for an active job');
  return row.brief_sha256;
}

/** Thin pool-connect wrapper around `import.ts`'s own one-transaction `recordImportedReel`, so the
 * worker loop never has to manage a `pg.PoolClient` itself. Owns no additional rules: migration
 * 0013's lineage trigger remains the only authority for whether an import may be recorded. */
export async function commitImportedReel(db: pg.Pool, input: RecordImportedReelInput): Promise<RecordImportedReelOutcome> {
  const client = await db.connect();
  try {
    return await recordImportedReel(client, input);
  } finally {
    client.release();
  }
}

/** A verified import committed: the job reaches its final `completed` status. Only valid from
 * `importing` — never called for a job that has not actually finished a video attempt. */
export async function completeImportedJob(db: pg.Pool, holder: LeaseHolder): Promise<void> {
  await transaction(db, async (client) => {
    const job = await requireLeasedJob(client, holder);
    if (job.status !== 'importing') deny('job_not_importing');
    await client.query(`UPDATE generation_job SET status='completed',status_detail=NULL WHERE id=$1`, [holder.jobId]);
  });
}

/**
 * A typed, honest import refusal: the job's status stays `importing` (never a fabricated success,
 * never a fabricated terminal failure) with the refusal reason recorded in `status_detail`, so a
 * later lease reclaim retries the import for as long as the engine's file still exists — exactly
 * `claimJob`'s own `RECLAIMABLE_STATUSES` behavior, unchanged for this status.
 */
export async function recordImportRefusal(db: pg.Pool, holder: LeaseHolder, detail: string): Promise<void> {
  await transaction(db, async (client) => {
    const job = await requireLeasedJob(client, holder);
    if (job.status !== 'importing') deny('job_not_importing');
    await client.query(`UPDATE generation_job SET status_detail=$2 WHERE id=$1`, [holder.jobId, detail]);
  });
}
