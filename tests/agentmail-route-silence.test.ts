/**
 * ADR-0027 / issue #106 — `POST /v1/auth/magic-link` wired to the real `AgentMailSender`, pointed
 * at a local fake AgentMail HTTP server this file starts and stops itself. Never reaches
 * `api.agentmail.to`.
 *
 * `resolvedSender()` in `sign-in-routes.ts` reads `process.env` lazily and caches **only on a
 * successful construction** (a throw inside `createMagicLinkSender()` is never cached, so the next
 * call re-resolves from whatever the environment is at that moment); and `requestMagicLink()` only
 * calls the sender at all for the configured **owner** address — a non-owner request never reaches
 * `resolvedSender()`. So every app below is "bound" to its target `AGENTMAIL_BASE_URL` by making
 * its *first owner-address* `/v1/auth/magic-link` call while that app's own environment values are
 * current (`bindApp()`); once that first call has resolved a sender successfully, later changes to
 * `process.env` for a *different* app can never retroactively move an already-cached instance.
 *
 * Proves: the route's `202 {"status":"requested"}` is byte-identical whether the fake server
 * accepts or refuses the send; the fake server sees exactly one request per magic-link call (no
 * automatic retry) regardless of outcome; a send failure is recorded for the operator with a
 * status/reason/message id and nothing else; and nothing this route logs during a failing send
 * ever contains the owner address, the issued token, the confirmation link or the configured key.
 *
 * Runs against the outer test.sh-managed disposable database via the shared `pool`, exactly like
 * `tests/signin-http.test.ts`, and signs in as the same owner address (`tests/helpers/owner-address.ts`)
 * so it reuses the same single-row owner account rather than trying to create a second one.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { after, test } from 'node:test';
import { buildApp } from '../apps/api/src/app.ts';
import { pool } from '../packages/db/src/index.ts';
import { resolveOwnerEmail } from '../packages/db/src/sign-in.ts';
import { useTestOwnerEmail } from './helpers/owner-address.ts';

useTestOwnerEmail();

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) {
  throw new Error('AgentMail route tests require an isolated knowscroll_test_* database');
}

const OWNER_EMAIL = resolveOwnerEmail();
const FIXTURE_API_KEY = 'sk-agentmail-route-fixture-secret-must-never-be-logged';
const FIXTURE_INBOX_ID = 'knowscroll-route-fixture-inbox';
const GENEROUS_LIMITS = { accountWindowMinutes: 15, accountMaxPerWindow: 5000, fingerprintWindowMinutes: 15, fingerprintMaxPerWindow: 5000 };

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(initial: Handler) {
  let handler = initial;
  let requestCount = 0;
  const server = createServer((req, res) => {
    requestCount += 1;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${(address as { port: number }).port}`,
    requests: () => requestCount,
    resetRequests: () => { requestCount = 0; },
    setHandler: (next: Handler) => { handler = next; },
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

function succeed(res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ message_id: 'msg_route_fixture', thread_id: 'thread_route_fixture' }));
}

function requestLink(app: ReturnType<typeof buildApp>, email: string) {
  return app.inject({ method: 'POST', url: '/v1/auth/magic-link', payload: { email } });
}

/**
 * Builds an app and immediately fires the one owner-address request that resolves and permanently
 * caches its `AgentMailSender`, bound to exactly this call's environment (see file header). Returns
 * both the app and that first response, since for the connection-refusal and timeout scenarios the
 * bind call *is* the test — there is nothing else to exercise once the sender is already fixed
 * against an address that will keep behaving the same way.
 */
async function bindApp(devToken: string, env: { baseUrl: string; timeoutMs?: string }) {
  process.env.KS_MAIL_SENDER = 'agentmail';
  process.env.AGENTMAIL_API_KEY = FIXTURE_API_KEY;
  process.env.AGENTMAIL_INBOX_ID = FIXTURE_INBOX_ID;
  process.env.AGENTMAIL_BASE_URL = env.baseUrl;
  if (env.timeoutMs === undefined) delete process.env.AGENTMAIL_TIMEOUT_MS;
  else process.env.AGENTMAIL_TIMEOUT_MS = env.timeoutMs;

  const app = buildApp(devToken, { magicLinkLimits: GENEROUS_LIMITS });
  await app.ready();
  const bindResponse = await requestLink(app, OWNER_EMAIL);
  return { app, bindResponse };
}

// -------------------------------------------------------------------------------------------
// Primary app: bound to this mutable-handler fixture; used for every scenario that only changes
// what the fake server *replies*, never which address it is.
// -------------------------------------------------------------------------------------------

const mainServer: Fixture = await fixture((_req, res) => succeed(res));
const cleanupFns: Array<() => Promise<void>> = [mainServer.close];
after(async () => {
  await pool.end();
  for (const fn of cleanupFns) await fn();
});

const { app: mainApp, bindResponse: mainBindResponse } = await bindApp('a'.repeat(32), { baseUrl: mainServer.baseUrl });
cleanupFns.push(async () => mainApp.close());
assert.equal(mainBindResponse.statusCode, 202, 'binding call itself must already answer 202');
mainServer.resetRequests();

