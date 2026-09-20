/**
 * ADR-0027 / issue #106 — `AgentMailSender` in isolation, against a local fake AgentMail HTTP
 * server this file starts and stops itself. No test in this file ever omits both `baseUrl` and
 * `fetchImpl`: every test that performs a real HTTP round trip supplies an explicit loopback
 * `baseUrl` pointing at its own fixture, and the one test that checks the *default* host supplies
 * `fetchImpl` instead, so `globalThis.fetch` is never invoked and `api.agentmail.to` is never
 * reachable from this file by construction.
 *
 * Never asserts the fixture API key by printing it if a test fails; every comparison below reduces
 * to a boolean (`.includes(...)`) before assertion, matching `tests/signin-token.test.ts`'s house
 * convention of never letting a failure message itself leak the sensitive value under test.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { AgentMailSendError, AgentMailSender, describeSendFailure } from '../apps/api/src/agentmail-sender.ts';

const FIXTURE_API_KEY = 'sk-agentmail-fixture-secret-must-never-be-logged';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

interface Seen {
  method?: string;
  url?: string;
  authorization?: string;
  body?: unknown;
}

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
    setHandler: (next: Handler) => { handler = next; },
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

function jsonSuccess(res: ServerResponse, messageId = 'msg_fixture', threadId: string | null = 'thread_fixture') {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(threadId === null ? { message_id: messageId } : { message_id: messageId, thread_id: threadId }));
}

// -------------------------------------------------------------------------------------------
// Request shape: exact method/path (including the inbox id), a well-formed bearer header (never
// its value logged), and to/subject/text/html with the link present in both text and html.
// -------------------------------------------------------------------------------------------

test('sends an exact POST to the inbox path with a well-formed bearer header and the link in text and html', async (t) => {
  let seen: Seen = {};
  const server = await fixture((req, res, raw) => {
    seen = { method: req.method, url: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) };
    jsonSuccess(res);
  });
  t.after(server.close);

  const link = 'http://127.0.0.1:4406/v1/auth/confirm?token=fixture-token-abc123';
  const sender = new AgentMailSender({ apiKey: FIXTURE_API_KEY, inboxId: 'inbox-fixture-1', baseUrl: server.baseUrl });
  await sender.send({ to: 'owner@example.test', link });

  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/v0/inboxes/inbox-fixture-1/messages/send');
  // Asserts the header's *shape* only; its value is never printed by this assertion or logged.
  assert.match(seen.authorization ?? '', /^Bearer \S+$/);
  assert.equal(seen.authorization, `Bearer ${FIXTURE_API_KEY}`);
  const body = seen.body as { to: string; subject: string; text: string; html: string };
  assert.equal(body.to, 'owner@example.test');
  assert.equal(typeof body.subject, 'string');
  assert.ok(body.subject.length > 0);
  assert.ok(body.text.includes(link));
  assert.ok(body.html.includes(link));
  assert.equal(server.requests(), 1);
  assert.deepEqual(sender.lastDelivery, { messageId: 'msg_fixture', threadId: 'thread_fixture' });
});

test('URL-encodes an inbox id that needs it (e.g. an email-shaped inbox id)', async (t) => {
  let seenUrl = '';
  const server = await fixture((req, res) => { seenUrl = req.url ?? ''; jsonSuccess(res); });
  t.after(server.close);
  const sender = new AgentMailSender({ apiKey: FIXTURE_API_KEY, inboxId: 'knowscroll@agentmail.to', baseUrl: server.baseUrl });
  await sender.send({ to: 'owner@example.test', link: 'http://x/confirm?token=t' });
  assert.equal(seenUrl, '/v0/inboxes/knowscroll%40agentmail.to/messages/send');
});

test('a success response without a thread_id still records the message id', async (t) => {
  const server = await fixture((_req, res) => jsonSuccess(res, 'msg_only', null));
  t.after(server.close);
  const sender = new AgentMailSender({ apiKey: FIXTURE_API_KEY, inboxId: 'inbox', baseUrl: server.baseUrl });
  await sender.send({ to: 'owner@example.test', link: 'http://x/confirm?token=t' });
  assert.deepEqual(sender.lastDelivery, { messageId: 'msg_only', threadId: null });
});

// -------------------------------------------------------------------------------------------
// Non-2xx statuses: reported through the closed AgentMailSendError shape, never thrown as
// something else, and never retried.
// -------------------------------------------------------------------------------------------

for (const status of [400, 401, 500]) {
  test(`HTTP ${status} is reported as http_error with the exact status, without retrying`, async (t) => {
    const server = await fixture((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'fixture_error' }));
    });
    t.after(server.close);
    const sender = new AgentMailSender({ apiKey: FIXTURE_API_KEY, inboxId: 'inbox', baseUrl: server.baseUrl });
    await assert.rejects(
      () => sender.send({ to: 'owner@example.test', link: 'http://x/confirm?token=t' }),
      (error: unknown) => {
        assert.ok(error instanceof AgentMailSendError);
        assert.equal(error.reason, 'http_error');
        assert.equal(error.httpStatus, status);
        return true;
      },
    );
    assert.equal(server.requests(), 1, 'exactly one attempt — no automatic retry');
  });
}

test('a non-2xx body carrying a message_id is still reported with that id for operator debugging', async (t) => {
  const server = await fixture((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'fixture_error', message_id: 'msg_on_error' }));
  });
  t.after(server.close);
  const sender = new AgentMailSender({ apiKey: FIXTURE_API_KEY, inboxId: 'inbox', baseUrl: server.baseUrl });
  await assert.rejects(
    () => sender.send({ to: 'owner@example.test', link: 'http://x/confirm?token=t' }),
    (error: unknown) => {
      assert.ok(error instanceof AgentMailSendError);
      assert.equal(error.messageId, 'msg_on_error');
      return true;
    },
  );
});

// -------------------------------------------------------------------------------------------
// Malformed / non-JSON bodies: a 2xx status that cannot be trusted is a failure, not a thrown
// parse error and not a false success.
// -------------------------------------------------------------------------------------------

test('a 2xx response with a non-JSON body is malformed_response, never a thrown parse error', async (t) => {
  const server = await fixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('not json at all');
  });
  t.after(server.close);
  const sender = new AgentMailSender({ apiKey: FIXTURE_API_KEY, inboxId: 'inbox', baseUrl: server.baseUrl });
  await assert.rejects(
    () => sender.send({ to: 'owner@example.test', link: 'http://x/confirm?token=t' }),
    (error: unknown) => {
      assert.ok(error instanceof AgentMailSendError);
      assert.equal(error.reason, 'malformed_response');
      assert.equal(error.httpStatus, 200);
      return true;
    },
  );
});

test('a 2xx response whose JSON lacks a usable message_id is also malformed_response', async (t) => {
  const server = await fixture((_req, res) => {
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  t.after(server.close);
  const sender = new AgentMailSender({ apiKey: FIXTURE_API_KEY, inboxId: 'inbox', baseUrl: server.baseUrl });
  await assert.rejects(
    () => sender.send({ to: 'owner@example.test', link: 'http://x/confirm?token=t' }),
    (error: unknown) => {
      assert.ok(error instanceof AgentMailSendError);
      assert.equal(error.reason, 'malformed_response');
      assert.equal(error.httpStatus, 202);
      return true;
    },
  );
});

// -------------------------------------------------------------------------------------------
// Connection refusal and timeout: transport-level failures, bounded, never thrown out uncaught.
// -------------------------------------------------------------------------------------------

test('a connection refusal is reported as network_error', async () => {
  // Nothing listens on 127.0.0.1:1 in this environment (an unprivileged process cannot bind a
  // reserved low port), so this reaches an actual refusal rather than a real fixture.
  const sender = new AgentMailSender({ apiKey: FIXTURE_API_KEY, inboxId: 'inbox', baseUrl: 'http://127.0.0.1:1' });
  await assert.rejects(
    () => sender.send({ to: 'owner@example.test', link: 'http://x/confirm?token=t' }),
    (error: unknown) => {
      assert.ok(error instanceof AgentMailSendError);
      assert.equal(error.reason, 'network_error');
      assert.equal(error.httpStatus, null);
      return true;
    },
  );
});

test('a stalled connection is bounded by the configured timeout', { timeout: 5_000 }, async (t) => {
  let arrived!: () => void;
  const requestArrived = new Promise<void>((resolve) => { arrived = resolve; });
  const server = await fixture((_req, _res) => { arrived(); /* never responds */ });
  t.after(server.close);
  const sender = new AgentMailSender({ apiKey: FIXTURE_API_KEY, inboxId: 'inbox', baseUrl: server.baseUrl, timeoutMs: 150 });
  const pending = sender.send({ to: 'owner@example.test', link: 'http://x/confirm?token=t' });
  await requestArrived;
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof AgentMailSendError);
    assert.equal(error.reason, 'timeout');
    assert.equal(error.httpStatus, null);
    return true;
  });
});

