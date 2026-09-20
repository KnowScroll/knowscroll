/**
 * ADR-0026 / issue #104 — database-level guards from migration 0016 (owned by that migration, not
 * this lane; verified here rather than trusted) plus `packages/db/src/sign-in.ts` itself: only the
 * configured owner address ever issues a token, the token lifecycle (issue/confirm/consume) is
 * correct and single-use, rate limiting holds under real concurrency, and a consumed token mints an
 * ordinary, correctly-scoped device session that authenticates through the existing path.
 *
 * Runs against the outer test.sh-managed disposable database via the shared `pool`, exactly like
 * every other tests/api-*.test.ts / tests/*.test.ts file — never a nested database of its own.
 * Never asserts the raw configured owner email or a raw token inside an assertion whose failure
 * message would print it; every comparison reduces to a boolean first.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { authenticateAndLock, OWNER_ID, pool, transaction, UnauthorizedSession } from '../packages/db/src/index.ts';
import {
  confirmSignInToken,
  consumeSignInToken,
  InvalidSignInToken,
  MAGIC_LINK_ACCOUNT_MAX_PER_WINDOW,
  MAGIC_LINK_FINGERPRINT_MAX_PER_WINDOW,
  normalizeEmail,
  requestMagicLink,
  requesterFingerprint,
  resolveOwnerEmail,
  SIGN_IN_TOKEN_TTL_MINUTES,
} from '../packages/db/src/sign-in.ts';

// This suite defines its own owner address rather than inheriting operator configuration: a test
// must not pass or fail because of what happens to be in a local .env or a CI job's environment.
process.env.KS_OWNER_EMAIL ??= 'owner@knowscroll.test';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) {
  throw new Error('Sign-in tests require an isolated knowscroll_test_* database');
}
after(async () => pool.end());

const OWNER_EMAIL = resolveOwnerEmail();
const LARGE_WINDOW_MINUTES = 1_000_000; // large enough that no test below can age out mid-run

async function currentAccountId(): Promise<string> {
  const row = (await pool.query('SELECT id FROM account WHERE email=$1', [OWNER_EMAIL])).rows[0] as { id: string } | undefined;
  if (row) return row.id;
  const issued = await transaction(client => requestMagicLink(client, { email: OWNER_EMAIL, requesterFingerprint: requesterFingerprint(`bootstrap-${randomUUID()}`) }));
  assert.ok(issued, 'bootstrap owner-account creation must succeed');
  return issued!.accountId;
}

async function accountTokenCount(accountId: string): Promise<number> {
  return (await pool.query('SELECT count(*)::int AS n FROM sign_in_token WHERE account_id=$1', [accountId])).rows[0].n as number;
}

function permissiveLimits(overrides: Partial<{ accountMaxPerWindow: number; fingerprintMaxPerWindow: number }> = {}) {
  return {
    accountWindowMinutes: LARGE_WINDOW_MINUTES,
    accountMaxPerWindow: overrides.accountMaxPerWindow ?? 1_000_000,
    fingerprintWindowMinutes: LARGE_WINDOW_MINUTES,
    fingerprintMaxPerWindow: overrides.fingerprintMaxPerWindow ?? 1_000_000,
  };
}

// -------------------------------------------------------------------------------------------
// Migration 0016's own guards (formalizing what the coordinator verified ad hoc for the ADR).
// -------------------------------------------------------------------------------------------

test('exactly one account can ever exist, enforced by the database, not by application logic', async () => {
  await currentAccountId(); // ensure the singleton already exists
  await assert.rejects(
    pool.query("INSERT INTO account(id,email) VALUES($1,'someone-else@example.test')", [randomUUID()]),
    /duplicate key|unique constraint/i,
  );
});

test('a non-normalised email is refused by the account CHECK constraint', async () => {
  // A second row would also collide with the single-user unique index; either failure mode proves
  // the non-normalised value is refused, but a real CHECK-constraint violation is checked first.
  await assert.rejects(
    pool.query("INSERT INTO account(id,email) VALUES($1,'Not-Normalised@Example.test')", [randomUUID()]),
    /violates check constraint|duplicate key/i,
  );
});

test('a sign-in token cannot outlive 15 minutes, is single-purpose, and can never be deleted', async () => {
  const accountId = await currentAccountId();
  await assert.rejects(
    pool.query(
      `INSERT INTO sign_in_token(id,account_id,token_hash,purpose,expires_at)
       VALUES($1,$2,$3,'sign_in',clock_timestamp() + interval '16 minutes')`,
      [randomUUID(), accountId, randomBytes(32).toString('hex')],
    ),
    /violates check constraint/,
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO sign_in_token(id,account_id,token_hash,purpose,expires_at)
       VALUES($1,$2,$3,'not_sign_in',clock_timestamp() + interval '5 minutes')`,
      [randomUUID(), accountId, randomBytes(32).toString('hex')],
    ),
    /violates check constraint/,
  );
  const tokenId = randomUUID();
  await pool.query(
    `INSERT INTO sign_in_token(id,account_id,token_hash,purpose,expires_at)
     VALUES($1,$2,$3,'sign_in',clock_timestamp() + interval '1 minute')`,
    [tokenId, accountId, randomBytes(32).toString('hex')],
  );
  await assert.rejects(pool.query('DELETE FROM sign_in_token WHERE id=$1', [tokenId]), /never deleted/);
  await assert.rejects(
    pool.query("UPDATE sign_in_token SET purpose='not_sign_in' WHERE id=$1", [tokenId]),
    /immutable|violates check constraint/,
  );
});

test('a universe adopted by an account can never be re-bound, directly at the database level', async () => {
  const accountId = await currentAccountId();
  const boundNow = (await pool.query(
    'UPDATE universe SET account_id=$1 WHERE id=$2 AND account_id IS NULL RETURNING id',
    [accountId, OWNER_ID],
  )).rowCount;
  if (boundNow) { /* first test file to adopt it in this run */ } else {
    const row = (await pool.query('SELECT account_id FROM universe WHERE id=$1', [OWNER_ID])).rows[0];
    assert.equal(row.account_id, accountId, 'owner universe must already be bound to the one existing account');
  }
  await assert.rejects(pool.query('UPDATE universe SET account_id=NULL WHERE id=$1', [OWNER_ID]), /stays with the account/);
  const otherUniverseId = randomUUID();
  await pool.query('INSERT INTO universe(id) VALUES($1)', [otherUniverseId]);
  await pool.query('INSERT INTO accounts(universe_id) VALUES($1)', [otherUniverseId]);
  await pool.query('UPDATE universe SET account_id=$1 WHERE id=$2', [accountId, otherUniverseId]);
  await assert.rejects(pool.query('UPDATE universe SET account_id=NULL WHERE id=$1', [otherUniverseId]), /stays with the account/);
});

