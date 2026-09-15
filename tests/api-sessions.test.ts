import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app.ts';
import { OWNER_ID, pool, provisionIdentity } from '../packages/db/src/index.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) {
  throw new Error('API session tests require an isolated knowscroll_test_* database');
}

const developmentToken = randomBytes(32).toString('hex');
const app = buildApp(developmentToken);
after(async () => { await app.close(); await pool.end(); });

const headers = (token: string) => ({ authorization: `Bearer ${token}` });
const getSession = (token: string) => app.inject({ url: '/v1/session', headers: headers(token) });

async function waitForBlockedRequest(blockerPid: number) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const row = (await pool.query(`SELECT pid, xact_start FROM pg_stat_activity
      WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`, [blockerPid])).rows[0];
    if (row) return row as { pid: number; xact_start: Date };
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('authenticated request never waited on the held universe lock');
}

async function feed(token: string) {
  const response = await app.inject({ url: '/v1/feed', headers: headers(token) });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function expose(token: string, receipt: { decisionId: string; items: Array<{ assetId: string }> }, clientExposureId = randomUUID()) {
  const body = { decisionId: receipt.decisionId, assetId: receipt.items[0]!.assetId, clientExposureId };
  const response = await app.inject({ method: 'POST', url: '/v1/exposures', headers: headers(token), payload: body });
  assert.equal(response.statusCode, 201, response.body);
  return { body, receipt: response.json() };
}

test('two independent sessions retain server-owned scope and isolate API resources', async () => {
  await app.ready();
  const ownerBefore = (await pool.query('SELECT revision, privacy_epoch FROM universe WHERE id=$1', [OWNER_ID])).rows[0];
  assert.ok(ownerBefore, 'migration must preserve the bootstrap owner universe');

  const first = await provisionIdentity();
  const second = await provisionIdentity({ universeId: first.scope.universeId });
  assert.notEqual(first.scope.sessionId, second.scope.sessionId);
  assert.notEqual(first.scope.deviceId, second.scope.deviceId);

  const firstSession = await getSession(first.token);
  const secondSession = await getSession(second.token);
  assert.equal(firstSession.statusCode, 200);
  assert.equal(secondSession.statusCode, 200);
  assert.equal(firstSession.json().universeId, first.scope.universeId);
  assert.equal(secondSession.json().universeId, first.scope.universeId);
  const universe = await app.inject({ url: '/v1/universe', headers: headers(first.token) });
  assert.equal(universe.statusCode, 200);
  assert.equal(universe.json().privacyEpoch, 0);

  const other = await provisionIdentity();
  const firstFeed = await feed(first.token);
  const firstExposure = await expose(first.token, firstFeed);
  const foreignDecision = await app.inject({
    method: 'POST', url: '/v1/exposures', headers: headers(other.token),
    payload: { ...firstExposure.body, clientExposureId: randomUUID() },
  });
  assert.equal(foreignDecision.statusCode, 422);

  const keepBody = {
    clientEventId: randomUUID(), exposureId: firstExposure.receipt.exposureId,
    assetId: firstExposure.body.assetId, kind: 'keep',
  };
  const keep = await app.inject({ method: 'POST', url: '/v1/interactions', headers: headers(first.token), payload: keepBody });
  assert.equal(keep.statusCode, 202, keep.body);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/interactions', headers: headers(other.token), payload: { ...keepBody, clientEventId: randomUUID() } })).statusCode, 422);
  assert.equal((await app.inject({ url: `/v1/events/${keep.json().eventId}`, headers: headers(other.token) })).statusCode, 404);

  assert.equal((await app.inject({ method: 'POST', url: '/v1/session/revoke', headers: headers(first.token), payload: {} })).statusCode, 204);
  assert.equal((await getSession(first.token)).statusCode, 401);
  assert.equal((await getSession(second.token)).statusCode, 200, 'revoking one device must not revoke its peer');
  assert.deepEqual((await pool.query('SELECT revision, privacy_epoch FROM universe WHERE id=$1', [OWNER_ID])).rows[0], ownerBefore);
});

test('session authentication and revoke errors are strict, generic, and token-free', async () => {
  const identity = await provisionIdentity();
  const invalidRequests = [
    await app.inject({ url: '/v1/session' }),
    await app.inject({ url: '/v1/session', headers: { authorization: 'Basic no' } }),
    await app.inject({ url: '/v1/session', headers: headers(randomBytes(32).toString('hex')) }),
    await app.inject({ method: 'POST', url: '/v1/exposures', payload: {} }),
  ];
  for (const response of invalidRequests) {
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'Unauthorized' });
    assert.equal(response.body.includes(identity.token), false);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/v1/session/revoke', headers: headers(identity.token) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/session/revoke', headers: headers(identity.token), payload: { sessionId: identity.scope.sessionId } })).statusCode, 400);
  assert.equal((await getSession(identity.token)).statusCode, 200, 'invalid revoke bodies must not revoke the caller');
});

