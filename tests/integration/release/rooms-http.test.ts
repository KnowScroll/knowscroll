/** The installed API and a real PostgreSQL: an idea room over HTTP, from preview to a moderator's pin. */
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ScopeChangedHintSchema,
  SOCKET_PATH,
  SocialProblemSchema,
  socketEvents,
  type ScopeChangedHint,
} from '@knowscroll/contracts';
import { createDatabase, type Database, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import { libraryRoomSeeds } from '@knowscroll/backend/modules/rooms';
import { seedRooms, setRoomModerator } from '@knowscroll/backend/modules/rooms/nest-providers';
import { apiClient } from '../support/api-client.js';
import { createEmptyDatabase } from '../support/empty-database.js';
import { seedKeepSessions } from '../support/keep-fixture.js';
import { freePort, startReleaseProcess, waitForHttp, type ReleaseProcess } from '../support/processes.js';
import { seedFriends, talkCases, type Friend } from '../support/talk.js';
import { seedAuthoredGeography } from '../support/visit-world.js';

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
  const sockets: Socket[] = [];

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

  it('places a station beside the system of the person’s own map, and runs a poll to its close', async () => {
    // The room's station: only on a map that holds its system; a person with no map has none.
    expect(await clientOf(b).rooms.stations({ version, readId: randomUUID() })).toMatchObject({ stations: [] });
    const seeded = await seedAuthoredGeography(db.db, b, [{ conceptId: slug, label: 'Machine learning', planets: [] }]);
    const stations = await clientOf(b).rooms.stations({ version, readId: randomUUID() });
    expect(stations.stations).toMatchObject([
      { room: { roomId }, standing: 'member', placement: { systemId: seeded.systems[0]?.id } },
    ]);

    // A moderator's poll: members vote, change their mind, and the moderator closes it.
    const created = await clientOf(a).rooms.createActivity({
      version,
      commandId: randomUUID(),
      roomId,
      activity: { kind: 'poll', prompt: 'Which first?', options: ['Batching', 'More instances'] },
    });
    const ids = { roomId, activityId: created.activityId };
    await clientOf(b).rooms.votePoll({ version, commandId: randomUUID(), ...ids, optionId: 'o1' });
    await clientOf(b).rooms.votePoll({ version, commandId: randomUUID(), ...ids, optionId: 'o2' });
    // The voter sees the tally; the moderator, who has not voted, would not.
    const open = await clientOf(b).rooms.readActivity({ version, readId: randomUUID(), ...ids });
    if (open.status !== 'ready' || open.activity.kind !== 'poll') throw new Error('CI poll view');
    expect(open.activity.options.map((option) => option.votes)).toEqual([0, 1]);
    await clientOf(a).rooms.moderateActivity({ version, commandId: randomUUID(), ...ids, action: 'close' });
    const refused = await fetch(origin + '/v1/rooms/activities/vote', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${b.tokens.native}`,
        'x-ks-scope': `${b.accountId}:1`,
      },
      body: JSON.stringify({ version, commandId: randomUUID(), ...ids, optionId: 'o1' }),
    });
    expect(SocialProblemSchema.parse(await refused.json()).code).toBe('SHARING_UNAVAILABLE');
  });

  describe('the room as a place, over the API and the socket (v3 R-1)', () => {
    const connect = async (person: Person): Promise<Socket> => {
      const socket = io(origin, {
        path: SOCKET_PATH,
        transports: ['websocket'],
        auth: { token: person.tokens.native, scope: `${person.accountId}:1` },
        reconnection: false,
      });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
      });
      return socket;
    };
    /** The hint exactly as it came off the wire, before any schema can strip a key from it. */
    const nextRawHint = (socket: Socket) =>
      new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no room hint within 5s')), 5000);
        socket.once(socketEvents.scopeChanged, (raw: unknown) => {
          clearTimeout(timer);
          resolve(raw);
        });
      });

    it('lands a member in General, shows who has the room open, and keeps their own AI settings', async () => {
      const room = await clientOf(b).rooms.read({ version, readId: randomUUID(), roomId });
      if (room.status !== 'member') throw new Error('CI room view');
      expect(room.general).toMatchObject({ kind: 'general', title: 'General' });
      expect(room.discussions.map((discussion) => discussion.kind)).not.toContain('general');
      expect(room.you).toMatchObject({ aiLevel: 'lively', keepOut: false });
      expect(room.you.noticeSeenAt).toBeUndefined();
      expect(room.here.faces).toEqual([expect.objectContaining({ you: true })]);

      await clientOf(a).rooms.presence({ version, roomId, state: 'here' });
      const two = await clientOf(b).rooms.read({ version, readId: randomUUID(), roomId });
      if (two.status !== 'member') throw new Error('CI room view');
      expect(two.here.faces).toHaveLength(2);
      expect(two.here.count).toBeUndefined();
      expect(two.memberTotal).toBe(2);

      const saved = await clientOf(b).rooms.preferences({
        version,
        commandId: randomUUID(),
        roomId,
        aiLevel: 'quieter',
        keepOut: true,
        noticeSeen: true,
      });
      expect(saved.you).toMatchObject({ aiLevel: 'quieter', keepOut: true });
      expect(saved.you.noticeSeenAt).toEqual(expect.any(String));
      await clientOf(a).rooms.presence({ version, roomId, state: 'away' });
    });

    it('sends a room hint within seconds to a member who subscribed, and refuses a stranger the subscription', async () => {
      const listener = await connect(b);
      const ack = (await listener.emitWithAck(socketEvents.subscribeScope, {
        scope: { kind: 'room', id: roomId },
      })) as {
        ok: boolean;
      };
      expect(ack.ok).toBe(true);
      const heard = nextRawHint(listener);
      await clientOf(a).rooms.presence({ version, roomId, state: 'here' });
      const raw = (await heard) as { scope: Record<string, unknown> };
      // A hint names the room and nothing else: these keys and no others, so no person and no content can ride on it.
      expect(Object.keys(raw).sort()).toEqual(['eventId', 'revision', 'scope']);
      expect(Object.keys(raw.scope).sort()).toEqual(['id', 'kind']);
      const hint: ScopeChangedHint = ScopeChangedHintSchema.parse(raw);
      expect(hint.scope).toEqual({ kind: 'room', id: roomId });
      expect(JSON.stringify(raw)).not.toContain(a.person.handle);
      expect(JSON.stringify(raw)).not.toContain(b.person.handle);

      const stranger = (await seedFriends(db.db, talkCases(db.db).friends)).a;
      const strangerPerson: Person = { ...stranger, tokens: await seedKeepSessions(db.db, stranger) };
      secrets.add(strangerPerson.tokens.native);
      const outsider = await connect(strangerPerson);
      expect(await outsider.emitWithAck(socketEvents.subscribeScope, { scope: { kind: 'room', id: roomId } })).toEqual({
        ok: false,
        code: 'FORBIDDEN',
      });
      await clientOf(a).rooms.presence({ version, roomId, state: 'away' });
    });
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