test('a response that stalls after its headers is bounded by the same timeout', { timeout: 5_000 }, async (t) => {
  // The dangerous shape is not a connection that never answers -- it is one that answers, so
  // `fetch` resolves, and then stalls mid-body. The sign-in route awaits `send()`, so an unbounded
  // body read would hold an unauthenticated request open indefinitely. The timeout must cover the
  // whole exchange, not just the headers.
  let arrived!: () => void;
  const requestArrived = new Promise<void>((resolve) => { arrived = resolve; });
  const server = await fixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"message_id":"msg_partial'); // headers sent, body never finished
    arrived();
  });
  t.after(server.close);
  const sender = new AgentMailSender({ apiKey: FIXTURE_API_KEY, inboxId: 'inbox', baseUrl: server.baseUrl, timeoutMs: 150 });
  const pending = sender.send({ to: 'owner@example.test', link: 'http://x/confirm?token=t' });
  await requestArrived;
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof AgentMailSendError);
    assert.equal(error.reason, 'timeout');
    return true;
  });
});

test('a real 3xx with a Location header is refused, not followed', async (t) => {
  // The request-init option alone does not prove the guarantee. A provider (or anything sitting in
  // front of it) answering a redirect must not cause a second request carrying the bearer key and
  // the link to somewhere else: the redirect is an ordinary failed send.
  const server = await fixture((req, res) => {
    if (req.url?.endsWith('/messages/send')) {
      res.writeHead(302, { location: '/redirected-target' });
      res.end();
      return;
    }
    jsonSuccess(res);
  });
  t.after(server.close);
  const sender = new AgentMailSender({ apiKey: FIXTURE_API_KEY, inboxId: 'inbox', baseUrl: server.baseUrl });
  await assert.rejects(
    sender.send({ to: 'owner@example.test', link: 'http://x/confirm?token=t' }),
    (error: unknown) => {
      assert.ok(error instanceof AgentMailSendError);
      assert.notEqual(error.reason, 'malformed_response'); // it never reached a success body
      return true;
    },
  );
  assert.equal(server.requests(), 1, 'the redirect target must never be requested');
  assert.equal(sender.lastDelivery, null);
});

