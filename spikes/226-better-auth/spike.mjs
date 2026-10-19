// S1.3 (#226) D-007 spike: better-auth 1.7.10 (magic-link + bearer) on Nest 12.1.3 / Express 5.2.1,
// Kysely 0.29.7 storage in the PostgreSQL `identity` schema. Hands-on probe against a throwaway
// local database; prints one line per observed property. Not a test suite.
import 'reflect-metadata';
import { Controller, Module, Post, Body } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { betterAuth } from 'better-auth';
import { magicLink, bearer } from 'better-auth/plugins';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import { randomUUID, createHash } from 'node:crypto';

const DB = process.env.SPIKE_DATABASE_URL;
const pool = new pg.Pool({ connectionString: DB, max: 5 });
const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
const out = (k, v) => console.log(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

await sql`drop schema if exists identity cascade`.execute(db);
await sql`create schema identity`.execute(db);
// Existing v2 tables (0001) plus the columns/tables better-auth needs, snake_case via field maps.
await sql`create table identity.accounts (id uuid primary key, status text not null default 'active',
  created_at timestamptz not null default now(), email text not null unique, name text not null default '',
  email_verified boolean not null default false, image text, updated_at timestamptz not null default now())`.execute(db);
await sql`create table identity.universes (id uuid primary key, account_id uuid not null unique references identity.accounts(id) on delete restrict,
  privacy_epoch integer not null default 1, status text not null default 'active', revision integer not null default 0, created_at timestamptz not null default now())`.execute(db);
await sql`create table identity.sessions (id uuid primary key, account_id uuid not null references identity.accounts(id), token text not null unique,
  expires_at timestamptz not null, ip_address text, user_agent text, created_at timestamptz not null, updated_at timestamptz not null)`.execute(db);
await sql`create table identity.credentials (id uuid primary key, account_ref text not null, provider_id text not null, account_id uuid not null references identity.accounts(id),
  access_token text, refresh_token text, id_token text, access_token_expires_at timestamptz, refresh_token_expires_at timestamptz, scope text, password text,
  created_at timestamptz not null, updated_at timestamptz not null)`.execute(db);
await sql`create table identity.verifications (id uuid primary key, identifier text not null, value text not null, expires_at timestamptz not null,
  created_at timestamptz not null, updated_at timestamptz not null)`.execute(db);

const mail = [];
let failUniverseOnce = false;
const auth = betterAuth({
  baseURL: 'http://127.0.0.1:55790',
  basePath: '/auth',
  secret: 'spike-only-secret-0123456789abcdef0123456789abcdef',
  trustedOrigins: ['http://127.0.0.1:55790'],
  database: { db, type: 'postgres', schemaName: 'identity', transaction: true },
  telemetry: { enabled: false },
  advanced: { database: { generateId: () => randomUUID() } },
  user: {
    modelName: 'accounts',
    fields: { emailVerified: 'email_verified', createdAt: 'created_at', updatedAt: 'updated_at' },
  },
  session: {
    modelName: 'sessions',
    fields: { userId: 'account_id', expiresAt: 'expires_at', ipAddress: 'ip_address', userAgent: 'user_agent', createdAt: 'created_at', updatedAt: 'updated_at' },
    cookieCache: { enabled: false },
  },
  account: {
    modelName: 'credentials',
    fields: { accountId: 'account_ref', providerId: 'provider_id', userId: 'account_id', accessToken: 'access_token', refreshToken: 'refresh_token', idToken: 'id_token',
      accessTokenExpiresAt: 'access_token_expires_at', refreshTokenExpiresAt: 'refresh_token_expires_at', createdAt: 'created_at', updatedAt: 'updated_at' },
  },
  verification: {
    modelName: 'verifications',
    fields: { expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at' },
  },
  rateLimit: { enabled: true, window: 60, max: 100 },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          if (failUniverseOnce) { failUniverseOnce = false; throw new Error('simulated crash before the universe root'); }
          await db.insertInto('identity.universes').values({ id: randomUUID(), account_id: user.id }).execute();
        },
      },
    },
  },
  plugins: [
    magicLink({ storeToken: 'hashed', expiresIn: 900, sendMagicLink: async ({ email, token, url }) => { mail.push({ email, token, url }); } }),
    bearer(),
  ],
});

class EchoController {
  echo(body) { return { echoed: body }; }
}
Body()(EchoController.prototype, 'echo', 0);
Post('v1/echo')(EchoController.prototype, 'echo', Object.getOwnPropertyDescriptor(EchoController.prototype, 'echo'));
Controller()(EchoController);
class SpikeModule {}
Module({ controllers: [EchoController] })(SpikeModule);

const app = await NestFactory.create(SpikeModule, { bodyParser: false, logger: false });
// better-auth must see the raw body: mount it before any JSON parser.
const authHandler = toNodeHandler(auth);
app.use((req, res, next) => (req.path.startsWith('/auth/') ? authHandler(req, res) : next()));
app.use(express.json({ limit: 65536 }));
await app.listen(55790, '127.0.0.1');
const base = 'http://127.0.0.1:55790';
const origin = { origin: base, 'content-type': 'application/json' };

