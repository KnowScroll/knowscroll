/** ADR-0023, issue #94 stage A1 ("runtime" lane): proves the storage layer's own admission,
 * lease/fence, dispatch-authorization, refusal/unknown/resend/park, event-cursor and settlement
 * behaviour against real disposable PostgreSQL. This file never talks to Cutroom or any HTTP
 * fixture — end-to-end worker behaviour against a local fixture lives in
 * `tests/generation-runtime.test.ts`. Fixture/storage proof only; never product acceptance. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {generationBrief, type GenerationBrief} from '../packages/contracts/src/generation.ts';
import * as storage from '../apps/worker/src/generation/storage.ts';

const databaseUrl = process.env.DATABASE_URL ?? (() => { throw new Error('DATABASE_URL required'); })();
const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!databaseName.startsWith('knowscroll_test_')) {
  throw new Error(`Generation admission tests require a disposable knowscroll_test_* database, received ${databaseName}`);
}

const pool = new pg.Pool({connectionString: databaseUrl, max: 12});

const claim = (id: string, role: 'main' | 'supporting') => ({id, role});
const sentence = (text: string, claimIds: string[]) => ({text, claimIds});
function makeBrief(assetId: string): GenerationBrief {
  // Each call must hash distinctly (brief_sha256 is UNIQUE): the worldId carries a fresh id.
  return generationBrief.parse({
    version: 1, worldId: `library-world-${randomUUID()}`,
    narration: [
      sentence('A wax seal closes the charter.', ['claim-seal']),
      sentence('The barons gather in the stone hall.', ['claim-hall']),
      sentence('A king sets his hand to the page.', ['claim-king']),
      sentence('The copy leaves for the shires.', ['claim-seal']),
    ],
    claims: [claim('claim-seal', 'main'), claim('claim-hall', 'supporting'), claim('claim-king', 'supporting')],
    claimSources: [
      {claimId: 'claim-seal', assetId, assetRevision: 1},
      {claimId: 'claim-hall', assetId, assetRevision: 1},
      {claimId: 'claim-king', assetId, assetRevision: 1},
    ],
    criteria: {
      mustShow: [{id: 'show-seal', text: 'A wax seal.', type: 'presence', claimId: 'claim-seal'}],
      mustNotShow: [{id: 'never-flag', text: 'A modern flag.', type: 'presence'}],
      depictionPolicyVersion: 'depiction-v1',
    },
    style: {id: 'library', version: 1, text: 'Quiet, documentary, no captions burned in.'},
  });
}

let assetId: string;
let enginePort = 24390;

async function freshEngine(mode: 'standin' | 'live' = 'standin', overrides: Partial<storage.RegisterEngineInput> = {}) {
  enginePort += 1;
  const {id} = await storage.registerEngine(pool, {
    origin: `http://127.0.0.1:${enginePort}`,
    contractRevision: storage.CUTROOM_CONTRACT_REVISION,
    artifactRoot: '/Volumes/Mrigesh SSD/knowscroll-dev/cutroom/instances/generation-admission-test/artifacts',
    providerMode: mode,
    declaredBy: 'generation-admission-test',
    ...overrides,
  });
  return id;
}
async function approvedBrief() {
  const {id} = await storage.addBrief(pool, {brief: makeBrief(assetId), authoredBy: 'generation-admission-test'});
  await storage.approveBrief(pool, id);
  return id;
}
async function freshGrant(capCents: number, mode: 'standin' | 'live' = 'standin') {
  const {id} = await storage.createGrant(pool, {
    mode, capCents,
    authorizationRef: mode === 'live' ? 'owner decision 2026-09-20: test fixture only' : undefined,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  return id;
}
function future(ms = 3_600_000): string { return new Date(Date.now() + ms).toISOString(); }

async function grantRow(grantId: string) {
  return (await pool.query<{reserved_cents: number; spent_cents: number; cap_cents: number}>(
    'SELECT reserved_cents,spent_cents,cap_cents FROM generation_budget_grant WHERE id=$1', [grantId],
  )).rows[0]!;
}
async function attemptRow(jobId: string) {
  return (await pool.query('SELECT * FROM cutroom_attempt WHERE job_id=$1 AND ordinal=1', [jobId])).rows[0];
}
async function jobRow(jobId: string) {
  return (await pool.query('SELECT * FROM generation_job WHERE id=$1', [jobId])).rows[0];
}
function isDenied(code: string) {
  return (error: unknown) => error instanceof storage.GenerationDenied && error.code === code;
}

/** `pnpm test` runs every `tests/*.test.ts` file against one shared disposable database, and
 * `storage.claimJob` claims the globally oldest ready job. Draining any pre-existing `queued`
 * job away first (a benign, non-destructive status change) keeps every claim below deterministic
 * regardless of what another file in this run may have left behind. */
