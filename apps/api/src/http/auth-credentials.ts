import { isIPv4, isIPv6 } from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { DEVELOPMENT_SESSION_COOKIE_NAME, SESSION_COOKIE_NAME, problemDetails } from '@knowscroll/contracts';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { SESSION_TTL_DAYS } from '@knowscroll/backend/modules/identity';
import { sendProblem } from './problems.js';
import { currentRequest } from './request-context.js';

/** The headers a credential can arrive in (HTTP request or Socket.IO handshake). */
export interface CredentialHeaders {
  readonly authorization?: string | undefined;
  readonly cookie?: string | undefined;
}

/** A presented session credential: a native bearer token, or the web session cookie. */
export type Credential = { readonly kind: 'bearer' | 'cookie'; readonly token: string };

/** The session cookie's name: `__Host-` prefixed on an HTTPS origin, plain on a development HTTP one. */
export function sessionCookieName(secure: boolean): string {
  return secure ? SESSION_COOKIE_NAME : DEVELOPMENT_SESSION_COOKIE_NAME;
}

/** The value of cookie `name` in a `Cookie` header, if present. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

/**
 * The credential a request presents. An `Authorization: Bearer` header wins (native clients and
 * tools); otherwise the session cookie (web). The token's shape is checked by whoever resolves it.
 */
export function credentialFrom(headers: CredentialHeaders, cookieName: string): Credential | undefined {
  const authorization = headers.authorization;
  if (authorization !== undefined) {
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    return match?.[1] === undefined ? undefined : { kind: 'bearer', token: match[1] };
  }
  const cookie = cookieValue(headers.cookie, cookieName);
  return cookie === undefined || cookie === '' ? undefined : { kind: 'cookie', token: cookie };
}

/**
 * `Set-Cookie` for a web session: HttpOnly (scripts cannot read it), SameSite=Lax (not sent on
 * cross-site subrequests or form posts), Path=/, and Secure with the `__Host-` prefix on HTTPS.
 */
export function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  const maxAge = Math.max(
    0,
    Math.min(SESSION_TTL_DAYS * 86_400, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
  );
  return `${sessionCookieName(secure)}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** `Set-Cookie` that removes the web session cookie. */
export function clearedSessionCookie(secure: boolean): string {
  return `${sessionCookieName(secure)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Express middleware (registered before every route): cross-site request forgery and origin
 * refusal for state-changing requests (D-007). For POST/PUT/PATCH/DELETE:
 * - an `Origin` header must be this world's own origin (`KS_PUBLIC_ORIGIN`): browsers send it on
 *   every such request, so another site's page is always refused;
 * - a request authenticated by the session cookie (no `Authorization` header) must carry `Origin`.
 * Native clients and tools send no `Origin` and authenticate with a bearer token, which a
 * browser never attaches on its own. Refusals answer `ORIGIN_NOT_ALLOWED` (403) and are logged.
 * (JSON-only bodies, SameSite=Lax and no CORS headers are further layers, not the check.)
 */
export function originGuard(options: {
  readonly publicOrigin: string;
  readonly cookieName: string;
  readonly logEvent: LogEvent;
}) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (safeMethods.has(request.method)) {
      next();
      return;
    }
    const origin = request.headers.origin;
    const cookieAuthenticated =
      request.headers.authorization === undefined &&
      cookieValue(request.headers.cookie, options.cookieName) !== undefined;
    const refused = origin === undefined ? cookieAuthenticated : origin !== options.publicOrigin;
    if (!refused) {
      next();
      return;
    }
    const context = currentRequest();
    options.logEvent('identity.origin_refused', {
      ...(context === undefined ? {} : { requestId: context.requestId }),
      method: request.method,
      reasonCode: origin === undefined ? 'origin_missing' : 'origin_mismatch',
    });
    const details = problemDetails('ORIGIN_NOT_ALLOWED');
    if (context !== undefined) context.problemCode = details.code;
    sendProblem(response, details);
  };
}

/** Express middleware: nothing under `/auth` is cached (sessions, tokens and their absence). */
export function noStoreForAuth() {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (request.path.startsWith('/auth/')) response.setHeader('cache-control', 'no-store');
    next();
  };
}

const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** The 16-bit groups of an IPv6 address (`::` expanded, an embedded IPv4 tail as two groups). */
function ipv6Groups(address: string): readonly number[] {
  const bare = address.split('%')[0] ?? address;
  const groups = (part: string): number[] =>
    (part === '' ? [] : part.split(':')).flatMap((group) => {
      if (!group.includes('.')) return [Number.parseInt(group, 16)];
      const [a = 0, b = 0, c = 0, d = 0] = group.split('.').map(Number);
      return [a * 256 + b, c * 256 + d];
    });
  const [head = '', tail] = bare.split('::');
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const fill = tail === undefined ? [] : new Array<number>(Math.max(0, 8 - left.length - right.length)).fill(0);
  return [...left, ...fill, ...right];
}

/**
 * The key one client is limited under (review M2): an IPv4 address as it is (an IPv4-mapped IPv6
 * address as its IPv4), an IPv6 address by its /64 prefix, because one subscriber usually holds a
 * whole /64 and could otherwise rotate through 2^64 addresses.
 */
export function clientKey(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped?.[1] !== undefined) return mapped[1];
  if (isIPv4(address) || !isIPv6(address)) return address;
  const prefix = ipv6Groups(address)
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':');
  return `${prefix}::/64`;
}

/**
 * The client's key for rate limits (`clientKey`). The API listens on loopback behind Caddy
 * (D-008), which sets `X-Forwarded-For`; its last entry is the address Caddy saw. A request that
 * did not come through a loopback peer is keyed by its own peer address.
 */
export function clientAddress(request: Request): string {
  const peer = request.socket.remoteAddress ?? 'unknown';
  if (!loopback.has(peer)) return clientKey(peer);
  const forwarded = request.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded.at(-1) : forwarded;
  const last = value?.split(',').at(-1)?.trim();
  return clientKey(last === undefined || last === '' ? peer : last);
}

/**
 * Express middleware (review m7): every API answer is JSON or a problem, so it may load nothing,
 * be framed nowhere and send no referrer. The web app's own policy is set by the edge (Caddy,
 * `roles/caddy/files/app-content-security-policy.txt`).
 */
export function apiSecurityHeaders() {
  return (_request: Request, response: Response, next: NextFunction): void => {
    response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    next();
  };
}