test('a magic_link device session must name an account; a development session never needs to', async () => {
  const accountId = await currentAccountId();
  const universeId = randomUUID();
  await pool.query('INSERT INTO universe(id) VALUES($1)', [universeId]);
  await pool.query('INSERT INTO accounts(universe_id) VALUES($1)', [universeId]);
  await assert.rejects(
    pool.query(
      `INSERT INTO device_session(id,universe_id,device_id,token_hash,privacy_epoch,expires_at,origin)
       VALUES($1,$2,$3,$4,0,clock_timestamp()+interval '1 hour','magic_link')`,
      [randomUUID(), universeId, randomUUID(), randomBytes(32).toString('hex')],
    ),
    /violates check constraint/,
  );
  const ok = await pool.query(
    `INSERT INTO device_session(id,universe_id,device_id,token_hash,privacy_epoch,expires_at,origin,account_id)
     VALUES($1,$2,$3,$4,0,clock_timestamp()+interval '1 hour','magic_link',$5) RETURNING origin`,
    [randomUUID(), universeId, randomUUID(), randomBytes(32).toString('hex'), accountId],
  );
  assert.equal(ok.rows[0].origin, 'magic_link');
  const dev = await pool.query(
    `INSERT INTO device_session(id,universe_id,device_id,token_hash,privacy_epoch,expires_at)
     VALUES($1,$2,$3,$4,0,clock_timestamp()+interval '1 hour') RETURNING origin,account_id`,
    [randomUUID(), universeId, randomUUID(), randomBytes(32).toString('hex')],
  );
  assert.equal(dev.rows[0].origin, 'development');
  assert.equal(dev.rows[0].account_id, null);
});

// -------------------------------------------------------------------------------------------
// requestMagicLink: only the owner address, normalization, no enumeration, rate limiting.
// -------------------------------------------------------------------------------------------

test('only the configured owner address ever issues a token or creates the account', async () => {
  const before = (await pool.query('SELECT count(*)::int AS n FROM account')).rows[0].n as number;
  const result = await transaction(client => requestMagicLink(
    client,
    { email: 'definitely-not-the-owner@example.test', requesterFingerprint: requesterFingerprint(`probe-${randomUUID()}`) },
    permissiveLimits(),
  ));
  assert.equal(result, null);
  const after1 = (await pool.query('SELECT count(*)::int AS n FROM account')).rows[0].n as number;
  assert.equal(after1, before, 'a non-owner address must never create an account');
});

test('the owner address normalizes (trim/case) before comparison and issuance', async () => {
  const accountId = await currentAccountId();
  const issued = await transaction(client => requestMagicLink(
    client,
    { email: `  ${OWNER_EMAIL.toUpperCase()}\t`, requesterFingerprint: requesterFingerprint(`norm-${randomUUID()}`) },
    permissiveLimits(),
  ));
  assert.ok(issued);
  assert.equal(issued!.accountId, accountId);
});

