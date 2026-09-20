/**
 * ADR-0026 — real sign-in: one owner account, email magic link. Built on migration 0016
 * (`account`, `sign_in_token`, `device_session.origin`/`account_id`), which this lane does not
 * modify. Nothing here erases or reveals history; it only issues/consumes a one-time secret and,
 * on success, mints an ordinary `device_session` through the same shape ADR-0009 already defines.
 *
 * Every function here is deliberately silent about *why* a request failed: `requestMagicLink`
 * returns `null` for a non-owner address, a misconfigured owner address it still validated the
 * same way, or a rate-limited owner address — the HTTP layer answers `202` in every one of those
 * cases, so nothing here may ever surface a distinguishing error for the caller to read. Token
 * consumption failures all become the single `InvalidSignInToken` shape.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { OWNER_ID, lockUniverse } from './index.ts';
import { DEFAULT_EXPIRY_HOURS, UnauthorizedSession } from './identity.ts';

type Queryable = Pick<pg.PoolClient, 'query'>;

// ---------------------------------------------------------------------------------------------
// Configuration: KS_OWNER_EMAIL. Never a secret (it is an address, not a credential), but treated
// with the same care as any other local configuration: read once per call, never logged.
// ---------------------------------------------------------------------------------------------

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Matches the `account.email` CHECK constraint in migration 0016 exactly, so a value this
 * function accepts can always be inserted, and a value it rejects never reaches the database. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function isPlausibleEmail(email: string): boolean {
  return email.length >= 6 && email.length <= 320 && EMAIL_PATTERN.test(email);
}

/** Throws a plain configuration error (never provider-specific, never per-address) when
 * `KS_OWNER_EMAIL` is unset or unusable — every request then fails the same way regardless of the
 * address it named, so a misconfigured deployment still discloses nothing about who the owner is. */
export function resolveOwnerEmail(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.KS_OWNER_EMAIL;
  if (!raw) throw new Error('invalid_config: KS_OWNER_EMAIL must be set before sign-in can be used');
  const email = normalizeEmail(raw);
  if (!isPlausibleEmail(email)) throw new Error('invalid_config: KS_OWNER_EMAIL is not a valid address');
  return email;
}

// ---------------------------------------------------------------------------------------------
// Coarse, salted requester fingerprint (never the raw address, never the raw IP at rest).
// ---------------------------------------------------------------------------------------------

/** Generated once per process start; deliberately not persisted or configurable. A restart resets
 * fingerprint history, which only ever *loosens* rate limiting — it can never let a stale
 * fingerprint impersonate a different requester's count. */
const FINGERPRINT_PROCESS_SALT = randomBytes(16).toString('hex');

/** A "coarse" requester identity for rate limiting only (ADR-0026 section 2): never an address,
 * never reversible to the raw input without the in-memory salt. Callers pass something like the
 * request's remote address; this never sees or stores it directly. */
