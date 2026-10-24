/** The installed API and a real PostgreSQL: conversations over HTTP, live hints over Socket.IO, share landing pages. */
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEVELOPMENT_SESSION_COOKIE_NAME,
  SOCKET_PATH,
  ScopeChangedHintSchema,
  SocialProblemSchema,
  socketEvents,
  type DirectConversationRef,
  type ScopeChangedHint,
} from '@knowscroll/contracts';
import { createDatabase, type Database, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import { apiClient } from '../support/api-client.js';
import { createEmptyDatabase } from '../support/empty-database.js';
import { seedKeepSessions } from '../support/keep-fixture.js';
import { freePort, startReleaseProcess, waitForHttp, type ReleaseProcess } from '../support/processes.js';
import { pairRevision, seedContent, seedFriends, talkCases, type Friend } from '../support/talk.js';

const version = 'direct-conversation.v1' as const;
const shareVersion = 'content-share.v1' as const;
const messageCanary = 'PRIVATE-MESSAGE-BODY-CANARY';

type Person = Friend & { tokens: Awaited<ReturnType<typeof seedKeepSessions>> };

describe('conversations, live hints and share links over the installed API (disposable accounts)', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let db: DatabaseHandle<Database>;
  let api: ReleaseProcess;
  let origin: string;
  let a: Person;
  let b: Person;
  let aRef: DirectConversationRef;
  let bRef: DirectConversationRef;
  const sockets: Socket[] = [];
  const secrets = new Set<string>();

  beforeAll(async () => {
    database = await createEmptyDatabase('conversations_http');
    expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' }).exited()).toBe(
      0,
    );
    db = createDatabase<Database>(
      { url: database.url, applicationName: 'ci-conversations-http', poolMax: 5, statementTimeoutMs: 15000 },
      { onIdleClientError: () => undefined },
    );
    origin = `http://127.0.0.1:${await freePort()}`;
    api = startReleaseProcess('api', 'main', {
      NODE_ENV: 'test',
      KS_WORLD: 'ci',
      DATABASE_URL: database.url,
      PORT: new URL(origin).port,
      KS_PUBLIC_ORIGIN: origin,
      KS_AUTH_ADAPTER: 'session',
      KS_MAIL_SENDER: 'fixture',
      AGENTMAIL_API_KEY: 'fixture-not-key',
      AGENTMAIL_INBOX_ID: 'fixture@agentmail.invalid',
      KS_SCOPE_LOCK_TIMEOUT_MS: '5000',
      KS_SHUTDOWN_GRACE_SECONDS: '10',
    });
    await api.waitForEvent('process.started');
    await waitForHttp(origin + '/health');
    const cases = talkCases(db.db, { now: new Date() });
    const friends = await seedFriends(db.db, cases.friends);
    const withSessions = async (friend: Friend): Promise<Person> => {
      const tokens = await seedKeepSessions(db.db, friend);
      secrets.add(tokens.native);
      secrets.add(tokens.web);
      return { ...friend, tokens };
    };
    a = await withSessions(friends.a);
    b = await withSessions(friends.b);
    // Friends are made by the use cases; everything after goes over HTTP.
    const startFor = async (actor: Person, peer: Person) =>
      (
        await clientOf(actor).conversations.start({
          version,
          commandId: randomUUID(),
          peerPersonId: peer.person.personId,
          expectedPairRevision: await pairRevision(cases.friends, actor, peer),
        })
      ).conversation;
    aRef = await startFor(a, b);
    bRef = await startFor(b, a);
  });

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    try {
      expect(await api.stop()).toBe(0);
      for (const secret of secrets) expect(api.rawOutput()).not.toContain(secret);
      expect(api.rawOutput()).not.toContain(messageCanary);
      expect(api.records.filter((record) => record.event === 'http.unexpected_error')).toEqual([]);
    } finally {
      await db.close();
      await database.drop();
    }
  });

  const scopeOf = (person: Person) => `${person.accountId}:1`;
  const clientOf = (person: Person) => apiClient(origin, `Bearer ${person.tokens.native}`, scopeOf(person));
  const cookieHeaders = (person: Person) => ({ cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=${person.tokens.web}` });
  const text = (value: string) => ({ kind: 'text' as const, text: value });

  function connect(person: Person): Socket {
    const socket = io(origin, {
      path: SOCKET_PATH,
      transports: ['websocket'],
      auth: { token: person.tokens.native, scope: scopeOf(person) },
      reconnection: false,
    });
    sockets.push(socket);
    return socket;
  }
  async function connected(socket: Socket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
  }
  const nextHint = (socket: Socket) =>
    new Promise<ScopeChangedHint>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no hint within 5s')), 5000);
      socket.once(socketEvents.scopeChanged, (raw: unknown) => {
        clearTimeout(timer);
        resolve(ScopeChangedHintSchema.parse(raw));
      });
    });

  it('delivers a message from one account to the other over HTTP, with the contract-shaped answers', async () => {
    const commandId = randomUUID();
    const body = { version, commandId, conversation: aRef, body: text(`hello ${messageCanary}`) };
    const sent = await clientOf(a).conversations.send(body);
    expect(sent).toMatchObject({ operation: 'message.send', messageSequence: 1, replayed: false });
    expect(await clientOf(a).conversations.send(body)).toMatchObject({ messageId: sent.messageId, replayed: true });

    const inbox = await clientOf(b).conversations.inbox({ version, readId: randomUUID(), limit: 20 });
    if (inbox.status !== 'ready') throw new Error('CI inbox');
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]?.peer.personId).toBe(a.person.personId);
    const snapshot = await clientOf(b).conversations.read({
      version,
      readId: randomUUID(),
      conversation: bRef,
      limit: 20,
    });
    if (snapshot.status !== 'ready') throw new Error('CI snapshot');
    expect(snapshot.messages[0]).toMatchObject({ body: { kind: 'text', text: `hello ${messageCanary}` } });
    expect(
      await clientOf(b).conversations.markRead({
        version,
        commandId: randomUUID(),
        conversation: bRef,
        throughSequence: 1,
      }),
    ).toMatchObject({ acceptedThroughSequence: 1 });
  });

  it('refuses a stranger and an unauthenticated caller without saying why', async () => {
    const stranger = (await seedFriends(db.db, talkCases(db.db).friends)).a;
    const strangerToken = await seedKeepSessions(db.db, stranger);
    secrets.add(strangerToken.native);
    const asStranger = apiClient(origin, `Bearer ${strangerToken.native}`, `${stranger.accountId}:1`);
    expect(
      await asStranger.conversations.read({ version, readId: randomUUID(), conversation: aRef, limit: 5 }),
    ).toMatchObject({ status: 'unavailable' });
    const refused = await fetch(origin + '/v1/social/conversations/send', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${strangerToken.native}`,
        'x-ks-scope': `${stranger.accountId}:1`,
      },
      body: JSON.stringify({ version, commandId: randomUUID(), conversation: aRef, body: text('hi') }),
    });
    expect(refused.headers.get('content-type')).toBe('application/problem+json');
    expect(refused.headers.get('cache-control')).toBe('private, no-store');
    const problem = SocialProblemSchema.parse(await refused.json());
    expect(problem.code).toBe('SHARING_UNAVAILABLE');

    const anonymous = await fetch(origin + '/v1/social/conversations/inbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version, readId: randomUUID(), limit: 5 }),
    });
    expect(anonymous.status).toBe(401);
    const wrongScope = await fetch(origin + '/v1/social/conversations/inbox', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${a.tokens.native}`,
        'x-ks-scope': `${a.accountId}:9`,
      },
      body: JSON.stringify({ version, readId: randomUUID(), limit: 5 }),
    });
    expect(wrongScope.status).toBe(409);
  });

  it('sends a hint to the recipient’s socket after commit, and a missed hint is recovered by the durable read', async () => {
    const socket = connect(b);
    await connected(socket);
    const ack = (await socket.emitWithAck(socketEvents.subscribeScope, {
      scope: { kind: 'inbox', id: b.universeId },
    })) as { ok: boolean; revision?: number };
    expect(ack.ok).toBe(true);
    const known = ack.revision ?? 0;

    // Another person's inbox cannot be subscribed to.
    expect(
      await socket.emitWithAck(socketEvents.subscribeScope, { scope: { kind: 'inbox', id: a.universeId } }),
    ).toEqual({ ok: false, code: 'FORBIDDEN' });

    const snapshot = await clientOf(b).conversations.read({
      version,
      readId: randomUUID(),
      conversation: bRef,
      limit: 50,
    });
    if (snapshot.status !== 'ready') throw new Error('CI snapshot');
    const hint = nextHint(socket);
    await clientOf(a).conversations.send({
      version,
      commandId: randomUUID(),
      conversation: aRef,
      body: text(`live ${messageCanary}`),
    });
    const received = await hint;
    expect(received.scope).toEqual({ kind: 'inbox', id: b.universeId });
    expect(received.revision).toBeGreaterThan(known);
    expect(JSON.stringify(received)).not.toContain(messageCanary);

    const caughtUp = await clientOf(b).conversations.changes({
      version,
      readId: randomUUID(),
      conversation: bRef,
      limit: 50,
      cursor: snapshot.catchUpCursor,
    });
    if (caughtUp.status !== 'ready') throw new Error('CI changes');
    expect(caughtUp.changes.map((change) => change.message.sequence)).toEqual([2]);

    // The socket goes away and two messages arrive meanwhile: nothing is lost.
    socket.close();
    for (const index of [1, 2])
      await clientOf(a).conversations.send({
        version,
        commandId: randomUUID(),
        conversation: aRef,
        body: text(`while away ${String(index)}`),
      });
    const second = connect(b);
    await connected(second);
    const resubscribed = (await second.emitWithAck(socketEvents.subscribeScope, {
      scope: { kind: 'inbox', id: b.universeId },
    })) as { ok: boolean; revision?: number };
    expect(resubscribed.revision).toBeGreaterThan(received.revision);
    const recovered = await clientOf(b).conversations.changes({
      version,
      readId: randomUUID(),
      conversation: bRef,
      limit: 50,
      cursor: caughtUp.continuation.cursor,
    });
    if (recovered.status !== 'ready') throw new Error('CI changes');
    expect(recovered.changes.map((change) => change.message.sequence)).toEqual([3, 4]);
  });

  describe('share links and the landing page', () => {
    async function link(person: Person, title: string, audience: object = { kind: 'public_metadata' }) {
      const content = await seedContent(db.db, { title, kind: 'reel' });
      const made = await clientOf(person).contentShares.create({
        version: shareVersion,
        commandId: randomUUID(),
        target: { assetId: content.assetId, assetRevision: 1 },
        audience: audience as never,
      });
      if (made.delivery.status !== 'available') throw new Error('CI token');
      secrets.add(made.delivery.token);
      return { token: made.delivery.token, shareId: made.acceptance.shareId, content };
    }
    const landing = (token: string, headers: Record<string, string> = {}) =>
      fetch(`${origin}/s/${token}`, { headers, redirect: 'manual' });

    it('shows a signed-out visitor the public card, with no people and no referrer', async () => {
      const { token, content } = await link(a, 'Why long prompts cost more');
      const page = await landing(token);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(page.headers.get('referrer-policy')).toBe('no-referrer');
      expect(page.headers.get('cache-control')).toBe('private, no-store');
      expect(page.headers.get('x-robots-tag')).toContain('noindex');
      expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
      const html = await page.text();
      expect(html).toContain('<h1>Why long prompts cost more</h1>');
      expect(html).toContain(`href="/reel/${content.assetId}"`);
      expect(html).toContain('Open Reel');
      expect(html).toContain('Sign in to keep it');
      expect(html).not.toContain(a.person.handle);
      expect(html).not.toContain(a.person.displayName);
      expect(html).not.toContain(token);

      const preview = await fetch(origin + '/s/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: shareVersion, readId: randomUUID(), token }),
      });
      expect(preview.status).toBe(200);
      expect(await preview.json()).toMatchObject({ status: 'public_metadata' });
    });

    it('says the link is no longer available after the owner revokes it, naming nobody', async () => {
      const { token, shareId } = await link(a, 'Revoked soon');
      expect(await (await landing(token)).text()).toContain('Revoked soon');
      await clientOf(a).contentShares.revoke({ version: shareVersion, commandId: randomUUID(), shareId });
      const page = await landing(token);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('This link is no longer available');
      expect(html).not.toContain('Revoked soon');
      expect(html).not.toContain(a.person.displayName);
      const preview = await fetch(origin + '/s/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: shareVersion, readId: randomUUID(), token }),
      });
      expect(await preview.json()).toMatchObject({ status: 'unavailable' });
      // A token that never existed looks the same.
      expect(await (await landing(`kssh_${'B'.repeat(43)}`)).text()).toContain('This link is no longer available');
      expect(await (await landing('not-a-token')).text()).toContain('This link is no longer available');
    });

    it('opens a private conversation link for its members only', async () => {
      const { token } = await link(a, 'For the two of us', { kind: 'conversation', conversation: aRef });
      const stranger = await landing(token);
      expect(await stranger.text()).toContain('This link is no longer available');
      const asMember = await (await landing(token, cookieHeaders(b))).text();
      expect(asMember).toContain('Shared in your conversation');
      expect(asMember).toContain('For the two of us');
      expect(asMember).toContain(`href="/conversations/${bRef.conversationId}"`);
      expect(asMember).not.toContain('Sign in to keep it');
    });

    it('escapes content text in the page', async () => {
      const { token } = await link(a, '<script>alert(1)</script> & "quotes"');
      const html = await (await landing(token)).text();
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;');
    });
  });
});
