import { oc } from '@orpc/contract';
import { z } from 'zod';
import { CommandIdSchema, UniverseIdSchema, UuidSchema } from './ids.js';

/**
 * Sign-in and sessions (D-007, D-022): email magic links, a session cookie on the web and a bearer
 * token on native. Every route lives under `/auth` on the world's own origin (D-008).
 *
 * Token shapes: a sign-in link token is `ksl_` + 43 base64url characters, a session token `kss_` +
 * 43. Both are secrets: they appear only in the link, the cookie, the native secure store and the
 * one response that hands a native client its token.
 */
export const SIGN_IN_TOKEN_PATTERN = /^ksl_[A-Za-z0-9_-]{43}$/;
export const SESSION_TOKEN_PATTERN = /^kss_[A-Za-z0-9_-]{43}$/;

/** The session cookie on an HTTPS origin (`__Host-`: Secure, Path=/, no Domain). */
export const SESSION_COOKIE_NAME = '__Host-ks_session';
/** The session cookie on a plain-HTTP development origin, where `__Host-` cannot be set. */
export const DEVELOPMENT_SESSION_COOKIE_NAME = 'ks_session';

export const SessionClientSchema = z.enum(['web', 'native']);
export type SessionClient = z.infer<typeof SessionClientSchema>;

/**
 * `POST /auth/sign-in`: mail a sign-in link. The answer is `202 {status: "requested"}` for every
 * well-formed address, whether or not an account exists or the mail could be delivered (no address
 * oracle). `TOO_MANY_REQUESTS` (429, with `Retry-After`) when the address or this client asked too
 * often. The address is normalised server-side (trimmed, lower-cased).
 */
export const RequestSignInSchema = z.object({ email: z.string().min(3).max(320) });

export const RequestSignInResponseSchema = z.object({ status: z.literal('requested') });

export const requestSignInContract = oc
  .route({ method: 'POST', path: '/auth/sign-in', successStatus: 202, tags: ['identity'] })
  .input(RequestSignInSchema)
  .output(RequestSignInResponseSchema);

/** The authority a session carries now: account, its universe and the current privacy epoch. */
export const SessionAccountSchema = z.object({
  accountId: UuidSchema,
  universeId: UniverseIdSchema,
  privacyEpoch: z.number().int().min(1),
  /** The account's own address, shown back to its owner (A01 "We sent a link to …", P01). */
  email: z.string(),
});

export type SessionAccount = z.infer<typeof SessionAccountSchema>;

/**
 * `POST /auth/redeem`: exchange the link's token for a session. `commandId` is minted once per
 * redemption and reused on retry: a retry of the same redemption (same token, same ID) before the
 * link expires returns the same account with a fresh session, so a lost answer never strands the
 * person. `SIGN_IN_LINK_INVALID` (400) when the link is unknown, expired, or was redeemed by
 * another command (the same answer for each).
 *
 * `client: "web"` sets the session cookie (HttpOnly, SameSite=Lax, Secure on HTTPS) and returns no
 * token; `client: "native"` returns the bearer token once, for the platform secure store.
 */
export const RedeemSignInSchema = z.object({
  token: z.string().regex(SIGN_IN_TOKEN_PATTERN),
  commandId: CommandIdSchema,
  client: SessionClientSchema,
});

export const RedeemSignInResponseSchema = z.object({
  account: SessionAccountSchema,
  /** True for the redemption that created the account and its universe. */
  accountCreated: z.boolean(),
  /** True when this answers a retry of an earlier redemption with the same command ID. */
  replayed: z.boolean(),
  session: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('cookie'), expiresAt: z.iso.datetime() }),
    z.object({
      kind: z.literal('bearer'),
      token: z.string().regex(SESSION_TOKEN_PATTERN),
      expiresAt: z.iso.datetime(),
    }),
  ]),
});

export type RedeemSignInResponse = z.infer<typeof RedeemSignInResponseSchema>;

export const redeemSignInContract = oc
  .route({ method: 'POST', path: '/auth/redeem', successStatus: 200, tags: ['identity'] })
  .input(RedeemSignInSchema)
  .output(RedeemSignInResponseSchema);

/**
 * `GET /auth/session`: who the presented session belongs to now (re-read on every request).
 * `UNAUTHENTICATED` (401) for no, an unknown, a revoked or an expired session.
 */
export const SessionResponseSchema = z.object({
  account: SessionAccountSchema,
  client: SessionClientSchema,
  expiresAt: z.iso.datetime(),
});

export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const sessionContract = oc
  .route({ method: 'GET', path: '/auth/session', successStatus: 200, tags: ['identity'] })
  .output(SessionResponseSchema);

/**
 * `POST /auth/sign-out`: end this session (or, with `everywhere`, every session of the account)
 * and drop the account's live sockets. Clears the web cookie. Answers success even when the
 * session had already ended; `UNAUTHENTICATED` only when no session was presented at all.
 */
export const SignOutSchema = z.object({ everywhere: z.boolean().optional() });

export const SignOutResponseSchema = z.object({ status: z.literal('signed_out'), revoked: z.number().int().min(0) });

export const signOutContract = oc
  .route({ method: 'POST', path: '/auth/sign-out', successStatus: 200, tags: ['identity'] })
  .input(SignOutSchema)
  .output(SignOutResponseSchema);