// -------------------------------------------------------------------------------------------
// Base URL: defaults to the real host, verified without ever calling the network.
// -------------------------------------------------------------------------------------------

test('defaults to the real AgentMail host, verified with an injected fetch stub that never touches the network', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({ message_id: 'm' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const sender = new AgentMailSender({ apiKey: FIXTURE_API_KEY, inboxId: 'knowscroll', fetchImpl });
  await sender.send({ to: 'owner@example.test', link: 'http://x/confirm?token=t' });

  assert.equal(capturedUrl, 'https://api.agentmail.to/v0/inboxes/knowscroll/messages/send');
  assert.equal(capturedInit?.redirect, 'manual');
  assert.equal(capturedInit?.method, 'POST');
});

// -------------------------------------------------------------------------------------------
// Silence discipline: nothing this module ever throws contains the key, the address, the token
// or the link, across every failure mode above.
// -------------------------------------------------------------------------------------------

test('nothing a failed send throws ever contains the key, the address, the token or the link', async (t) => {
  const to = 'owner-secret-address@example.test';
  const token = 'token-fixture-9f8e7d6c5b4a';
  const link = `http://127.0.0.1:4406/v1/auth/confirm?token=${token}`;
  const sensitive = [FIXTURE_API_KEY, to, token, link];

  // Synchronous by design: `assert.rejects`'s validation callback is checked for a truthy return
  // value, never awaited, so this must not be an `async` function (which would always return a
  // pending Promise object — itself truthy, but never actually exercising these assertions).
  function assertSilent(error: unknown): true {
    const rendered = [
      JSON.stringify(describeSendFailure(error)),
      String(error),
      error instanceof Error ? (error.stack ?? '') : '',
    ].join('\n');
    for (const value of sensitive) {
      assert.equal(rendered.includes(value), false, `leaked a sensitive value via ${value.slice(0, 8)}...`);
    }
    return true;
  }

  const httpErrorServer = await fixture((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'fixture_error' }));
  });
  t.after(httpErrorServer.close);
  await assert.rejects(new AgentMailSender({ apiKey: FIXTURE_API_KEY, inboxId: 'inbox', baseUrl: httpErrorServer.baseUrl })
    .send({ to, link }), assertSilent);

  const malformedServer = await fixture((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('nope'); });
  t.after(malformedServer.close);
  await assert.rejects(new AgentMailSender({ apiKey: FIXTURE_API_KEY, inboxId: 'inbox', baseUrl: malformedServer.baseUrl })
    .send({ to, link }), assertSilent);

  await assert.rejects(new AgentMailSender({ apiKey: FIXTURE_API_KEY, inboxId: 'inbox', baseUrl: 'http://127.0.0.1:1' })
    .send({ to, link }), assertSilent);
});
