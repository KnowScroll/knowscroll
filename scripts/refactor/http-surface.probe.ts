/**
 * HTTP surface probe for the backend refactor (issue #196). Not a test of correctness: it records
 * every status, header and body the API produces today, for every registered route, so a refactor
 * can be re-run against the recorded file and shown to change nothing.
 *
 *   PROBE_OUT=/abs/path/out.json ./scripts/test.sh scripts/refactor/http-surface.probe.ts
 *   node scripts/refactor/probe/compare.mjs old.json new.json
 *
 * Invariants: the registered route list is read from the app (a route without a case, or a case
 * for an unregistered route, fails the run); case order is fixed; per-run values are normalized
 * by `probe/normalize.ts`; destructive cases (Reset, account deletion) run last. In-process only:
 * no network, no provider. The mail sender stays the development sink.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { useTestOwnerEmail } from '../../tests/helpers/owner-address.ts';
import { Normalizer, stableStringify } from './probe/normalize.ts';

// Configuration is set before any module that reads it is imported: the database package copies
// `.env` into unset process.env keys on first import, and the sign-in and web-session modules read
// these at build time.
useTestOwnerEmail();
process.env.KS_WEB_ORIGIN = 'https://knowscroll.test';
process.env.KS_CSRF_SECRET = 'a-fixed-probe-secret-of-at-least-32-bytes!!';
assert.equal(
  process.env.KS_MAIL_SENDER,
  undefined,
  'the probe must run with the development mail sink: KS_MAIL_SENDER has to be unset',
);
const scratchBase = join(
  process.env.KS_DEV_ROOT ?? '/Volumes/Mrigesh SSD/knowscroll-dev',
  'tmp',
  'refactor-196',
  'a2',
);
await mkdir(scratchBase, { recursive: true });
const scratch = await mkdtemp(join(scratchBase, 'scratch-'));
const realDevRoot = process.env.KS_DEV_ROOT;
process.env.KS_DEV_ROOT = scratch;
const mediaRoot = join(scratch, 'media');
await mkdir(mediaRoot, { recursive: true });

const { buildApp } = await import('../../apps/api/src/app.ts');
const { csrfToken, webSessionConfig } = await import(
  '../../apps/api/src/web-session.ts'
);
const { pool, provisionIdentity, transaction } = await import('@knowscroll/db');
const { projectOne } = await import('../../apps/worker/src/project.ts');
const { readScroll, EDITORIAL, askAbout } = await import(
  '../../tests/helpers/reading.ts'
);
const { COMPOSER_SIGNALS_V2 } = await import('@knowscroll/core/composer');
const { COMPOSER_SEMANTIC_V4 } = await import(
  '@knowscroll/core/composer/semantic'
);
const { carryGravityQuestion } = await import('../../tests/helpers/rooms.ts');
const { seedTraceRevisitGraph } = await import(
  '../../tests/helpers/trace-revisit-fixture.ts'
);
const { gateTestReel, mintGatedTestReel } = await import(
  '../fixtures/gated-reel.ts'
);
const { resolveOwnerEmail } = await import('@knowscroll/db/sign-in');
const { installAskAnswerRoute, answerAuthority, answerFairnessPolicy } =
  await import('@knowscroll/db/reasoning-answers');
const { createReasoningFairness } = await import(
  '@knowscroll/db/reasoning-fairness'
);
const { runAnswerPass } = await import(
  '../../apps/worker/src/reasoning/answer-worker.ts'
);
const { createFixtureAnswerTransport } = await import(
  '../../apps/worker/src/providers/answer-fixture.ts'
);
assert.equal(
  process.env.KS_MAIL_SENDER,
  undefined,
  'loading the database package must not have introduced KS_MAIL_SENDER',
);
assert.ok(
  new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_'),
  'the probe needs a disposable knowscroll_test_* database',
);
assert.ok(
  process.env.PROBE_OUT?.startsWith('/'),
  'PROBE_OUT must be an absolute path',
);

const DEV_TOKEN = 'probe-development-token-0123456789abcdef';
const app = buildApp(DEV_TOKEN, {
  mediaRoot,
  magicLinkLimits: {
    accountWindowMinutes: 15,
    accountMaxPerWindow: 5000,
    fingerprintWindowMinutes: 15,
    fingerprintMaxPerWindow: 5000,
  },
});
// The deployment-selectable ranking policies change what /v1/feed records; the default app runs v3.
const appV2 = buildApp(DEV_TOKEN, {
  mediaRoot,
  composerPolicy: COMPOSER_SIGNALS_V2,
});
const appV4 = buildApp(DEV_TOKEN, {
  mediaRoot,
  composerPolicy: COMPOSER_SEMANTIC_V4,
});
after(async () => {
  await appV2.close();
  await appV4.close();
  await app.close();
  await pool.end();
  process.env.KS_DEV_ROOT = realDevRoot;
  await rm(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------

const normalizer = new Normalizer();
const EXCLUDED_HEADERS = new Set([
  'date',
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
]);

interface Recorded {
  route: string;
  name: string;
  request: string;
  statusCode: number;
  contentType: string | null;
  cacheControl: string | null;
  setCookie: { names: string[]; attributes: string[] } | null;
  location: string | null;
  wwwAuthenticate: string | null;
  headerNames: string[];
  /** Every other response header with its (normalized) value: Content-Range, Accept-Ranges, the simulated marker. */
  headers: Record<string, string>;
  /** Media-style bytes are recorded by length and digest, never normalized. */
  body: unknown;
}

const recorded: Recorded[] = [];
const seenKeys = new Set<string>();
const routesWithCases = new Set<string>();
// Not a route: requests that match nothing, recorded for the default 404 shape.
const UNMATCHED = '(unmatched)';

function headerValue(res: LightMyRequestResponse, name: string): string | null {
  const value = res.headers[name];
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(', ') : String(value);
}

function cookieSummary(res: LightMyRequestResponse): Recorded['setCookie'] {
  const raw = res.headers['set-cookie'];
  if (raw === undefined) return null;
  const cookies = Array.isArray(raw) ? raw : [String(raw)];
  const names: string[] = [];
  const attributes = new Set<string>();
  for (const cookie of cookies) {
    const [pair, ...rest] = cookie.split(';');
    names.push(pair!.split('=')[0]!.trim());
    for (const attribute of rest)
      attributes.add(attribute.split('=')[0]!.trim().toLowerCase());
  }
  return { names, attributes: [...attributes].sort() };
}

/** Credentials a response hands out are registered before the body is normalized, so they never appear. */
function registerBodyCredentials(parsed: unknown): void {
  if (parsed === null || typeof parsed !== 'object') return;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>))
    if (
      ['sessionToken', 'csrfToken'].includes(key) &&
      typeof value === 'string'
    )
      normalizer.registerToken(value);
}

function bodyOf(
  res: LightMyRequestResponse,
  contentType: string | null,
): unknown {
  const raw = res.rawPayload as Buffer;
  if (raw.length === 0) return { empty: true };
  if (contentType?.startsWith('application/json')) {
    try {
      const parsed: unknown = JSON.parse(res.body);
      registerBodyCredentials(parsed);
      return normalizer.normalize(parsed);
    } catch {
      return { unparsedJson: normalizer.normalize(res.body) };
    }
  }
  if (contentType?.startsWith('text/')) return normalizer.normalize(res.body);
  return {
    length: raw.length,
    sha256: createHash('sha256').update(raw).digest('hex'),
  };
}

async function call(
  route: string,
  name: string,
  request: string,
  options: InjectOptions,
  target: Pick<typeof app, 'inject'> = app,
): Promise<LightMyRequestResponse> {
  const key = `${route} :: ${name}`;
  assert.ok(!seenKeys.has(key), `duplicate probe case ${key}`);
  seenKeys.add(key);
  routesWithCases.add(route);
  const res = await target.inject(options);
  const contentType = headerValue(res, 'content-type');
  const location = headerValue(res, 'location');
  recorded.push({
    route,
    name,
    // The summary quotes URLs, which carry per-run ids.
    request: normalizer.normalize(request) as string,
    statusCode: res.statusCode,
    contentType,
    cacheControl: headerValue(res, 'cache-control'),
    setCookie: cookieSummary(res),
    location:
      location === null ? null : (normalizer.normalize(location) as string),
    wwwAuthenticate: headerValue(res, 'www-authenticate'),
    headerNames: Object.keys(res.headers)
      .filter((h) => !EXCLUDED_HEADERS.has(h))
      .sort(),
    headers: Object.fromEntries(
      Object.keys(res.headers)
        .filter((h) => !EXCLUDED_HEADERS.has(h) && h !== 'set-cookie')
        .sort()
        .map((h) => [h, normalizer.normalize(headerValue(res, h)) as string]),
    ),
    body: bodyOf(res, contentType),
  });
  return res;
}

// ---------------------------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------------------------

type Json = any; // response bodies are recorded as received, never typed
const json = (res: LightMyRequestResponse): Json => res.json();
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const UNKNOWN_TOKEN = 'unknown-bearer-token-0000000000000000000000';
const UNKNOWN_COOKIE = `ks_session=${UNKNOWN_TOKEN}`;
const CSRF_SECRET = webSessionConfig().secret;
const ORIGIN = 'https://knowscroll.test';

type Reader = {
  token: string;
  universeId: string;
  headers: { authorization: string };
  epoch: () => Promise<number>;
};

let fixedUuidCount = 0;
/**
 * Runs `fn` with `crypto.randomUUID` returning a fixed sequence. Minting a Reel creates its asset id
 * inside the product code, and the feed's tie-break is salted with asset ids, so a random id would
 * reorder the recorded feed between runs. Nothing else runs inside the window.
 */
async function withFixedUuids<T>(fn: () => Promise<T>): Promise<T> {
  const cjs = createRequire(import.meta.url)('node:crypto') as {
    randomUUID: () => string;
  };
  const original = cjs.randomUUID;
  cjs.randomUUID = () => {
    fixedUuidCount += 1;
    return `bbbbbbbb-0000-4000-8000-${String(fixedUuidCount).padStart(12, '0')}`;
  };
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    cjs.randomUUID = original;
    syncBuiltinESMExports();
  }
}

let readerCount = 0;
/**
 * A new reader gets a fixed universe id: the feed's tie-break is salted with it, so random ids would
 * make the recorded feeds differ between runs. Passing an existing id adds a session to it.
 */
async function reader(universeId?: string): Promise<Reader> {
  let target = universeId;
  if (target === undefined) {
    readerCount += 1;
    target = `aaaaaaaa-0000-4000-8000-${String(readerCount).padStart(12, '0')}`;
    await pool.query('INSERT INTO universe(id) VALUES($1)', [target]);
    await pool.query('INSERT INTO accounts(universe_id) VALUES($1)', [target]);
  }
  const identity = await provisionIdentity({ universeId: target });
  normalizer.registerToken(identity.token);
  const headers = bearer(identity.token);
  return {
    token: identity.token,
    universeId: identity.scope.universeId,
    headers,
    epoch: async () =>
      json(await app.inject({ url: '/v1/universe', headers })).privacyEpoch,
  };
}

const isMutating = (method: string | undefined) =>
  method !== undefined && !['GET', 'HEAD'].includes(method);

/**
 * The four credential cases every authenticated route gets. The cookie hook runs before the route:
 * an unknown cookie on a change is refused for its missing page token (403) before any lookup,
 * and with a matching token and origin is simply an unknown session (401).
 */
async function credentialCases(
  route: string,
  base: { method: 'GET' | 'POST' | 'PUT'; url: string; payload?: Json },
) {
  const label = `${base.method} ${base.url}`;
  const plain = { method: base.method, url: base.url, payload: base.payload };
  await call(
    route,
    'no-credential',
    `${label}, no Authorization, no cookie`,
    plain,
  );
  await call(route, 'bad-credential', `${label}, unknown bearer token`, {
    ...plain,
    headers: bearer(UNKNOWN_TOKEN),
  });
  await call(
    route,
    'bad-cookie',
    `${label}, unknown session cookie, no page token`,
    {
      ...plain,
      headers: { cookie: UNKNOWN_COOKIE },
    },
  );
  if (isMutating(base.method)) {
    await call(
      route,
      'bad-cookie-with-page-token',
      `${label}, unknown session cookie with a matching page token and origin`,
      {
        ...plain,
        headers: {
          cookie: UNKNOWN_COOKIE,
          origin: ORIGIN,
          'x-csrf-token': csrfToken(CSRF_SECRET, UNKNOWN_TOKEN),
        },
      },
    );
  }
  await call(
    route,
    'two-credentials',
    `${label}, a cookie and a bearer token together`,
    {
      ...plain,
      headers: { cookie: UNKNOWN_COOKIE, ...bearer(UNKNOWN_TOKEN) },
    },
  );
}

/** Body-parsing cases: Fastify refuses these before the handler, so they hold for every body route. */
async function bodyCases(
  route: string,
  url: string,
  method: 'POST' | 'PUT',
  headers: Record<string, string>,
) {
  await call(
    route,
    'invalid-json',
    `${method} ${url}, body "{bad" as application/json`,
    {
      method,
      url,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: '{bad',
    },
  );
  await call(
    route,
    'empty-json-body',
    `${method} ${url}, empty body as application/json`,
    {
      method,
      url,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: '',
    },
  );
  await call(
    route,
    'unsupported-media-type',
    `${method} ${url}, text/plain body`,
    {
      method,
      url,
      headers: { ...headers, 'content-type': 'text/plain' },
      payload: 'hello',
    },
  );
  await call(route, 'array-body', `${method} ${url}, a JSON array body`, {
    method,
    url,
    headers,
    payload: [] as unknown as Record<string, unknown>,
  });
}

// ---------------------------------------------------------------------------------------------
// Setup that is not itself recorded
// ---------------------------------------------------------------------------------------------

async function feedOf(r: Reader, query = '?kinds=Scroll'): Promise<Json> {
  const res = await app.inject({ url: `/v1/feed${query}`, headers: r.headers });
  assert.equal(res.statusCode, 200, res.body);
  return json(res);
}

async function projectKeep(jobId: string) {
  await pool.query(
    "UPDATE job SET available_at='1990-01-01T00:00:00Z' WHERE id=$1",
    [jobId],
  );
  assert.equal((await projectOne())?.status, 'completed');
}

async function mailToken(): Promise<string> {
  const link = (
    await readFile(join(scratch, 'sign-in', 'magic-link.txt'), 'utf8')
  ).trim();
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get('token')!;
  normalizer.registerToken(token);
  return token;
}

async function issueToken(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/magic-link',
    payload: { email: resolveOwnerEmail() },
  });
  assert.equal(res.statusCode, 202);
  return mailToken();
}

function sessionCookieOf(res: LightMyRequestResponse): {
  cookie: string;
  token: string;
} {
  const pair = String(res.headers['set-cookie']).split(';')[0]!;
  const token = decodeURIComponent(pair.slice(pair.indexOf('=') + 1));
  normalizer.registerToken(token);
  return { cookie: pair, token };
}

// ---------------------------------------------------------------------------------------------
// Route enumeration
// ---------------------------------------------------------------------------------------------

/** Fastify prints its radix tree; depth is the 4-column indent, each node's path is a suffix of its parent's. */
function registeredRoutes(): string[] {
  const stack: string[] = [];
  const routes: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const match = /^((?:[│ ] {3})*)[├└]── (\S+)(?: \(([A-Z, ]+)\))?$/u.exec(
      line,
    );
    if (!match) continue;
    const depth = match[1]!.length / 4;
    stack[depth] = match[2]!;
    stack.length = depth + 1;
    for (const method of (match[3] ?? '').split(', ').filter(Boolean))
      routes.push(`${method} ${stack.join('')}`);
  }
  return routes.sort();
}

// ---------------------------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------------------------

