/**
 * ADR-0034 — the desktop session cookie and its CSRF guard.
 *
 * The web page never reads a credential: the session token lives in an HttpOnly, Secure,
 * SameSite=Strict cookie. A cookie-authenticated request that changes anything must also carry
 * `X-CSRF-Token` (an HMAC of the session token's hash under a server secret, so nothing is stored
 * and it survives reloads) and be same-origin. After those checks the cookie's token is presented
 * to the one authentication path every route already uses (`authenticateAndLock`), so a cookie
 * session has exactly the same epoch, revocation, expiry and lock semantics as a bearer one.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError } from './errors.ts';

export const SESSION_COOKIE = 'ks_session';
const SAFE_METHODS = new Set(['GET', 'HEAD']);

export type WebSessionConfig = { secret: Buffer; webOrigin: string | null };

/** Production requires both settings; development gets a random secret per process. */
export function webSessionConfig(env: NodeJS.ProcessEnv = process.env): WebSessionConfig {
  const production = env.NODE_ENV === 'production';
  const configured = env.KS_CSRF_SECRET;
  if (production && (!configured || Buffer.byteLength(configured) < 32)) throw new Error('KS_CSRF_SECRET (32+ bytes) is required in production');
  if (production && !env.KS_WEB_ORIGIN) throw new Error('KS_WEB_ORIGIN is required in production');
  return { secret: configured ? Buffer.from(configured) : randomBytes(32), webOrigin: env.KS_WEB_ORIGIN?.replace(/\/+$/, '') ?? null };
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function sessionCookie(token: string, expiresAt: string): string {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/v1; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
export const clearedSessionCookie = `${SESSION_COOKIE}=; Path=/v1; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

/** Derived, never stored: binds the CSRF token to this session without revealing the session token. */
export function csrfToken(secret: Buffer, sessionToken: string): string {
  return createHmac('sha256', secret).update(`csrf:${createHash('sha256').update(sessionToken).digest('hex')}`).digest('hex');
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

declare module 'fastify' {
  interface FastifyRequest { ksCookieSession?: string }
}

/**
 * Registers the cookie → bearer bridge. Sign-in routes are exempt (they authenticate nothing and a
 * stale cookie must not block a new sign-in).
 */
export function registerWebSession(app: FastifyInstance, config: WebSessionConfig): void {
  app.addHook('onRequest', async (req: FastifyRequest) => {
    if (req.url.startsWith('/v1/auth/')) return;
    const cookie = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!cookie) return;
    if (req.headers.authorization) throw new HttpError(400, 'A request carries one credential, not two');
    if (!SAFE_METHODS.has(req.method)) {
      const origin = req.headers.origin;
      const site = req.headers['sec-fetch-site'];
      const sameOrigin = typeof origin === 'string' ? origin === config.webOrigin : site === 'same-origin';
      const token = req.headers['x-csrf-token'];
      if (!sameOrigin || typeof token !== 'string' || !sameToken(token, csrfToken(config.secret, cookie))) {
        throw new HttpError(403, 'This change needs the page’s own request token');
      }
    }
    req.ksCookieSession = cookie;
    req.headers.authorization = `Bearer ${cookie}`;
  });
}