test('privacy epoch invalidates old sessions and rejects stale references before replay', async () => {
  const oldIdentity = await provisionIdentity();
  const oldFeed = await feed(oldIdentity.token);
  assert.equal(oldFeed.privacyEpoch, 0);
  const oldExposure = await expose(oldIdentity.token, oldFeed);
  const keepBody = {
    clientEventId: randomUUID(), exposureId: oldExposure.receipt.exposureId,
    assetId: oldExposure.body.assetId, kind: 'keep',
  };
  const keep = await app.inject({ method: 'POST', url: '/v1/interactions', headers: headers(oldIdentity.token), payload: keepBody });
  assert.equal(keep.statusCode, 202, keep.body);

  await pool.query('UPDATE universe SET privacy_epoch=privacy_epoch+1 WHERE id=$1', [oldIdentity.scope.universeId]);
  const currentIdentity = await provisionIdentity({ universeId: oldIdentity.scope.universeId });
  assert.equal((await getSession(oldIdentity.token)).statusCode, 401);
  const currentFeed = await feed(currentIdentity.token);
  assert.equal(currentFeed.privacyEpoch, 1);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/exposures', headers: headers(currentIdentity.token), payload: oldExposure.body })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/interactions', headers: headers(currentIdentity.token), payload: keepBody })).statusCode, 409);

  const stamps = await pool.query(
    `SELECT d.privacy_epoch AS decision_epoch, e.privacy_epoch AS exposure_epoch,
      k.privacy_epoch AS keep_epoch, j.privacy_epoch AS job_epoch
     FROM decision d
     JOIN ledger e ON e.id=$2
     JOIN ledger k ON k.id=$3
     JOIN job j ON j.event_id=k.id
     WHERE d.id=$1`,
    [oldFeed.decisionId, oldExposure.receipt.eventId, keep.json().eventId],
  );
  assert.deepEqual(stamps.rows[0], { decision_epoch: 0, exposure_epoch: 0, keep_epoch: 0, job_epoch: 0 });
  await pool.query("UPDATE job SET status='discarded', discarded_at=clock_timestamp() WHERE id=$1", [keep.json().jobId]);
});

test('expiry is checked after a request finishes waiting for the universe lock', async () => {
  const identity = await provisionIdentity();
  await pool.query("UPDATE device_session SET created_at=clock_timestamp()-interval '1 second', expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1", [identity.scope.sessionId]);
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE', [identity.scope.universeId]);
    const blockerPid = Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const request = Promise.resolve(getSession(identity.token));
    const waiting = await waitForBlockedRequest(blockerPid);
    const expiresAt = (await pool.query('SELECT expires_at FROM device_session WHERE id=$1', [identity.scope.sessionId])).rows[0].expires_at as Date;
    assert.ok(waiting.xact_start < expiresAt, 'request transaction must begin before expiry');
    while (!(await pool.query('SELECT clock_timestamp()>=$1 AS expired', [expiresAt])).rows[0].expired) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await blocker.query('COMMIT');
    const response = await request;
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'Unauthorized' });
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
});

test('revocation committed while a request waits on the universe lock denies that request', async () => {
  const identity = await provisionIdentity();
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE', [identity.scope.universeId]);
    await blocker.query('UPDATE device_session SET revoked_at=clock_timestamp() WHERE id=$1', [identity.scope.sessionId]);
    const blockerPid = Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const request = Promise.resolve(getSession(identity.token));
    await waitForBlockedRequest(blockerPid);
    await blocker.query('COMMIT');
    const response = await request;
    assert.equal(response.statusCode, 401);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
});

test('development enrollment on restart does not reactivate a revoked session', async () => {
  const restartToken = randomBytes(32).toString('hex');
  const firstApp = buildApp(restartToken);
  await firstApp.ready();
  assert.equal((await firstApp.inject({ url: '/v1/session', headers: headers(restartToken) })).statusCode, 200);
  assert.equal((await firstApp.inject({ method: 'POST', url: '/v1/session/revoke', headers: headers(restartToken), payload: {} })).statusCode, 204);
  await firstApp.close();

  const restartedApp = buildApp(restartToken);
  await restartedApp.ready();
  const response = await restartedApp.inject({ url: '/v1/session', headers: headers(restartToken) });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: 'Unauthorized' });
  await restartedApp.close();
});