test('normalizeEmail matches the database CHECK constraint\'s own normalization', () => {
  assert.equal(normalizeEmail('  Foo@Bar.Example  '), 'foo@bar.example');
});

test('per-account rate limit is enforced, including two genuinely concurrent requests racing the last slot', async () => {
  const accountId = await currentAccountId();
  const currentCount = await accountTokenCount(accountId);
  const limits = { accountWindowMinutes: LARGE_WINDOW_MINUTES, accountMaxPerWindow: currentCount + 1, fingerprintWindowMinutes: LARGE_WINDOW_MINUTES, fingerprintMaxPerWindow: 1_000_000 };

  const [a, b] = await Promise.all([
    transaction(client => requestMagicLink(client, { email: OWNER_EMAIL, requesterFingerprint: requesterFingerprint(`race-a-${randomUUID()}`) }, limits)),
    transaction(client => requestMagicLink(client, { email: OWNER_EMAIL, requesterFingerprint: requesterFingerprint(`race-b-${randomUUID()}`) }, limits)),
  ]);
  const successCount = [a, b].filter((value) => value !== null).length;
  assert.equal(successCount, 1, 'exactly one of two concurrent requests may win the last rate-limit slot');
  assert.equal(await accountTokenCount(accountId), currentCount + 1);

  const thirdBlocked = await transaction(client => requestMagicLink(
    client, { email: OWNER_EMAIL, requesterFingerprint: requesterFingerprint(`race-c-${randomUUID()}`) }, limits,
  ));
  assert.equal(thirdBlocked, null, 'the limit, once reached, refuses a subsequent request too');
  assert.equal(await accountTokenCount(accountId), currentCount + 1, 'a refused request must not create a token');
});

test('per-fingerprint rate limit is enforced independently of the account limit', async () => {
  const fingerprint = requesterFingerprint(`isolated-${randomUUID()}`);
  const limits = { accountWindowMinutes: LARGE_WINDOW_MINUTES, accountMaxPerWindow: 1_000_000, fingerprintWindowMinutes: LARGE_WINDOW_MINUTES, fingerprintMaxPerWindow: 2 };
  const first = await transaction(client => requestMagicLink(client, { email: OWNER_EMAIL, requesterFingerprint: fingerprint }, limits));
  const second = await transaction(client => requestMagicLink(client, { email: OWNER_EMAIL, requesterFingerprint: fingerprint }, limits));
  const third = await transaction(client => requestMagicLink(client, { email: OWNER_EMAIL, requesterFingerprint: fingerprint }, limits));
  assert.ok(first);
  assert.ok(second);
  assert.equal(third, null);
});

test('documented production rate-limit numbers are exactly what the route uses by default', () => {
  assert.equal(MAGIC_LINK_ACCOUNT_MAX_PER_WINDOW, 5);
  assert.equal(MAGIC_LINK_FINGERPRINT_MAX_PER_WINDOW, 10);
  assert.equal(SIGN_IN_TOKEN_TTL_MINUTES, 15);
});

// -------------------------------------------------------------------------------------------
// confirmSignInToken (GET path): never consumes, safe to call repeatedly.
// -------------------------------------------------------------------------------------------

test('confirm reports validity without ever consuming, and is idempotent under repetition', async () => {
  const issued = await transaction(client => requestMagicLink(
    client, { email: OWNER_EMAIL, requesterFingerprint: requesterFingerprint(`confirm-${randomUUID()}`) }, permissiveLimits(),
  ));
  assert.ok(issued);
  for (let i = 0; i < 5; i += 1) {
    assert.equal(await confirmSignInToken(pool, issued!.token), true);
  }
  assert.equal(await confirmSignInToken(pool, 'this-token-does-not-exist'), false);
  assert.equal(await confirmSignInToken(pool, ''), false);
  // Still fully usable afterward — confirm truly never consumed it.
  const session = await transaction(client => consumeSignInToken(client, issued!.token));
  assert.ok(session.token.length > 0);
});

// -------------------------------------------------------------------------------------------
// consumeSignInToken (POST path): exactly-once, unified refusal, session shape, universe adoption.
// -------------------------------------------------------------------------------------------

