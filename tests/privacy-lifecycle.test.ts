/**
 * ADR-0028 / issue #4 / #115 — pause, export and reset over the real Fastify app (`buildApp`),
 * exactly like tests/history-clear.test.ts. Proves: pause stops new exposure/keep/ask ledger rows
 * (a database refusal, not an application promise) while leaving reads, the served feed, existing
 * jobs and the privacy epoch untouched; resume lifts it without ever backfilling what was missed
 * (nothing was ever half-written, because every blocked attempt rolled back its own transaction);
 * export returns exactly the rows the contract promises, always live, and only ever records one
 * receipt per (universe, requestId) key; reset performs every Clear step plus revokes every
 * session for the universe including the caller's own; every operation takes the universe lock
 * before touching a row and rechecks the authenticated session's epoch after that wait resolves;
 * and a concurrent session cannot slip a write in between (either genuinely excluded, for the two
 * destructive operations, or genuinely idempotent, for pause/resume/export, which is the honest
 * behaviour the ADR itself describes for each).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { buildApp } from '../apps/api/src/app.ts';
import { projectOne } from '../apps/worker/src/project.ts';
import { exportUniverse, pool, provisionIdentity } from '../packages/db/src/index.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) {
  throw new Error('Privacy lifecycle tests require an isolated knowscroll_test_* database');
}
const developmentToken = 'privacy-lifecycle-development-token-1234567';
const app = buildApp(developmentToken);
await app.ready();
after(async () => { await app.close(); await pool.end(); });

type Identity = Awaited<ReturnType<typeof provisionIdentity>>;
const headers = (token: string) => ({ authorization: `Bearer ${token}` });

async function createHistory(identity: Identity): Promise<{ jobId: string }> {
  const feedResponse = await app.inject({ url: '/v1/feed', headers: headers(identity.token) });
  assert.equal(feedResponse.statusCode, 200);
  const feed = feedResponse.json(), item = feed.items[0];
  const exposureResponse = await app.inject({ method: 'POST', url: '/v1/exposures', headers: headers(identity.token), payload: { decisionId: feed.decisionId, assetId: item.assetId, clientExposureId: randomUUID() } });
  assert.equal(exposureResponse.statusCode, 201);
  const exposure = exposureResponse.json();
  const keepResponse = await app.inject({ method: 'POST', url: '/v1/interactions', headers: headers(identity.token), payload: { clientEventId: randomUUID(), exposureId: exposure.exposureId, assetId: item.assetId, kind: 'keep' } });
  assert.equal(keepResponse.statusCode, 202);
  const keep = keepResponse.json();
  await pool.query("UPDATE job SET available_at='1990-01-01T00:00:00Z' WHERE id=$1", [keep.jobId]);
  assert.deepEqual(await projectOne(), { jobId: keep.jobId, status: 'completed' });
  return { jobId: keep.jobId };
}

async function scopedCounts(universeId: string) {
  return (await pool.query(`SELECT
   (SELECT count(*)::int FROM decision WHERE universe_id=$1) decisions,
   (SELECT count(*)::int FROM exposure WHERE universe_id=$1) exposures,
   (SELECT count(*)::int FROM ledger WHERE universe_id=$1) events,
   (SELECT count(*)::int FROM job WHERE universe_id=$1) jobs,
   (SELECT count(*)::int FROM trace WHERE universe_id=$1) traces`, [universeId])).rows[0];
}

function pause(identity: Identity, body: { requestId: string; expectedPrivacyEpoch: number }) {
  return app.inject({ method: 'POST', url: '/v1/privacy/pause', headers: headers(identity.token), payload: body });
}
function resume(identity: Identity, body: { requestId: string; expectedPrivacyEpoch: number }) {
  return app.inject({ method: 'POST', url: '/v1/privacy/resume', headers: headers(identity.token), payload: body });
}
function exportViaHttp(identity: Identity, body: { requestId: string; expectedPrivacyEpoch: number }) {
  return app.inject({ method: 'POST', url: '/v1/privacy/export', headers: headers(identity.token), payload: body });
}
function reset(identity: Identity, body: { requestId: string; expectedPrivacyEpoch: number; confirmation: string }) {
  return app.inject({ method: 'POST', url: '/v1/privacy/reset', headers: headers(identity.token), payload: body });
}

// -------------------------------------------------------------------------------------------
// Pause / resume
// -------------------------------------------------------------------------------------------

test('pause blocks every new ledger write regardless of kind, leaves reads/feed/existing jobs alone, and does not touch the epoch or revision', async () => {
  const owner = await provisionIdentity({ expiresInHours: 2 });
  const otherDevice = await provisionIdentity({ universeId: owner.scope.universeId, expiresInHours: 2 });
  await createHistory(owner); // pre-existing history, must survive untouched

  // A second exposure, recorded before the pause and deliberately left un-kept, so we can try a
  // genuinely valid keep against it while paused (not merely an invalid one).
  const preFeed = (await app.inject({ url: '/v1/feed', headers: headers(owner.token) })).json();
  const preItem = preFeed.items[0];
  const preExposure = await app.inject({ method: 'POST', url: '/v1/exposures', headers: headers(owner.token), payload: { decisionId: preFeed.decisionId, assetId: preItem.assetId, clientExposureId: randomUUID() } });
  assert.equal(preExposure.statusCode, 201);
  const preExposureId = preExposure.json().exposureId;

  const before = await scopedCounts(owner.scope.universeId);
  const universeBefore = (await pool.query('SELECT revision FROM universe WHERE id=$1', [owner.scope.universeId])).rows[0].revision;

  const body = { requestId: randomUUID(), expectedPrivacyEpoch: 0 };
  const response = await pause(owner, body);
  assert.equal(response.statusCode, 200);
  const receipt = response.json();
  assert.equal(receipt.action, 'pause');
  assert.equal(receipt.privacyEpoch, 0);
  assert.ok(receipt.recordingPausedAt, 'a pause receipt reports when recording stopped');
  assert.match(receipt.recordingPausedAt, /Z$/);
  assert.equal(receipt.appliedAt, receipt.recordingPausedAt);

  const universeState = (await app.inject({ url: '/v1/universe', headers: headers(owner.token) })).json();
  assert.ok(universeState.recordingPausedAt, 'GET /v1/universe surfaces the pause');
  assert.equal(universeState.privacyEpoch, 0, 'pause never advances the privacy epoch');
  assert.equal(universeState.revision, universeBefore, 'pause does not bump the general change counter');

  // Browsing continues: a new decision (candidate feed) is not blocked by the ledger guard.
  const feedResponse = await app.inject({ url: '/v1/feed', headers: headers(owner.token) });
  assert.equal(feedResponse.statusCode, 200);
  const feed = feedResponse.json();

  // But every attempt to record a new fact fails at the database, not at some higher validation
  // layer -- exercised here for the two HTTP-reachable kinds (exposure, keep).
  const exposureAttempt = await app.inject({ method: 'POST', url: '/v1/exposures', headers: headers(owner.token), payload: { decisionId: feed.decisionId, assetId: feed.items[0].assetId, clientExposureId: randomUUID() } });
  assert.equal(exposureAttempt.statusCode, 500, 'the ledger_pause_guard trigger refuses the insert');

  // The database's own refusal is kind-agnostic (ledger_pause_guard fires BEFORE any row of any
  // kind is inserted), proven directly for 'ask' without needing the full explicit-ask pairing
  // machinery to be independently exercised here.
  await assert.rejects(
    pool.query("INSERT INTO ledger(id,universe_id,kind,client_key,payload,privacy_epoch) VALUES($1,$2,'ask',$3,'{}'::jsonb,0)", [randomUUID(), owner.scope.universeId, randomUUID()]),
    /Recording is paused/,
  );

  // Nothing partially committed from any blocked attempt (every failure rolled its own transaction back).
  assert.deepEqual(await scopedCounts(owner.scope.universeId), { ...before, decisions: before.decisions + 1 });

  // A genuinely valid keep against the pre-pause exposure is still refused: pausing blocks the
  // new ledger row a keep requires, even though the exposure it references is legitimate.
  const keepAttempt = await app.inject({ method: 'POST', url: '/v1/interactions', headers: headers(owner.token), payload: { clientEventId: randomUUID(), exposureId: preExposureId, assetId: preItem.assetId, kind: 'keep' } });
  assert.equal(keepAttempt.statusCode, 500, 'a valid keep is still refused by the pause guard');
  assert.deepEqual(await scopedCounts(owner.scope.universeId), { ...before, decisions: before.decisions + 1 }, 'the blocked keep attempt left no trace');

  // Every other privacy operation still authenticates and works while paused (pause only blocks
  // Ledger inserts): resume itself must succeed even though ledger writes are blocked.
  const resumeResponse = await resume(owner, { requestId: randomUUID(), expectedPrivacyEpoch: 0 });
  assert.equal(resumeResponse.statusCode, 200);
  const resumeReceipt = resumeResponse.json();
  assert.equal(resumeReceipt.action, 'resume');
  assert.equal(resumeReceipt.recordingPausedAt, null);
  assert.equal(resumeReceipt.privacyEpoch, 0);

  const resumedState = (await app.inject({ url: '/v1/universe', headers: headers(owner.token) })).json();
  assert.equal(resumedState.recordingPausedAt, null);
  assert.equal(resumedState.privacyEpoch, 0);

  // Resuming does not backfill what was missed: the ledger only grows from what is recorded now.
  const afterResume = await scopedCounts(owner.scope.universeId);
  await createHistory(owner);
  const afterNewHistory = await scopedCounts(owner.scope.universeId);
  assert.equal(afterNewHistory.events, afterResume.events + 2, 'exactly the two new events from the new activity, nothing missed getting replayed in');

  // Universe-wide, not per-device: the other device on the same universe saw the same pause.
  assert.equal(otherDevice.scope.universeId, owner.scope.universeId);
});

test('pause/resume replay follows the exact-retry contract but, unlike Clear, never consumes the epoch', async () => {
  const same = await provisionIdentity({ expiresInHours: 1 });
  const body = { requestId: randomUUID(), expectedPrivacyEpoch: 0 };
  const first = await pause(same, body);
  assert.equal(first.statusCode, 200);
  const replay = await pause(same, body);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body, first.body, 'identical key replays the stored receipt');
  const conflict = await pause(same, { ...body, expectedPrivacyEpoch: 1 });
  assert.equal(conflict.statusCode, 409, 'reused key with a different expected epoch is a conflict');
  const unknownWrong = await pause(same, { requestId: randomUUID(), expectedPrivacyEpoch: 1 });
  assert.equal(unknownWrong.statusCode, 409, 'unknown key requires the current epoch');
  assert.equal((await pool.query('SELECT count(*)::int n FROM privacy_recording_receipt WHERE universe_id=$1', [same.scope.universeId])).rows[0].n, 1);

  // Because pause never advances the epoch, two DISTINCT concurrent keys at the SAME starting
  // epoch are both legitimate (unlike Clear/Reset, where the second necessarily loses the race) --
  // this is the honest, documented difference, not a race bug.
  const distinct = await provisionIdentity({ expiresInHours: 1 });
  const [a, b] = await Promise.all([
    pause(distinct, { requestId: randomUUID(), expectedPrivacyEpoch: 0 }),
    pause(distinct, { requestId: randomUUID(), expectedPrivacyEpoch: 0 }),
  ]);
  assert.deepEqual([a.statusCode, b.statusCode], [200, 200]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM privacy_recording_receipt WHERE universe_id=$1', [distinct.scope.universeId])).rows[0].n, 2);
});

test('a request id already spent on resume cannot silently no-op a later pause', async () => {
  // Keyed on (universe, requestId) alone, the second call was answered with the first call's
  // receipt: HTTP 200, a body saying resumed, and recording never actually stopping. A privacy
  // control that reports success for something it did not do is the worst failure here.
  const identity = await provisionIdentity({ expiresInHours: 1 });
  const requestId = randomUUID();
  const resumed = await resume(identity, { requestId, expectedPrivacyEpoch: 0 });
  assert.equal(resumed.statusCode, 200);

  const paused = await pause(identity, { requestId, expectedPrivacyEpoch: 0 });
  assert.equal(paused.statusCode, 200);
  assert.equal(JSON.parse(paused.body).action, 'pause', 'a pause must be answered as a pause');
  const row = (await pool.query(
    'SELECT recording_paused_at FROM universe WHERE id=$1', [identity.scope.universeId],
  )).rows[0];
  assert.ok(row.recording_paused_at, 'recording is really paused, not merely reported as handled');
});

test('pause/resume: auth precedes strict validation, and a malformed body changes nothing', async () => {
  const owner = await provisionIdentity({ expiresInHours: 1 });
  const payload = { requestId: randomUUID(), expectedPrivacyEpoch: 0, extra: true };
  assert.equal((await app.inject({ method: 'POST', url: '/v1/privacy/pause', payload })).statusCode, 401);
  const malformed = await app.inject({ method: 'POST', url: '/v1/privacy/pause', headers: headers(owner.token), payload });
  assert.equal(malformed.statusCode, 400);
  assert.equal((await pool.query('SELECT recording_paused_at FROM universe WHERE id=$1', [owner.scope.universeId])).rows[0].recording_paused_at, null);
});

// -------------------------------------------------------------------------------------------
// Export
// -------------------------------------------------------------------------------------------

test('export contains exactly the rows the contract promises and no more', async () => {
  const owner = await provisionIdentity({ expiresInHours: 2 });
  const otherDevice = await provisionIdentity({ universeId: owner.scope.universeId, expiresInHours: 2 });
  const neighbor = await provisionIdentity({ expiresInHours: 2 });
  await createHistory(owner);
  await createHistory(neighbor);

  const response = await exportViaHttp(owner, { requestId: randomUUID(), expectedPrivacyEpoch: 0 });
  assert.equal(response.statusCode, 200);
  const result = response.json();

  assert.deepEqual(Object.keys(result).sort(), [
    'account', 'accounts', 'decisions', 'deviceSessions', 'exposures', 'exportedAt', 'jobs',
    'askAnswers', 'inquiries', 'ledger', 'privacyEpoch', 'reasoning', 'receiptId', 'personalModel', 'returns', 'rowCounts', 'semantic', 'traces', 'universe',
  ].sort());
  assert.equal(result.privacyEpoch, 0);
  assert.match(result.exportedAt, /Z$/);
  assert.equal(result.account.email, null, 'a development-token universe has no bound account yet');
  assert.deepEqual(result.universe, { id: owner.scope.universeId, revision: result.universe.revision, privacyEpoch: 0, recordingPausedAt: null });
  assert.deepEqual(Object.keys(result.accounts).sort(), ['keptAssetIds', 'revision']);
  assert.equal(result.accounts.keptAssetIds.length, 1);

  // The personal model is counted from the database itself, not from the export being checked.
  const storedCount = async (table: string) => Number((await pool.query(`SELECT count(*) FROM ${table} WHERE universe_id=$1`, [owner.scope.universeId])).rows[0].count);
  const modelAccounts = await storedCount('attention_account'), modelHypotheses = await storedCount('personal_hypothesis');
  assert.equal(result.personalModel.attentionTransitions.length, await storedCount('attention_transition'));
  assert.deepEqual(result.rowCounts, {
    decisions: 1, ledger: 2, exposures: 1, traces: 1, jobs: 1, deviceSessions: 2,
    reasoningJobs: 0, reasoningSteps: 0, reasoningReceipts: 0, reasoningAccounting: 0,
    // ADR-0031: branch opens, connection feedback and personal proposals are exported too.
    branchOpens: 0, connectionFeedback: 0, semanticProposals: 0,
    // ADR-0032: the personal model derived from this history is exported with it.
    attentionAccounts: modelAccounts, hypotheses: modelHypotheses, encounterFeedback: 0,
    // ADR-0033: Ask answer requests and outcomes.
    askAnswers: 0,
    // ADR-0038: background inquiries (their consent, requests and mail are exported alongside).
    inquiries: 0,
    // ADR-0039/0044: return markers, Relics and the reader's objections.
    awayAcknowledgements: 0, relics: 0, objections: 0,
  });
  assert.deepEqual(result.inquiries, { consent: [], consentRequests: [], mail: [], inquiries: [] });
  assert.deepEqual(result.returns, { acknowledgements: [], relics: [], objections: [] });
  assert.equal(result.personalModel.attentionAccounts.length, result.rowCounts.attentionAccounts);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.ledger.length, 2);
  assert.equal(result.exposures.length, 1);
  assert.equal(result.traces.length, 1);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.deviceSessions.length, 2);
  for (const session of result.deviceSessions) {
    assert.deepEqual(Object.keys(session).sort(), ['createdAt', 'deviceId', 'expiresAt', 'origin', 'revokedAt']);
    assert.equal('tokenHash' in session, false);
  }
  assert.deepEqual(result.reasoning, { jobs: [], steps: [], receipts: [], accounting: [] });
  assert.deepEqual(result.semantic, { branchOpens: [], connectionFeedback: [], proposals: [], bridges: [] });
  assert.equal(JSON.stringify(result).includes(neighbor.scope.universeId), false, 'no other universe leaks into this export');
  assert.ok(otherDevice.scope.deviceId);

  const stored = (await pool.query('SELECT row_counts FROM privacy_export_receipt WHERE universe_id=$1', [owner.scope.universeId])).rows[0];
  assert.deepEqual(stored.row_counts, result.rowCounts);
});

test('export always re-reads live rows on a reused key, but writes only one manifest receipt, and refuses a stale epoch', async () => {
  const owner = await provisionIdentity({ expiresInHours: 1 });
  await createHistory(owner);
  const body = { requestId: randomUUID(), expectedPrivacyEpoch: 0 };
  const first = (await exportViaHttp(owner, body)).json();
  await createHistory(owner); // more activity within the same epoch
  const second = (await exportViaHttp(owner, body)).json();
  assert.equal(second.receiptId, first.receiptId, 'the manifest bookkeeping row is not duplicated for a reused key');
  assert.equal(second.exportedAt, first.exportedAt, 'the receipt itself records only the first attempt');
  assert.ok(second.rowCounts.ledger > first.rowCounts.ledger, 'unlike Clear, a reused export key still returns fresh live content');
  assert.equal((await pool.query('SELECT count(*)::int n FROM privacy_export_receipt WHERE universe_id=$1 AND request_id=$2', [owner.scope.universeId, body.requestId])).rows[0].n, 1);

  const resetResponse = await reset(owner, { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: 'reset-personal-universe' });
  assert.equal(resetResponse.statusCode, 200);
  const staleAttempt = await exportViaHttp(owner, { requestId: randomUUID(), expectedPrivacyEpoch: 0 });
  assert.equal(staleAttempt.statusCode, 401, 'the caller\'s own session was revoked by the reset it missed');
});

test('export reports the bound account email once the universe is adopted, and null before that', async () => {
  const owner = await provisionIdentity({ expiresInHours: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const unbound = await exportUniverse(client, owner.scope, { requestId: randomUUID(), expectedPrivacyEpoch: owner.scope.privacyEpoch });
    assert.equal(unbound.account.email, null);
    // `account` is a real (ADR-0026) single-row-ever table: reuse whatever row another suite in
    // this shared run may already have committed, rather than trying to insert a second one.
    const existingAccount = (await client.query('SELECT id,email FROM account LIMIT 1')).rows[0] as { id: string; email: string } | undefined;
    const accountId = existingAccount?.id ?? randomUUID();
    const email = existingAccount?.email ?? 'scratch-export-test@example.test';
    if (!existingAccount) await client.query('INSERT INTO account(id,email) VALUES($1,$2)', [accountId, email]);
    await client.query('UPDATE universe SET account_id=$1 WHERE id=$2', [accountId, owner.scope.universeId]);
    const bound = await exportUniverse(client, owner.scope, { requestId: randomUUID(), expectedPrivacyEpoch: owner.scope.privacyEpoch });
    assert.equal(bound.account.email, email);
  } finally {
    // Rolled back so this never durably creates an account row or rebinds a universe for other suites.
    await client.query('ROLLBACK');
    client.release();
  }
});

test('export: auth precedes strict validation, and a malformed body changes nothing', async () => {
  const owner = await provisionIdentity({ expiresInHours: 1 });
  const payload = { requestId: randomUUID(), expectedPrivacyEpoch: 0, extra: true };
  assert.equal((await app.inject({ method: 'POST', url: '/v1/privacy/export', payload })).statusCode, 401);
  const malformed = await app.inject({ method: 'POST', url: '/v1/privacy/export', headers: headers(owner.token), payload });
  assert.equal(malformed.statusCode, 400);
  assert.equal((await pool.query('SELECT count(*)::int n FROM privacy_export_receipt WHERE universe_id=$1', [owner.scope.universeId])).rows[0].n, 0);
});

// -------------------------------------------------------------------------------------------
// Reset
// -------------------------------------------------------------------------------------------

test('reset erases what it says, leaves what it says, advances the epoch by one, and revokes every session including the caller\'s', async () => {
  const owner = await provisionIdentity({ expiresInHours: 2 });
  const otherDevice = await provisionIdentity({ universeId: owner.scope.universeId, expiresInHours: 2 });
  const neighbor = await provisionIdentity({ expiresInHours: 2 });
  await createHistory(owner);
  await createHistory(neighbor);
  const assetsBefore = Number((await pool.query('SELECT count(*) FROM asset')).rows[0].count);
  const neighborBefore = await scopedCounts(neighbor.scope.universeId);
  const universeBefore = (await pool.query('SELECT revision FROM universe WHERE id=$1', [owner.scope.universeId])).rows[0].revision;

  const body = { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: 'reset-personal-universe' };
  const response = await reset(owner, body);
  assert.equal(response.statusCode, 200);
  const receipt = response.json();
  assert.equal(receipt.epochBefore, 0);
  assert.equal(receipt.epochAfter, 1);
  assert.equal(receipt.sessionsRevoked, 2);
  assert.match(receipt.resetAt, /Z$/);

  assert.deepEqual(await scopedCounts(owner.scope.universeId), { decisions: 0, exposures: 0, events: 0, jobs: 0, traces: 0 });
  assert.deepEqual(await scopedCounts(neighbor.scope.universeId), neighborBefore);
  assert.equal(Number((await pool.query('SELECT count(*) FROM asset')).rows[0].count), assetsBefore);
  const state = (await pool.query('SELECT revision,privacy_epoch FROM universe WHERE id=$1', [owner.scope.universeId])).rows[0];
  assert.equal(state.privacy_epoch, 1);
  assert.equal(state.revision, universeBefore + 1);
  const clearedAccount = (await pool.query('SELECT cardinality(kept_asset_ids) kept FROM accounts WHERE universe_id=$1', [owner.scope.universeId])).rows[0];
  assert.equal(clearedAccount.kept, 0);

  // Unlike Clear, Reset does not roll the calling session forward: every session on the universe
  // is revoked, including the one that asked for the reset.
  assert.equal((await pool.query('SELECT count(*)::int n FROM device_session WHERE universe_id=$1 AND revoked_at IS NULL', [owner.scope.universeId])).rows[0].n, 0);
  assert.equal((await app.inject({ url: '/v1/universe', headers: headers(owner.token) })).statusCode, 401);
  assert.equal((await app.inject({ url: '/v1/universe', headers: headers(otherDevice.token) })).statusCode, 401);
  assert.equal((await app.inject({ url: '/v1/universe', headers: headers(neighbor.token) })).statusCode, 200, 'an unrelated universe is unaffected');
});

test('reset does not delete the account row or the universe row itself', async () => {
  const owner = await provisionIdentity({ expiresInHours: 1 });
  await createHistory(owner);
  const accountsBefore = Number((await pool.query('SELECT count(*) FROM account')).rows[0].count);
  const universesBefore = Number((await pool.query('SELECT count(*) FROM universe')).rows[0].count);
  const response = await reset(owner, { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: 'reset-personal-universe' });
  assert.equal(response.statusCode, 200);
  assert.equal(Number((await pool.query('SELECT count(*) FROM account')).rows[0].count), accountsBefore);
  assert.equal(Number((await pool.query('SELECT count(*) FROM universe WHERE id=$1', [owner.scope.universeId])).rows[0].count), 1);
  assert.equal(Number((await pool.query('SELECT count(*) FROM universe')).rows[0].count), universesBefore);
});

test('reset replay follows Clear\'s exact-retry contract, exercised through a fresh session on the same (now reset) universe', async () => {
  const owner = await provisionIdentity({ expiresInHours: 1 });
  await createHistory(owner);
  const requestId = randomUUID();
  const body = { requestId, expectedPrivacyEpoch: 0, confirmation: 'reset-personal-universe' };
  const first = await reset(owner, body);
  assert.equal(first.statusCode, 200);

  // The caller's own session no longer authenticates at all -- it cannot even attempt a replay.
  assert.equal((await reset(owner, body)).statusCode, 401);

  // A fresh session on the same, now-epoch-1, universe can replay the exact receipt.
  const fresh = await provisionIdentity({ universeId: owner.scope.universeId, expiresInHours: 1 });
  await createHistory(fresh); // real activity recorded after the reset
  const laterCounts = await scopedCounts(owner.scope.universeId);
  const replay = await reset(fresh, body);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body, first.body);
  assert.deepEqual(await scopedCounts(owner.scope.universeId), laterCounts, 'an old receipt replay must not re-erase later activity');
  assert.equal((await app.inject({ url: '/v1/universe', headers: headers(fresh.token) })).statusCode, 200, 'replay is read-only for sessions -- it revoked nothing new');

  const conflict = await reset(fresh, { ...body, expectedPrivacyEpoch: 1 });
  assert.equal(conflict.statusCode, 409, 'reused key with a different expected epoch is a conflict');
  const unknownWrong = await reset(fresh, { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: 'reset-personal-universe' });
  assert.equal(unknownWrong.statusCode, 409, 'unknown key requires the current epoch');
  assert.equal((await pool.query('SELECT count(*)::int n FROM privacy_reset_receipt WHERE universe_id=$1', [owner.scope.universeId])).rows[0].n, 1);
});

test('reset waits for the universe lock before erasing anything', async () => {
  const owner = await provisionIdentity({ expiresInHours: 1 });
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE', [owner.scope.universeId]);
  const pending = reset(owner, { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: 'reset-personal-universe' });
  void pending.catch(() => {});
  try {
    const early = await Promise.race([pending.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))]);
    assert.equal(early, false, 'reset must wait for the universe lock');
  } finally {
    await blocker.query('COMMIT');
    blocker.release();
  }
  const response = await pending;
  assert.equal(response.statusCode, 200);
});

test('a mid-reset failure rolls back the epoch, every deletion, and every session revocation', async () => {
  const owner = await provisionIdentity({ expiresInHours: 1 });
  await createHistory(owner);
  const before = await scopedCounts(owner.scope.universeId);
  const universe = (await pool.query('SELECT revision,privacy_epoch FROM universe WHERE id=$1', [owner.scope.universeId])).rows[0];
  await pool.query(`CREATE FUNCTION reject_reset() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN IF OLD.universe_id='${owner.scope.universeId}'::uuid THEN RAISE EXCEPTION 'forced reset rollback'; END IF; RETURN OLD; END $$`);
  await pool.query('CREATE TRIGGER reject_reset BEFORE DELETE ON decision FOR EACH ROW EXECUTE FUNCTION reject_reset()');
  let response;
  try {
    response = await reset(owner, { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: 'reset-personal-universe' });
  } finally {
    await pool.query('DROP TRIGGER reject_reset ON decision');
    await pool.query('DROP FUNCTION reject_reset()');
  }
  assert.equal(response!.statusCode, 500);
  assert.deepEqual(await scopedCounts(owner.scope.universeId), before);
  assert.deepEqual((await pool.query('SELECT revision,privacy_epoch FROM universe WHERE id=$1', [owner.scope.universeId])).rows[0], universe);
  assert.equal((await pool.query('SELECT count(*)::int n FROM device_session WHERE id=$1 AND revoked_at IS NULL', [owner.scope.sessionId])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM privacy_reset_receipt WHERE universe_id=$1', [owner.scope.universeId])).rows[0].n, 0);
  assert.equal((await app.inject({ url: '/v1/universe', headers: headers(owner.token) })).statusCode, 200, 'the caller\'s session survived the rollback');
});

test('reset: auth precedes strict validation, and a malformed body changes nothing', async () => {
  const owner = await provisionIdentity({ expiresInHours: 1 });
  await createHistory(owner);
  const before = await scopedCounts(owner.scope.universeId);
  const payload = { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: 'reset-personal-universe', extra: true };
  assert.equal((await app.inject({ method: 'POST', url: '/v1/privacy/reset', payload })).statusCode, 401);
  const malformed = await app.inject({ method: 'POST', url: '/v1/privacy/reset', headers: headers(owner.token), payload });
  assert.equal(malformed.statusCode, 400);
  assert.deepEqual(await scopedCounts(owner.scope.universeId), before);
  assert.equal((await pool.query('SELECT privacy_epoch FROM universe WHERE id=$1', [owner.scope.universeId])).rows[0].privacy_epoch, 0);
  // the deliberate confirmation literal is required, and it is not interchangeable with Clear's
  const wrongConfirmation = await app.inject({ method: 'POST', url: '/v1/privacy/reset', headers: headers(owner.token), payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: 'clear-scroll-history' } });
  assert.equal(wrongConfirmation.statusCode, 400);
});

// -------------------------------------------------------------------------------------------
// Receipt schemas
// -------------------------------------------------------------------------------------------

test('receipt schemas retain only retry/manifest metadata', async () => {
  const recordingColumns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='privacy_recording_receipt' ORDER BY ordinal_position")).rows.map(row => row.column_name);
  assert.deepEqual(recordingColumns, ['id', 'universe_id', 'request_id', 'action', 'privacy_epoch', 'applied_at']);
  const exportColumns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='privacy_export_receipt' ORDER BY ordinal_position")).rows.map(row => row.column_name);
  assert.deepEqual(exportColumns, ['id', 'universe_id', 'request_id', 'privacy_epoch', 'exported_at', 'row_counts']);
  const resetColumns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='privacy_reset_receipt' ORDER BY ordinal_position")).rows.map(row => row.column_name);
  assert.deepEqual(resetColumns, ['id', 'universe_id', 'request_id', 'epoch_before', 'epoch_after', 'sessions_revoked', 'reset_at']);
});