async function drainStrayQueuedJobs(): Promise<void> {
  for (;;) {
    const claimed = await storage.claimJob(pool, {owner: 'generation-admission-test-sweep', leaseMs: 60_000});
    if (!claimed) return;
  }
}

test('ADR-0023 generation storage: admission, lease/fence, dispatch, outcomes, events, settlement', async (t) => {
  assetId = (await pool.query<{id: string}>('SELECT id FROM asset ORDER BY editorial_order LIMIT 1')).rows[0]?.id as string;
  assert.ok(assetId, 'the seeded library has at least one asset');
  await drainStrayQueuedJobs();
  try {

  await t.test('admission is all-or-nothing; exactly at cap admits, one cent over refuses', async () => {
    const engineId = await freshEngine();
    const briefId = await approvedBrief();
    const grantId = await freshGrant(500);

    const created = await storage.createJob(pool, {briefId, engineId, grantId, until: 'video', budgetCents: 500, deadlineAt: future()});
    assert.ok(created.jobId && created.attemptId);
    assert.equal((await grantRow(grantId)).reserved_cents, 500);

    await assert.rejects(
      storage.createJob(pool, {briefId, engineId, grantId, until: 'video', budgetCents: 1, deadlineAt: future()}),
      isDenied('grant_cap_exceeded'),
    );
    assert.equal((await grantRow(grantId)).reserved_cents, 500, 'a denied admission must not touch the reservation');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM generation_job WHERE grant_id=$1', [grantId])).rows[0]?.n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM cutroom_attempt WHERE job_id=$1', [created.jobId])).rows[0]?.n, 1);

    const emptyGrant = await freshGrant(500);
    await assert.rejects(
      storage.createJob(pool, {briefId, engineId, grantId: emptyGrant, until: 'video', budgetCents: 501, deadlineAt: future()}),
      isDenied('grant_cap_exceeded'),
    );
    assert.equal((await grantRow(emptyGrant)).reserved_cents, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM generation_job WHERE grant_id=$1', [emptyGrant])).rows[0]?.n, 0);

    // Claim the surviving job away from 'queued' so later subtests' own claimJob calls (which
    // pick the globally oldest ready job, by design) cannot pick this one up instead of their own.
    const swept = await storage.claimJob(pool, {owner: 'admission-sweep', leaseMs: 60_000});
    assert.equal(swept?.jobId, created.jobId);
  });

  await t.test('admission refuses an unapproved brief, a retired engine and a mode-mismatched grant, creating nothing', async () => {
    const engineId = await freshEngine();
    const grantId = await freshGrant(1_000);
    const {id: draftBriefId} = await storage.addBrief(pool, {brief: makeBrief(assetId), authoredBy: 'generation-admission-test'});
    await assert.rejects(
      storage.createJob(pool, {briefId: draftBriefId, engineId, grantId, until: 'video', budgetCents: 100, deadlineAt: future()}),
      isDenied('brief_not_approved'),
    );
    assert.equal((await grantRow(grantId)).reserved_cents, 0);

    const briefId = await approvedBrief();
    const retiredEngineId = await freshEngine();
    await storage.retireEngine(pool, retiredEngineId);
    await assert.rejects(
      storage.createJob(pool, {briefId, engineId: retiredEngineId, grantId, until: 'video', budgetCents: 100, deadlineAt: future()}),
      isDenied('engine_retired'),
    );
    assert.equal((await grantRow(grantId)).reserved_cents, 0);

    // This runtime slice refuses ANY live-engine job outright (owner decision 2026-09-20, ADR-0023
    // section 2). A live engine is checked before the grant at all, so this needs no live-mode
    // grant row here: migration 0013's cumulative 200-cent live-grant cap is a single shared
    // database-wide total, and `generation-contract.test.ts` (a different lane's file, sharing
    // this same disposable database within one `pnpm test` run) already exercises that boundary
    // exactly at its limit. Creating an additional live grant here would risk breaking that file's
    // assertions depending on file execution order, so `grant_mode_mismatch` (standin engine vs.
    // live grant) is intentionally left unexercised in this file; it is covered indirectly by
    // migration 0013's own admission trigger, which `generation-contract.test.ts` already proves.
    const liveEngineId = await freshEngine('live');
    await assert.rejects(
      storage.createJob(pool, {briefId, engineId: liveEngineId, grantId, until: 'video', budgetCents: 100, deadlineAt: future()}),
      isDenied('live_dispatch_not_authorized'),
    );
    assert.equal((await grantRow(grantId)).reserved_cents, 0);
  });

  await t.test('concurrent admission on one grant cannot over-reserve', async () => {
    const engineId = await freshEngine();
    const briefId = await approvedBrief();
    const grantId = await freshGrant(100);
    const outcomes = await Promise.allSettled([
      storage.createJob(pool, {briefId, engineId, grantId, until: 'plan', budgetCents: 60, deadlineAt: future()}),
      storage.createJob(pool, {briefId, engineId, grantId, until: 'plan', budgetCents: 60, deadlineAt: future()}),
    ]);
    const fulfilled = outcomes.filter((o): o is PromiseFulfilledResult<storage.CreatedJob> => o.status === 'fulfilled');
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(isDenied('grant_cap_exceeded')(rejected[0]!.reason));
    assert.equal((await grantRow(grantId)).reserved_cents, 60);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM generation_job WHERE grant_id=$1', [grantId])).rows[0]?.n, 1);
    // As above: remove the surviving job from 'queued' candidacy for later subtests.
    await storage.claimJob(pool, {owner: 'admission-sweep', leaseMs: 60_000});
  });

  await t.test('claim/fence/lease: claiming increments the fence, and a locked job cannot block another candidate', async () => {
    const engineId = await freshEngine();
    const briefId = await approvedBrief();
    const grantA = await freshGrant(1_000);
    const grantB = await freshGrant(1_000);
    const jobA = await storage.createJob(pool, {briefId, engineId, grantId: grantA, until: 'plan', budgetCents: 10, deadlineAt: future()});
    const jobB = await storage.createJob(pool, {briefId, engineId, grantId: grantB, until: 'plan', budgetCents: 10, deadlineAt: future()});

    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM generation_job WHERE id=$1 FOR UPDATE', [jobA.jobId]);
    try {
      const timeout = new Promise((_resolve, reject) => setTimeout(() => reject(new Error('claimJob blocked on a locked row')), 3_000));
      const claimed = await Promise.race([storage.claimJob(pool, {owner: 'worker-a', leaseMs: 20_000}), timeout]);
      assert.equal((claimed as storage.ClaimedGenerationJob | null)?.jobId, jobB.jobId);
      assert.equal((claimed as storage.ClaimedGenerationJob).fence, '1');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    const reclaimedA = await storage.claimJob(pool, {owner: 'worker-a', leaseMs: 20_000});
    assert.equal(reclaimedA?.jobId, jobA.jobId);
    assert.equal(reclaimedA?.fence, '1');
    assert.equal(await storage.claimJob(pool, {owner: 'worker-a', leaseMs: 20_000}), null);
  });

  await t.test('dispatch authorization refuses a stale fence or a cancelled job', async () => {
    const engineId = await freshEngine();
    const briefId = await approvedBrief();
    const grantId = await freshGrant(1_000);
    const job = await storage.createJob(pool, {briefId, engineId, grantId, until: 'plan', budgetCents: 50, deadlineAt: future()});
    const claimed = await storage.claimJob(pool, {owner: 'worker-a', leaseMs: 20_000});
    assert.equal(claimed?.jobId, job.jobId);
    const holder = {jobId: job.jobId, owner: 'worker-a', leaseFence: claimed!.fence};

    await assert.rejects(
      storage.authorizeDispatch(pool, {...holder, leaseFence: String(BigInt(holder.leaseFence) + 1n)}),
      isDenied('stale_lease'),
    );
    await assert.rejects(storage.authorizeDispatch(pool, {...holder, owner: 'worker-b'}), isDenied('stale_lease'));

    await storage.requestCancel(pool, job.jobId);
    await assert.rejects(storage.authorizeDispatch(pool, holder), isDenied('cancel_requested'));
    assert.equal((await attemptRow(job.jobId)).state, 'prepared', 'a denied authorization must not move the attempt');
  });

  await t.test("'prepared' + cancel closes not_sent and releases the reservation", async () => {
    const engineId = await freshEngine();
    const briefId = await approvedBrief();
    const grantId = await freshGrant(1_000);
    const job = await storage.createJob(pool, {briefId, engineId, grantId, until: 'plan', budgetCents: 75, deadlineAt: future()});
    const claimed = await storage.claimJob(pool, {owner: 'worker-a', leaseMs: 20_000});
    const holder = {jobId: job.jobId, owner: 'worker-a', leaseFence: claimed!.fence};
    assert.equal((await grantRow(grantId)).reserved_cents, 75);

    await storage.requestCancel(pool, job.jobId);
    await storage.closeNotSent(pool, holder, 'cancelled');
    const attempt = await attemptRow(job.jobId);
    assert.equal(attempt.state, 'not_sent');
    assert.equal(attempt.settlement, 'released');
    assert.equal((await jobRow(job.jobId)).status, 'cancelled');
    assert.equal((await grantRow(grantId)).reserved_cents, 0, 'the whole reservation is released');

    await assert.rejects(storage.closeNotSent(pool, holder, 'cancelled'), isDenied('attempt_not_closable'));
  });

  await t.test('a refusal releases the reservation and marks the job refused', async () => {
    const engineId = await freshEngine();
    const briefId = await approvedBrief();
    const grantId = await freshGrant(1_000);
    const job = await storage.createJob(pool, {briefId, engineId, grantId, until: 'plan', budgetCents: 40, deadlineAt: future()});
    const claimed = await storage.claimJob(pool, {owner: 'worker-a', leaseMs: 20_000});
    const holder = {jobId: job.jobId, owner: 'worker-a', leaseFence: claimed!.fence};
    await storage.authorizeDispatch(pool, holder);
    assert.equal((await grantRow(grantId)).reserved_cents, 40);

    await storage.recordRefused(pool, holder, {reason: 'conflict', detail: 'fixture conflict', httpStatus: 409});
    const attempt = await attemptRow(job.jobId);
    assert.equal(attempt.state, 'refused');
    assert.equal(attempt.settlement, 'released');
    assert.equal(attempt.run_id, null, 'a refusal never has a run');
    assert.equal((await jobRow(job.jobId)).status, 'refused');
    assert.equal((await grantRow(grantId)).reserved_cents, 0);
  });

  await t.test('an unknown outcome is reconciled by lookup on the original request id and never creates a second identity', async () => {
    const engineId = await freshEngine();
    const briefId = await approvedBrief();
    const grantId = await freshGrant(1_000);
    const job = await storage.createJob(pool, {briefId, engineId, grantId, until: 'video', budgetCents: 200, deadlineAt: future()});
    const originalRequestId = job.requestId;
    const claimed = await storage.claimJob(pool, {owner: 'worker-a', leaseMs: 20_000});
    const holder = {jobId: job.jobId, owner: 'worker-a', leaseFence: claimed!.fence};
    await storage.authorizeDispatch(pool, holder);
    await storage.recordUnknown(pool, holder, 'simulated transport loss');
    assert.equal((await attemptRow(job.jobId)).state, 'unknown');

    // Reconciliation resolves via a lookup keyed on the SAME request id that was originally
    // prepared; storage.recordAccepted never takes a request id parameter at all, so there is no
    // code path here that could fabricate a second identity for this job.
    await storage.recordAccepted(pool, holder, {runId: 'run-reconciled-1', replayed: null});
    const attempt = await attemptRow(job.jobId);
    assert.equal(attempt.state, 'accepted');
    assert.equal(attempt.run_id, 'run-reconciled-1');
    assert.equal(attempt.request_id, originalRequestId, 'reconciliation never changes the original request id');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM cutroom_attempt WHERE job_id=$1', [job.jobId])).rows[0]?.n, 1);
    assert.equal((await jobRow(job.jobId)).status, 'following');
  });

  await t.test('the identical-bytes resend is bounded at 3 and then parks the job, keeping the reservation held', async () => {
    const engineId = await freshEngine();
    const briefId = await approvedBrief();
    const grantId = await freshGrant(1_000);
    const job = await storage.createJob(pool, {briefId, engineId, grantId, until: 'video', budgetCents: 90, deadlineAt: future()});
    const claimed = await storage.claimJob(pool, {owner: 'worker-a', leaseMs: 20_000});
    const holder = {jobId: job.jobId, owner: 'worker-a', leaseFence: claimed!.fence};
    await storage.authorizeDispatch(pool, holder);
    await storage.recordUnknown(pool, holder, 'simulated transport loss');

    assert.equal((await storage.recordResend(pool, holder)).resendCount, 1);
    assert.equal((await storage.recordResend(pool, holder)).resendCount, 2);
    assert.equal((await storage.recordResend(pool, holder)).resendCount, 3);
    await assert.rejects(storage.recordResend(pool, holder), isDenied('resend_bound_reached'));
    assert.equal((await attemptRow(job.jobId)).state, 'unknown', 'still unresolved after 3 bounded resends');
    assert.equal((await grantRow(grantId)).reserved_cents, 90, 'a missing result keeps the whole reservation held');

    await storage.parkNeedsOperator(pool, holder, 'exhausted 3 identical-bytes resends without resolution');
    assert.equal((await jobRow(job.jobId)).status, 'needs_operator');
    assert.equal((await grantRow(grantId)).reserved_cents, 90, 'parking never releases the reservation');
    // needs_operator is not terminal (recoverable by an operator or later evidence), so parking
    // again is idempotent rather than an error.
    await storage.parkNeedsOperator(pool, holder, 'still parked');
    assert.equal((await jobRow(job.jobId)).status, 'needs_operator');
  });

  await t.test('event pages advance the cursor, reject a regression, and record a gap rather than hide it', async () => {
    const engineId = await freshEngine();
    const briefId = await approvedBrief();
    const grantId = await freshGrant(1_000);
    const job = await storage.createJob(pool, {briefId, engineId, grantId, until: 'video', budgetCents: 60, deadlineAt: future()});
    const claimed = await storage.claimJob(pool, {owner: 'worker-a', leaseMs: 20_000});
    const holder = {jobId: job.jobId, owner: 'worker-a', leaseFence: claimed!.fence};
    await storage.authorizeDispatch(pool, holder);
    await storage.recordAccepted(pool, holder, {runId: 'run-events-1', replayed: false});

    const first = await storage.appendEvents(pool, holder, {
      events: [{seq: 1, event: {type: 'run.accepted'}}, {seq: 2, event: {type: 'stage.started', stage: 'plan'}}],
      nextSince: 2,
    });
    assert.deepEqual(first, {stored: 2, nextSince: 2});
    assert.equal((await attemptRow(job.jobId)).next_since, 2);

    await assert.rejects(
      storage.appendEvents(pool, holder, {events: [{seq: 2, event: {type: 'duplicate'}}], nextSince: 2}),
      isDenied('event_seq_regression'),
    );
    await assert.rejects(
      storage.appendEvents(pool, holder, {events: [], nextSince: 1}),
      isDenied('cursor_regression'),
    );
    assert.equal((await attemptRow(job.jobId)).next_since, 2, 'a rejected page must not move the cursor');

    // A gap (seq jumps from 2 straight to 5) is recorded faithfully, not rejected and not hidden.
    const gapPage = await storage.appendEvents(pool, holder, {events: [{seq: 5, event: {type: 'stage.finished', stage: 'plan'}}], nextSince: 5});
    assert.deepEqual(gapPage, {stored: 1, nextSince: 5});
    const seqs = (await pool.query<{seq: number}>('SELECT seq FROM cutroom_event WHERE attempt_id=$1 ORDER BY seq', [(await attemptRow(job.jobId)).id])).rows.map((r) => r.seq);
    assert.deepEqual(seqs, [1, 2, 5], 'seq 3 and 4 are genuinely absent, exactly reflecting what the page reported');
    assert.equal((await attemptRow(job.jobId)).next_since, 5);
  });

  await t.test('settlement moves the reported cost to spent and releases the remainder', async () => {
    const engineId = await freshEngine();
    const briefId = await approvedBrief();
    const grantId = await freshGrant(1_000);
    const job = await storage.createJob(pool, {briefId, engineId, grantId, until: 'plan', budgetCents: 120, deadlineAt: future()});
    const claimed = await storage.claimJob(pool, {owner: 'worker-a', leaseMs: 20_000});
    const holder = {jobId: job.jobId, owner: 'worker-a', leaseFence: claimed!.fence};
    await storage.authorizeDispatch(pool, holder);
    await storage.recordAccepted(pool, holder, {runId: 'run-settle-1', replayed: false});
    const {jobStatus} = await storage.recordResult(pool, holder, {status: 'completed', costCents: 37, body: {status: 'completed', until: 'plan', estimateCents: 37}});
    assert.equal(jobStatus, 'completed', 'a plan-only completed result needs no import');
    assert.equal((await attemptRow(job.jobId)).settlement, 'held', 'held until settle() runs');
    assert.equal((await grantRow(grantId)).reserved_cents, 120, 'a recorded-but-unsettled result still keeps the reservation held');

    const settled = await storage.settle(pool, holder);
    assert.deepEqual(settled, {releasedCents: 83, spentCents: 37});
    const grant = await grantRow(grantId);
    assert.equal(grant.reserved_cents, 0);
    assert.equal(grant.spent_cents, 37);
    assert.equal((await attemptRow(job.jobId)).settlement, 'settled');
    await assert.rejects(storage.settle(pool, holder), isDenied('attempt_not_settleable'));
  });

  await t.test('a missing result keeps the reservation held indefinitely (until an operator or later evidence resolves it)', async () => {
    const engineId = await freshEngine();
    const briefId = await approvedBrief();
    const grantId = await freshGrant(1_000);
    const job = await storage.createJob(pool, {briefId, engineId, grantId, until: 'video', budgetCents: 65, deadlineAt: future()});
    const claimed = await storage.claimJob(pool, {owner: 'worker-a', leaseMs: 20_000});
    const holder = {jobId: job.jobId, owner: 'worker-a', leaseFence: claimed!.fence};
    await storage.authorizeDispatch(pool, holder);
    await storage.recordAccepted(pool, holder, {runId: 'run-missing-result', replayed: false});
    // No recordResult/settle call at all: the attempt simply sits accepted/following.
    assert.equal((await grantRow(grantId)).reserved_cents, 65);
    assert.equal((await attemptRow(job.jobId)).state, 'accepted');
  });

  await t.test('operator cancellation of a still-queued job closes it not_sent without ever claiming it', async () => {
    const engineId = await freshEngine();
    const briefId = await approvedBrief();
    const grantId = await freshGrant(1_000);
    const job = await storage.createJob(pool, {briefId, engineId, grantId, until: 'plan', budgetCents: 30, deadlineAt: future()});
    assert.equal((await jobRow(job.jobId)).status, 'queued');
    await storage.requestCancel(pool, job.jobId);
    await assert.rejects(storage.requestCancel(pool, job.jobId), isDenied('job_not_cancellable'));
    await storage.closeQueuedCancelled(pool, job.jobId);
    assert.equal((await jobRow(job.jobId)).status, 'cancelled');
    assert.equal((await attemptRow(job.jobId)).state, 'not_sent');
    assert.equal((await grantRow(grantId)).reserved_cents, 0);
    assert.equal(await storage.claimJob(pool, {owner: 'worker-a', leaseMs: 1_000}), null, 'a cancelled job is never claimable');
    await assert.rejects(storage.requestCancel(pool, job.jobId), isDenied('job_not_cancellable'));
  });
  } finally {
    await pool.end();
  }
});