export function requesterFingerprint(rawIdentifier: string): string {
  return createHash('sha256').update(`${FINGERPRINT_PROCESS_SALT}:${rawIdentifier}`).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// Token issuance.
// ---------------------------------------------------------------------------------------------

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A sign-in token lives at most 15 minutes (migration 0016's own CHECK constraint enforces the
 * outer bound independently; this is the value this lane actually issues). */
export const SIGN_IN_TOKEN_TTL_MINUTES = 15;

/** Rate limits (ADR-0026 section 2: "choose and document the numbers"). Fifteen minutes matches
 * the token's own lifetime, so the window reads as "how many sign-in emails per token lifetime".
 * `sign_in_token` rows are never deleted or backdated (`sign_in_token_guard`), so this is a running
 * total for the window's real duration, not something a retention job can trim; the numbers below
 * are picked generously enough to survive a single owner's legitimate retries (mistyped address,
 * lost link, an automated verification pass that itself signs in several times) while still
 * meaningfully bounding an attacker who has the address but not the mailbox: twenty valid links in
 * fifteen minutes is nothing without the ability to read them. Both limits are enforced inside the
 * same transaction that would insert the token, serialized with `pg_advisory_xact_lock` so
 * concurrent requests cannot both squeeze through the last remaining slot. */
export const MAGIC_LINK_ACCOUNT_WINDOW_MINUTES = 15;
export const MAGIC_LINK_ACCOUNT_MAX_PER_WINDOW = 5;
export const MAGIC_LINK_FINGERPRINT_WINDOW_MINUTES = 15;
export const MAGIC_LINK_FINGERPRINT_MAX_PER_WINDOW = 10;

export interface MagicLinkRateLimits {
  accountWindowMinutes: number;
  accountMaxPerWindow: number;
  fingerprintWindowMinutes: number;
  fingerprintMaxPerWindow: number;
}

const DEFAULT_RATE_LIMITS: MagicLinkRateLimits = {
  accountWindowMinutes: MAGIC_LINK_ACCOUNT_WINDOW_MINUTES,
  accountMaxPerWindow: MAGIC_LINK_ACCOUNT_MAX_PER_WINDOW,
  fingerprintWindowMinutes: MAGIC_LINK_FINGERPRINT_WINDOW_MINUTES,
  fingerprintMaxPerWindow: MAGIC_LINK_FINGERPRINT_MAX_PER_WINDOW,
};

export interface MagicLinkRequest {
  /** Raw, caller-supplied address text; normalized (trimmed, lowercased) internally. Never a
   * signal of anything by itself — every syntactically acceptable string reaches this function. */
  email: string;
  /** Always a 64-character lowercase hex string from `requesterFingerprint()`, matching
   * `sign_in_token.requester_fingerprint`'s CHECK constraint. */
  requesterFingerprint: string;
}

/**
 * Issues a sign-in token for the configured owner address only. Returns `null` — never throws —
 * for a non-owner address or a rate-limited owner address; the HTTP layer answers `202` either
 * way, so this function's return value must never leak through an error path.
 *
 * Both counts are over a real sliding window (`created_at > now - window`), so a quiet period
 * always restores the ability to sign in; tokens are never deleted, but old ones stop counting.
 * Overriding `limits` is for tests only, because several test files share one disposable database
 * within a single window and would otherwise throttle each other.
 */
export async function requestMagicLink(
  client: pg.PoolClient,
  input: MagicLinkRequest,
  limits: MagicLinkRateLimits = DEFAULT_RATE_LIMITS,
): Promise<{ token: string; accountId: string } | null> {
  const email = normalizeEmail(input.email);
  const ownerEmail = resolveOwnerEmail();

  const owner = email === ownerEmail;

  // Both paths take the same lock, run the same counts and spend the same randomness, so a caller
  // cannot tell the owner's address from any other by how long the answer takes or by what the
  // database did. The one residual asymmetry is the single INSERT that only a real, unthrottled
  // owner request performs; it is documented in ADR-0026 rather than hidden.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ks-magic-link-account:${ownerEmail}`]);

  let account = (await client.query<{ id: string }>('SELECT id FROM account WHERE email=$1', [email])).rows[0];
  if (!account && owner) {
    account = (await client.query<{ id: string }>(
      'INSERT INTO account(id,email) VALUES($1,$2) RETURNING id',
      [randomUUID(), email],
    )).rows[0]!;
  }
  // A non-owner address counts against a uuid that matches nothing, so the same two queries run
  // with the same plans and return zero.
  const countedAccountId = account?.id ?? '00000000-0000-4000-8000-000000000000';

  const accountCount = (await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM sign_in_token
      WHERE account_id=$1 AND created_at > clock_timestamp() - ($2::int * interval '1 minute')`,
    [countedAccountId, limits.accountWindowMinutes],
  )).rows[0]!.n;
  const fingerprintCount = (await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM sign_in_token
      WHERE requester_fingerprint=$1 AND created_at > clock_timestamp() - ($2::int * interval '1 minute')`,
    [input.requesterFingerprint, limits.fingerprintWindowMinutes],
  )).rows[0]!.n;
  const throttled = accountCount >= limits.accountMaxPerWindow || fingerprintCount >= limits.fingerprintMaxPerWindow;

  // Generated either way, so the cost of making and hashing a secret is not a signal.
  const rawToken = randomBytes(32).toString('base64url');
  const hashed = tokenHash(rawToken);
  if (!owner || !account || throttled) return null;

  await client.query(
    `INSERT INTO sign_in_token(id,account_id,token_hash,purpose,requester_fingerprint,expires_at)
     VALUES($1,$2,$3,'sign_in',$4,now() + ($5::int * interval '1 minute'))`,
    [randomUUID(), account.id, hashed, input.requesterFingerprint, SIGN_IN_TOKEN_TTL_MINUTES],
  );
  return { token: rawToken, accountId: account.id };
}

// ---------------------------------------------------------------------------------------------
// GET confirm: read-only, safe to call repeatedly, never consumes.
// ---------------------------------------------------------------------------------------------

/** `GET /v1/auth/confirm`'s entire job: report whether a confirmation surface should be shown.
 * Takes no lock and changes nothing, so an email scanner's prefetch is harmless and idempotent. */
export async function confirmSignInToken(client: Queryable, rawToken: string): Promise<boolean> {
  const row = (await client.query(
    `SELECT 1 FROM sign_in_token
      WHERE token_hash=$1 AND purpose='sign_in' AND consumed_at IS NULL AND expires_at > clock_timestamp()`,
    [tokenHash(rawToken)],
  )).rows[0];
  return row !== undefined;
}

// ---------------------------------------------------------------------------------------------
// POST session: consumes exactly once under a row lock.
// ---------------------------------------------------------------------------------------------