test('two parallel consumptions of one valid token mint exactly one session', async () => {
  // The sequential replay test below proves a consumed token is dead; this proves the row lock
  // actually serialises a genuine race, so a leaked link opened twice at once cannot mint two
  // sessions. Both calls run in their own transaction, started together.
  const issued = await transaction(client => requestMagicLink(
    client, { email: OWNER_EMAIL, requesterFingerprint: requesterFingerprint(`race-${randomUUID()}`) }, permissiveLimits(),
  ));
  assert.ok(issued);

  const outcomes = await Promise.allSettled([
    transaction(client => consumeSignInToken(client, issued!.token)),
    transaction(client => consumeSignInToken(client, issued!.token)),
  ]);
  const won = outcomes.filter(o => o.status === 'fulfilled');
  const lost = outcomes.filter(o => o.status === 'rejected');
  assert.equal(won.length, 1, 'exactly one consumption succeeds');
  assert.equal(lost.length, 1, 'the other is refused');
  assert.ok((lost[0] as PromiseRejectedResult).reason instanceof InvalidSignInToken,
    'the loser refuses with the same indistinguishable shape as any other bad token');
});

test('a token is consumed exactly once; replay, expiry, tampering and unknown tokens all refuse identically', async () => {
  const issued = await transaction(client => requestMagicLink(
    client, { email: OWNER_EMAIL, requesterFingerprint: requesterFingerprint(`consume-${randomUUID()}`) }, permissiveLimits(),
  ));
  assert.ok(issued);

  const session = await transaction(client => consumeSignInToken(client, issued!.token));
  assert.equal(session.accountId, issued!.accountId);
  assert.match(session.token, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(session.token, issued!.token, 'the minted session bearer must differ from the consumed sign-in token');

  await assert.rejects(transaction(client => consumeSignInToken(client, issued!.token)), InvalidSignInToken, 'replay of a consumed token');

  const tampered = issued!.token.slice(0, -1) + (issued!.token.endsWith('A') ? 'B' : 'A');
  await assert.rejects(transaction(client => consumeSignInToken(client, tampered)), InvalidSignInToken, 'tampered token');
  await assert.rejects(transaction(client => consumeSignInToken(client, 'unknown-token-value')), InvalidSignInToken, 'unknown token');
  await assert.rejects(transaction(client => consumeSignInToken(client, '')), InvalidSignInToken, 'empty token');

  // Expired: `sign_in_token`'s own guard makes `expires_at` immutable (an UPDATE cannot age a real
  // token out after the fact), so this inserts an already-expired row directly instead — a valid
  // shape (expires_at > created_at, within 15 minutes of it), just entirely in the past.
  const accountId = await currentAccountId();
  const expiredRawToken = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sign_in_token(id,account_id,token_hash,purpose,expires_at,created_at)
     VALUES($1,$2,$3,'sign_in',clock_timestamp() - interval '5 minutes',clock_timestamp() - interval '10 minutes')`,
    [randomUUID(), accountId, createHash('sha256').update(expiredRawToken, 'utf8').digest('hex')],
  );
  await assert.rejects(transaction(client => consumeSignInToken(client, expiredRawToken)), InvalidSignInToken, 'expired token');
});

test('a consumed session authenticates the normal way, carries origin/account, and honors expiry+revoke', async () => {
  const issued = await transaction(client => requestMagicLink(
    client, { email: OWNER_EMAIL, requesterFingerprint: requesterFingerprint(`authn-${randomUUID()}`) }, permissiveLimits(),
  ));
  assert.ok(issued);
  const session = await transaction(client => consumeSignInToken(client, issued!.token));

  const scope = await transaction(client => authenticateAndLock(client, session.token));
  assert.equal(scope.sessionId, session.sessionId);
  assert.equal(scope.universeId, session.universeId);

  const row = (await pool.query('SELECT origin, account_id FROM device_session WHERE id=$1', [session.sessionId])).rows[0];
  assert.equal(row.origin, 'magic_link');
  assert.equal(row.account_id, session.accountId);

  await pool.query('UPDATE device_session SET revoked_at=clock_timestamp() WHERE id=$1', [session.sessionId]);
  await assert.rejects(transaction(client => authenticateAndLock(client, session.token)), UnauthorizedSession);
});

test('the universe is adopted on first consumption and never re-bound by a second sign-in', async () => {
  const accountId = await currentAccountId();
  const universeBefore = (await pool.query('SELECT account_id FROM universe WHERE id=$1', [OWNER_ID])).rows[0].account_id;
  assert.equal(universeBefore, accountId, 'earlier tests in this run must already have adopted the owner universe');

  const issued = await transaction(client => requestMagicLink(
    client, { email: OWNER_EMAIL, requesterFingerprint: requesterFingerprint(`adopt-${randomUUID()}`) }, permissiveLimits(),
  ));
  assert.ok(issued);
  const session = await transaction(client => consumeSignInToken(client, issued!.token));
  assert.equal(session.universeId, OWNER_ID);
  const universeAfter = (await pool.query('SELECT account_id FROM universe WHERE id=$1', [OWNER_ID])).rows[0].account_id;
  assert.equal(universeAfter, accountId, 'still the same account; never re-bound');
});
