/**
 * ADR-0026 / issue #104 — the three sign-in HTTP routes over the real Fastify app (`buildApp`),
 * exactly like every other tests/api-*.test.ts file, plus the `MagicLinkSender` factory's
 * production refusal. Proves: identical `202` regardless of address; the strict body/malformed
 * cases; `GET /v1/auth/confirm` never consumes and is repeatable; `POST /v1/auth/session` consumes
 * exactly once with one indistinguishable refusal shape for every failure mode; the minted session
 * authenticates ordinary routes (including Clear History and Trace revisit) exactly like a
 * development-token session; and that no response body or dev-sink file ever contains the raw
 * owner address (the raw token legitimately appears in the dev sink and in the caller's own
 * responses — that is the mechanism — but never in a log this suite writes).
 *
 * Uses a dedicated scratch `KS_DEV_ROOT` (never the real one) so the development sink never
 * touches actual local developer state, and removes it afterward.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildApp } from '../apps/api/src/app.ts';
import { createMagicLinkSender } from '../apps/api/src/magic-link-sender.ts';
import { pool } from '../packages/db/src/index.ts';
import { resolveOwnerEmail } from '../packages/db/src/sign-in.ts';
import { projectOne } from '../apps/worker/src/project.ts';

// This suite defines its own owner address rather than inheriting operator configuration: a test
// must not pass or fail because of what happens to be in a local .env or a CI job's environment.
process.env.KS_OWNER_EMAIL ??= 'owner@knowscroll.test';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) {
  throw new Error('Sign-in HTTP tests require an isolated knowscroll_test_* database');
}

const OWNER_EMAIL = resolveOwnerEmail();
const scratchDevRoot = await mkdtemp(join(tmpdir(), 'ks-signin-http-'));
const realDevRoot = process.env.KS_DEV_ROOT;
process.env.KS_DEV_ROOT = scratchDevRoot; // isolates the development sink from the real machine

const developmentToken = randomBytes(32).toString('hex');
// Production defaults are deliberately tight (5 per account, 10 per fingerprint per 15 minutes).
// This file requests many links inside one window, so it injects a permissive limit rather than
// loosening what the real route uses.
const app = buildApp(developmentToken, {
  magicLinkLimits: { accountWindowMinutes: 15, accountMaxPerWindow: 500, fingerprintWindowMinutes: 15, fingerprintMaxPerWindow: 500 },
});
await app.ready();

after(async () => {
  await app.close();
  await pool.end();
  process.env.KS_DEV_ROOT = realDevRoot;
  await rm(scratchDevRoot, { recursive: true, force: true });
});

function headers(token: string) {
  return { authorization: `Bearer ${token}` };
}

const SINK_PATH = join(scratchDevRoot, 'sign-in', 'magic-link.txt');

async function readSinkLinkOrNull(): Promise<string | null> {
  try {
    return (await readFile(SINK_PATH, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function tokenFromLink(link: string): string {
  const url = new URL(link);
  const token = url.searchParams.get('token');
  assert.ok(token, 'confirmation link must carry a token query parameter');
  return token!;
}

async function requestLink(email: string) {
  return app.inject({ method: 'POST', url: '/v1/auth/magic-link', payload: { email } });
}

// -------------------------------------------------------------------------------------------
// POST /v1/auth/magic-link: no enumeration, strict body, sink only written for the owner address.
// -------------------------------------------------------------------------------------------

test('unknown and owner addresses receive byte-identical 202 responses', async () => {
  const unknown = await requestLink('someone-who-does-not-exist@example.test');
  const owner = await requestLink(OWNER_EMAIL);
  assert.equal(unknown.statusCode, 202);
  assert.equal(owner.statusCode, 202);
  assert.equal(unknown.body, owner.body);
  assert.deepEqual(unknown.json(), { status: 'requested' });
});

test('a malformed body is rejected before any address is considered', async () => {
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/magic-link', payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/magic-link', payload: { email: 'x@example.test', extra: 1 } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/magic-link', payload: { email: 5 } })).statusCode, 400);
});

test('the development sink is written only for the owner address, and never contains the address', async () => {
  await requestLink('nobody-in-particular@example.test');
  const beforeOwnerRequest = await readSinkLinkOrNull();

  await requestLink('still-not-the-owner@example.test');
  assert.equal(await readSinkLinkOrNull(), beforeOwnerRequest, 'a non-owner request must never change the sink');

  const response = await requestLink(OWNER_EMAIL);
  assert.equal(response.statusCode, 202);
  const link = await readSinkLinkOrNull();
  assert.ok(link);
  assert.equal(link!.includes('@'), false, 'the sink content must never contain an email address');
  assert.equal(response.body.includes(OWNER_EMAIL), false);
});

// -------------------------------------------------------------------------------------------
// GET /v1/auth/confirm: never consumes, repeatable, generic for anything invalid.
// -------------------------------------------------------------------------------------------

test('confirm reports validity, never consumes, and is safe to call repeatedly', async () => {
  await requestLink(OWNER_EMAIL);
  const link = await readSinkLinkOrNull();
  const token = tokenFromLink(link!);

  for (let i = 0; i < 3; i += 1) {
    const confirm = await app.inject({ url: `/v1/auth/confirm?token=${encodeURIComponent(token)}` });
    assert.equal(confirm.statusCode, 200);
    assert.deepEqual(confirm.json(), { valid: true });
  }
  assert.equal((await app.inject({ url: '/v1/auth/confirm?token=not-a-real-token' })).statusCode, 200);
  assert.deepEqual((await app.inject({ url: '/v1/auth/confirm?token=not-a-real-token' })).json(), { valid: false });
  assert.equal((await app.inject({ url: '/v1/auth/confirm' })).statusCode, 400);

  // Still fully usable — confirm truly never consumed it.
  const session = await app.inject({ method: 'POST', url: '/v1/auth/session', payload: { token } });
  assert.equal(session.statusCode, 200);
});

// -------------------------------------------------------------------------------------------
// POST /v1/auth/session: consumes exactly once; one indistinguishable refusal for every failure.
// -------------------------------------------------------------------------------------------

test('session consumption is exactly-once; replay, malformed body and an expired token all refuse identically', async () => {
  await requestLink(OWNER_EMAIL);
  const link = await readSinkLinkOrNull();
  const token = tokenFromLink(link!);

  const first = await app.inject({ method: 'POST', url: '/v1/auth/session', payload: { token } });
  assert.equal(first.statusCode, 200);
  const receipt = first.json();
  assert.equal(receipt.origin, 'magic_link');
  assert.ok(receipt.sessionToken);
  assert.notEqual(receipt.sessionToken, token);

  const replay = await app.inject({ method: 'POST', url: '/v1/auth/session', payload: { token } });
  assert.equal(replay.statusCode, 401);
  assert.deepEqual(replay.json(), { error: 'Unauthorized' });

  const shapes = [
    { payload: {} },
    { payload: { token: 12345 } },
    { payload: { token: '' } },
    { payload: { token: 'not-a-real-token' } },
    { payload: undefined },
  ];
  for (const shape of shapes) {
    const response = await app.inject({ method: 'POST', url: '/v1/auth/session', ...shape });
    assert.equal(response.statusCode, 401, JSON.stringify(shape));
    assert.deepEqual(response.json(), { error: 'Unauthorized' });
  }

  // Expired: `sign_in_token`'s own guard makes `expires_at` immutable (an UPDATE cannot age a real
  // token out after the fact), so this inserts an already-expired row directly instead — a valid
  // shape, just entirely in the past. The raw value never went through the HTTP route or the sink;
  // it is fabricated here purely to exercise the refusal path.
  const { id: accountId } = (await pool.query('SELECT id FROM account WHERE email=$1', [OWNER_EMAIL])).rows[0];
  const expiredRawToken = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sign_in_token(id,account_id,token_hash,purpose,expires_at,created_at)
     VALUES($1,$2,$3,'sign_in',clock_timestamp() - interval '5 minutes',clock_timestamp() - interval '10 minutes')`,
    [randomUUID(), accountId, createHash('sha256').update(expiredRawToken, 'utf8').digest('hex')],
  );
  const expired = await app.inject({ method: 'POST', url: '/v1/auth/session', payload: { token: expiredRawToken } });
  assert.equal(expired.statusCode, 401);
  assert.deepEqual(expired.json(), { error: 'Unauthorized' });
});

// -------------------------------------------------------------------------------------------
// The minted session is an ordinary session: feed/expose/keep/project/events/trace/Clear History/
// revoke all work exactly as they do for a development-token session.
// -------------------------------------------------------------------------------------------

test('a magic-link session authenticates a full encounter, Clear History, Trace revisit and sign-out', async () => {
  await requestLink(OWNER_EMAIL);
  const token = tokenFromLink((await readSinkLinkOrNull())!);
  const sessionResponse = await app.inject({ method: 'POST', url: '/v1/auth/session', payload: { token } });
  assert.equal(sessionResponse.statusCode, 200);
  const { sessionToken } = sessionResponse.json();

  const sessionInfo = await app.inject({ url: '/v1/session', headers: headers(sessionToken) });
  assert.equal(sessionInfo.statusCode, 200);

  const universe = await app.inject({ url: '/v1/universe', headers: headers(sessionToken) });
  assert.equal(universe.statusCode, 200);
  const startingEpoch = universe.json().privacyEpoch as number;

  const feedResponse = await app.inject({ url: '/v1/feed', headers: headers(sessionToken) });
  assert.equal(feedResponse.statusCode, 200);
  const feed = feedResponse.json();
  const item = feed.items[0];

  const exposureResponse = await app.inject({
    method: 'POST', url: '/v1/exposures', headers: headers(sessionToken),
    payload: { decisionId: feed.decisionId, assetId: item.assetId, clientExposureId: randomUUID() },
  });
  assert.equal(exposureResponse.statusCode, 201);
  const exposure = exposureResponse.json();

  const keepResponse = await app.inject({
    method: 'POST', url: '/v1/interactions', headers: headers(sessionToken),
    payload: { clientEventId: randomUUID(), exposureId: exposure.exposureId, assetId: item.assetId, kind: 'keep' },
  });
  assert.equal(keepResponse.statusCode, 202);
  const keep = keepResponse.json();

  await pool.query("UPDATE job SET available_at='1990-01-01T00:00:00Z' WHERE id=$1", [keep.jobId]);
  assert.deepEqual(await projectOne(), { jobId: keep.jobId, status: 'completed' });

  const eventLookup = await app.inject({ url: `/v1/events/${keep.eventId}`, headers: headers(sessionToken) });
  assert.equal(eventLookup.statusCode, 200);
  assert.equal(eventLookup.json().projected, true);

  const revisit = await app.inject({ url: `/v1/traces/${keep.eventId}`, headers: headers(sessionToken) });
  assert.equal(revisit.statusCode, 200, revisit.body);

  const clearResponse = await app.inject({
    method: 'POST', url: '/v1/history/clear', headers: headers(sessionToken),
    payload: { requestId: randomUUID(), expectedPrivacyEpoch: startingEpoch, confirmation: 'clear-scroll-history' },
  });
  assert.equal(clearResponse.statusCode, 200, clearResponse.body);
  assert.equal(clearResponse.json().privacyEpoch, startingEpoch + 1);

  const revisitAfterClear = await app.inject({ url: `/v1/traces/${keep.eventId}`, headers: headers(sessionToken) });
  assert.equal(revisitAfterClear.statusCode, 404, 'an erased reference uses the existing missing-reference behavior');

  const revoke = await app.inject({ method: 'POST', url: '/v1/session/revoke', headers: headers(sessionToken), payload: {} });
  assert.equal(revoke.statusCode, 204);
  assert.equal((await app.inject({ url: '/v1/session', headers: headers(sessionToken) })).statusCode, 401);
});

// -------------------------------------------------------------------------------------------
// MagicLinkSender factory: production refusal, missing configuration.
// -------------------------------------------------------------------------------------------

test('createMagicLinkSender refuses in production mode and without KS_DEV_ROOT', () => {
  assert.throws(() => createMagicLinkSender({ NODE_ENV: 'production', KS_DEV_ROOT: scratchDevRoot }), /No MagicLinkSender is configured for production/);
  assert.throws(() => createMagicLinkSender({}), /KS_DEV_ROOT/);
  const sender = createMagicLinkSender({ KS_DEV_ROOT: scratchDevRoot });
  assert.ok(sender);
});