/** The one indistinguishable refusal shape for expired, consumed, unknown, malformed and
 * wrong-purpose tokens (ADR-0026 section 3). Extends `UnauthorizedSession` so the existing global
 * error handler in `apps/api/src/app.ts` turns it into the same generic `401 {"error":"Unauthorized"}`
 * every other authentication failure already produces — no new error shape to keep indistinguishable. */
export class InvalidSignInToken extends UnauthorizedSession {}

export interface SignInSession {
  /** The new device-session bearer token (distinct from the now-consumed sign-in token). */
  token: string;
  sessionId: string;
  deviceId: string;
  universeId: string;
  privacyEpoch: number;
  expiresAt: string;
  accountId: string;
}

/**
 * Consumes a sign-in token exactly once and mints a normal `device_session` (ADR-0009 shape,
 * `origin='magic_link'`, its account) for the universe that account has adopted — adopting the
 * existing bootstrap universe on the very first successful consumption, and never re-binding it
 * afterward (the `universe_account_binding_guard` trigger refuses that at the database level
 * regardless of what this function does).
 *
 * Lock order matches `authenticateAndLock`: an unlocked read finds the candidate universe, the
 * universe is locked, then the token row is re-read and locked (`FOR UPDATE`) before any decision
 * is made — universe before session/domain rows, per this repository's stated lock order.
 */
export async function consumeSignInToken(client: pg.PoolClient, rawToken: string): Promise<SignInSession> {
  const hash = tokenHash(rawToken);
  const candidate = (await client.query<{ account_id: string }>(
    'SELECT account_id FROM sign_in_token WHERE token_hash=$1',
    [hash],
  )).rows[0];
  if (!candidate) throw new InvalidSignInToken();

  const alreadyAdopted = (await client.query<{ id: string }>(
    'SELECT id FROM universe WHERE account_id=$1 LIMIT 1',
    [candidate.account_id],
  )).rows[0];
  const universeId = alreadyAdopted?.id ?? OWNER_ID;
  await lockUniverse(client, universeId);

  const row = (await client.query<{ id: string; consumed_at: Date | null; live: boolean }>(
    `SELECT id, consumed_at, (expires_at > clock_timestamp()) AS live
       FROM sign_in_token WHERE token_hash=$1 AND purpose='sign_in' FOR UPDATE`,
    [hash],
  )).rows[0];
  if (!row || row.consumed_at !== null || !row.live) throw new InvalidSignInToken();

  let privacyEpoch: number;
  if (alreadyAdopted) {
    privacyEpoch = (await client.query<{ privacy_epoch: number }>(
      'SELECT privacy_epoch FROM universe WHERE id=$1',
      [universeId],
    )).rows[0]!.privacy_epoch;
  } else {
    const adopted = (await client.query<{ privacy_epoch: number }>(
      'UPDATE universe SET account_id=$1 WHERE id=$2 AND account_id IS NULL RETURNING privacy_epoch',
      [candidate.account_id, universeId],
    )).rows[0];
    // Cannot happen under the single-account invariant (only one account can ever exist, so a
    // universe found unbound above cannot have been bound by someone else by now), but this
    // function never proceeds on an assumption it has not just re-checked under the lock it holds.
    // Refuse exactly like every other sign-in failure: a caller learns nothing from losing a race.
    if (!adopted) throw new InvalidSignInToken();
    privacyEpoch = adopted.privacy_epoch;
  }

  const sessionId = randomUUID();
  const deviceId = randomUUID();
  const newSessionToken = randomBytes(32).toString('base64url');
  const session = (await client.query<{ id: string; device_id: string; universe_id: string; privacy_epoch: number; expires_at: Date }>(
    `INSERT INTO device_session(id,universe_id,device_id,token_hash,privacy_epoch,expires_at,origin,account_id)
     VALUES($1,$2,$3,$4,$5,clock_timestamp() + ($6::int * interval '1 hour'),'magic_link',$7)
     RETURNING id, device_id, universe_id, privacy_epoch, expires_at`,
    [sessionId, universeId, deviceId, tokenHash(newSessionToken), privacyEpoch, DEFAULT_EXPIRY_HOURS, candidate.account_id],
  )).rows[0]!;

  await client.query(
    'UPDATE sign_in_token SET consumed_at=clock_timestamp(), consumed_session_id=$1 WHERE id=$2',
    [sessionId, row.id],
  );

  const expiresAt = session.expires_at instanceof Date ? session.expires_at.toISOString() : new Date(String(session.expires_at)).toISOString();
  return {
    token: newSessionToken,
    sessionId: session.id,
    deviceId: session.device_id,
    universeId: session.universe_id,
    privacyEpoch: Number(session.privacy_epoch),
    expiresAt,
    accountId: candidate.account_id,
  };
}