test('the 202 is byte-identical whether the fake AgentMail server accepts or refuses the send', async () => {
  mainServer.setHandler((_req, res) => succeed(res));
  const success = await requestLink(mainApp, OWNER_EMAIL);

  mainServer.setHandler((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'fixture_error' }));
  });
  const failure = await requestLink(mainApp, OWNER_EMAIL);

  assert.equal(success.statusCode, 202);
  assert.equal(failure.statusCode, 202);
  assert.equal(success.body, failure.body);
  assert.deepEqual(success.json(), { status: 'requested' });
});

for (const status of [400, 401, 500]) {
  test(`HTTP ${status} from AgentMail never changes the 202, and the fixture sees exactly one request`, async () => {
    mainServer.resetRequests();
    mainServer.setHandler((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'fixture_error' }));
    });
    const response = await requestLink(mainApp, OWNER_EMAIL);
    assert.equal(response.statusCode, 202);
    assert.deepEqual(response.json(), { status: 'requested' });
    assert.equal(mainServer.requests(), 1, 'no automatic retry');
  });
}

test('a malformed (non-JSON) 2xx body from AgentMail never changes the 202', async () => {
  mainServer.resetRequests();
  mainServer.setHandler((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('not json');
  });
  const response = await requestLink(mainApp, OWNER_EMAIL);
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { status: 'requested' });
  assert.equal(mainServer.requests(), 1);
});

// -------------------------------------------------------------------------------------------
// Connection refusal and timeout: each gets its own app, bound once, since the bind call itself
// already exercises the scenario (see `bindApp()`'s doc comment).
// -------------------------------------------------------------------------------------------

test('a connection refusal (AgentMail unreachable) never changes the 202', async () => {
  // Nothing listens on 127.0.0.1:1 in this environment.
  const { app, bindResponse } = await bindApp('b'.repeat(32), { baseUrl: 'http://127.0.0.1:1' });
  try {
    assert.equal(bindResponse.statusCode, 202);
    assert.deepEqual(bindResponse.json(), { status: 'requested' });
  } finally {
    await app.close();
  }
});

test('a stalled AgentMail connection (timeout) never changes the 202', { timeout: 5_000 }, async () => {
  let arrived!: () => void;
  const requestArrived = new Promise<void>((resolve) => { arrived = resolve; });
  const stalledServer = await fixture((_req, _res) => { arrived(); /* never responds */ });
  try {
    const bound = bindApp('c'.repeat(32), { baseUrl: stalledServer.baseUrl, timeoutMs: '150' });
    await requestArrived;
    const { app, bindResponse } = await bound;
    try {
      assert.equal(bindResponse.statusCode, 202);
      assert.deepEqual(bindResponse.json(), { status: 'requested' });
    } finally {
      await app.close();
    }
  } finally {
    await stalledServer.close();
  }
});

// -------------------------------------------------------------------------------------------
// Silence discipline at the route: a failing send is recorded for the operator with only a
// status/reason/message id, and everything sensitive stays absent from what is logged.
// -------------------------------------------------------------------------------------------

test('a failing send is recorded for the operator without the address, the token, the link or the key', async () => {
  mainServer.resetRequests();
  mainServer.setHandler((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_key' }));
  });

  const captured: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
  let response: Awaited<ReturnType<typeof requestLink>>;
  try {
    response = await requestLink(mainApp, OWNER_EMAIL);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.statusCode, 202);
  assert.equal(captured.length, 1, 'exactly one operator log line for the failing send');
  const line = captured[0]!;
  const parsed = JSON.parse(line) as { service: string; event: string; httpStatus: number; reason: string; messageId: string | null };
  assert.equal(parsed.service, 'api');
  assert.equal(parsed.event, 'magic_link_send_failed');
  assert.equal(parsed.httpStatus, 401);
  assert.equal(parsed.reason, 'http_error');

  assert.equal(line.includes(OWNER_EMAIL), false, 'must never log the address');
  assert.equal(line.includes(FIXTURE_API_KEY), false, 'must never log the key');
  assert.equal(/[A-Za-z0-9_-]{32,}/.test(line.replace(/msg_route_fixture|thread_route_fixture/g, '')), false, 'must never log a token/link-shaped opaque string');
});

test('nothing logged across a run of every failure mode ever contains the address, a token, a link or the key', async () => {
  mainServer.resetRequests();
  const scenarios: Array<() => void> = [
    () => mainServer.setHandler((_req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'bad_request' })); }),
    () => mainServer.setHandler((_req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); }),
    () => mainServer.setHandler((_req, res) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'internal' })); }),
    () => mainServer.setHandler((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('not json'); }),
  ];

  const captured: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
  try {
    for (const scenario of scenarios) {
      scenario();
      const response = await requestLink(mainApp, OWNER_EMAIL);
      assert.equal(response.statusCode, 202);
    }
  } finally {
    console.error = originalConsoleError;
  }

  // This route issues a fresh token/link per request but never returns or exposes either to this
  // suite (by design — the development sink is not the configured sender here); the check below
  // instead asserts the *shape* no confirmation link could avoid matching (an opaque
  // `token=`-bearing query string against this route's own confirm path), which is a stronger,
  // address-independent guarantee than comparing against one specific captured value.
  const combined = captured.join('\n');
  assert.equal(combined.includes(OWNER_EMAIL), false);
  assert.equal(combined.includes(FIXTURE_API_KEY), false);
  assert.equal(combined.includes('token='), false, 'must never log a confirmation link');
  assert.equal(combined.includes('/v1/auth/confirm'), false, 'must never log a confirmation link');
});
