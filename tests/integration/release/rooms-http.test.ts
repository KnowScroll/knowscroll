/** The installed API and a real PostgreSQL: an idea room over HTTP, from preview to a moderator's pin. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SocialProblemSchema } from '@knowscroll/contracts';
import { createDatabase, type Database, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import { libraryRoomSeeds } from '@knowscroll/backend/modules/rooms';
import { seedRooms, setRoomModerator } from '@knowscroll/backend/modules/rooms/nest-providers';
import { apiClient } from '../support/api-client.js';
import { createEmptyDatabase } from '../support/empty-database.js';
import { seedKeepSessions } from '../support/keep-fixture.js';
import { freePort, startReleaseProcess, waitForHttp, type ReleaseProcess } from '../support/processes.js';
import { seedFriends, talkCases, type Friend } from '../support/talk.js';

const version = 'rooms.v1' as const;
const messageCanary = 'PRIVATE-ROOM-MESSAGE-CANARY';

type Person = Friend & { tokens: Awaited<ReturnType<typeof seedKeepSessions>> };

describe('idea rooms over the installed API (disposable accounts)', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let db: DatabaseHandle<Database>;
  let api: ReleaseProcess;
  let origin: string;
  let a: Person;
  let b: Person;
  let roomId: string;
  const slug = 'machine-learning';
  const secrets = new Set<string>();

  beforeAll(async () => {
    database = await createEmptyDatabase('rooms_http');
    expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' }).exited()).toBe(
      0,
    );
    db = createDatabase<Database>(
      { url: database.url, applicationName: 'ci-rooms-http', poolMax: 5, statementTimeoutMs: 15000 },
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
    // The operator's seed: one room for each library system, with nobody in it.
    await seedRooms(db.db, [...libraryRoomSeeds()], new Date());
    const row = await db.db
      .selectFrom('rooms.rooms')
      .select('room_id')
      .where('slug', '=', slug)
      .executeTakeFirstOrThrow();
    roomId = row.room_id;
    expect(await setRoomModerator(db.db, { slug, accountId: a.accountId, moderator: true, now: new Date() })).toBe(
      'set',
    );
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

  it('runs the path: preview an empty room, join, start a discussion, talk, and pin it as moderator', async () => {
    // A person who is not yet a member sees the room as it is: nobody in it, nothing said.
    const preview = await clientOf(b).rooms.read({ version, readId: randomUUID(), roomId });
    expect(preview).toMatchObject({ status: 'preview', room: { roomId, topic: { kind: 'system', id: slug } } });
    expect(JSON.stringify(preview)).not.toMatch(/online|memberCount|messageCount/i);

    // The operator named `a` the moderator, which makes `a` a member; `b` joins by the room's open rule.
    const joined = await clientOf(b).rooms.join({ version, commandId: randomUUID(), roomId });
    expect(joined).toMatchObject({ outcome: 'accepted', replayed: false });

    const started = await clientOf(b).rooms.createDiscussion({
      version,
      commandId: randomUUID(),
      roomId,
      start: { kind: 'topic', title: 'Where should it run?' },
    });
    const ids = { roomId, discussionId: started.discussionId };
    await clientOf(b).rooms.send({
      version,
      commandId: randomUUID(),
      ...ids,
      body: { kind: 'text', text: `One thought ${messageCanary}` },
    });

    const seen = await clientOf(a).rooms.readDiscussion({ version, readId: randomUUID(), ...ids, limit: 20 });
    if (seen.status !== 'ready') throw new Error('CI discussion view');
    expect(seen.messages).toMatchObject([{ status: 'available', author: { kind: 'person' }, body: { kind: 'text' } }]);
    expect(JSON.stringify(seen)).not.toMatch(/position|playhead|presence/i);

    // Only the moderator may pin.
    const refused = await fetch(origin + '/v1/rooms/discussions/pin', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${b.tokens.native}`,
        'x-ks-scope': `${b.accountId}:1`,
      },
      body: JSON.stringify({ version, commandId: randomUUID(), ...ids, pinned: true }),
    });
    expect(refused.headers.get('content-type')).toBe('application/problem+json');
    expect(refused.headers.get('cache-control')).toBe('private, no-store');
    expect(SocialProblemSchema.parse(await refused.json()).code).toBe('SHARING_UNAVAILABLE');

    await clientOf(a).rooms.pin({ version, commandId: randomUUID(), ...ids, pinned: true });
    const room = await clientOf(b).rooms.read({ version, readId: randomUUID(), roomId });
    if (room.status !== 'member') throw new Error('CI room view');
    expect(room.discussions[0]).toMatchObject({ discussionId: started.discussionId, pinned: true });
  });

  it('answers a stranger in one shape and refuses an unauthenticated caller', async () => {
    const stranger = (await seedFriends(db.db, talkCases(db.db).friends)).a;
    const strangerToken = await seedKeepSessions(db.db, stranger);
    secrets.add(strangerToken.native);
    // A room, a discussion or a person that does not exist for the caller all answer in one shape.
    expect(
      await clientOf({ ...stranger, tokens: strangerToken }).rooms.readDiscussion({
        version,
        readId: randomUUID(),
        roomId,
        discussionId: randomUUID(),
        limit: 5,
      }),
    ).toMatchObject({ status: 'unavailable' });
    const strayMessage = await fetch(origin + '/v1/rooms/discussions/send', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${strangerToken.native}`,
        'x-ks-scope': `${stranger.accountId}:1`,
      },
      body: JSON.stringify({
        version,
        commandId: randomUUID(),
        roomId,
        discussionId: randomUUID(),
        body: { kind: 'text', text: 'hello' },
      }),
    });
    expect(strayMessage.headers.get('content-type')).toBe('application/problem+json');
    expect(SocialProblemSchema.parse(await strayMessage.json()).code).toBe('SHARING_UNAVAILABLE');

    const anonymous = await fetch(origin + '/v1/rooms/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version, readId: randomUUID() }),
    });
    expect(anonymous.status).toBe(401);
  });
});