test('http surface', { timeout: 600_000 }, async () => {
  await app.ready();
  const routes = registeredRoutes();
  const lookup = (needle: string) =>
    assert.ok(routes.includes(needle), `${needle} is not registered`);

  // ---- public routes -------------------------------------------------------------------------
  await call('GET /health', 'valid', 'GET /health', { url: '/health' });
  await call(
    'GET /health',
    'credential-ignored',
    'GET /health with a bad bearer token',
    {
      url: '/health',
      headers: bearer(UNKNOWN_TOKEN),
    },
  );
  await call(
    'GET /health',
    'cookie-and-bearer-ignored',
    'GET /health with an unknown cookie and a bearer token',
    {
      url: '/health',
      headers: { cookie: UNKNOWN_COOKIE, ...bearer(UNKNOWN_TOKEN) },
    },
  );
  await call(UNMATCHED, 'unknown-path', 'GET /v1/nothing-here', {
    url: '/v1/nothing-here',
  });
  await call(UNMATCHED, 'wrong-method', 'DELETE /v1/session', {
    method: 'DELETE',
    url: '/v1/session',
  });
  await call(UNMATCHED, 'trailing-slash', 'GET /v1/session/', {
    url: '/v1/session/',
  });
  await call(UNMATCHED, 'get-on-post-route', 'GET /v1/asks', {
    url: '/v1/asks',
  });
  await call(UNMATCHED, 'options', 'OPTIONS /v1/session', {
    method: 'OPTIONS',
    url: '/v1/session',
  });

  // ---- sign-in: magic link, confirm, session, web-session -----------------------------------
  const ML = 'POST /v1/auth/magic-link';
  const owner = resolveOwnerEmail();
  await call(
    ML,
    'valid-owner',
    'POST /v1/auth/magic-link with the owner address',
    {
      method: 'POST',
      url: '/v1/auth/magic-link',
      payload: { email: owner },
    },
  );
  const t1 = await mailToken();
  await call(
    ML,
    'owner-address-padded-upper',
    'owner address upper-cased with spaces',
    {
      method: 'POST',
      url: '/v1/auth/magic-link',
      payload: { email: `  ${owner.toUpperCase()} ` },
    },
  );
  const t1b = await mailToken();
  assert.notEqual(t1, t1b, 'a second request must issue a second link');
  await call(
    ML,
    'unknown-address',
    'a non-owner address (answered like the owner)',
    {
      method: 'POST',
      url: '/v1/auth/magic-link',
      payload: { email: 'someone-else@example.test' },
    },
  );
  await call(
    ML,
    'stale-cookie-ignored',
    'owner address with an unknown cookie (auth paths are exempt)',
    {
      method: 'POST',
      url: '/v1/auth/magic-link',
      headers: { cookie: UNKNOWN_COOKIE },
      payload: { email: 'x@example.test' },
    },
  );
  await call(ML, 'missing-email', 'empty object', {
    method: 'POST',
    url: '/v1/auth/magic-link',
    payload: {},
  });
  await call(ML, 'empty-email', 'email ""', {
    method: 'POST',
    url: '/v1/auth/magic-link',
    payload: { email: '' },
  });
  await call(ML, 'email-not-string', 'email 5', {
    method: 'POST',
    url: '/v1/auth/magic-link',
    payload: { email: 5 },
  });
  await call(ML, 'email-too-long', 'email of 321 chars', {
    method: 'POST',
    url: '/v1/auth/magic-link',
    payload: { email: `${'a'.repeat(315)}@b.cd` },
  });
  await call(ML, 'extra-field', 'valid email plus an extra key', {
    method: 'POST',
    url: '/v1/auth/magic-link',
    payload: { email: 'x@example.test', extra: 1 },
  });
  await call(ML, 'no-body', 'no body, no content type', {
    method: 'POST',
    url: '/v1/auth/magic-link',
  });
  await bodyCases(ML, '/v1/auth/magic-link', 'POST', {});

  const CF = 'GET /v1/auth/confirm';
  await call(CF, 'valid', 'GET /v1/auth/confirm?token=<live token>', {
    url: `/v1/auth/confirm?token=${encodeURIComponent(t1)}`,
  });
  await call(CF, 'unknown-token', 'unknown token', {
    url: '/v1/auth/confirm?token=nothing-issued-this',
  });
  await call(CF, 'missing-token', 'no query', { url: '/v1/auth/confirm' });
  await call(CF, 'empty-token', 'token=', { url: '/v1/auth/confirm?token=' });
  await call(CF, 'token-too-long', 'token of 513 chars', {
    url: `/v1/auth/confirm?token=${'a'.repeat(513)}`,
  });
  await call(CF, 'extra-param', 'valid token plus another parameter', {
    url: `/v1/auth/confirm?token=${encodeURIComponent(t1)}&x=1`,
  });
  await call(CF, 'repeated-param', 'token given twice', {
    url: `/v1/auth/confirm?token=${encodeURIComponent(t1)}&token=${encodeURIComponent(t1)}`,
  });

  const SS = 'POST /v1/auth/session';
  const sessionRes = await call(
    SS,
    'valid',
    'POST /v1/auth/session with a live token',
    {
      method: 'POST',
      url: '/v1/auth/session',
      payload: { token: t1 },
    },
  );
  const ownerBearer: string = json(sessionRes).sessionToken;
  normalizer.registerToken(ownerBearer);
  await call(SS, 'replay-consumed', 'the same token again', {
    method: 'POST',
    url: '/v1/auth/session',
    payload: { token: t1 },
  });
  await call(CF, 'consumed-token', 'confirm a consumed token', {
    url: `/v1/auth/confirm?token=${encodeURIComponent(t1)}`,
  });
  await call(SS, 'unknown-token', 'unknown token', {
    method: 'POST',
    url: '/v1/auth/session',
    payload: { token: 'nothing' },
  });
  await call(SS, 'empty-token', 'token ""', {
    method: 'POST',
    url: '/v1/auth/session',
    payload: { token: '' },
  });
  await call(SS, 'token-not-string', 'token 7', {
    method: 'POST',
    url: '/v1/auth/session',
    payload: { token: 7 },
  });
  await call(SS, 'empty-object', '{}', {
    method: 'POST',
    url: '/v1/auth/session',
    payload: {},
  });
  await call(SS, 'no-body', 'no body', {
    method: 'POST',
    url: '/v1/auth/session',
  });
  await bodyCases(SS, '/v1/auth/session', 'POST', {});

  const WS = 'POST /v1/auth/web-session';
  const webRes = await call(
    WS,
    'valid',
    'POST /v1/auth/web-session with a live token',
    {
      method: 'POST',
      url: '/v1/auth/web-session',
      payload: { token: t1b },
    },
  );
  const web = sessionCookieOf(webRes);
  const webCsrf: string = json(webRes).csrfToken;
  normalizer.registerToken(webCsrf);
  await call(WS, 'replay-consumed', 'the same token again', {
    method: 'POST',
    url: '/v1/auth/web-session',
    payload: { token: t1b },
  });
  await call(WS, 'unknown-token', 'unknown token', {
    method: 'POST',
    url: '/v1/auth/web-session',
    payload: { token: 'nothing' },
  });
  await call(WS, 'token-not-string', 'token {}', {
    method: 'POST',
    url: '/v1/auth/web-session',
    payload: { token: {} },
  });
  await call(WS, 'no-body', 'no body', {
    method: 'POST',
    url: '/v1/auth/web-session',
  });
  await bodyCases(WS, '/v1/auth/web-session', 'POST', {});

  // ---- the session routes: bearer variants, cookie reads, page-token checks ------------------
  const SESSION = 'GET /v1/session';
  await credentialCases(SESSION, { method: 'GET', url: '/v1/session' });
  for (const [name, value] of [
    ['basic-scheme', 'Basic abc'],
    ['no-token', 'Bearer'],
    ['lower-case-scheme', 'bearer abc'],
    ['two-parts', 'Bearer a b'],
    ['empty', ''],
  ] as const)
    await call(
      SESSION,
      `authorization-${name}`,
      `Authorization: ${value || '(empty)'}`,
      {
        url: '/v1/session',
        headers: { authorization: value },
      },
    );
  await call(
    SESSION,
    'valid-owner-bearer',
    'GET /v1/session with the owner bearer session',
    {
      url: '/v1/session',
      headers: bearer(ownerBearer),
    },
  );
  await call(
    SESSION,
    'valid-development-token',
    'GET /v1/session with the development token',
    {
      url: '/v1/session',
      headers: bearer(DEV_TOKEN),
    },
  );
  await call(SESSION, 'valid-cookie', 'GET /v1/session with the web cookie', {
    url: '/v1/session',
    headers: { cookie: web.cookie },
  });
  await call(
    SESSION,
    'valid-cookie-among-others',
    'cookie header carrying the session among other cookies',
    {
      url: '/v1/session',
      headers: { cookie: `a=1; ${web.cookie}; b=2` },
    },
  );
  for (const cookie of [
    'ks_session=%E0%A4%A',
    'ks_session=%',
    'other=1; ks_session=abc%zz',
  ])
    await call(
      SESSION,
      `malformed-cookie-${cookie.length}`,
      `Cookie: ${cookie}`,
      {
        url: '/v1/session',
        headers: { cookie },
      },
    );
  await call(SESSION, 'cookie-and-bearer', 'valid cookie and valid bearer', {
    url: '/v1/session',
    headers: { cookie: web.cookie, ...bearer(ownerBearer) },
  });

  const CSRF = 'GET /v1/session/csrf';
  await credentialCases(CSRF, { method: 'GET', url: '/v1/session/csrf' });
  await call(CSRF, 'valid-cookie', 'cookie session reads its page token', {
    url: '/v1/session/csrf',
    headers: { cookie: web.cookie },
  });
  await call(
    CSRF,
    'bearer-has-no-token',
    'a bearer session has no page token',
    {
      url: '/v1/session/csrf',
      headers: bearer(ownerBearer),
    },
  );

  // ---- a fresh reader: reads, feed, exposures, interactions, events, traces ------------------
  const F = await reader();
  const UNIVERSE = 'GET /v1/universe';
  await credentialCases(UNIVERSE, { method: 'GET', url: '/v1/universe' });
  await call(UNIVERSE, 'valid-fresh', 'fresh reader', {
    url: '/v1/universe',
    headers: F.headers,
  });
  const WORLDS = 'GET /v1/worlds';
  await credentialCases(WORLDS, { method: 'GET', url: '/v1/worlds' });
  await call(WORLDS, 'valid-fresh', 'fresh reader', {
    url: '/v1/worlds',
    headers: F.headers,
  });
  const INVENTORY = 'GET /v1/inventory';
  await credentialCases(INVENTORY, { method: 'GET', url: '/v1/inventory' });
  await call(INVENTORY, 'valid-fresh', 'fresh reader', {
    url: '/v1/inventory',
    headers: F.headers,
  });
  const INQUIRIES = 'GET /v1/inquiries';
  await credentialCases(INQUIRIES, { method: 'GET', url: '/v1/inquiries' });
  await call(INQUIRIES, 'valid-fresh', 'fresh reader', {
    url: '/v1/inquiries',
    headers: F.headers,
  });

  const FEED = 'GET /v1/feed';
  const WHY = 'GET /v1/decisions/:decisionId/why';
  const EXPOSURES = 'POST /v1/exposures';
  await credentialCases(FEED, { method: 'GET', url: '/v1/feed' });
  const feed1Res = await call(FEED, 'valid-default', 'default kinds', {
    url: '/v1/feed',
    headers: F.headers,
  });
  const feed1 = json(feed1Res);
  await call(FEED, 'kinds-scroll', 'kinds=Scroll', {
    url: '/v1/feed?kinds=Scroll',
    headers: F.headers,
  });
  await call(
    FEED,
    'kinds-reel-none-minted',
    'kinds=Reel before any Reel exists',
    { url: '/v1/feed?kinds=Reel', headers: F.headers },
  );
  await call(FEED, 'kinds-both', 'kinds=Scroll,Reel', {
    url: '/v1/feed?kinds=Scroll,Reel',
    headers: F.headers,
  });
  await call(FEED, 'kinds-invalid', 'kinds=Podcast', {
    url: '/v1/feed?kinds=Podcast',
    headers: F.headers,
  });
  await call(FEED, 'kinds-empty', 'kinds=', {
    url: '/v1/feed?kinds=',
    headers: F.headers,
  });
  await call(FEED, 'kinds-repeated', 'kinds twice', {
    url: '/v1/feed?kinds=Scroll&kinds=Reel',
    headers: F.headers,
  });
  await call(FEED, 'web-artifact-v1', 'webArtifact=v1', {
    url: '/v1/feed?kinds=Scroll&webArtifact=v1',
    headers: F.headers,
  });
  await call(FEED, 'web-artifact-invalid', 'webArtifact=v2', {
    url: '/v1/feed?webArtifact=v2',
    headers: F.headers,
  });
  await call(FEED, 'preview-invalid', 'preview=other', {
    url: '/v1/feed?preview=other',
    headers: F.headers,
  });
  await call(
    FEED,
    'preview-unavailable',
    'preview=authored-web-scrolls outside development',
    {
      url: '/v1/feed?preview=authored-web-scrolls',
      headers: F.headers,
    },
  );
  const savedEnv = {
    NODE_ENV: process.env.NODE_ENV,
    KS_RICH_SCROLL_PREVIEW: process.env.KS_RICH_SCROLL_PREVIEW,
  };
  process.env.NODE_ENV = 'development';
  process.env.KS_RICH_SCROLL_PREVIEW = '1';
  try {
    await call(
      FEED,
      'preview-available',
      'preview=authored-web-scrolls with the development switches on',
      {
        url: '/v1/feed?preview=authored-web-scrolls',
        headers: F.headers,
      },
    );
  } finally {
    if (savedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv.NODE_ENV;
    if (savedEnv.KS_RICH_SCROLL_PREVIEW === undefined)
      delete process.env.KS_RICH_SCROLL_PREVIEW;
    else process.env.KS_RICH_SCROLL_PREVIEW = savedEnv.KS_RICH_SCROLL_PREVIEW;
  }
  const firstIds: string[] = feed1.items.map((i: Json) => i.assetId);
  await call(FEED, 'exclude-valid', 'exclude=<ids from the first feed>', {
    url: `/v1/feed?kinds=Scroll&exclude=${firstIds.join(',')}`,
    headers: F.headers,
  });
  await call(FEED, 'exclude-upper-case', 'exclude with upper-cased ids', {
    url: `/v1/feed?kinds=Scroll&exclude=${firstIds.map((i) => i.toUpperCase()).join(',')}`,
    headers: F.headers,
  });
  await call(FEED, 'exclude-empty', 'exclude=', {
    url: '/v1/feed?kinds=Scroll&exclude=',
    headers: F.headers,
  });
  await call(FEED, 'exclude-malformed', 'exclude=not-a-uuid', {
    url: '/v1/feed?exclude=not-a-uuid',
    headers: F.headers,
  });
  await call(FEED, 'exclude-repeated', 'exclude given twice', {
    url: `/v1/feed?exclude=${ID_A}&exclude=${ID_B}`,
    headers: F.headers,
  });
  await call(FEED, 'exclude-257', 'exclude with 257 ids', {
    url: `/v1/feed?exclude=${Array.from({ length: 257 }, () => ID_A).join(',')}`,
    headers: F.headers,
  });
  await call(FEED, 'exclude-256', 'exclude with 256 ids', {
    url: `/v1/feed?exclude=${Array.from({ length: 256 }, () => ID_A).join(',')}`,
    headers: F.headers,
  });
  await call(FEED, 'unknown-query-ignored', 'unknown parameter', {
    url: '/v1/feed?other=1',
    headers: F.headers,
  });
  const feed2 = await feedOf(F);

  // The other ranking policies, on their own fresh readers.
  const V2 = await reader();
  await appV2.ready();
  const v2Feed = await call(
    FEED,
    'policy-v2-default',
    'composer-signals-v2 app, default kinds',
    { url: '/v1/feed', headers: V2.headers },
    appV2,
  );
  await call(
    FEED,
    'policy-v2-with-exclude',
    'composer-signals-v2 app, exclude ignored by v2',
    {
      url: `/v1/feed?kinds=Scroll&exclude=${json(v2Feed).items[0].assetId}`,
      headers: V2.headers,
    },
    appV2,
  );
  await call(
    EXPOSURES,
    'policy-v2-valid',
    'expose an asset of a v2 decision',
    {
      method: 'POST',
      url: '/v1/exposures',
      headers: V2.headers,
      payload: {
        decisionId: json(v2Feed).decisionId,
        assetId: json(v2Feed).items[0].assetId,
        clientExposureId: randomUUID(),
      },
    },
    appV2,
  );
  const V4 = await reader();
  await appV4.ready();
  const v4Feed = await call(
    FEED,
    'policy-v4-default',
    'composer-semantic-v4 app, default kinds',
    { url: '/v1/feed', headers: V4.headers },
    appV4,
  );
  await call(
    FEED,
    'policy-v4-with-exclude',
    'composer-semantic-v4 app, exclude the first slate',
    {
      url: `/v1/feed?kinds=Scroll&exclude=${json(v4Feed)
        .items.map((i: Json) => i.assetId)
        .join(',')}`,
      headers: V4.headers,
    },
    appV4,
  );
  await call(
    WHY,
    'policy-v4-valid',
    'why for a v4 decision',
    {
      url: `/v1/decisions/${json(v4Feed).decisionId}/why?assetId=${json(v4Feed).items[0].assetId}`,
      headers: V4.headers,
    },
    appV4,
  );

  // exposures
  const exposureBody = {
    decisionId: feed2.decisionId,
    assetId: feed2.items[0].assetId,
    clientExposureId: randomUUID(),
  };
  await credentialCases(EXPOSURES, {
    method: 'POST',
    url: '/v1/exposures',
    payload: exposureBody,
  });
  const exposed = await call(
    EXPOSURES,
    'valid',
    'a served asset of a served decision',
    {
      method: 'POST',
      url: '/v1/exposures',
      headers: F.headers,
      payload: exposureBody,
    },
  );
  await call(EXPOSURES, 'replay', 'exact replay of the valid call', {
    method: 'POST',
    url: '/v1/exposures',
    headers: F.headers,
    payload: exposureBody,
  });
  const feed3 = await feedOf(F);
  await call(
    EXPOSURES,
    'key-reused-other-decision',
    'same client key, another decision',
    {
      method: 'POST',
      url: '/v1/exposures',
      headers: F.headers,
      payload: {
        ...exposureBody,
        decisionId: feed3.decisionId,
        assetId: feed3.items[0].assetId,
      },
    },
  );
  await call(
    EXPOSURES,
    'asset-not-in-decision',
    'asset the decision did not serve',
    {
      method: 'POST',
      url: '/v1/exposures',
      headers: F.headers,
      payload: {
        ...exposureBody,
        clientExposureId: randomUUID(),
        assetId: ID_A,
      },
    },
  );
  await call(EXPOSURES, 'unknown-decision', 'decision that does not exist', {
    method: 'POST',
    url: '/v1/exposures',
    headers: F.headers,
    payload: {
      ...exposureBody,
      clientExposureId: randomUUID(),
      decisionId: ID_A,
    },
  });
  await call(EXPOSURES, 'missing-field', 'no clientExposureId', {
    method: 'POST',
    url: '/v1/exposures',
    headers: F.headers,
    payload: {
      decisionId: exposureBody.decisionId,
      assetId: exposureBody.assetId,
    },
  });
  await call(EXPOSURES, 'non-uuid', 'decisionId "nope"', {
    method: 'POST',
    url: '/v1/exposures',
    headers: F.headers,
    payload: { ...exposureBody, decisionId: 'nope' },
  });
  await call(EXPOSURES, 'wrong-type', 'assetId 5', {
    method: 'POST',
    url: '/v1/exposures',
    headers: F.headers,
    payload: { ...exposureBody, assetId: 5 },
  });
  await call(EXPOSURES, 'extra-field', 'an extra key', {
    method: 'POST',
    url: '/v1/exposures',
    headers: F.headers,
    payload: { ...exposureBody, extra: true },
  });
  await bodyCases(EXPOSURES, '/v1/exposures', 'POST', F.headers);
  await call(
    EXPOSURES,
    'body-over-16kb',
    'a 17000-byte JSON body (default body limit 16384)',
    {
      method: 'POST',
      url: '/v1/exposures',
      headers: F.headers,
      payload: { ...exposureBody, padding: 'x'.repeat(17000) },
    },
  );

  // interactions
  const INTERACTIONS = 'POST /v1/interactions';
  const exposureId = json(exposed).exposureId;
  const keepBody = {
    clientEventId: randomUUID(),
    exposureId,
    assetId: exposureBody.assetId,
    kind: 'keep',
  };
  await credentialCases(INTERACTIONS, {
    method: 'POST',
    url: '/v1/interactions',
    payload: keepBody,
  });
  const keepRes = await call(INTERACTIONS, 'valid', 'keep the exposed asset', {
    method: 'POST',
    url: '/v1/interactions',
    headers: F.headers,
    payload: keepBody,
  });
  const keep = json(keepRes);
  await call(INTERACTIONS, 'replay', 'exact replay of the keep', {
    method: 'POST',
    url: '/v1/interactions',
    headers: F.headers,
    payload: keepBody,
  });
  const exposure2 = json(
    await app.inject({
      method: 'POST',
      url: '/v1/exposures',
      headers: F.headers,
      payload: {
        decisionId: feed3.decisionId,
        assetId: feed3.items[0].assetId,
        clientExposureId: randomUUID(),
      },
    }),
  );
  await call(
    INTERACTIONS,
    'key-reused-other-exposure',
    'same event key against another exposure',
    {
      method: 'POST',
      url: '/v1/interactions',
      headers: F.headers,
      payload: {
        ...keepBody,
        exposureId: exposure2.exposureId,
        assetId: feed3.items[0].assetId,
      },
    },
  );
  await call(
    INTERACTIONS,
    'no-matching-exposure',
    'exposure id that does not exist',
    {
      method: 'POST',
      url: '/v1/interactions',
      headers: F.headers,
      payload: { ...keepBody, clientEventId: randomUUID(), exposureId: ID_A },
    },
  );
  await call(INTERACTIONS, 'asset-mismatch', 'an exposure of another asset', {
    method: 'POST',
    url: '/v1/interactions',
    headers: F.headers,
    payload: { ...keepBody, clientEventId: randomUUID(), assetId: ID_A },
  });
  await call(INTERACTIONS, 'unknown-kind', 'kind "like"', {
    method: 'POST',
    url: '/v1/interactions',
    headers: F.headers,
    payload: { ...keepBody, kind: 'like' },
  });
  await call(INTERACTIONS, 'missing-field', 'no kind', {
    method: 'POST',
    url: '/v1/interactions',
    headers: F.headers,
    payload: {
      clientEventId: keepBody.clientEventId,
      exposureId,
      assetId: keepBody.assetId,
    },
  });
  await call(INTERACTIONS, 'non-uuid', 'exposureId "x"', {
    method: 'POST',
    url: '/v1/interactions',
    headers: F.headers,
    payload: { ...keepBody, exposureId: 'x' },
  });
  await bodyCases(INTERACTIONS, '/v1/interactions', 'POST', F.headers);

  // events
  const EVENTS = 'GET /v1/events/:eventId';
  await credentialCases(EVENTS, {
    method: 'GET',
    url: `/v1/events/${keep.eventId}`,
  });
  await call(EVENTS, 'valid-keep-pending', 'the keep event before projection', {
    url: `/v1/events/${keep.eventId}`,
    headers: F.headers,
  });
  await projectKeep(keep.jobId);
  await call(
    EVENTS,
    'valid-keep-projected',
    'the keep event after projection',
    {
      url: `/v1/events/${keep.eventId}`,
      headers: F.headers,
    },
  );
  await call(EVENTS, 'valid-exposure-event', 'the exposure event (no job)', {
    url: `/v1/events/${json(exposed).eventId}`,
    headers: F.headers,
  });
  await call(EVENTS, 'unknown-event', 'an id that is not an event', {
    url: `/v1/events/${ID_A}`,
    headers: F.headers,
  });
  await call(EVENTS, 'non-uuid', '/v1/events/not-a-uuid', {
    url: '/v1/events/not-a-uuid',
    headers: F.headers,
  });
  const stranger = await reader();
  await call(EVENTS, 'other-universe', 'an event of another universe', {
    url: `/v1/events/${keep.eventId}`,
    headers: stranger.headers,
  });

  // universe again (with a kept trace) and traces on the reader's own history
  await call(UNIVERSE, 'valid-with-trace', 'reader with one projected keep', {
    url: '/v1/universe',
    headers: F.headers,
  });
  const TRACES = 'GET /v1/traces/:eventId';
  await credentialCases(TRACES, {
    method: 'GET',
    url: `/v1/traces/${keep.eventId}`,
  });
  await call(TRACES, 'valid', 'revisit the projected keep', {
    url: `/v1/traces/${keep.eventId}`,
    headers: F.headers,
  });
  await call(TRACES, 'valid-web-reader', 'webReader=v1', {
    url: `/v1/traces/${keep.eventId}?webReader=v1`,
    headers: F.headers,
  });
  await call(TRACES, 'valid-upper-case-id', 'event id upper-cased', {
    url: `/v1/traces/${String(keep.eventId).toUpperCase()}`,
    headers: F.headers,
  });
  await call(TRACES, 'web-reader-invalid', 'webReader=v2', {
    url: `/v1/traces/${keep.eventId}?webReader=v2`,
    headers: F.headers,
  });
  await call(TRACES, 'extra-query', 'an unknown parameter', {
    url: `/v1/traces/${keep.eventId}?assetId=${ID_A}`,
    headers: F.headers,
  });
  await call(
    TRACES,
    'web-reader-and-extra',
    'webReader=v1 plus another parameter',
    {
      url: `/v1/traces/${keep.eventId}?webReader=v1&x=1`,
      headers: F.headers,
    },
  );
  await call(TRACES, 'with-body', 'a GET carrying a JSON body', {
    method: 'GET',
    url: `/v1/traces/${keep.eventId}`,
    headers: { ...F.headers, 'content-type': 'application/json' },
    payload: { a: 1 },
  });
  await call(TRACES, 'non-uuid', '/v1/traces/not-a-uuid', {
    url: '/v1/traces/not-a-uuid',
    headers: F.headers,
  });
  await call(TRACES, 'unknown-event', 'an id that is not a Trace', {
    url: `/v1/traces/${ID_A}`,
    headers: F.headers,
  });
  await call(TRACES, 'exposure-event-not-a-trace', 'an exposure event id', {
    url: `/v1/traces/${json(exposed).eventId}`,
    headers: F.headers,
  });
  await call(TRACES, 'other-universe', 'a Trace of another universe', {
    url: `/v1/traces/${keep.eventId}`,
    headers: stranger.headers,
  });
  // Seeded graphs reach the TraceRevisitError kinds the live flow cannot.
  const sourceDrift = await seedTraceRevisitGraph(pool);
  normalizer.registerToken(sourceDrift.token);
  await pool.query(
    "UPDATE asset SET title='Changed live title', body='Changed live body' WHERE id=$1",
    [sourceDrift.assetId],
  );
  await call(TRACES, 'source-changed', 'the Scroll changed after the keep', {
    url: `/v1/traces/${sourceDrift.keepEventId}`,
    headers: bearer(sourceDrift.token),
  });
  await call(
    UNIVERSE,
    'valid-trace-with-source-drift',
    'the Universe list keeps the historical title',
    {
      url: '/v1/universe',
      headers: bearer(sourceDrift.token),
    },
  );
  const lineage = await seedTraceRevisitGraph(pool);
  normalizer.registerToken(lineage.token);
  await pool.query('UPDATE ledger SET causation_id=NULL WHERE id=$1', [
    lineage.keepEventId,
  ]);
  await call(TRACES, 'lineage-unavailable', 'the keep lost its exposure link', {
    url: `/v1/traces/${lineage.keepEventId}`,
    headers: bearer(lineage.token),
  });
  await call(
    UNIVERSE,
    'valid-trace-lineage-broken',
    'the Universe list names it unavailable',
    {
      url: '/v1/universe',
      headers: bearer(lineage.token),
    },
  );
  const staleTrace = await seedTraceRevisitGraph(pool);
  normalizer.registerToken(staleTrace.token);
  await pool.query('UPDATE universe SET privacy_epoch=1 WHERE id=$1', [
    staleTrace.scope.universeId,
  ]);
  await pool.query('UPDATE device_session SET privacy_epoch=1 WHERE id=$1', [
    staleTrace.scope.sessionId,
  ]);
  await call(
    TRACES,
    'stale-epoch',
    'the keep belongs to an older privacy epoch',
    {
      url: `/v1/traces/${staleTrace.keepEventId}`,
      headers: bearer(staleTrace.token),
    },
  );
  const pendingTrace = await seedTraceRevisitGraph(pool, { projected: false });
  normalizer.registerToken(pendingTrace.token);
  await call(TRACES, 'keep-not-projected', 'accepted keep without a Trace', {
    url: `/v1/traces/${pendingTrace.keepEventId}`,
    headers: bearer(pendingTrace.token),
  });

  // ---- asks ----------------------------------------------------------------------------------
  const ASKS = 'POST /v1/asks';
  const askBody = {
    clientAskId: randomUUID(),
    exposureId,
    expectedPrivacyEpoch: 0,
    question: 'What changed in this Scroll?',
  };
  await credentialCases(ASKS, {
    method: 'POST',
    url: '/v1/asks',
    payload: askBody,
  });
  const askRes = await call(ASKS, 'valid', 'an Ask about an exposed Scroll', {
    method: 'POST',
    url: '/v1/asks',
    headers: F.headers,
    payload: askBody,
  });
  const askId: string = json(askRes).askId;
  await call(ASKS, 'replay', 'exact replay', {
    method: 'POST',
    url: '/v1/asks',
    headers: F.headers,
    payload: askBody,
  });
  await call(
    ASKS,
    'conflict-same-key-other-question',
    'same clientAskId, another question',
    {
      method: 'POST',
      url: '/v1/asks',
      headers: F.headers,
      payload: { ...askBody, question: 'A different question?' },
    },
  );
  await call(ASKS, 'stale-epoch', 'expectedPrivacyEpoch 1 on epoch 0', {
    method: 'POST',
    url: '/v1/asks',
    headers: F.headers,
    payload: { ...askBody, clientAskId: randomUUID(), expectedPrivacyEpoch: 1 },
  });
  await call(
    ASKS,
    'no-current-exposure',
    'an exposure id that does not exist',
    {
      method: 'POST',
      url: '/v1/asks',
      headers: F.headers,
      payload: { ...askBody, clientAskId: randomUUID(), exposureId: ID_A },
    },
  );
  await call(ASKS, 'other-universe-exposure', "another reader's exposure", {
    method: 'POST',
    url: '/v1/asks',
    headers: stranger.headers,
    payload: { ...askBody, clientAskId: randomUUID() },
  });
  await call(ASKS, 'blank-question', 'question "   "', {
    method: 'POST',
    url: '/v1/asks',
    headers: F.headers,
    payload: { ...askBody, clientAskId: randomUUID(), question: '   ' },
  });
  await call(ASKS, 'question-4096-bytes', 'question of exactly 4096 bytes', {
    method: 'POST',
    url: '/v1/asks',
    headers: F.headers,
    payload: {
      ...askBody,
      clientAskId: randomUUID(),
      question: 'q'.repeat(4096),
    },
  });
  await call(ASKS, 'question-4097-bytes', 'question of 4097 bytes', {
    method: 'POST',
    url: '/v1/asks',
    headers: F.headers,
    payload: {
      ...askBody,
      clientAskId: randomUUID(),
      question: 'q'.repeat(4097),
    },
  });
  await call(ASKS, 'question-nul', 'question containing NUL', {
    method: 'POST',
    url: '/v1/asks',
    headers: F.headers,
    payload: { ...askBody, clientAskId: randomUUID(), question: 'a\u0000b' },
  });
  await call(ASKS, 'missing-field', 'no question', {
    method: 'POST',
    url: '/v1/asks',
    headers: F.headers,
    payload: { clientAskId: randomUUID(), exposureId, expectedPrivacyEpoch: 0 },
  });
  await call(ASKS, 'wrong-type', 'expectedPrivacyEpoch "0"', {
    method: 'POST',
    url: '/v1/asks',
    headers: F.headers,
    payload: {
      ...askBody,
      clientAskId: randomUUID(),
      expectedPrivacyEpoch: '0',
    },
  });
  await call(ASKS, 'extra-field', 'an extra key', {
    method: 'POST',
    url: '/v1/asks',
    headers: F.headers,
    payload: { ...askBody, clientAskId: randomUUID(), extra: 1 },
  });
  await bodyCases(ASKS, '/v1/asks', 'POST', F.headers);
  await call(
    ASKS,
    'body-20000-bytes-allowed',
    'a 20000-byte body (route limit 32768 beats the default 16384)',
    {
      method: 'POST',
      url: '/v1/asks',
      headers: F.headers,
      payload: {
        ...askBody,
        clientAskId: randomUUID(),
        padding: 'x'.repeat(20000),
      },
    },
  );
  await call(ASKS, 'body-over-32kb', 'a 33000-byte body', {
    method: 'POST',
    url: '/v1/asks',
    headers: F.headers,
    payload: {
      ...askBody,
      clientAskId: randomUUID(),
      padding: 'x'.repeat(33000),
    },
  });
  await call(
    ASKS,
    'body-over-32kb-no-credential',
    'a 33000-byte body with no credential (limit applies first)',
    {
      method: 'POST',
      url: '/v1/asks',
      payload: { ...askBody, padding: 'x'.repeat(33000) },
    },
  );

  // ---- ask answers ---------------------------------------------------------------------------
  const ANSWER_POST = 'POST /v1/asks/:askId/answer';
  const ANSWER_GET = 'GET /v1/asks/:askId/answer';
  const CANCEL = 'POST /v1/asks/:askId/answer/cancel';
  const answerBody = { clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 };
  await credentialCases(ANSWER_POST, {
    method: 'POST',
    url: `/v1/asks/${askId}/answer`,
    payload: answerBody,
  });
  await credentialCases(ANSWER_GET, {
    method: 'GET',
    url: `/v1/asks/${askId}/answer`,
  });
  await credentialCases(CANCEL, {
    method: 'POST',
    url: `/v1/asks/${askId}/answer/cancel`,
    payload: { expectedPrivacyEpoch: 0 },
  });
  await call(
    ANSWER_GET,
    'not-requested',
    'no answer was requested for this Ask',
    { url: `/v1/asks/${askId}/answer`, headers: F.headers },
  );
  await call(ANSWER_GET, 'non-uuid', '/v1/asks/not-a-uuid/answer', {
    url: '/v1/asks/not-a-uuid/answer',
    headers: F.headers,
  });
  await call(
    ANSWER_POST,
    'not-enabled',
    'no answer route is installed in this deployment',
    {
      method: 'POST',
      url: `/v1/asks/${askId}/answer`,
      headers: F.headers,
      payload: answerBody,
    },
  );
  await call(
    CANCEL,
    'nothing-to-cancel',
    'cancel before any answer was requested',
    {
      method: 'POST',
      url: `/v1/asks/${askId}/answer/cancel`,
      headers: F.headers,
      payload: { expectedPrivacyEpoch: 0 },
    },
  );
  const POLICY = 'probe-answers-v1';
  await createReasoningFairness(pool, answerAuthority()).installPolicy(
    answerFairnessPolicy(POLICY, {
      maxInputTokens: 16384,
      maxOutputTokens: 1024,
    }),
  );
  await transaction((client) =>
    installAskAnswerRoute(client, {
      policyVersion: POLICY,
      routeId: 'fixture-route',
      routeProfileVersion: 'fixture-v1',
      transport: 'fixture',
      model: 'fixture-model',
      maxInputTokens: 16384,
      maxOutputTokens: 1024,
      requestCap: 40,
      tokenBudget: 10_000_000,
      ownerCapacity: 1_000_000,
      jobCapacity: 100_000,
      answerTtlSeconds: 600,
      remoteSlots: 16,
    }),
  );
  await call(
    ANSWER_POST,
    'valid',
    'request an answer once a fixture route is installed',
    {
      method: 'POST',
      url: `/v1/asks/${askId}/answer`,
      headers: F.headers,
      payload: answerBody,
    },
  );
  await call(ANSWER_POST, 'replay', 'exact replay', {
    method: 'POST',
    url: `/v1/asks/${askId}/answer`,
    headers: F.headers,
    payload: answerBody,
  });
  await call(
    ANSWER_POST,
    'conflict-other-request',
    'another request id for the same Ask',
    {
      method: 'POST',
      url: `/v1/asks/${askId}/answer`,
      headers: F.headers,
      payload: { ...answerBody, clientRequestId: randomUUID() },
    },
  );
  await call(ANSWER_POST, 'stale-epoch', 'expectedPrivacyEpoch 1', {
    method: 'POST',
    url: `/v1/asks/${askId}/answer`,
    headers: F.headers,
    payload: { ...answerBody, expectedPrivacyEpoch: 1 },
  });
  await call(ANSWER_POST, 'unknown-ask', 'an Ask that does not exist', {
    method: 'POST',
    url: `/v1/asks/${ID_A}/answer`,
    headers: F.headers,
    payload: { clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 },
  });
  await call(ANSWER_POST, 'non-uuid-ask', '/v1/asks/not-a-uuid/answer', {
    method: 'POST',
    url: '/v1/asks/not-a-uuid/answer',
    headers: F.headers,
    payload: answerBody,
  });
  await call(ANSWER_POST, 'missing-field', 'no clientRequestId', {
    method: 'POST',
    url: `/v1/asks/${askId}/answer`,
    headers: F.headers,
    payload: { expectedPrivacyEpoch: 0 },
  });
  await call(ANSWER_POST, 'extra-field', 'an extra key', {
    method: 'POST',
    url: `/v1/asks/${askId}/answer`,
    headers: F.headers,
    payload: { ...answerBody, extra: 1 },
  });
  await bodyCases(ANSWER_POST, `/v1/asks/${askId}/answer`, 'POST', F.headers);
  await call(ANSWER_GET, 'queued', 'the requested answer, waiting', {
    url: `/v1/asks/${askId}/answer`,
    headers: F.headers,
  });
  await call(ANSWER_GET, 'other-universe', "another reader's Ask", {
    url: `/v1/asks/${askId}/answer`,
    headers: stranger.headers,
  });
  await call(CANCEL, 'valid', 'withdraw the waiting answer', {
    method: 'POST',
    url: `/v1/asks/${askId}/answer/cancel`,
    headers: F.headers,
    payload: { expectedPrivacyEpoch: 0 },
  });
  await call(CANCEL, 'already-cancelled', 'cancel again', {
    method: 'POST',
    url: `/v1/asks/${askId}/answer/cancel`,
    headers: F.headers,
    payload: { expectedPrivacyEpoch: 0 },
  });
  await call(CANCEL, 'stale-epoch', 'expectedPrivacyEpoch 1', {
    method: 'POST',
    url: `/v1/asks/${askId}/answer/cancel`,
    headers: F.headers,
    payload: { expectedPrivacyEpoch: 1 },
  });
  await call(CANCEL, 'malformed', 'wrong field type', {
    method: 'POST',
    url: `/v1/asks/${askId}/answer/cancel`,
    headers: F.headers,
    payload: { expectedPrivacyEpoch: 'x' },
  });
  await call(CANCEL, 'non-uuid-ask', '/v1/asks/not-a-uuid/answer/cancel', {
    method: 'POST',
    url: '/v1/asks/not-a-uuid/answer/cancel',
    headers: F.headers,
    payload: { expectedPrivacyEpoch: 0 },
  });
  await bodyCases(CANCEL, `/v1/asks/${askId}/answer/cancel`, 'POST', F.headers);
  await call(ANSWER_GET, 'cancelled', 'the cancelled answer', {
    url: `/v1/asks/${askId}/answer`,
    headers: F.headers,
  });

  // The worker's fixture transport settles answers locally (no provider is ever called).
  type FixtureMode = Parameters<typeof createFixtureAnswerTransport>[0] extends
    | (() => infer M)
    | undefined
    ? M
    : never;
  let fixtureMode: FixtureMode = 'answer';
  const fixtureTransport = createFixtureAnswerTransport(() => fixtureMode, {
    count: 0,
  });
  const settle = async (mode: FixtureMode): Promise<string> => {
    fixtureMode = mode;
    const another = json(
      await app.inject({
        method: 'POST',
        url: '/v1/asks',
        headers: F.headers,
        payload: {
          clientAskId: randomUUID(),
          exposureId,
          expectedPrivacyEpoch: 0,
          question: `Settled as ${mode}?`,
        },
      }),
    ).askId as string;
    const requested = await app.inject({
      method: 'POST',
      url: `/v1/asks/${another}/answer`,
      headers: F.headers,
      payload: { clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 },
    });
    assert.equal(requested.statusCode, 202, requested.body);
    const done = await runAnswerPass({
      pool,
      owner: 'probe-answer-worker',
      leaseMs: 60_000,
      transports: { fixture: fixtureTransport },
      signal: new AbortController().signal,
    });
    assert.equal(done.kind, 'done');
    return another;
  };
  const answeredAsk = await settle('answer');
  await call(
    ANSWER_GET,
    'answered',
    'an answer the fixture transport produced',
    { url: `/v1/asks/${answeredAsk}/answer`, headers: F.headers },
  );
  await call(
    CANCEL,
    'already-answered',
    'cancel an answer that has been given',
    {
      method: 'POST',
      url: `/v1/asks/${answeredAsk}/answer/cancel`,
      headers: F.headers,
      payload: { expectedPrivacyEpoch: 0 },
    },
  );
  await call(
    ANSWER_POST,
    'conflict-after-answer',
    'request an answer again once it was given',
    {
      method: 'POST',
      url: `/v1/asks/${answeredAsk}/answer`,
      headers: F.headers,
      payload: { clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 },
    },
  );
  const notInSourceAsk = await settle('not_in_source');
  await call(
    ANSWER_GET,
    'not-in-source',
    'an answer that said the Scroll does not say',
    { url: `/v1/asks/${notInSourceAsk}/answer`, headers: F.headers },
  );
  const rejectedAsk = await settle('invented_quote');
  await call(
    ANSWER_GET,
    'rejected',
    'a reply whose quote is not in the Scroll',
    { url: `/v1/asks/${rejectedAsk}/answer`, headers: F.headers },
  );
  const failedAsk = await settle('http_error');
  await call(ANSWER_GET, 'failed', 'a provider error, never retried', {
    url: `/v1/asks/${failedAsk}/answer`,
    headers: F.headers,
  });
  const FA = answeredAsk;

  // ---- decisions/why and encounter feedback --------------------------------------------------
  const whyUrl = `/v1/decisions/${feed2.decisionId}/why?assetId=${feed2.items[0].assetId}`;
  await credentialCases(WHY, { method: 'GET', url: whyUrl });
  await call(WHY, 'valid', 'why the first served asset appeared', {
    url: whyUrl,
    headers: F.headers,
  });
  await call(WHY, 'missing-asset', 'no assetId', {
    url: `/v1/decisions/${feed2.decisionId}/why`,
    headers: F.headers,
  });
  await call(WHY, 'non-uuid-decision', '/v1/decisions/not-a-uuid/why', {
    url: `/v1/decisions/not-a-uuid/why?assetId=${ID_A}`,
    headers: F.headers,
  });
  await call(WHY, 'non-uuid-asset', 'assetId=x', {
    url: `/v1/decisions/${feed2.decisionId}/why?assetId=x`,
    headers: F.headers,
  });
  await call(WHY, 'unknown-decision', 'a decision that does not exist', {
    url: `/v1/decisions/${ID_A}/why?assetId=${ID_B}`,
    headers: F.headers,
  });
  await call(
    WHY,
    'asset-not-in-decision',
    'an asset the decision did not serve',
    {
      url: `/v1/decisions/${feed2.decisionId}/why?assetId=${ID_B}`,
      headers: F.headers,
    },
  );
  await call(WHY, 'other-universe', "another reader's decision", {
    url: whyUrl,
    headers: stranger.headers,
  });

  const FEEDBACK = 'POST /v1/encounters/feedback';
  const fbBody = {
    clientFeedbackId: randomUUID(),
    decisionId: feed2.decisionId,
    assetId: feed2.items[0].assetId,
    kind: 'less_like_this',
    expectedPrivacyEpoch: 0,
  };
  await credentialCases(FEEDBACK, {
    method: 'POST',
    url: '/v1/encounters/feedback',
    payload: fbBody,
  });
  await call(FEEDBACK, 'valid', 'less_like_this on a served encounter', {
    method: 'POST',
    url: '/v1/encounters/feedback',
    headers: F.headers,
    payload: fbBody,
  });
  await call(FEEDBACK, 'replay', 'exact replay', {
    method: 'POST',
    url: '/v1/encounters/feedback',
    headers: F.headers,
    payload: fbBody,
  });
  await call(
    FEEDBACK,
    'conflict-same-key-other-kind',
    'same key, kind wrong_connection',
    {
      method: 'POST',
      url: '/v1/encounters/feedback',
      headers: F.headers,
      payload: { ...fbBody, kind: 'wrong_connection' },
    },
  );
  await call(FEEDBACK, 'wrong-connection', 'wrong_connection with a new key', {
    method: 'POST',
    url: '/v1/encounters/feedback',
    headers: F.headers,
    payload: {
      ...fbBody,
      clientFeedbackId: randomUUID(),
      kind: 'wrong_connection',
    },
  });
  await call(FEEDBACK, 'stale-epoch', 'expectedPrivacyEpoch 1', {
    method: 'POST',
    url: '/v1/encounters/feedback',
    headers: F.headers,
    payload: {
      ...fbBody,
      clientFeedbackId: randomUUID(),
      expectedPrivacyEpoch: 1,
    },
  });
  await call(FEEDBACK, 'unknown-decision', 'a decision that does not exist', {
    method: 'POST',
    url: '/v1/encounters/feedback',
    headers: F.headers,
    payload: { ...fbBody, clientFeedbackId: randomUUID(), decisionId: ID_A },
  });
  await call(
    FEEDBACK,
    'asset-not-in-decision',
    'an asset the decision did not serve',
    {
      method: 'POST',
      url: '/v1/encounters/feedback',
      headers: F.headers,
      payload: { ...fbBody, clientFeedbackId: randomUUID(), assetId: ID_A },
    },
  );
  await call(FEEDBACK, 'unknown-kind', 'kind "meh"', {
    method: 'POST',
    url: '/v1/encounters/feedback',
    headers: F.headers,
    payload: { ...fbBody, clientFeedbackId: randomUUID(), kind: 'meh' },
  });
  await call(FEEDBACK, 'missing-field', 'no kind', {
    method: 'POST',
    url: '/v1/encounters/feedback',
    headers: F.headers,
    payload: {
      clientFeedbackId: randomUUID(),
      decisionId: fbBody.decisionId,
      assetId: fbBody.assetId,
      expectedPrivacyEpoch: 0,
    },
  });
  await call(FEEDBACK, 'extra-field', 'an extra key', {
    method: 'POST',
    url: '/v1/encounters/feedback',
    headers: F.headers,
    payload: { ...fbBody, clientFeedbackId: randomUUID(), extra: 1 },
  });
  await bodyCases(FEEDBACK, '/v1/encounters/feedback', 'POST', F.headers);

  // ---- continuations: branches, connection feedback, relics ----------------------------------
  // The first editorial Scroll that has an admitted continuation, so the seeded substrate decides.
  const library = JSON.parse(
    await readFile('content/editorial-scrolls.json', 'utf8'),
  ) as Array<{ assetId: string }>;
  const B = await reader();
  let branchSource: string | undefined;
  let branchList: Json;
  let bareScroll: string | undefined;
  for (const { assetId } of library) {
    const res = await app.inject({
      url: `/v1/assets/${assetId}/branches`,
      headers: B.headers,
    });
    if (res.statusCode !== 200) continue;
    if (json(res).branches?.length > 0) {
      if (branchSource === undefined) {
        branchSource = assetId;
        branchList = json(res);
      }
    } else bareScroll ??= assetId;
  }
  assert.ok(branchSource, 'the seed must offer at least one continuation');
  const BRANCHES = 'GET /v1/assets/:assetId/branches';
  await credentialCases(BRANCHES, {
    method: 'GET',
    url: `/v1/assets/${branchSource}/branches`,
  });
  await call(
    BRANCHES,
    'valid-legacy',
    'continuations of a Scroll with admitted bridges',
    { url: `/v1/assets/${branchSource}/branches`, headers: B.headers },
  );
  assert.ok(bareScroll, 'the seed must hold a Scroll with no continuation');
  await call(
    BRANCHES,
    'valid-no-continuations',
    'a Scroll with no admitted bridge',
    { url: `/v1/assets/${bareScroll}/branches`, headers: B.headers },
  );
  await call(BRANCHES, 'valid-web-reader', 'webReader=v1', {
    url: `/v1/assets/${branchSource}/branches?webReader=v1`,
    headers: B.headers,
  });
  await call(
    BRANCHES,
    'web-reader-other-value',
    'webReader=v2 behaves as the legacy shape',
    {
      url: `/v1/assets/${branchSource}/branches?webReader=v2`,
      headers: B.headers,
    },
  );
  await call(BRANCHES, 'encounter-not-found', 'an id that is not an asset', {
    url: `/v1/assets/${ID_A}/branches`,
    headers: B.headers,
  });
  await call(BRANCHES, 'non-uuid', '/v1/assets/not-a-uuid/branches', {
    url: '/v1/assets/not-a-uuid/branches',
    headers: B.headers,
  });
  const originExposure = await readScroll(app, B.headers, branchSource, false);
  const bridge = branchList.branches[0];
  const BRANCH_POST = 'POST /v1/branches';
  const branchBody = {
    clientBranchId: randomUUID(),
    fromExposureId: originExposure,
    bridgeId: bridge.bridgeId,
    targetAssetId: bridge.target.assetId,
    expectedPrivacyEpoch: 0,
  };
  await credentialCases(BRANCH_POST, {
    method: 'POST',
    url: '/v1/branches',
    payload: branchBody,
  });
  await call(BRANCH_POST, 'valid', 'open the first continuation', {
    method: 'POST',
    url: '/v1/branches',
    headers: B.headers,
    payload: branchBody,
  });
  await call(BRANCH_POST, 'replay', 'exact replay', {
    method: 'POST',
    url: '/v1/branches',
    headers: B.headers,
    payload: branchBody,
  });
  await call(BRANCH_POST, 'conflict-other-target', 'same key, another target', {
    method: 'POST',
    url: '/v1/branches',
    headers: B.headers,
    payload: { ...branchBody, targetAssetId: branchSource },
  });
  await call(BRANCH_POST, 'valid-web-reader', 'webReader=v1 with a new key', {
    method: 'POST',
    url: '/v1/branches?webReader=v1',
    headers: B.headers,
    payload: { ...branchBody, clientBranchId: randomUUID() },
  });
  await call(BRANCH_POST, 'stale-epoch', 'expectedPrivacyEpoch 1', {
    method: 'POST',
    url: '/v1/branches',
    headers: B.headers,
    payload: {
      ...branchBody,
      clientBranchId: randomUUID(),
      expectedPrivacyEpoch: 1,
    },
  });
  await call(
    BRANCH_POST,
    'unknown-exposure',
    'an exposure that does not exist',
    {
      method: 'POST',
      url: '/v1/branches',
      headers: B.headers,
      payload: {
        ...branchBody,
        clientBranchId: randomUUID(),
        fromExposureId: ID_A,
      },
    },
  );
  await call(
    BRANCH_POST,
    'other-universe-exposure',
    "another reader's exposure",
    {
      method: 'POST',
      url: '/v1/branches',
      headers: stranger.headers,
      payload: { ...branchBody, clientBranchId: randomUUID() },
    },
  );
  await call(BRANCH_POST, 'unknown-bridge', 'a bridge that does not exist', {
    method: 'POST',
    url: '/v1/branches',
    headers: B.headers,
    payload: { ...branchBody, clientBranchId: randomUUID(), bridgeId: ID_A },
  });
  await call(
    BRANCH_POST,
    'target-not-the-bridge-target',
    'a target the bridge does not lead to',
    {
      method: 'POST',
      url: '/v1/branches',
      headers: B.headers,
      payload: {
        ...branchBody,
        clientBranchId: randomUUID(),
        targetAssetId: ID_A,
      },
    },
  );
  await call(BRANCH_POST, 'missing-field', 'no bridgeId', {
    method: 'POST',
    url: '/v1/branches',
    headers: B.headers,
    payload: {
      clientBranchId: randomUUID(),
      fromExposureId: originExposure,
      targetAssetId: bridge.target.assetId,
      expectedPrivacyEpoch: 0,
    },
  });
  await call(BRANCH_POST, 'non-uuid', 'bridgeId "x"', {
    method: 'POST',
    url: '/v1/branches',
    headers: B.headers,
    payload: { ...branchBody, bridgeId: 'x' },
  });
  await call(BRANCH_POST, 'extra-field', 'an extra key', {
    method: 'POST',
    url: '/v1/branches',
    headers: B.headers,
    payload: { ...branchBody, extra: 1 },
  });
  await bodyCases(BRANCH_POST, '/v1/branches', 'POST', B.headers);

  const CONN = 'POST /v1/connections/feedback';
  const connBody = {
    clientFeedbackId: randomUUID(),
    bridgeId: bridge.bridgeId,
    expectedPrivacyEpoch: 0,
    objection: 'not_useful',
  };
  await credentialCases(CONN, {
    method: 'POST',
    url: '/v1/connections/feedback',
    payload: connBody,
  });
  await call(CONN, 'valid', 'not_useful on the first bridge', {
    method: 'POST',
    url: '/v1/connections/feedback',
    headers: B.headers,
    payload: connBody,
  });
  await call(CONN, 'replay', 'exact replay', {
    method: 'POST',
    url: '/v1/connections/feedback',
    headers: B.headers,
    payload: connBody,
  });
  await call(CONN, 'conflict-other-objection', 'same key, seems_wrong', {
    method: 'POST',
    url: '/v1/connections/feedback',
    headers: B.headers,
    payload: { ...connBody, objection: 'seems_wrong' },
  });
  await call(CONN, 'stale-epoch', 'expectedPrivacyEpoch 1', {
    method: 'POST',
    url: '/v1/connections/feedback',
    headers: B.headers,
    payload: {
      ...connBody,
      clientFeedbackId: randomUUID(),
      expectedPrivacyEpoch: 1,
    },
  });
  await call(CONN, 'unknown-bridge', 'a bridge that does not exist', {
    method: 'POST',
    url: '/v1/connections/feedback',
    headers: B.headers,
    payload: { ...connBody, clientFeedbackId: randomUUID(), bridgeId: ID_A },
  });
  await call(CONN, 'unknown-objection', 'objection "meh"', {
    method: 'POST',
    url: '/v1/connections/feedback',
    headers: B.headers,
    payload: { ...connBody, clientFeedbackId: randomUUID(), objection: 'meh' },
  });
  await call(CONN, 'missing-field', 'no objection', {
    method: 'POST',
    url: '/v1/connections/feedback',
    headers: B.headers,
    payload: {
      clientFeedbackId: randomUUID(),
      bridgeId: bridge.bridgeId,
      expectedPrivacyEpoch: 0,
    },
  });
  await call(CONN, 'extra-field', 'an extra key', {
    method: 'POST',
    url: '/v1/connections/feedback',
    headers: B.headers,
    payload: { ...connBody, clientFeedbackId: randomUUID(), extra: 1 },
  });
  await bodyCases(CONN, '/v1/connections/feedback', 'POST', B.headers);
  await call(
    BRANCHES,
    'after-suppression',
    'the suppressed bridge is gone from the listing',
    { url: `/v1/assets/${branchSource}/branches`, headers: B.headers },
  );

  // ---- places, rooms, relics, passages: a reader with two days of reading --------------------
  const A = await reader();
  await carryGravityQuestion(app, A.headers, A.universeId);
  const ATLAS = 'GET /v1/atlas';
  await credentialCases(ATLAS, { method: 'GET', url: '/v1/atlas' });
  const atlasRes = await call(
    ATLAS,
    'valid',
    'a reader with places and a room',
    { url: '/v1/atlas', headers: A.headers },
  );
  const atlas = json(atlasRes);
  await call(ATLAS, 'valid-web-reader', 'webReader=v1', {
    url: '/v1/atlas?webReader=v1',
    headers: A.headers,
  });
  await call(ATLAS, 'web-reader-invalid', 'webReader=v2', {
    url: '/v1/atlas?webReader=v2',
    headers: A.headers,
  });
  await call(ATLAS, 'unknown-query', 'an unknown parameter', {
    url: '/v1/atlas?x=1',
    headers: A.headers,
  });
  await call(ATLAS, 'valid-fresh', 'a fresh reader (no places)', {
    url: '/v1/atlas',
    headers: F.headers,
  });
  const gravity =
    atlas.places.find((p: Json) => p.anchor?.code === 'physics.gravity') ??
    atlas.places[0];
  assert.ok(gravity, 'the reader must have a place');
  const room = gravity.rooms[0];
  assert.ok(room, 'the reader must have a room');
  const atlasDeltaId: string | undefined =
    atlas.chronicle?.[0]?.deltaId ?? atlas.chronicle?.[0]?.id;
  const roomRes = await app.inject({
    url: `/v1/rooms/${room.roomId}`,
    headers: A.headers,
  });
  const roomDeltaId: string | undefined =
    json(roomRes).chronicle?.[0]?.deltaId ?? json(roomRes).chronicle?.[0]?.id;

  const ATLAS_DELTA = 'GET /v1/atlas/deltas/:deltaId';
  await credentialCases(ATLAS_DELTA, {
    method: 'GET',
    url: `/v1/atlas/deltas/${atlasDeltaId ?? ID_A}`,
  });
  if (atlasDeltaId)
    await call(ATLAS_DELTA, 'valid', 'a chronicle change of the reader', {
      url: `/v1/atlas/deltas/${atlasDeltaId}`,
      headers: A.headers,
    });
  await call(ATLAS_DELTA, 'unknown-delta', 'a delta that does not exist', {
    url: `/v1/atlas/deltas/${ID_A}`,
    headers: A.headers,
  });
  await call(ATLAS_DELTA, 'non-uuid', '/v1/atlas/deltas/not-a-uuid', {
    url: '/v1/atlas/deltas/not-a-uuid',
    headers: A.headers,
  });
  if (atlasDeltaId)
    await call(ATLAS_DELTA, 'other-universe', "another reader's delta", {
      url: `/v1/atlas/deltas/${atlasDeltaId}`,
      headers: F.headers,
    });

  const ROOM = 'GET /v1/rooms/:roomId';
  await credentialCases(ROOM, {
    method: 'GET',
    url: `/v1/rooms/${room.roomId}`,
  });
  await call(ROOM, 'valid', "the reader's room", {
    url: `/v1/rooms/${room.roomId}`,
    headers: A.headers,
  });
  await call(ROOM, 'unknown-room', 'a room that does not exist', {
    url: `/v1/rooms/${ID_A}`,
    headers: A.headers,
  });
  await call(ROOM, 'non-uuid', '/v1/rooms/not-a-uuid', {
    url: '/v1/rooms/not-a-uuid',
    headers: A.headers,
  });
  await call(ROOM, 'other-universe', "another reader's room", {
    url: `/v1/rooms/${room.roomId}`,
    headers: F.headers,
  });
  const ROOM_DELTA = 'GET /v1/rooms/deltas/:deltaId';
  await credentialCases(ROOM_DELTA, {
    method: 'GET',
    url: `/v1/rooms/deltas/${roomDeltaId ?? ID_A}`,
  });
  if (roomDeltaId)
    await call(ROOM_DELTA, 'valid', 'a change of the room', {
      url: `/v1/rooms/deltas/${roomDeltaId}`,
      headers: A.headers,
    });
  await call(ROOM_DELTA, 'unknown-delta', 'a delta that does not exist', {
    url: `/v1/rooms/deltas/${ID_A}`,
    headers: A.headers,
  });
  await call(ROOM_DELTA, 'non-uuid', '/v1/rooms/deltas/not-a-uuid', {
    url: '/v1/rooms/deltas/not-a-uuid',
    headers: A.headers,
  });

  const SET_ASIDE = 'POST /v1/rooms/:roomId/set-aside';
  const asideBody = { clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 };
  await credentialCases(SET_ASIDE, {
    method: 'POST',
    url: `/v1/rooms/${room.roomId}/set-aside`,
    payload: asideBody,
  });
  await call(SET_ASIDE, 'stale-epoch', 'expectedPrivacyEpoch 1', {
    method: 'POST',
    url: `/v1/rooms/${room.roomId}/set-aside`,
    headers: A.headers,
    payload: { ...asideBody, expectedPrivacyEpoch: 1 },
  });
  await call(SET_ASIDE, 'unknown-room', 'a room that does not exist', {
    method: 'POST',
    url: `/v1/rooms/${ID_A}/set-aside`,
    headers: A.headers,
    payload: asideBody,
  });
  await call(SET_ASIDE, 'non-uuid', '/v1/rooms/not-a-uuid/set-aside', {
    method: 'POST',
    url: '/v1/rooms/not-a-uuid/set-aside',
    headers: A.headers,
    payload: asideBody,
  });
  await call(SET_ASIDE, 'missing-field', 'no clientRequestId', {
    method: 'POST',
    url: `/v1/rooms/${room.roomId}/set-aside`,
    headers: A.headers,
    payload: { expectedPrivacyEpoch: 0 },
  });
  await call(SET_ASIDE, 'other-universe', "another reader's room", {
    method: 'POST',
    url: `/v1/rooms/${room.roomId}/set-aside`,
    headers: F.headers,
    payload: asideBody,
  });
  await bodyCases(
    SET_ASIDE,
    `/v1/rooms/${room.roomId}/set-aside`,
    'POST',
    A.headers,
  );

  const PASSAGES = 'GET /v1/scrolls/:assetId/passages';
  const scrollId = EDITORIAL.oneForce;
  await credentialCases(PASSAGES, {
    method: 'GET',
    url: `/v1/scrolls/${scrollId}/passages`,
  });
  const passagesRes = await call(
    PASSAGES,
    'valid',
    'claims of a Scroll the reader read',
    { url: `/v1/scrolls/${scrollId}/passages`, headers: A.headers },
  );
  await call(PASSAGES, 'never-read', 'a Scroll the reader never read', {
    url: `/v1/scrolls/${scrollId}/passages`,
    headers: stranger.headers,
  });
  await call(PASSAGES, 'unknown-scroll', 'an id that is not a Scroll', {
    url: `/v1/scrolls/${ID_A}/passages`,
    headers: A.headers,
  });
  await call(PASSAGES, 'non-uuid', '/v1/scrolls/not-a-uuid/passages', {
    url: '/v1/scrolls/not-a-uuid/passages',
    headers: A.headers,
  });
  const claimKey: string = json(passagesRes).passages[0].claimKey;

  const RELICS = 'GET /v1/relics';
  await credentialCases(RELICS, { method: 'GET', url: '/v1/relics' });
  await call(RELICS, 'valid-empty', 'no Relics yet', {
    url: '/v1/relics',
    headers: A.headers,
  });
  const RELIC_KEEP = 'POST /v1/relics';
  const placeBody = {
    clientRequestId: randomUUID(),
    expectedPrivacyEpoch: 0,
    kind: 'place',
    placeId: gravity.placeId,
  };
  await credentialCases(RELIC_KEEP, {
    method: 'POST',
    url: '/v1/relics',
    payload: placeBody,
  });
  const placeRelic = await call(RELIC_KEEP, 'valid-place', 'keep a place', {
    method: 'POST',
    url: '/v1/relics',
    headers: A.headers,
    payload: placeBody,
  });
  await call(
    RELIC_KEEP,
    'replay-place',
    'exact replay (answered 200, already kept)',
    {
      method: 'POST',
      url: '/v1/relics',
      headers: A.headers,
      payload: placeBody,
    },
  );
  await call(
    RELIC_KEEP,
    'conflict-place-key-other-place',
    'same key, another place',
    {
      method: 'POST',
      url: '/v1/relics',
      headers: A.headers,
      payload: { ...placeBody, placeId: ID_A },
    },
  );
  const passageBody = {
    clientRequestId: randomUUID(),
    expectedPrivacyEpoch: 0,
    kind: 'passage',
    assetId: scrollId,
    revision: 1,
    claimKey,
  };
  await call(RELIC_KEEP, 'valid-passage', 'keep a passage of a read Scroll', {
    method: 'POST',
    url: '/v1/relics',
    headers: A.headers,
    payload: passageBody,
  });
  await call(
    RELIC_KEEP,
    'passage-wrong-revision',
    'a revision the reader did not read',
    {
      method: 'POST',
      url: '/v1/relics',
      headers: A.headers,
      payload: { ...passageBody, clientRequestId: randomUUID(), revision: 2 },
    },
  );
  await call(RELIC_KEEP, 'passage-never-read', 'a Scroll never read', {
    method: 'POST',
    url: '/v1/relics',
    headers: stranger.headers,
    payload: { ...passageBody, clientRequestId: randomUUID() },
  });
  await call(
    RELIC_KEEP,
    'passage-unknown-claim',
    'a claim the Scroll does not present',
    {
      method: 'POST',
      url: '/v1/relics',
      headers: A.headers,
      payload: {
        ...passageBody,
        clientRequestId: randomUUID(),
        claimKey: 'clm.nothing.here',
      },
    },
  );
  await call(RELIC_KEEP, 'unknown-place', 'a place that does not exist', {
    method: 'POST',
    url: '/v1/relics',
    headers: A.headers,
    payload: { ...placeBody, clientRequestId: randomUUID(), placeId: ID_A },
  });
  const answerRelic = {
    clientRequestId: randomUUID(),
    expectedPrivacyEpoch: 0,
    kind: 'answer',
    askId: FA,
  };
  await call(
    RELIC_KEEP,
    'valid-answer',
    'keep an answer the reader was given',
    {
      method: 'POST',
      url: '/v1/relics',
      headers: F.headers,
      payload: answerRelic,
    },
  );
  await call(RELIC_KEEP, 'replay-answer', 'exact replay (200, already kept)', {
    method: 'POST',
    url: '/v1/relics',
    headers: F.headers,
    payload: answerRelic,
  });
  await call(
    RELIC_KEEP,
    'answer-of-another-reader',
    "another reader's answered Ask",
    {
      method: 'POST',
      url: '/v1/relics',
      headers: stranger.headers,
      payload: { ...answerRelic, clientRequestId: randomUUID() },
    },
  );
  await call(RELIC_KEEP, 'unknown-answer', 'an Ask without an applied answer', {
    method: 'POST',
    url: '/v1/relics',
    headers: A.headers,
    payload: {
      clientRequestId: randomUUID(),
      expectedPrivacyEpoch: 0,
      kind: 'answer',
      askId: ID_A,
    },
  });
  await call(
    RELIC_KEEP,
    'connection-not-seen',
    'a connection the reader was never shown',
    {
      method: 'POST',
      url: '/v1/relics',
      headers: A.headers,
      payload: {
        clientRequestId: randomUUID(),
        expectedPrivacyEpoch: 0,
        kind: 'connection',
        bridgeId: ID_A,
      },
    },
  );
  await call(RELIC_KEEP, 'stale-epoch', 'expectedPrivacyEpoch 1', {
    method: 'POST',
    url: '/v1/relics',
    headers: A.headers,
    payload: {
      ...placeBody,
      clientRequestId: randomUUID(),
      expectedPrivacyEpoch: 1,
    },
  });
  await call(RELIC_KEEP, 'unknown-kind', 'kind "song"', {
    method: 'POST',
    url: '/v1/relics',
    headers: A.headers,
    payload: { ...placeBody, clientRequestId: randomUUID(), kind: 'song' },
  });
  await call(
    RELIC_KEEP,
    'kind-field-mismatch',
    'kind place carrying a bridgeId',
    {
      method: 'POST',
      url: '/v1/relics',
      headers: A.headers,
      payload: {
        clientRequestId: randomUUID(),
        expectedPrivacyEpoch: 0,
        kind: 'place',
        bridgeId: ID_A,
      },
    },
  );
  await call(RELIC_KEEP, 'missing-kind', 'no kind', {
    method: 'POST',
    url: '/v1/relics',
    headers: A.headers,
    payload: { clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 },
  });
  await bodyCases(RELIC_KEEP, '/v1/relics', 'POST', A.headers);
  const relicsRes = await call(
    RELICS,
    'valid-with-relics',
    "the reader's Relics",
    { url: '/v1/relics', headers: A.headers },
  );
  await call(RELICS, 'page-invalid', 'page=garbage', {
    url: '/v1/relics?page=garbage',
    headers: A.headers,
  });
  await call(RELICS, 'page-valid-cursor', 'a well-formed cursor past the end', {
    url: `/v1/relics?page=${encodeURIComponent('2000-01-01T00:00:00.000000Z|' + ID_A)}`,
    headers: A.headers,
  });
  const relicId: string = json(relicsRes).relics[0].relicId;

  const RELEASE = 'POST /v1/relics/:relicId/release';
  await credentialCases(RELEASE, {
    method: 'POST',
    url: `/v1/relics/${relicId}/release`,
    payload: { expectedPrivacyEpoch: 0 },
  });
  await call(RELEASE, 'valid', 'release a Relic', {
    method: 'POST',
    url: `/v1/relics/${relicId}/release`,
    headers: A.headers,
    payload: { expectedPrivacyEpoch: 0 },
  });
  await call(RELEASE, 'again', 'release it again', {
    method: 'POST',
    url: `/v1/relics/${relicId}/release`,
    headers: A.headers,
    payload: { expectedPrivacyEpoch: 0 },
  });
  await call(RELEASE, 'stale-epoch', 'expectedPrivacyEpoch 1', {
    method: 'POST',
    url: `/v1/relics/${relicId}/release`,
    headers: A.headers,
    payload: { expectedPrivacyEpoch: 1 },
  });
  await call(RELEASE, 'unknown-relic', 'a Relic that does not exist', {
    method: 'POST',
    url: `/v1/relics/${ID_A}/release`,
    headers: A.headers,
    payload: { expectedPrivacyEpoch: 0 },
  });
  await call(RELEASE, 'non-uuid', '/v1/relics/not-a-uuid/release', {
    method: 'POST',
    url: '/v1/relics/not-a-uuid/release',
    headers: A.headers,
    payload: { expectedPrivacyEpoch: 0 },
  });
  await call(RELEASE, 'malformed', 'wrong field type', {
    method: 'POST',
    url: `/v1/relics/${relicId}/release`,
    headers: A.headers,
    payload: { expectedPrivacyEpoch: 'x' },
  });
  await bodyCases(RELEASE, `/v1/relics/${relicId}/release`, 'POST', A.headers);

  const OBJECTIONS = 'POST /v1/objections';
  const objBody = {
    clientRequestId: randomUUID(),
    expectedPrivacyEpoch: 0,
    kind: 'passage',
    assetId: scrollId,
    claimKey,
  };
  await credentialCases(OBJECTIONS, {
    method: 'POST',
    url: '/v1/objections',
    payload: objBody,
  });
  await call(OBJECTIONS, 'valid-passage', 'seems wrong on a passage', {
    method: 'POST',
    url: '/v1/objections',
    headers: A.headers,
    payload: objBody,
  });
  await call(OBJECTIONS, 'replay', 'exact replay (200, already made)', {
    method: 'POST',
    url: '/v1/objections',
    headers: A.headers,
    payload: objBody,
  });
  await call(
    OBJECTIONS,
    'conflict-key-other-claim',
    'same key, another claim',
    {
      method: 'POST',
      url: '/v1/objections',
      headers: A.headers,
      payload: { ...objBody, claimKey: 'clm.nothing.here' },
    },
  );
  await call(OBJECTIONS, 'never-read', 'a Scroll never read', {
    method: 'POST',
    url: '/v1/objections',
    headers: stranger.headers,
    payload: { ...objBody, clientRequestId: randomUUID() },
  });
  await call(OBJECTIONS, 'valid-answer', 'seems wrong on an answer', {
    method: 'POST',
    url: '/v1/objections',
    headers: F.headers,
    payload: {
      clientRequestId: randomUUID(),
      expectedPrivacyEpoch: 0,
      kind: 'answer',
      askId: FA,
    },
  });
  await call(
    ANSWER_GET,
    'answered-and-doubted',
    'the answer after the reader doubted it',
    { url: `/v1/asks/${FA}/answer`, headers: F.headers },
  );
  await call(OBJECTIONS, 'unknown-answer', 'an Ask without an applied answer', {
    method: 'POST',
    url: '/v1/objections',
    headers: A.headers,
    payload: {
      clientRequestId: randomUUID(),
      expectedPrivacyEpoch: 0,
      kind: 'answer',
      askId: ID_A,
    },
  });
  await call(OBJECTIONS, 'stale-epoch', 'expectedPrivacyEpoch 1', {
    method: 'POST',
    url: '/v1/objections',
    headers: A.headers,
    payload: {
      ...objBody,
      clientRequestId: randomUUID(),
      expectedPrivacyEpoch: 1,
    },
  });
  await call(OBJECTIONS, 'unknown-kind', 'kind "place"', {
    method: 'POST',
    url: '/v1/objections',
    headers: A.headers,
    payload: { ...objBody, clientRequestId: randomUUID(), kind: 'place' },
  });
  await call(OBJECTIONS, 'missing-field', 'no claimKey', {
    method: 'POST',
    url: '/v1/objections',
    headers: A.headers,
    payload: {
      clientRequestId: randomUUID(),
      expectedPrivacyEpoch: 0,
      kind: 'passage',
      assetId: scrollId,
    },
  });
  await bodyCases(OBJECTIONS, '/v1/objections', 'POST', A.headers);
  await call(PASSAGES, 'after-objection', 'the passage now reads as doubted', {
    url: `/v1/scrolls/${scrollId}/passages`,
    headers: A.headers,
  });

  // connection Relic: a bridge the reader was shown as a continuation
  const connRelic = {
    clientRequestId: randomUUID(),
    expectedPrivacyEpoch: 0,
    kind: 'connection',
    bridgeId: bridge.bridgeId,
  };
  await call(RELIC_KEEP, 'valid-connection', 'keep an admitted connection', {
    method: 'POST',
    url: '/v1/relics',
    headers: A.headers,
    payload: connRelic,
  });
  await call(
    RELIC_KEEP,
    'replay-connection',
    'exact replay (200, already kept)',
    {
      method: 'POST',
      url: '/v1/relics',
      headers: A.headers,
      payload: connRelic,
    },
  );
  await call(
    RELIC_KEEP,
    'valid-connection-after-not-useful',
    'keep a connection the reader had marked not useful',
    {
      method: 'POST',
      url: '/v1/relics',
      headers: B.headers,
      payload: { ...connRelic, clientRequestId: randomUUID() },
    },
  );
  await call(RELICS, 'valid-b', 'the Relics of the continuation reader', {
    url: '/v1/relics',
    headers: B.headers,
  });

  const REJECT = 'POST /v1/atlas/places/:placeId/reject';
  const rejectBody = { expectedPrivacyEpoch: 0 };
  await credentialCases(REJECT, {
    method: 'POST',
    url: `/v1/atlas/places/${gravity.placeId}/reject`,
    payload: rejectBody,
  });
  await call(REJECT, 'stale-epoch', 'expectedPrivacyEpoch 1', {
    method: 'POST',
    url: `/v1/atlas/places/${gravity.placeId}/reject`,
    headers: A.headers,
    payload: { expectedPrivacyEpoch: 1 },
  });
  await call(REJECT, 'non-uuid', '/v1/atlas/places/not-a-uuid/reject', {
    method: 'POST',
    url: '/v1/atlas/places/not-a-uuid/reject',
    headers: A.headers,
    payload: rejectBody,
  });
  await call(REJECT, 'unknown-place', 'a place that does not exist', {
    method: 'POST',
    url: `/v1/atlas/places/${ID_A}/reject`,
    headers: A.headers,
    payload: rejectBody,
  });
  await call(REJECT, 'missing-field', 'empty object', {
    method: 'POST',
    url: `/v1/atlas/places/${gravity.placeId}/reject`,
    headers: A.headers,
    payload: {},
  });
  await call(REJECT, 'extra-field', 'an extra key', {
    method: 'POST',
    url: `/v1/atlas/places/${gravity.placeId}/reject`,
    headers: A.headers,
    payload: { ...rejectBody, extra: 1 },
  });
  await call(REJECT, 'web-reader-invalid', 'webReader=v2', {
    method: 'POST',
    url: `/v1/atlas/places/${gravity.placeId}/reject?webReader=v2`,
    headers: A.headers,
    payload: rejectBody,
  });
  await call(REJECT, 'other-universe', "another reader's place", {
    method: 'POST',
    url: `/v1/atlas/places/${gravity.placeId}/reject`,
    headers: F.headers,
    payload: rejectBody,
  });
  await bodyCases(
    REJECT,
    `/v1/atlas/places/${gravity.placeId}/reject`,
    'POST',
    A.headers,
  );
  await call(
    REJECT,
    'valid-web-reader',
    'set the Gravity place aside, webReader=v1',
    {
      method: 'POST',
      url: `/v1/atlas/places/${gravity.placeId}/reject?webReader=v1`,
      headers: A.headers,
      payload: rejectBody,
    },
  );
  await call(REJECT, 'again', 'set it aside again', {
    method: 'POST',
    url: `/v1/atlas/places/${gravity.placeId}/reject`,
    headers: A.headers,
    payload: rejectBody,
  });
  await call(ATLAS, 'after-reject', 'the atlas after setting a place aside', {
    url: '/v1/atlas',
    headers: A.headers,
  });
  // A room can only be set aside while its place stands: use a second reader with the same history.
  const A2 = await reader();
  await carryGravityQuestion(app, A2.headers, A2.universeId);
  const a2Atlas = json(
    await app.inject({ url: '/v1/atlas', headers: A2.headers }),
  );
  const a2Room = (
    a2Atlas.places.find((p: Json) => p.anchor?.code === 'physics.gravity') ??
    a2Atlas.places[0]
  ).rooms[0];
  await call(SET_ASIDE, 'valid', 'set a room aside (answers the atlas)', {
    method: 'POST',
    url: `/v1/rooms/${a2Room.roomId}/set-aside`,
    headers: A2.headers,
    payload: { clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 },
  });
  const a2Aside = { clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 };
  await call(SET_ASIDE, 'again', 'set the same room aside again', {
    method: 'POST',
    url: `/v1/rooms/${a2Room.roomId}/set-aside`,
    headers: A2.headers,
    payload: a2Aside,
  });
  await call(ROOM, 'after-set-aside', 'the room that was set aside', {
    url: `/v1/rooms/${a2Room.roomId}`,
    headers: A2.headers,
  });

  // ---- away and inquiries --------------------------------------------------------------------
  const AWAY = 'GET /v1/away';
  await credentialCases(AWAY, { method: 'GET', url: '/v1/away' });
  await call(AWAY, 'valid-fresh', 'a reader with nothing waiting', {
    url: '/v1/away',
    headers: F.headers,
  });
  await call(AWAY, 'valid-with-history', 'a reader with reading history', {
    url: '/v1/away',
    headers: A.headers,
  });
  await call(AWAY, 'page-invalid', 'page=garbage', {
    url: '/v1/away?page=garbage',
    headers: F.headers,
  });
  await call(AWAY, 'page-valid-cursor', 'a well-formed cursor', {
    url: `/v1/away?page=${encodeURIComponent('2000-01-01T00:00:00.000000Z|' + ID_A)}`,
    headers: F.headers,
  });
  const ACK = 'POST /v1/away/acknowledge';
  // The request carries "now"; nothing of it is recorded except the marker it moves (normalized).
  const ackBody = {
    clientRequestId: randomUUID(),
    expectedPrivacyEpoch: 0,
    through: new Date().toISOString(),
  };
  await credentialCases(ACK, {
    method: 'POST',
    url: '/v1/away/acknowledge',
    payload: ackBody,
  });
  await call(ACK, 'valid', 'acknowledge through a time', {
    method: 'POST',
    url: '/v1/away/acknowledge',
    headers: F.headers,
    payload: ackBody,
  });
  await call(ACK, 'replay', 'exact replay', {
    method: 'POST',
    url: '/v1/away/acknowledge',
    headers: F.headers,
    payload: ackBody,
  });
  await call(ACK, 'conflict-key-other-through', 'same key, another time', {
    method: 'POST',
    url: '/v1/away/acknowledge',
    headers: F.headers,
    payload: {
      ...ackBody,
      through: new Date(Date.now() - 3_600_000).toISOString(),
    },
  });
  await call(ACK, 'future-time', 'through a time in the future', {
    method: 'POST',
    url: '/v1/away/acknowledge',
    headers: F.headers,
    payload: {
      ...ackBody,
      clientRequestId: randomUUID(),
      through: '2100-01-01T00:00:00.000Z',
    },
  });
  await call(ACK, 'stale-epoch', 'expectedPrivacyEpoch 1', {
    method: 'POST',
    url: '/v1/away/acknowledge',
    headers: F.headers,
    payload: {
      ...ackBody,
      clientRequestId: randomUUID(),
      expectedPrivacyEpoch: 1,
    },
  });
  await call(ACK, 'through-not-a-time', 'through "yesterday"', {
    method: 'POST',
    url: '/v1/away/acknowledge',
    headers: F.headers,
    payload: {
      ...ackBody,
      clientRequestId: randomUUID(),
      through: 'yesterday',
    },
  });
  await call(ACK, 'missing-field', 'no through', {
    method: 'POST',
    url: '/v1/away/acknowledge',
    headers: F.headers,
    payload: { clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 },
  });
  await call(ACK, 'extra-field', 'an extra key', {
    method: 'POST',
    url: '/v1/away/acknowledge',
    headers: F.headers,
    payload: { ...ackBody, clientRequestId: randomUUID(), extra: 1 },
  });
  await bodyCases(ACK, '/v1/away/acknowledge', 'POST', F.headers);
  await call(AWAY, 'after-acknowledge', 'the marker moved', {
    url: '/v1/away',
    headers: F.headers,
  });

  const CONSENT = 'PUT /v1/inquiries/consent';
  const consentBody = {
    enabled: true,
    dailyLimit: 2,
    clientRequestId: randomUUID(),
    expectedPrivacyEpoch: 0,
  };
  await credentialCases(CONSENT, {
    method: 'PUT',
    url: '/v1/inquiries/consent',
    payload: consentBody,
  });
  await call(CONSENT, 'valid-enable', 'consent on, limit 2', {
    method: 'PUT',
    url: '/v1/inquiries/consent',
    headers: F.headers,
    payload: consentBody,
  });
  await call(CONSENT, 'replay', 'exact replay', {
    method: 'PUT',
    url: '/v1/inquiries/consent',
    headers: F.headers,
    payload: consentBody,
  });
  await call(CONSENT, 'conflict-key-other-limit', 'same key, another limit', {
    method: 'PUT',
    url: '/v1/inquiries/consent',
    headers: F.headers,
    payload: { ...consentBody, dailyLimit: 3 },
  });
  await call(
    CONSENT,
    'valid-disable-default-limit',
    'consent off, limit left as is',
    {
      method: 'PUT',
      url: '/v1/inquiries/consent',
      headers: F.headers,
      payload: {
        enabled: false,
        clientRequestId: randomUUID(),
        expectedPrivacyEpoch: 0,
      },
    },
  );
  await call(CONSENT, 'stale-epoch', 'expectedPrivacyEpoch 1', {
    method: 'PUT',
    url: '/v1/inquiries/consent',
    headers: F.headers,
    payload: {
      ...consentBody,
      clientRequestId: randomUUID(),
      expectedPrivacyEpoch: 1,
    },
  });
  await call(CONSENT, 'limit-zero', 'dailyLimit 0', {
    method: 'PUT',
    url: '/v1/inquiries/consent',
    headers: F.headers,
    payload: { ...consentBody, clientRequestId: randomUUID(), dailyLimit: 0 },
  });
  await call(CONSENT, 'limit-huge', 'dailyLimit 1000', {
    method: 'PUT',
    url: '/v1/inquiries/consent',
    headers: F.headers,
    payload: {
      ...consentBody,
      clientRequestId: randomUUID(),
      dailyLimit: 1000,
    },
  });
  await call(CONSENT, 'enabled-not-boolean', 'enabled "yes"', {
    method: 'PUT',
    url: '/v1/inquiries/consent',
    headers: F.headers,
    payload: { ...consentBody, clientRequestId: randomUUID(), enabled: 'yes' },
  });
  await call(CONSENT, 'missing-field', 'no enabled', {
    method: 'PUT',
    url: '/v1/inquiries/consent',
    headers: F.headers,
    payload: { clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 },
  });
  await call(CONSENT, 'extra-field', 'an extra key', {
    method: 'PUT',
    url: '/v1/inquiries/consent',
    headers: F.headers,
    payload: { ...consentBody, clientRequestId: randomUUID(), extra: 1 },
  });
  await bodyCases(CONSENT, '/v1/inquiries/consent', 'PUT', F.headers);
  await call(
    INVENTORY,
    'valid-after-reading',
    'a reader whose feeds were observed',
    { url: '/v1/inventory', headers: F.headers },
  );
  await call(
    INVENTORY,
    'valid-rich-reader',
    'a reader with places and a room',
    { url: '/v1/inventory', headers: A.headers },
  );
  await call(WORLDS, 'valid-after-reading', 'a reader with exposures', {
    url: '/v1/worlds',
    headers: F.headers,
  });
  await call(WORLDS, 'valid-rich-reader', 'a reader with two days of reading', {
    url: '/v1/worlds',
    headers: A.headers,
  });
  await call(
    INQUIRIES,
    'valid-after-consent',
    'consent recorded, nothing looked for',
    { url: '/v1/inquiries', headers: F.headers },
  );

  // ---- media: GET and HEAD, ranges --------------------------------------------------------------
  const MEDIA = 'GET /v1/media/:sha256';
  const MEDIA_HEAD = 'HEAD /v1/media/:sha256';
  const bytes = Buffer.from(
    Array.from({ length: 300 }, (_, i) => (i * 7 + 3) % 256),
  );
  const mediaSha = createHash('sha256').update(bytes).digest('hex');
  const gated = await withFixedUuids(() =>
    mintGatedTestReel(pool, library[0]!.assetId, {
      tag: 'probe-media',
      title: 'Probe Reel',
      summary: 'A test Reel for the HTTP surface probe.',
      media: {
        sha256: mediaSha,
        byteSize: bytes.length,
        probe: { durationSeconds: 7.25, width: 1080, height: 1920 },
      },
    }),
  );
  await mkdir(
    join(mediaRoot, gated.storageKey.split('/').slice(0, -1).join('/')),
    { recursive: true },
  );
  await writeFile(join(mediaRoot, gated.storageKey), bytes);
  const missingGated = await withFixedUuids(() =>
    mintGatedTestReel(pool, library[1]!.assetId, {
      tag: 'probe-media-missing',
      title: 'Probe Reel without bytes',
      summary: 'A test Reel whose file is absent.',
    }),
  );
  // A genuinely `eligible` Reel (no simulated marker). The immutability trigger on gate verdicts is
  // lifted for exactly this fixture write in the disposable database, as `scripts/lib/backdate.ts` does.
  const realBytes = Buffer.from(
    Array.from({ length: 120 }, (_, i) => (i * 11 + 5) % 256),
  );
  const realSha = createHash('sha256').update(realBytes).digest('hex');
  const real = await withFixedUuids(() =>
    gateTestReel(pool, library[2]!.assetId, {
      tag: 'probe-media-eligible',
      title: 'Probe eligible Reel',
      summary: 'An eligible test Reel.',
      media: {
        sha256: realSha,
        byteSize: realBytes.length,
        probe: { durationSeconds: 5, width: 1080, height: 1920 },
      },
    }),
  );
  await transaction(async (client) => {
    await client.query(
      'ALTER TABLE publication_gate_result DISABLE TRIGGER publication_gate_result_immutable',
    );
    await client.query(
      "UPDATE publication_gate_result SET verdict='pass', evidence='{}' WHERE generated_reel_id=$1 AND gate='witness_alignment'",
      [real.generatedReelId],
    );
    await client.query(
      'ALTER TABLE publication_gate_result ENABLE TRIGGER publication_gate_result_immutable',
    );
    await client.query(
      "UPDATE generated_reel SET availability='eligible' WHERE id=$1",
      [real.generatedReelId],
    );
  });
  await mkdir(
    join(mediaRoot, real.storageKey.split('/').slice(0, -1).join('/')),
    { recursive: true },
  );
  await writeFile(join(mediaRoot, real.storageKey), realBytes);
  const mediaUrl = `/v1/media/${mediaSha}`;
  await credentialCases(MEDIA, { method: 'GET', url: mediaUrl });
  await call(MEDIA, 'valid-full', 'GET the whole file', {
    url: mediaUrl,
    headers: F.headers,
  });
  await call(MEDIA, 'valid-cookie', 'GET with the web cookie', {
    url: mediaUrl,
    headers: { cookie: web.cookie },
  });
  await call(MEDIA, 'range-first-10', 'Range: bytes=0-9', {
    url: mediaUrl,
    headers: { ...F.headers, range: 'bytes=0-9' },
  });
  await call(MEDIA, 'range-open-end', 'Range: bytes=290-', {
    url: mediaUrl,
    headers: { ...F.headers, range: 'bytes=290-' },
  });
  await call(MEDIA, 'range-suffix', 'Range: bytes=-5', {
    url: mediaUrl,
    headers: { ...F.headers, range: 'bytes=-5' },
  });
  await call(MEDIA, 'range-past-end-clamped', 'Range: bytes=250-9999', {
    url: mediaUrl,
    headers: { ...F.headers, range: 'bytes=250-9999' },
  });
  await call(MEDIA, 'range-unsatisfiable', 'Range: bytes=300-400', {
    url: mediaUrl,
    headers: { ...F.headers, range: 'bytes=300-400' },
  });
  await call(MEDIA, 'range-multiple', 'Range: bytes=0-1,5-6', {
    url: mediaUrl,
    headers: { ...F.headers, range: 'bytes=0-1,5-6' },
  });
  await call(MEDIA, 'range-reversed', 'Range: bytes=9-0', {
    url: mediaUrl,
    headers: { ...F.headers, range: 'bytes=9-0' },
  });
  await call(MEDIA, 'range-garbage', 'Range: pages=1-2', {
    url: mediaUrl,
    headers: { ...F.headers, range: 'pages=1-2' },
  });
  await call(MEDIA, 'range-empty-spec', 'Range: bytes=-', {
    url: mediaUrl,
    headers: { ...F.headers, range: 'bytes=-' },
  });
  await call(
    MEDIA,
    'eligible-no-simulated-marker',
    'a genuinely eligible Reel carries no simulated marker',
    { url: `/v1/media/${realSha}`, headers: F.headers },
  );
  await call(MEDIA, 'eligible-range', 'Range: bytes=100-', {
    url: `/v1/media/${realSha}`,
    headers: { ...F.headers, range: 'bytes=100-' },
  });
  await call(MEDIA, 'sha-too-short', '/v1/media/abc', {
    url: '/v1/media/abc',
    headers: F.headers,
  });
  await call(MEDIA, 'sha-upper-case', 'the digest upper-cased', {
    url: `/v1/media/${mediaSha.toUpperCase()}`,
    headers: F.headers,
  });
  await call(
    MEDIA,
    'sha-invalid-no-credential',
    'a malformed digest answers 400 before authentication',
    { url: '/v1/media/abc' },
  );
  await call(MEDIA, 'unknown-sha', 'a digest nothing names', {
    url: `/v1/media/${'0'.repeat(64)}`,
    headers: F.headers,
  });
  await call(
    MEDIA,
    'file-missing-on-disk',
    'an eligible Reel whose bytes are not on disk',
    { url: `/v1/media/${missingGated.mediaSha256}`, headers: F.headers },
  );
  await call(MEDIA_HEAD, 'valid', 'HEAD the whole file', {
    method: 'HEAD',
    url: mediaUrl,
    headers: F.headers,
  });
  await call(MEDIA_HEAD, 'valid-range', 'HEAD with Range: bytes=0-9', {
    method: 'HEAD',
    url: mediaUrl,
    headers: { ...F.headers, range: 'bytes=0-9' },
  });
  await call(
    MEDIA_HEAD,
    'range-unsatisfiable',
    'HEAD with Range: bytes=300-400',
    {
      method: 'HEAD',
      url: mediaUrl,
      headers: { ...F.headers, range: 'bytes=300-400' },
    },
  );
  await call(MEDIA_HEAD, 'eligible', 'HEAD an eligible Reel', {
    method: 'HEAD',
    url: `/v1/media/${realSha}`,
    headers: F.headers,
  });
  await call(MEDIA_HEAD, 'no-credential', 'HEAD with no credential', {
    method: 'HEAD',
    url: mediaUrl,
  });
  await call(MEDIA_HEAD, 'sha-invalid', 'HEAD with a malformed digest', {
    method: 'HEAD',
    url: '/v1/media/abc',
    headers: F.headers,
  });
  await call(
    MEDIA_HEAD,
    'file-missing-on-disk',
    'HEAD where the bytes are not on disk',
    {
      method: 'HEAD',
      url: `/v1/media/${missingGated.mediaSha256}`,
      headers: F.headers,
    },
  );
  // The minted Reel is now offered by the feed.
  const R = await reader();
  await call(FEED, 'kinds-reel-minted', 'kinds=Reel once a Reel is eligible', {
    url: '/v1/feed?kinds=Reel',
    headers: R.headers,
  });
  await call(FEED, 'kinds-both-minted', 'kinds=Scroll,Reel interleaves', {
    url: '/v1/feed?kinds=Scroll,Reel',
    headers: R.headers,
  });
  await call(FEED, 'default-with-reels-minted', 'default kinds ignores Reels', {
    url: '/v1/feed',
    headers: R.headers,
  });

  // ---- cookie sessions: page-token checks, then privacy lifecycle ----------------------------
  const PAUSE = 'POST /v1/privacy/pause';
  const RESUME = 'POST /v1/privacy/resume';
  const EXPORT = 'POST /v1/privacy/export';
  const RESET = 'POST /v1/privacy/reset';
  const CLEAR = 'POST /v1/history/clear';
  const REVOKE = 'POST /v1/session/revoke';
  const DELETE = 'POST /v1/account/delete';
  const pageHeaders = (extra: Record<string, string> = { origin: ORIGIN }) => ({
    cookie: web.cookie,
    'x-csrf-token': webCsrf,
    ...extra,
  });
  const ownerEpoch: number = json(
    await app.inject({ url: '/v1/universe', headers: { cookie: web.cookie } }),
  ).privacyEpoch;
  const cookiePause = {
    requestId: randomUUID(),
    expectedPrivacyEpoch: ownerEpoch,
  };
  await call(
    PAUSE,
    'cookie-no-page-token',
    'cookie change without X-CSRF-Token',
    {
      method: 'POST',
      url: '/v1/privacy/pause',
      headers: { cookie: web.cookie, origin: ORIGIN },
      payload: cookiePause,
    },
  );
  await call(
    PAUSE,
    'cookie-wrong-page-token',
    'cookie change with the wrong page token',
    {
      method: 'POST',
      url: '/v1/privacy/pause',
      headers: {
        cookie: web.cookie,
        'x-csrf-token': 'f'.repeat(64),
        origin: ORIGIN,
      },
      payload: cookiePause,
    },
  );
  await call(PAUSE, 'cookie-other-site', 'cookie change from another origin', {
    method: 'POST',
    url: '/v1/privacy/pause',
    headers: pageHeaders({ origin: 'https://evil.test' }),
    payload: cookiePause,
  });
  await call(
    PAUSE,
    'cookie-no-origin-no-fetch-metadata',
    'cookie change with neither Origin nor Sec-Fetch-Site',
    {
      method: 'POST',
      url: '/v1/privacy/pause',
      headers: pageHeaders({}),
      payload: cookiePause,
    },
  );
  await call(
    PAUSE,
    'cookie-cross-site-fetch-metadata',
    'Sec-Fetch-Site: cross-site',
    {
      method: 'POST',
      url: '/v1/privacy/pause',
      headers: pageHeaders({ 'sec-fetch-site': 'cross-site' }),
      payload: cookiePause,
    },
  );
  await call(
    PAUSE,
    'cookie-valid-origin',
    'cookie change with the page token and Origin',
    {
      method: 'POST',
      url: '/v1/privacy/pause',
      headers: pageHeaders(),
      payload: cookiePause,
    },
  );
  await call(
    RESUME,
    'cookie-valid-fetch-metadata',
    'cookie change with Sec-Fetch-Site: same-origin',
    {
      method: 'POST',
      url: '/v1/privacy/resume',
      headers: pageHeaders({ 'sec-fetch-site': 'same-origin' }),
      payload: { requestId: randomUUID(), expectedPrivacyEpoch: ownerEpoch },
    },
  );
  await call(
    CSRF,
    'cookie-reload-same-token',
    'the page token survives a reload',
    { url: '/v1/session/csrf', headers: { cookie: web.cookie } },
  );

  // Pause / resume / export / clear / reset on a disposable reader, destructive steps last.
  const P = await reader();
  const pauseFeed = await feedOf(P);
  const preClearExposure = {
    decisionId: pauseFeed.decisionId,
    assetId: pauseFeed.items[0].assetId,
    clientExposureId: randomUUID(),
  };
  const exposureBeforeClear = json(
    await app.inject({
      method: 'POST',
      url: '/v1/exposures',
      headers: P.headers,
      payload: { ...preClearExposure, clientExposureId: randomUUID() },
    }),
  );
  const pauseBody = { requestId: randomUUID(), expectedPrivacyEpoch: 0 };
  await credentialCases(PAUSE, {
    method: 'POST',
    url: '/v1/privacy/pause',
    payload: pauseBody,
  });
  await call(PAUSE, 'valid', 'pause recording', {
    method: 'POST',
    url: '/v1/privacy/pause',
    headers: P.headers,
    payload: pauseBody,
  });
  await call(PAUSE, 'replay', 'exact replay', {
    method: 'POST',
    url: '/v1/privacy/pause',
    headers: P.headers,
    payload: pauseBody,
  });
  await call(
    PAUSE,
    'conflict-key-other-epoch',
    'same request id, another expected epoch',
    {
      method: 'POST',
      url: '/v1/privacy/pause',
      headers: P.headers,
      payload: { ...pauseBody, expectedPrivacyEpoch: 5 },
    },
  );
  await call(
    PAUSE,
    'stale-epoch',
    'new request id with expectedPrivacyEpoch 5',
    {
      method: 'POST',
      url: '/v1/privacy/pause',
      headers: P.headers,
      payload: { requestId: randomUUID(), expectedPrivacyEpoch: 5 },
    },
  );
  await call(PAUSE, 'missing-field', 'no requestId', {
    method: 'POST',
    url: '/v1/privacy/pause',
    headers: P.headers,
    payload: { expectedPrivacyEpoch: 0 },
  });
  await call(PAUSE, 'wrong-type', 'expectedPrivacyEpoch -1', {
    method: 'POST',
    url: '/v1/privacy/pause',
    headers: P.headers,
    payload: { requestId: randomUUID(), expectedPrivacyEpoch: -1 },
  });
  await call(PAUSE, 'extra-field', 'an extra key', {
    method: 'POST',
    url: '/v1/privacy/pause',
    headers: P.headers,
    payload: { ...pauseBody, requestId: randomUUID(), extra: 1 },
  });
  await bodyCases(PAUSE, '/v1/privacy/pause', 'POST', P.headers);
  await call(UNIVERSE, 'valid-paused', 'a paused reader', {
    url: '/v1/universe',
    headers: P.headers,
  });
  await call(
    EXPOSURES,
    'while-paused',
    'an exposure while recording is paused',
    {
      method: 'POST',
      url: '/v1/exposures',
      headers: P.headers,
      payload: { ...preClearExposure, clientExposureId: randomUUID() },
    },
  );
  await call(ASKS, 'while-paused', 'an Ask while recording is paused', {
    method: 'POST',
    url: '/v1/asks',
    headers: P.headers,
    payload: {
      clientAskId: randomUUID(),
      exposureId: exposureBeforeClear.exposureId,
      expectedPrivacyEpoch: 0,
      question: 'Asked while paused?',
    },
  });
  await call(FEED, 'while-paused', 'the feed while recording is paused', {
    url: '/v1/feed',
    headers: P.headers,
  });
  await call(RELICS, 'valid-paused', 'Relics list while recording is paused', {
    url: '/v1/relics',
    headers: P.headers,
  });
  await call(AWAY, 'valid-paused', 'the return while recording is paused', {
    url: '/v1/away',
    headers: P.headers,
  });
  await call(
    CONSENT,
    'while-paused',
    'consent change while recording is paused',
    {
      method: 'PUT',
      url: '/v1/inquiries/consent',
      headers: P.headers,
      payload: {
        enabled: true,
        clientRequestId: randomUUID(),
        expectedPrivacyEpoch: 0,
      },
    },
  );
  await call(
    RELIC_KEEP,
    'while-paused',
    'keep a Relic while recording is paused',
    {
      method: 'POST',
      url: '/v1/relics',
      headers: P.headers,
      payload: {
        clientRequestId: randomUUID(),
        expectedPrivacyEpoch: 0,
        kind: 'place',
        placeId: ID_A,
      },
    },
  );
  await call(
    ACK,
    'while-paused',
    'acknowledge the return while recording is paused',
    {
      method: 'POST',
      url: '/v1/away/acknowledge',
      headers: P.headers,
      payload: {
        clientRequestId: randomUUID(),
        expectedPrivacyEpoch: 0,
        through: new Date().toISOString(),
      },
    },
  );
  const resumeBody = { requestId: randomUUID(), expectedPrivacyEpoch: 0 };
  await credentialCases(RESUME, {
    method: 'POST',
    url: '/v1/privacy/resume',
    payload: resumeBody,
  });
  await call(RESUME, 'valid', 'resume recording', {
    method: 'POST',
    url: '/v1/privacy/resume',
    headers: P.headers,
    payload: resumeBody,
  });
  await call(RESUME, 'replay', 'exact replay', {
    method: 'POST',
    url: '/v1/privacy/resume',
    headers: P.headers,
    payload: resumeBody,
  });
  await call(
    RESUME,
    'conflict-key-other-epoch',
    'same request id, another expected epoch',
    {
      method: 'POST',
      url: '/v1/privacy/resume',
      headers: P.headers,
      payload: { ...resumeBody, expectedPrivacyEpoch: 5 },
    },
  );
  await call(
    RESUME,
    'stale-epoch',
    'new request id with expectedPrivacyEpoch 5',
    {
      method: 'POST',
      url: '/v1/privacy/resume',
      headers: P.headers,
      payload: { requestId: randomUUID(), expectedPrivacyEpoch: 5 },
    },
  );
  await call(RESUME, 'malformed', 'wrong field type', {
    method: 'POST',
    url: '/v1/privacy/resume',
    headers: P.headers,
    payload: { requestId: 'x', expectedPrivacyEpoch: 0 },
  });
  await bodyCases(RESUME, '/v1/privacy/resume', 'POST', P.headers);

  const exportBody = { requestId: randomUUID(), expectedPrivacyEpoch: 0 };
  await credentialCases(EXPORT, {
    method: 'POST',
    url: '/v1/privacy/export',
    payload: exportBody,
  });
  await call(EXPORT, 'valid', 'export a reader with history', {
    method: 'POST',
    url: '/v1/privacy/export',
    headers: P.headers,
    payload: exportBody,
  });
  await call(EXPORT, 'replay', 'exact replay', {
    method: 'POST',
    url: '/v1/privacy/export',
    headers: P.headers,
    payload: exportBody,
  });
  await call(
    EXPORT,
    'conflict-key-other-epoch',
    'same request id, another expected epoch',
    {
      method: 'POST',
      url: '/v1/privacy/export',
      headers: P.headers,
      payload: { ...exportBody, expectedPrivacyEpoch: 5 },
    },
  );
  await call(
    EXPORT,
    'stale-epoch',
    'new request id with expectedPrivacyEpoch 5',
    {
      method: 'POST',
      url: '/v1/privacy/export',
      headers: P.headers,
      payload: { requestId: randomUUID(), expectedPrivacyEpoch: 5 },
    },
  );
  await call(EXPORT, 'malformed', 'missing requestId', {
    method: 'POST',
    url: '/v1/privacy/export',
    headers: P.headers,
    payload: { expectedPrivacyEpoch: 0 },
  });
  await bodyCases(EXPORT, '/v1/privacy/export', 'POST', P.headers);
  await call(
    EXPORT,
    'valid-rich-reader',
    'export a reader with rooms, Relics and Asks',
    {
      method: 'POST',
      url: '/v1/privacy/export',
      headers: A.headers,
      payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0 },
    },
  );

  const clearBody = {
    requestId: randomUUID(),
    expectedPrivacyEpoch: 0,
    confirmation: 'clear-scroll-history',
  };
  await credentialCases(CLEAR, {
    method: 'POST',
    url: '/v1/history/clear',
    payload: clearBody,
  });
  await call(CLEAR, 'wrong-confirmation', 'confirmation "yes"', {
    method: 'POST',
    url: '/v1/history/clear',
    headers: P.headers,
    payload: { ...clearBody, confirmation: 'yes' },
  });
  await call(CLEAR, 'missing-confirmation', 'no confirmation', {
    method: 'POST',
    url: '/v1/history/clear',
    headers: P.headers,
    payload: { requestId: clearBody.requestId, expectedPrivacyEpoch: 0 },
  });
  await call(CLEAR, 'extra-field', 'an extra key', {
    method: 'POST',
    url: '/v1/history/clear',
    headers: P.headers,
    payload: { ...clearBody, extra: 1 },
  });
  await call(CLEAR, 'stale-epoch', 'expectedPrivacyEpoch 7', {
    method: 'POST',
    url: '/v1/history/clear',
    headers: P.headers,
    payload: { ...clearBody, requestId: randomUUID(), expectedPrivacyEpoch: 7 },
  });
  await bodyCases(CLEAR, '/v1/history/clear', 'POST', P.headers);
  await call(CLEAR, 'valid', 'clear Scroll history', {
    method: 'POST',
    url: '/v1/history/clear',
    headers: P.headers,
    payload: clearBody,
  });
  await call(CLEAR, 'replay', 'exact replay', {
    method: 'POST',
    url: '/v1/history/clear',
    headers: P.headers,
    payload: clearBody,
  });
  await call(
    CLEAR,
    'conflict-key-other-epoch',
    'same request id, another expected epoch',
    {
      method: 'POST',
      url: '/v1/history/clear',
      headers: P.headers,
      payload: { ...clearBody, expectedPrivacyEpoch: 3 },
    },
  );
  await call(UNIVERSE, 'valid-after-clear', 'the epoch moved on', {
    url: '/v1/universe',
    headers: P.headers,
  });
  await call(
    EXPOSURES,
    'decision-from-older-epoch',
    'an exposure of a decision from before the clear',
    {
      method: 'POST',
      url: '/v1/exposures',
      headers: P.headers,
      payload: { ...preClearExposure, clientExposureId: randomUUID() },
    },
  );
  await call(
    ASKS,
    'exposure-from-older-epoch',
    'an Ask about an exposure from before the clear',
    {
      method: 'POST',
      url: '/v1/asks',
      headers: P.headers,
      payload: {
        clientAskId: randomUUID(),
        exposureId: exposureBeforeClear.exposureId,
        expectedPrivacyEpoch: 1,
        question: 'Asked after the clear?',
      },
    },
  );
  const postClearFeed = await feedOf(P);
  const postClearExposure = json(
    await app.inject({
      method: 'POST',
      url: '/v1/exposures',
      headers: P.headers,
      payload: {
        decisionId: postClearFeed.decisionId,
        assetId: postClearFeed.items[0].assetId,
        clientExposureId: randomUUID(),
      },
    }),
  );
  assert.ok(postClearExposure.exposureId);

  // Session revoke (a second session of the same universe), then Reset ends them all.
  const P2 = await reader(P.universeId);
  await credentialCases(REVOKE, {
    method: 'POST',
    url: '/v1/session/revoke',
    payload: {},
  });
  await call(REVOKE, 'non-empty-body', 'body {"x":1}', {
    method: 'POST',
    url: '/v1/session/revoke',
    headers: P2.headers,
    payload: { x: 1 },
  });
  await call(REVOKE, 'no-body', 'no body at all', {
    method: 'POST',
    url: '/v1/session/revoke',
    headers: P2.headers,
  });
  await call(REVOKE, 'array-body', 'body []', {
    method: 'POST',
    url: '/v1/session/revoke',
    headers: P2.headers,
    payload: [] as unknown as Record<string, unknown>,
  });
  await call(REVOKE, 'invalid-json', 'body "{bad"', {
    method: 'POST',
    url: '/v1/session/revoke',
    headers: { ...P2.headers, 'content-type': 'application/json' },
    payload: '{bad',
  });
  await call(REVOKE, 'valid', 'revoke the second session', {
    method: 'POST',
    url: '/v1/session/revoke',
    headers: P2.headers,
    payload: {},
  });
  await call(SESSION, 'revoked-session', 'the revoked session is gone', {
    url: '/v1/session',
    headers: P2.headers,
  });
  await call(REVOKE, 'again', 'revoke it again', {
    method: 'POST',
    url: '/v1/session/revoke',
    headers: P2.headers,
    payload: {},
  });
  const P3 = await reader(P.universeId);
  const P3Epoch = await P3.epoch();
  const resetBody = {
    requestId: randomUUID(),
    expectedPrivacyEpoch: P3Epoch,
    confirmation: 'reset-personal-universe',
  };
  await credentialCases(RESET, {
    method: 'POST',
    url: '/v1/privacy/reset',
    payload: resetBody,
  });
  await call(RESET, 'wrong-confirmation', 'confirmation "reset"', {
    method: 'POST',
    url: '/v1/privacy/reset',
    headers: P3.headers,
    payload: { ...resetBody, confirmation: 'reset' },
  });
  await call(RESET, 'missing-confirmation', 'no confirmation', {
    method: 'POST',
    url: '/v1/privacy/reset',
    headers: P3.headers,
    payload: { requestId: resetBody.requestId, expectedPrivacyEpoch: P3Epoch },
  });
  await call(RESET, 'stale-epoch', 'expectedPrivacyEpoch 99', {
    method: 'POST',
    url: '/v1/privacy/reset',
    headers: P3.headers,
    payload: {
      ...resetBody,
      requestId: randomUUID(),
      expectedPrivacyEpoch: 99,
    },
  });
  await bodyCases(RESET, '/v1/privacy/reset', 'POST', P3.headers);
  await call(RESET, 'valid', 'reset the personal universe', {
    method: 'POST',
    url: '/v1/privacy/reset',
    headers: P3.headers,
    payload: resetBody,
  });
  await call(
    RESET,
    'replay-after-session-ended',
    'the same call after Reset ended every session',
    {
      method: 'POST',
      url: '/v1/privacy/reset',
      headers: P3.headers,
      payload: resetBody,
    },
  );
  await call(SESSION, 'after-reset', "the reset reader's other session", {
    url: '/v1/session',
    headers: P.headers,
  });

  // ---- account deletion (last: it ends the owner account and every owner session) ------------
  const del = {
    requestId: randomUUID(),
    expectedPrivacyEpoch: 0,
    confirmation: 'delete-my-account-and-history',
  };
  const Z = await reader();
  await credentialCases(DELETE, {
    method: 'POST',
    url: '/v1/account/delete',
    payload: del,
  });
  await call(DELETE, 'no-account-bound', 'a universe with no account', {
    method: 'POST',
    url: '/v1/account/delete',
    headers: Z.headers,
    payload: del,
  });
  await call(DELETE, 'wrong-confirmation', 'confirmation "delete"', {
    method: 'POST',
    url: '/v1/account/delete',
    headers: Z.headers,
    payload: { ...del, confirmation: 'delete' },
  });
  await call(DELETE, 'missing-confirmation', 'no confirmation', {
    method: 'POST',
    url: '/v1/account/delete',
    headers: Z.headers,
    payload: { requestId: del.requestId, expectedPrivacyEpoch: 0 },
  });
  await call(DELETE, 'stale-epoch', 'expectedPrivacyEpoch 9', {
    method: 'POST',
    url: '/v1/account/delete',
    headers: Z.headers,
    payload: { ...del, expectedPrivacyEpoch: 9 },
  });
  await bodyCases(DELETE, '/v1/account/delete', 'POST', Z.headers);
  const ownerEpochNow: number = json(
    await app.inject({ url: '/v1/universe', headers: { cookie: web.cookie } }),
  ).privacyEpoch;
  await call(
    DELETE,
    'cookie-no-page-token',
    'cookie deletion without the page token',
    {
      method: 'POST',
      url: '/v1/account/delete',
      headers: { cookie: web.cookie, origin: ORIGIN },
      payload: { ...del, expectedPrivacyEpoch: ownerEpochNow },
    },
  );
  await call(
    DELETE,
    'cookie-stale-epoch',
    'cookie deletion with a stale epoch',
    {
      method: 'POST',
      url: '/v1/account/delete',
      headers: pageHeaders(),
      payload: { ...del, expectedPrivacyEpoch: ownerEpochNow + 4 },
    },
  );
  await call(
    DELETE,
    'valid-cookie',
    'delete the owner account by cookie (clears the cookie)',
    {
      method: 'POST',
      url: '/v1/account/delete',
      headers: pageHeaders(),
      payload: { ...del, expectedPrivacyEpoch: ownerEpochNow },
    },
  );
  await call(
    DELETE,
    'replay-after-session-ended',
    'the same call once the session is gone',
    {
      method: 'POST',
      url: '/v1/account/delete',
      headers: pageHeaders(),
      payload: { ...del, expectedPrivacyEpoch: ownerEpochNow },
    },
  );
  await call(
    SESSION,
    'owner-bearer-after-deletion',
    'the owner bearer session is gone too',
    { url: '/v1/session', headers: bearer(ownerBearer) },
  );
  await call(
    SESSION,
    'development-token-after-deletion',
    'the development session is gone too',
    { url: '/v1/session', headers: bearer(DEV_TOKEN) },
  );
  // A new sign-in starts a fresh account; revoke by cookie clears the cookie.
  const afterT = await issueToken();
  const afterWeb = await call(
    WS,
    'valid-after-deletion',
    'sign in again after the account was deleted',
    {
      method: 'POST',
      url: '/v1/auth/web-session',
      payload: { token: afterT },
    },
  );
  const again = sessionCookieOf(afterWeb);
  const againCsrf = json(afterWeb).csrfToken as string;
  normalizer.registerToken(againCsrf);
  await call(REVOKE, 'valid-cookie', 'sign out by cookie (clears the cookie)', {
    method: 'POST',
    url: '/v1/session/revoke',
    headers: {
      cookie: again.cookie,
      'x-csrf-token': againCsrf,
      origin: ORIGIN,
    },
    payload: {},
  });
  await call(
    REVOKE,
    'cookie-no-page-token',
    'sign out by cookie without the page token',
    {
      method: 'POST',
      url: '/v1/session/revoke',
      headers: { cookie: again.cookie, origin: ORIGIN },
      payload: {},
    },
  );
  // HEAD on every GET route: Fastify exposes it automatically and it must keep doing so.
  for (const route of routes.filter(
    (r) => r.startsWith('GET ') && r !== MEDIA,
  )) {
    const path = route.slice(4);
    const concrete = path
      .replace(':eventId', ID_A)
      .replace(':askId', ID_A)
      .replace(':assetId', ID_A)
      .replace(':decisionId', ID_A)
      .replace(':deltaId', ID_A)
      .replace(':roomId', ID_A)
      .replace(':relicId', ID_A)
      .replace(':sha256', 'abc');
    await call(
      `HEAD ${path}`,
      'no-credential',
      `HEAD ${concrete}, no credential`,
      { method: 'HEAD', url: concrete },
    );
  }
  await call('HEAD /health', 'valid', 'HEAD /health', {
    method: 'HEAD',
    url: '/health',
  });

  // ---- coverage ------------------------------------------------------------------------------
  lookup('GET /health');
  const covered = [...routesWithCases].filter((r) => r !== UNMATCHED).sort();
  const output = {
    meta: { probe: 'http-surface', version: 1 },
    routes,
    caseCounts: Object.fromEntries(
      routes.map((r) => [r, recorded.filter((c) => c.route === r).length]),
    ),
    cases: recorded,
  };
  await writeFile(process.env.PROBE_OUT!, stableStringify(output));
  const uncovered = routes.filter((r) => !covered.includes(r));
  const unregistered = covered.filter((r) => !routes.includes(r));
  assert.deepEqual(
    uncovered,
    [],
    `registered routes with no probe case: ${uncovered.join(', ')}`,
  );
  assert.deepEqual(
    unregistered,
    [],
    `probe cases for unregistered routes: ${unregistered.join(', ')}`,
  );
});
