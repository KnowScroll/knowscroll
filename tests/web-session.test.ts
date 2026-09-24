/**
 * ADR-0034 — the desktop session cookie over the real Fastify app: minting from a magic link, reads
 * by cookie, CSRF and same-origin on every change, one credential per request, sign-out and Reset
 * ending the session, and the Android bearer path unchanged.
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
const scratch = await mkdtemp(join(tmpdir(), 'ks-web-session-'));
const realDevRoot = process.env.KS_DEV_ROOT;
process.env.KS_DEV_ROOT = scratch;

const { buildApp } = await import('../apps/api/src/app.ts');
const { webSessionConfig } = await import('../apps/api/src/web-session.ts');
const { pool } = await import('../packages/db/src/index.ts');
const { resolveOwnerEmail } = await import('../packages/db/src/sign-in.ts');

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Web session tests require a disposable knowscroll_test_* database');
const app = buildApp(randomBytes(32).toString('hex'), {
  magicLinkLimits: { accountWindowMinutes: 15, accountMaxPerWindow: 500, fingerprintWindowMinutes: 15, fingerprintMaxPerWindow: 500 },
});
await app.ready();
after(async () => { await app.close(); await pool.end(); process.env.KS_DEV_ROOT = realDevRoot; await rm(scratch, { recursive: true, force: true }); });

const ORIGIN = 'https://knowscroll.test';
async function signInToken(): Promise<string> {
  const requested = await app.inject({ method: 'POST', url: '/v1/auth/magic-link', payload: { email: resolveOwnerEmail() } });
  assert.equal(requested.statusCode, 202);
  const link = (await readFile(join(scratch, 'sign-in', 'magic-link.txt'), 'utf8')).trim();
  // With a web origin the link opens the sign-in page and carries the token in the fragment.
  const url = new URL(link);
  assert.equal(`${url.origin}${url.pathname}`, `${ORIGIN}/sign-in`);
  assert.equal(url.search, '', 'the token never travels in a query string');
  return new URLSearchParams(url.hash.slice(1)).get('token')!;
}
async function webSession(): Promise<{ cookie: string; csrf: string; setCookie: string; body: Record<string, unknown> }> {
  const response = await app.inject({ method: 'POST', url: '/v1/auth/web-session', payload: { token: await signInToken() } });
  assert.equal(response.statusCode, 200, response.body);
  const setCookie = String(response.headers['set-cookie']);
  const cookie = setCookie.split(';')[0]!;
  return { cookie, csrf: response.json().csrfToken, setCookie, body: response.json() };
}
// Sign-in always lands in the one owner universe, which other test files also use: read its epoch.
async function epochOf(cookie: string): Promise<number> {
  const u = (await app.inject({ url: '/v1/universe', headers: { cookie } })).json();
  return u.privacyEpoch ?? u.universe?.privacyEpoch ?? 0;
}
const change = (s: { cookie: string; csrf: string }, url: string, payload: unknown, extra: Record<string, string> = { origin: ORIGIN }) =>
  app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, ...extra } });

test('a web session is a cookie the page cannot read; the body never carries the session token', async () => {
  const s = await webSession();
  assert.match(s.setCookie, /^ks_session=[^;]+; Path=\/v1; HttpOnly; Secure; SameSite=Strict; Max-Age=\d+$/);
  assert.equal('sessionToken' in s.body, false);
  assert.ok(!JSON.stringify(s.body).includes(decodeURIComponent(s.cookie.split('=')[1]!)), 'the token is only in the cookie');
  assert.match(String(s.body.csrfToken), /^[0-9a-f]{64}$/);
  const read = await app.inject({ url: '/v1/session', headers: { cookie: s.cookie } });
  assert.equal(read.statusCode, 200, 'a cookie authenticates reads');
  const csrf = await app.inject({ url: '/v1/session/csrf', headers: { cookie: s.cookie } });
  assert.equal(csrf.json().csrfToken, s.csrf, 'the derived token survives a reload');
});

test('a change by cookie needs the page\'s token and origin; bearer changes do not', async () => {
  const s = await webSession();
  const epoch = await epochOf(s.cookie);
  const pause = { requestId: randomUUID(), expectedPrivacyEpoch: epoch };
  assert.equal((await app.inject({ method: 'POST', url: '/v1/privacy/pause', payload: pause, headers: { cookie: s.cookie, origin: ORIGIN } })).statusCode, 403, 'no token');
  assert.equal((await change({ ...s, csrf: 'f'.repeat(64) }, '/v1/privacy/pause', pause)).statusCode, 403, 'wrong token');
  assert.equal((await change(s, '/v1/privacy/pause', pause, { origin: 'https://evil.test' })).statusCode, 403, 'another site');
  assert.equal((await change(s, '/v1/privacy/pause', pause, {})).statusCode, 403, 'no origin and no fetch metadata');
  assert.equal((await change(s, '/v1/privacy/pause', pause)).statusCode, 200, 'the page itself');
  assert.equal((await change(s, '/v1/privacy/resume', { requestId: randomUUID(), expectedPrivacyEpoch: epoch }, { 'sec-fetch-site': 'same-origin' })).statusCode, 200, 'same-origin fetch metadata');
  const other = await webSession();
  assert.equal((await change({ cookie: s.cookie, csrf: other.csrf }, '/v1/privacy/pause', { requestId: randomUUID(), expectedPrivacyEpoch: epoch })).statusCode, 403, 'another session\'s token');
});

test('one credential per request; a bearer session has no CSRF token', async () => {
  const s = await webSession();
  const bearer = await app.inject({ method: 'POST', url: '/v1/auth/session', payload: { token: await signInToken() } });
  assert.equal(bearer.statusCode, 200);
  assert.match(bearer.json().sessionToken, /.+/, 'Android keeps its bearer token');
  const both = await app.inject({ url: '/v1/session', headers: { cookie: s.cookie, authorization: `Bearer ${bearer.json().sessionToken}` } });
  assert.equal(both.statusCode, 400);
  assert.equal((await app.inject({ url: '/v1/session/csrf', headers: { authorization: `Bearer ${bearer.json().sessionToken}` } })).statusCode, 400);
});

test('sign-out clears the cookie and ends the session; Reset ends every cookie session', async () => {
  const s = await webSession();
  const out = await change(s, '/v1/session/revoke', {});
  assert.equal(out.statusCode, 204);
  assert.match(String(out.headers['set-cookie']), /^ks_session=; .*Max-Age=0$/);
  assert.equal((await app.inject({ url: '/v1/session', headers: { cookie: s.cookie } })).statusCode, 401);
  const t = await webSession();
  const epoch = await epochOf(t.cookie);
  const reset = await change(t, '/v1/privacy/reset', { requestId: randomUUID(), expectedPrivacyEpoch: epoch, confirmation: 'reset-personal-universe' });
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal((await app.inject({ url: '/v1/session', headers: { cookie: t.cookie } })).statusCode, 401);
});

test('production refuses to start without a CSRF secret and the web origin', () => {
  assert.throws(() => webSessionConfig({ NODE_ENV: 'production' }), /KS_CSRF_SECRET/);
  assert.throws(() => webSessionConfig({ NODE_ENV: 'production', KS_CSRF_SECRET: 'x'.repeat(32) }), /KS_WEB_ORIGIN/);
  assert.ok(webSessionConfig({ NODE_ENV: 'production', KS_CSRF_SECRET: 'x'.repeat(32), KS_WEB_ORIGIN: ORIGIN }));
});
