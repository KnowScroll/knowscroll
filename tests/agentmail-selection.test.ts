/**
 * ADR-0027 section 4 / issue #106 — `createMagicLinkSender()`'s `KS_MAIL_SENDER` selection: the
 * development sink remains the unset-outside-production default, `'agentmail'` can be selected
 * explicitly anywhere, an unrecognized value is a configuration error rather than a silent
 * fallback, and production requires `'agentmail'` fully configured with **no** path back to the
 * sink. Pure unit tests of the selection function itself — no database, no HTTP except the one
 * end-to-end wiring check at the bottom, which uses a local fixture server, never the real host.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { AgentMailSender } from '../apps/api/src/agentmail-sender.ts';
import { createMagicLinkSender, DevelopmentMagicLinkSink } from '../apps/api/src/magic-link-sender.ts';

const SCRATCH_DEV_ROOT = '/tmp/ks-agentmail-selection-scratch'; // never written to — construction alone never touches disk.

// -------------------------------------------------------------------------------------------
// Outside production: dev-sink is the default; agentmail is available on request.
// -------------------------------------------------------------------------------------------

test('defaults to the development sink outside production when KS_MAIL_SENDER is unset', () => {
  const sender = createMagicLinkSender({ KS_DEV_ROOT: SCRATCH_DEV_ROOT });
  assert.ok(sender instanceof DevelopmentMagicLinkSink);
});

test("an explicit 'dev-sink' selection behaves exactly like the default", () => {
  const sender = createMagicLinkSender({ KS_MAIL_SENDER: 'dev-sink', KS_DEV_ROOT: SCRATCH_DEV_ROOT });
  assert.ok(sender instanceof DevelopmentMagicLinkSink);
});

test('an unrecognized KS_MAIL_SENDER value is a configuration error, never a silent fallback', () => {
  assert.throws(() => createMagicLinkSender({ KS_MAIL_SENDER: 'smtp', KS_DEV_ROOT: SCRATCH_DEV_ROOT }), /KS_MAIL_SENDER/);
});

test("selecting 'agentmail' outside production still requires both AGENTMAIL_API_KEY and AGENTMAIL_INBOX_ID", () => {
  assert.throws(() => createMagicLinkSender({ KS_MAIL_SENDER: 'agentmail' }), /AGENTMAIL_API_KEY/);
  assert.throws(() => createMagicLinkSender({ KS_MAIL_SENDER: 'agentmail' }), /AGENTMAIL_INBOX_ID/);
  assert.throws(() => createMagicLinkSender({ KS_MAIL_SENDER: 'agentmail', AGENTMAIL_API_KEY: 'k' }), /AGENTMAIL_INBOX_ID/);
  assert.throws(() => createMagicLinkSender({ KS_MAIL_SENDER: 'agentmail', AGENTMAIL_INBOX_ID: 'inbox' }), /AGENTMAIL_API_KEY/);
});

test("selecting 'agentmail' outside production with both variables present constructs the real sender", () => {
  const sender = createMagicLinkSender({ KS_MAIL_SENDER: 'agentmail', AGENTMAIL_API_KEY: 'k', AGENTMAIL_INBOX_ID: 'inbox' });
  assert.ok(sender instanceof AgentMailSender);
});

test('AGENTMAIL_TIMEOUT_MS, if set, must be a positive number', () => {
  assert.throws(
    () => createMagicLinkSender({ KS_MAIL_SENDER: 'agentmail', AGENTMAIL_API_KEY: 'k', AGENTMAIL_INBOX_ID: 'inbox', AGENTMAIL_TIMEOUT_MS: '0' }),
    /AGENTMAIL_TIMEOUT_MS/,
  );
  assert.throws(
    () => createMagicLinkSender({ KS_MAIL_SENDER: 'agentmail', AGENTMAIL_API_KEY: 'k', AGENTMAIL_INBOX_ID: 'inbox', AGENTMAIL_TIMEOUT_MS: 'nope' }),
    /AGENTMAIL_TIMEOUT_MS/,
  );
  const sender = createMagicLinkSender({ KS_MAIL_SENDER: 'agentmail', AGENTMAIL_API_KEY: 'k', AGENTMAIL_INBOX_ID: 'inbox', AGENTMAIL_TIMEOUT_MS: '500' });
  assert.ok(sender instanceof AgentMailSender);
});

// -------------------------------------------------------------------------------------------
// Production: agentmail is required; there is never a path back to the development sink.
// -------------------------------------------------------------------------------------------

test('production without an explicit agentmail selection refuses to start, never falling back to the sink', () => {
  assert.throws(
    () => createMagicLinkSender({ NODE_ENV: 'production', KS_DEV_ROOT: SCRATCH_DEV_ROOT }),
    /No MagicLinkSender is configured for production/,
  );
  assert.throws(
    () => createMagicLinkSender({ NODE_ENV: 'production', KS_MAIL_SENDER: 'dev-sink', KS_DEV_ROOT: SCRATCH_DEV_ROOT }),
    /No MagicLinkSender is configured for production/,
  );
});

test('production with agentmail selected but missing key/inbox still refuses to start (no fallback)', () => {
  assert.throws(
    () => createMagicLinkSender({ NODE_ENV: 'production', KS_MAIL_SENDER: 'agentmail' }),
    /AGENTMAIL_API_KEY/,
  );
  // Confirms the refusal is a thrown configuration error, not a quietly-returned dev sink.
  assert.throws(
    () => createMagicLinkSender({ NODE_ENV: 'production', KS_MAIL_SENDER: 'agentmail', KS_DEV_ROOT: SCRATCH_DEV_ROOT }),
    (error: unknown) => error instanceof Error && !/No MagicLinkSender is configured for production/.test(error.message),
  );
});

test('production with agentmail fully configured constructs the real sender, never the development sink', () => {
  const sender = createMagicLinkSender({
    NODE_ENV: 'production',
    KS_MAIL_SENDER: 'agentmail',
    AGENTMAIL_API_KEY: 'k',
    AGENTMAIL_INBOX_ID: 'inbox',
  });
  assert.ok(sender instanceof AgentMailSender);
  assert.equal(sender instanceof DevelopmentMagicLinkSink, false);
});

// -------------------------------------------------------------------------------------------
// End-to-end wiring: AGENTMAIL_BASE_URL threads through selection to the constructed sender,
// reaching only a local fixture — never the real AgentMail host.
// -------------------------------------------------------------------------------------------

test('AGENTMAIL_BASE_URL selected through createMagicLinkSender reaches the local fixture, not the real host', async () => {
  let seenUrl = '';
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seenUrl = req.url ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message_id: 'm' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${(address as { port: number }).port}`;

  try {
    const sender = createMagicLinkSender({
      KS_MAIL_SENDER: 'agentmail',
      AGENTMAIL_API_KEY: 'k',
      AGENTMAIL_INBOX_ID: 'wired-inbox',
      AGENTMAIL_BASE_URL: baseUrl,
    });
    await sender.send({ to: 'owner@example.test', link: 'http://x/confirm?token=t' });
    assert.equal(seenUrl, '/v0/inboxes/wired-inbox/messages/send');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