// 1. Mount: Nest JSON routes keep working.
const echo = await fetch(`${base}/v1/echo`, { method: 'POST', headers: origin, body: JSON.stringify({ a: 1 }) });
out('nest_json_route_after_mount', `${echo.status} ${await echo.text()}`);

// 2. Request a link.
const request = await fetch(`${base}/auth/sign-in/magic-link`, { method: 'POST', headers: origin, body: JSON.stringify({ email: 'a@example.test' }) });
out('sign_in_request', `${request.status} ${await request.text()}`);
const stored = await db.selectFrom('identity.verifications').select(['identifier', 'value', 'expires_at']).execute();
out('verification_row_identifier_is_hash_not_token', stored[0].identifier !== `magic-link:${mail[0].token}` && !stored[0].identifier.includes(mail[0].token));
out('verification_row_value_holds_plain_email', stored[0].value);
out('link_points_at', new URL(mail[0].url).pathname);

// 3. A GET with no cookie, no origin (what a mail scanner / prefetcher sends) signs the person in.
const scan = await fetch(mail[0].url, { redirect: 'manual' });
const scanCookie = scan.headers.get('set-cookie') ?? '';
out('prefetch_get_status', scan.status);
out('prefetch_get_sets_session_cookie', scanCookie.includes('session_token'));
out('sessions_after_prefetch', (await db.selectFrom('identity.sessions').select('id').execute()).length);
const second = await fetch(mail[0].url, { redirect: 'manual' });
out('second_use_redirect', second.headers.get('location'));

// 4. Session lookup: cookie and bearer.
const cookie = scanCookie.split(';')[0];
const viaCookie = await auth.api.getSession({ headers: fromNodeHeaders({ cookie }) });
out('get_session_cookie', viaCookie?.user?.email ?? null);
const bearerToken = scan.headers.get('set-auth-token');
const viaBearer = await auth.api.getSession({ headers: fromNodeHeaders({ authorization: `Bearer ${bearerToken}` }) });
out('get_session_bearer', viaBearer?.user?.email ?? null);
out('universes_for_account', (await db.selectFrom('identity.universes').select('id').execute()).length);

// 5. Atomicity: a failure after the account insert (simulated crash before the universe root).
failUniverseOnce = true;
await fetch(`${base}/auth/sign-in/magic-link`, { method: 'POST', headers: origin, body: JSON.stringify({ email: 'b@example.test' }) });
const crash = await fetch(mail.at(-1).url, { redirect: 'manual' });
const accountsB = await db.selectFrom('identity.accounts').select('id').where('email', '=', 'b@example.test').execute();
const universesB = await db.selectFrom('identity.universes').innerJoin('identity.accounts', 'identity.accounts.id', 'identity.universes.account_id').select('identity.universes.id').where('email', '=', 'b@example.test').execute();
out('hook_failure_response', `${crash.status} ${crash.headers.get('location') ?? ''}`);
out('hook_failure_left_account_without_universe', accountsB.length === 1 && universesB.length === 0);

// 6. Concurrent first sign-in with two links for one new address.
for (let i = 0; i < 2; i += 1)
  await fetch(`${base}/auth/sign-in/magic-link`, { method: 'POST', headers: origin, body: JSON.stringify({ email: 'c@example.test' }) });
const [l1, l2] = mail.slice(-2);
const results = await Promise.all([fetch(l1.url, { redirect: 'manual' }), fetch(l2.url, { redirect: 'manual' })]);
out('concurrent_first_sign_in', results.map((r) => `${r.status} ${(r.headers.get('location') ?? '').replace(base, '')} cookie=${(r.headers.get('set-cookie') ?? '').includes('session_token')}`));

const accountsC = await db.selectFrom('identity.accounts').select('id').where('email', '=', 'c@example.test').execute();
const universesC = await db.selectFrom('identity.universes').innerJoin('identity.accounts', 'identity.accounts.id', 'identity.universes.account_id').select('identity.universes.id').where('email', '=', 'c@example.test').execute();
out('concurrent_first_sign_in_accounts_universes', [accountsC.length, universesC.length]);

// 6b. Workaround probe: consume through the server API from our own POST handler.
await fetch(`${base}/auth/sign-in/magic-link`, { method: 'POST', headers: origin, body: JSON.stringify({ email: 'd@example.test' }) });
const viaApi = await auth.api.magicLinkVerify({ query: { token: mail.at(-1).token }, headers: fromNodeHeaders({ origin: base }), asResponse: true });
out('server_api_consume_status_and_cookie', `${viaApi.status} cookie=${(viaApi.headers.get('set-cookie') ?? '').includes('session_token')}`);

// 7. Error format.
const bad = await fetch(`${base}/auth/sign-in/magic-link`, { method: 'POST', headers: origin, body: JSON.stringify({ email: 'not-an-address' }) });
out('error_content_type', bad.headers.get('content-type'));
out('error_body', await bad.text());

// 8. Cross-site POST without Origin header but with cookie: is it refused?
const csrf = await fetch(`${base}/auth/sign-out`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: 'https://evil.example' }, body: '{}' });
out('cross_origin_sign_out', `${csrf.status} ${await csrf.text()}`);

await app.close();
await db.destroy();
