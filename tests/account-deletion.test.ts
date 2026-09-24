/**
 * ADR-0035 — deleting the owner account over the real Fastify app. Proves: the deletion needs its
 * own confirmation literal and the current epoch; in one transaction it erases everything Reset
 * does and also deletes every session, sign-in token, dated privacy receipt and the account row,
 * leaving the universe empty and unbound with an address-free tombstone; a cookie session gets its
 * cookie cleared; a later sign-in with the owner address starts a new account on the empty
 * universe; and outside that one transaction the schema still refuses every one of those deletions.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

process.env.KS_OWNER_EMAIL ??= 'owner@knowscroll.test';
process.env.KS_WEB_ORIGIN = 'https://knowscroll.test';
process.env.KS_CSRF_SECRET = 'a-fixed-test-secret-of-at-least-32-bytes!!';
const scratch = await mkdtemp(join(tmpdir(), 'ks-account-deletion-'));
const realDevRoot = process.env.KS_DEV_ROOT;
process.env.KS_DEV_ROOT = scratch;

const { buildApp } = await import('../apps/api/src/app.ts');
const { projectOne } = await import('../apps/worker/src/project.ts');
const { pool, ensureDevelopmentSession } = await import('../packages/db/src/index.ts');
const { resolveOwnerEmail, requestMagicLink } = await import('../packages/db/src/sign-in.ts');

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Account deletion tests require a disposable knowscroll_test_* database');
const app = buildApp(randomBytes(32).toString('hex'), {
  magicLinkLimits: { accountWindowMinutes: 15, accountMaxPerWindow: 500, fingerprintWindowMinutes: 15, fingerprintMaxPerWindow: 500 },
});
await app.ready();
after(async () => { await app.close(); await pool.end(); process.env.KS_DEV_ROOT = realDevRoot; await rm(scratch, { recursive: true, force: true }); });

const ORIGIN = 'https://knowscroll.test';
const CONFIRM = 'delete-my-account-and-history';
async function signInToken(): Promise<string> {
  const requested = await app.inject({ method: 'POST', url: '/v1/auth/magic-link', payload: { email: resolveOwnerEmail() } });
  assert.equal(requested.statusCode, 202);
  return new URLSearchParams(new URL((await readFile(join(scratch, 'sign-in', 'magic-link.txt'), 'utf8')).trim()).hash.slice(1)).get('token')!;
}
async function bearerSession(): Promise<{ authorization: string; universeId: string; accountId: string }> {
  const response = await app.inject({ method: 'POST', url: '/v1/auth/session', payload: { token: await signInToken() } });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  const authorization = `Bearer ${body.sessionToken}`;
  const session = (await app.inject({ url: '/v1/session', headers: { authorization } })).json();
  const account = (await pool.query('SELECT account_id FROM universe WHERE id=$1', [session.universeId])).rows[0].account_id;
  return { authorization, universeId: session.universeId, accountId: account };
}
async function epochOf(headers: Record<string, string>): Promise<number> {
  const u = (await app.inject({ url: '/v1/universe', headers })).json();
  return u.privacyEpoch;
}
async function createHistory(authorization: string): Promise<void> {
  const headers = { authorization };
  const feed = (await app.inject({ url: '/v1/feed', headers })).json();
  const item = feed.items[0];
  const exposure = await app.inject({ method: 'POST', url: '/v1/exposures', headers, payload: { decisionId: feed.decisionId, assetId: item.assetId, clientExposureId: randomUUID() } });
  assert.equal(exposure.statusCode, 201, exposure.body);
  const keep = await app.inject({ method: 'POST', url: '/v1/interactions', headers, payload: { clientEventId: randomUUID(), exposureId: exposure.json().exposureId, assetId: item.assetId, kind: 'keep' } });
  assert.equal(keep.statusCode, 202, keep.body);
  await pool.query("UPDATE job SET available_at='1990-01-01T00:00:00Z' WHERE id=$1", [keep.json().jobId]);
  assert.equal((await projectOne())?.status, 'completed');
  const epoch = await epochOf(headers);
  for (const [url, body] of [['/v1/privacy/pause', {}], ['/v1/privacy/resume', {}], ['/v1/privacy/export', {}]] as const) {
    const r = await app.inject({ method: 'POST', url, headers, payload: { requestId: randomUUID(), expectedPrivacyEpoch: epoch, ...body } });
    assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
  }
}
async function footprint(universeId: string, accountId: string) {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM account WHERE id=$2) accounts,
    (SELECT count(*)::int FROM sign_in_token WHERE account_id=$2) tokens,
    (SELECT count(*)::int FROM device_session WHERE universe_id=$1) sessions,
    (SELECT count(*)::int FROM exposure WHERE universe_id=$1) exposures,
    (SELECT count(*)::int FROM ledger WHERE universe_id=$1) events,
    (SELECT count(*)::int FROM decision WHERE universe_id=$1) decisions,
    (SELECT count(*)::int FROM trace WHERE universe_id=$1) traces,
    (SELECT count(*)::int FROM history_clear_receipt WHERE universe_id=$1)
     + (SELECT count(*)::int FROM privacy_recording_receipt WHERE universe_id=$1)
     + (SELECT count(*)::int FROM privacy_export_receipt WHERE universe_id=$1)
     + (SELECT count(*)::int FROM privacy_reset_receipt WHERE universe_id=$1) receipts,
    (SELECT account_id FROM universe WHERE id=$1) bound`, [universeId, accountId])).rows[0];
}

test('deletion needs its own confirmation and the current epoch, then removes the account and everything personal', async () => {
  const s = await bearerSession();
  await createHistory(s.authorization);
  const before = await footprint(s.universeId, s.accountId);
  assert.ok(before.accounts === 1 && before.tokens > 0 && before.exposures > 0 && before.receipts >= 3, JSON.stringify(before));
  const epoch = await epochOf({ authorization: s.authorization });
  const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/v1/account/delete', headers: { authorization: s.authorization }, payload });
  assert.equal((await post({ requestId: randomUUID(), expectedPrivacyEpoch: epoch, confirmation: 'reset-personal-universe' })).statusCode, 400, 'Reset\'s literal is not enough');
  assert.equal((await post({ requestId: randomUUID(), expectedPrivacyEpoch: epoch + 1, confirmation: CONFIRM })).statusCode, 409, 'a stale epoch is refused');
  assert.equal((await footprint(s.universeId, s.accountId)).accounts, 1, 'refusals change nothing');

  const deleted = await post({ requestId: randomUUID(), expectedPrivacyEpoch: epoch, confirmation: CONFIRM });
  assert.equal(deleted.statusCode, 200, deleted.body);
  const receipt = deleted.json();
  assert.deepEqual(Object.keys(receipt).sort(), ['deletedAt', 'epochAfter', 'epochBefore', 'receiptId', 'sessionsDeleted']);
  assert.equal(receipt.epochAfter, epoch + 1);
  assert.ok(receipt.sessionsDeleted >= 1);

  assert.equal((await app.inject({ url: '/v1/session', headers: { authorization: s.authorization } })).statusCode, 401, 'the calling session is gone');
  assert.deepEqual(await footprint(s.universeId, s.accountId), { accounts: 0, tokens: 0, sessions: 0, exposures: 0, events: 0, decisions: 0, traces: 0, receipts: 0, bound: null });
  const tomb = (await pool.query('SELECT * FROM account_deletion_receipt WHERE id=$1', [receipt.receiptId])).rows[0];
  assert.equal(tomb.account_id, s.accountId);
  assert.ok(!JSON.stringify(tomb).includes(resolveOwnerEmail()), 'the tombstone keeps no address');
  assert.equal((await pool.query('SELECT count(*)::int n FROM account WHERE email=$1', [resolveOwnerEmail()])).rows[0].n, 0);
});

test('signing in again after deletion starts a new account on the empty universe', async () => {
  const s = await bearerSession();
  const deletedAccounts = (await pool.query('SELECT account_id FROM account_deletion_receipt WHERE universe_id=$1', [s.universeId])).rows.map(r => r.account_id);
  assert.ok(deletedAccounts.length >= 1 && !deletedAccounts.includes(s.accountId), 'a new account id');
  const epoch = await epochOf({ authorization: s.authorization });
  const exported = await app.inject({ method: 'POST', url: '/v1/privacy/export', headers: { authorization: s.authorization }, payload: { requestId: randomUUID(), expectedPrivacyEpoch: epoch } });
  assert.equal(exported.statusCode, 200, exported.body);
  const counts = exported.json().rowCounts;
  assert.deepEqual([counts.exposures, counts.ledger, counts.decisions, counts.traces], [0, 0, 0, 0]);
  assert.equal(counts.deviceSessions, 1, 'only this new session exists');
});

test('a cookie session needs its CSRF token to delete, and the cookie is cleared', async () => {
  const minted = await app.inject({ method: 'POST', url: '/v1/auth/web-session', payload: { token: await signInToken() } });
  assert.equal(minted.statusCode, 200, minted.body);
  const cookie = String(minted.headers['set-cookie']).split(';')[0]!;
  const csrf = minted.json().csrfToken;
  const epoch = await epochOf({ cookie });
  const payload = { requestId: randomUUID(), expectedPrivacyEpoch: epoch, confirmation: CONFIRM };
  assert.equal((await app.inject({ method: 'POST', url: '/v1/account/delete', headers: { cookie, origin: ORIGIN }, payload })).statusCode, 403);
  const deleted = await app.inject({ method: 'POST', url: '/v1/account/delete', headers: { cookie, origin: ORIGIN, 'x-csrf-token': csrf }, payload });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.match(String(deleted.headers['set-cookie']), /^ks_session=; .*Max-Age=0$/);
  assert.equal((await app.inject({ url: '/v1/session', headers: { cookie } })).statusCode, 401);
});

test('outside a deletion, the schema refuses every deletion the account transaction performs', async () => {
  const s = await bearerSession();
  await createHistory(s.authorization);
  const refuse = async (sql: string, params: unknown[], pattern: RegExp) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(client.query(sql, params), pattern, sql);
    } finally { await client.query('ROLLBACK'); client.release(); }
  };
  await refuse('DELETE FROM sign_in_token WHERE account_id=$1', [s.accountId], /never deleted/);
  await refuse('UPDATE universe SET account_id=NULL WHERE id=$1', [s.universeId], /stays with the account/);
  await refuse('DELETE FROM privacy_export_receipt WHERE universe_id=$1', [s.universeId], /immutable/);
  await refuse('DELETE FROM privacy_recording_receipt WHERE universe_id=$1', [s.universeId], /immutable/);
  await refuse('DELETE FROM account_deletion_receipt WHERE universe_id=$1', [s.universeId], /immutable/);
  await refuse('UPDATE account_deletion_receipt SET deleted_at=now() WHERE universe_id=$1', [s.universeId], /immutable/);
  // An earlier deletion's receipt authorizes nothing now: its time is not this transaction's.
  const earlier = (await pool.query('SELECT count(*)::int n FROM account_deletion_receipt WHERE universe_id=$1', [s.universeId])).rows[0].n;
  assert.ok(earlier >= 2, 'two earlier deletions exist in this file');
  await refuse('DELETE FROM sign_in_token WHERE account_id=$1', [s.accountId], /never deleted/);
});

test('a deletion ends the development session for good: an API restart does not revive it, and a later sign-in still starts clean', async () => {
  const developmentToken = randomBytes(32).toString('hex');
  await ensureDevelopmentSession(developmentToken);
  const dev = { authorization: `Bearer ${developmentToken}` };
  assert.equal((await app.inject({ url: '/v1/universe', headers: dev })).statusCode, 200, 'the development session works before');

  const s = await bearerSession();
  const epoch = await epochOf({ authorization: s.authorization });
  const deleted = await app.inject({ method: 'POST', url: '/v1/account/delete', headers: { authorization: s.authorization }, payload: { requestId: randomUUID(), expectedPrivacyEpoch: epoch, confirmation: CONFIRM } });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal((await app.inject({ url: '/v1/universe', headers: dev })).statusCode, 401, 'the deletion ended it');

  await ensureDevelopmentSession(developmentToken); // what every API start does (buildApp's onReady)
  assert.equal((await app.inject({ url: '/v1/universe', headers: dev })).statusCode, 401, 'a restart must not revive the development session');

  const again = await bearerSession();
  const afterEpoch = await epochOf({ authorization: again.authorization });
  const exported = await app.inject({ method: 'POST', url: '/v1/privacy/export', headers: { authorization: again.authorization }, payload: { requestId: randomUUID(), expectedPrivacyEpoch: afterEpoch } });
  assert.equal(exported.statusCode, 200, exported.body);
  const counts = exported.json().rowCounts;
  assert.deepEqual([counts.exposures, counts.ledger, counts.decisions, counts.traces, counts.deviceSessions], [0, 0, 0, 0, 1], 'only the new sign-in exists');

  await ensureDevelopmentSession(developmentToken); // and a restart after the new sign-in
  assert.equal((await app.inject({ url: '/v1/universe', headers: dev })).statusCode, 401, 'still ended, exactly as after a Reset');
});

test('a sign-in link requested while the deletion runs never turns it into a 500: both take the account\'s magic-link lock', async () => {
  const s = await bearerSession();
  const epoch = await epochOf({ authorization: s.authorization });
  // A magic-link request caught mid-transaction: it holds its lock and has inserted a token for
  // this account that is not committed yet.
  const racing = await pool.connect();
  try {
    await racing.query('BEGIN');
    const issued = await requestMagicLink(racing, { email: resolveOwnerEmail(), requesterFingerprint: 'f'.repeat(64) },
      { accountWindowMinutes: 15, accountMaxPerWindow: 500, fingerprintWindowMinutes: 15, fingerprintMaxPerWindow: 500 });
    assert.equal(issued?.accountId, s.accountId);
    const deletion = app.inject({ method: 'POST', url: '/v1/account/delete', headers: { authorization: s.authorization }, payload: { requestId: randomUUID(), expectedPrivacyEpoch: epoch, confirmation: CONFIRM } });
    const deadline = Date.now() + 10_000;
    while ((await pool.query(`SELECT count(*)::int n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()`)).rows[0].n === 0) {
      assert.ok(Date.now() < deadline, 'the deletion never waited on the in-flight sign-in request');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await racing.query('COMMIT');
    const response = await deletion;
    assert.equal(response.statusCode, 200, response.body);
  } finally {
    racing.release();
  }
  assert.deepEqual(await footprint(s.universeId, s.accountId), { accounts: 0, tokens: 0, sessions: 0, exposures: 0, events: 0, decisions: 0, traces: 0, receipts: 0, bound: null });
});
