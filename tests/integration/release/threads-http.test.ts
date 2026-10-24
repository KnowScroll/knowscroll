/** The installed API and a real PostgreSQL: a content thread over HTTP, from invitation to an opened snippet. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SocialProblemSchema, type ContentThreadRef } from '@knowscroll/contracts';
import { createDatabase, type Database, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import { apiClient } from '../support/api-client.js';
import { createEmptyDatabase } from '../support/empty-database.js';
import { seedKeepSessions } from '../support/keep-fixture.js';
import { freePort, startReleaseProcess, waitForHttp, type ReleaseProcess } from '../support/processes.js';
import { seedFriends, talkCases, type Friend } from '../support/talk.js';
import { seedReel } from '../support/thread-fixtures.js';

const version = 'content-thread.v1' as const;
const messageCanary = 'PRIVATE-THREAD-MESSAGE-CANARY';

type Person = Friend & { tokens: Awaited<ReturnType<typeof seedKeepSessions>> };

describe('content threads over the installed API (disposable accounts)', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let db: DatabaseHandle<Database>;
  let api: ReleaseProcess;
  let origin: string;
  let a: Person;
  let b: Person;
  let reelId: string;
  const secrets = new Set<string>();

  beforeAll(async () => {
    database = await createEmptyDatabase('threads_http');
    expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' }).exited()).toBe(
      0,
    );
    db = createDatabase<Database>(
      { url: database.url, applicationName: 'ci-threads-http', poolMax: 5, statementTimeoutMs: 15000 },
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
    const friends = await seedFriends(db.db, talkCases(db.db, { now: new Date() }).friends);
    const withSessions = async (friend: Friend): Promise<Person> => {
      const tokens = await seedKeepSessions(db.db, friend);
      secrets.add(tokens.native);
      return { ...friend, tokens };
    };
    a = await withSessions(friends.a);
    b = await withSessions(friends.b);
    reelId = (await seedReel(db.db, { durationMs: 30_000 })).assetId;
  });

  afterAll(async () => {
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

  const clientOf = (person: Person) => apiClient(origin, `Bearer ${person.tokens.native}`, `${person.accountId}:1`);
  const root = () => ({ assetId: reelId, assetRevision: 1 });

  it('runs the whole path: create, invite, join, send a moment, read it, open it', async () => {
    const created = await clientOf(a).threads.create({
      version,
      commandId: randomUUID(),
      root: root(),
      friendPersonIds: [b.person.personId],
      name: 'The edge',
    });
    expect(created).toMatchObject({ operation: 'thread.create', replayed: false });

    const invited = await clientOf(b).threads.inbox({ version, readId: randomUUID(), limit: 20 });
    expect(invited.items).toMatchObject([{ state: 'invited', name: 'The edge', latestMessageSequence: 0 }]);
    const bRef: ContentThreadRef = invited.items[0]!.thread;
    expect(await clientOf(b).threads.read({ version, readId: randomUUID(), thread: bRef, limit: 20 })).toMatchObject({
      status: 'invitation',
      invitedBy: { handle: a.person.handle },
    });
    await clientOf(b).threads.respond({ version, commandId: randomUUID(), thread: bRef, response: 'join' });

    const moment = await clientOf(a).threads.send({
      version,
      commandId: randomUUID(),
      thread: created.thread,
      body: {
        kind: 'snippet',
        target: root(),
        anchor: { kind: 'reel_range', startMs: 5_000, endMs: 14_000 },
        note: `look at this ${messageCanary}`,
      },
    });
    expect(moment).toMatchObject({ sent: { kind: 'snippet', anchor: 'reel_range' }, messageSequence: 1 });

    const view = await clientOf(b).threads.read({ version, readId: randomUUID(), thread: bRef, limit: 20 });
    if (view.status !== 'ready') throw new Error('CI thread view');
    expect(view.messages[0]).toMatchObject({
      body: { kind: 'snippet', snippet: { kind: 'reel_range', startMs: 5_000, endMs: 14_000 } },
    });
    expect(view.episodes).toMatchObject([{ assetId: reelId, state: 'ready', visited: false }]);
    expect(JSON.stringify(view)).not.toMatch(/position|playhead|presence/i);

    expect(
      await clientOf(b).threads.openSnippet({
        version,
        readId: randomUUID(),
        thread: bRef,
        messageId: moment.messageId,
      }),
    ).toMatchObject({ status: 'ready', content: { kind: 'reel', assetId: reelId }, anchor: { kind: 'reel_range' } });
    expect(
      await clientOf(b).threads.markRead({ version, commandId: randomUUID(), thread: bRef, throughSequence: 1 }),
    ).toMatchObject({ acceptedThroughSequence: 1 });
  });

  it('refuses a stranger, an invalid anchor and an unauthenticated caller with closed problems', async () => {
    const stranger = (await seedFriends(db.db, talkCases(db.db).friends)).a;
    const strangerToken = await seedKeepSessions(db.db, stranger);
    secrets.add(strangerToken.native);
    const post = (path: string, token: string, body: unknown, accountId: string) =>
      fetch(origin + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-ks-scope': `${accountId}:1`,
        },
        body: JSON.stringify(body),
      });
    const invited = await clientOf(a).threads.create({
      version,
      commandId: randomUUID(),
      root: root(),
      friendPersonIds: [b.person.personId],
    });
    const stray = await post(
      '/v1/social/threads/send',
      strangerToken.native,
      { version, commandId: randomUUID(), thread: invited.thread, body: { kind: 'text', text: 'hi' } },
      stranger.accountId,
    );
    expect(stray.headers.get('content-type')).toBe('application/problem+json');
    expect(stray.headers.get('cache-control')).toBe('private, no-store');
    expect(SocialProblemSchema.parse(await stray.json()).code).toBe('SHARING_UNAVAILABLE');

    const outside = await post(
      '/v1/social/threads/send',
      a.tokens.native,
      {
        version,
        commandId: randomUUID(),
        thread: invited.thread,
        body: {
          kind: 'snippet',
          target: root(),
          anchor: { kind: 'reel_range', startMs: 28_000, endMs: 45_000 },
        },
      },
      a.accountId,
    );
    expect(SocialProblemSchema.parse(await outside.json()).code).toBe('INVALID_REQUEST');

    const anonymous = await fetch(origin + '/v1/social/threads/inbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version, readId: randomUUID(), limit: 5 }),
    });
    expect(anonymous.status).toBe(401);
  });
});
