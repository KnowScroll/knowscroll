/**
 * The installed API and a real PostgreSQL: what a person lets friends see, a friend's visit, and
 * availability heartbeats over Socket.IO (#241, D-047). Disposable accounts, authored geography rows
 * written to the tables (no formation), no provider calls.
 */
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PresenceHeartbeatAckSchema,
  SOCKET_PATH,
  socketEvents,
  type PresenceHeartbeatAck,
} from '@knowscroll/contracts';
import { createDatabase, type Database, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import { apiClient } from '../support/api-client.js';
import { createEmptyDatabase } from '../support/empty-database.js';
import { seedKeepSessions } from '../support/keep-fixture.js';
import { freePort, startReleaseProcess, waitForHttp, type ReleaseProcess } from '../support/processes.js';
import { seedFriend, seedFriends, talkCases, type Friend } from '../support/talk.js';
import { seedAuthoredGeography, type SeededWorld } from '../support/visit-world.js';

type Person = Friend & { tokens: Awaited<ReturnType<typeof seedKeepSessions>> };

describe('visibility, availability and the friend visit over the installed API (disposable accounts)', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let db: DatabaseHandle<Database>;
  let api: ReleaseProcess;
  let origin: string;
  let owner: Person;
  let friend: Person;
  let stranger: Person;
  let world: SeededWorld;
  const sockets: Socket[] = [];
  const secrets = new Set<string>();

  beforeAll(async () => {
    database = await createEmptyDatabase('visits_http');
    expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' }).exited()).toBe(
      0,
    );
    db = createDatabase<Database>(
      { url: database.url, applicationName: 'ci-visits-http', poolMax: 5, statementTimeoutMs: 15000 },
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
    const withSessions = async (person: Friend): Promise<Person> => {
      const tokens = await seedKeepSessions(db.db, person);
      secrets.add(tokens.native);
      secrets.add(tokens.web);
      return { ...person, tokens };
    };
    owner = await withSessions(friends.a);
    friend = await withSessions(friends.b);
    stranger = await withSessions(await seedFriend(db.db, cases.friends));
    world = await seedAuthoredGeography(db.db, owner);
  });

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    try {
      expect(await api.stop()).toBe(0);
      for (const secret of secrets) expect(api.rawOutput()).not.toContain(secret);
      expect(api.records.filter((record) => record.event === 'http.unexpected_error')).toEqual([]);
    } finally {
      await db.close();
      await database.drop();
    }
  });

  const scopeOf = (person: Person) => `${person.accountId}:1`;
  const clientOf = (person: Person) => apiClient(origin, `Bearer ${person.tokens.native}`, scopeOf(person));
  const earthId = () => world.systems.find((system) => system.conceptId === 'earth')!.id;
  const visitOf = (visitor: Person, host: Person) =>
    clientOf(visitor).sharing.visit({
      version: 'sharing.v1',
      target: { kind: 'person', personId: host.person.personId },
      capabilities: { presentations: ['list.v1'] },
    });

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
  async function beat(socket: Socket): Promise<PresenceHeartbeatAck> {
    const raw = await socket.timeout(5000).emitWithAck(socketEvents.presenceHeartbeat);
    return PresenceHeartbeatAckSchema.parse(raw);
  }
  async function availabilityOf(viewer: Person, subject: Person) {
    const page = await clientOf(viewer).friendPages.friends({
      version: 'friend-pages.v2',
      requestId: randomUUID(),
      filter: 'friends',
      limit: 20,
    });
    const item = page.items.find((entry) => entry.peer.personId === subject.person.personId);
    if (item?.state !== 'friends') throw new Error('CI friend not listed');
    return item.availability;
  }

  it('shares nothing by default and refuses every visitor with the same answer', async () => {
    const visibility = await clientOf(owner).sharing.visibility({});
    expect(visibility).toMatchObject({ visibilityRevision: 1, audience: { mode: 'nobody' } });
    expect(visibility.systems.every((system) => system.shared === false)).toBe(true);
    const asFriend = await visitOf(friend, owner);
    const asStranger = await visitOf(stranger, owner);
    expect(asFriend.status).toBe('unavailable');
    const strip = ({ scope: _scope, ...rest }: typeof asFriend) => rest;
    expect(strip(asStranger)).toEqual(strip(asFriend));
  });

  it('shows an allowed friend the shared systems and planets, and not one private identity', async () => {
    const before = await clientOf(owner).sharing.visibility({});
    const accepted = await clientOf(owner).sharing.setVisibility({
      version: 'sharing.v1',
      commandId: randomUUID(),
      expectedVisibilityRevision: before.visibilityRevision,
      audience: { mode: 'all_friends' },
      sharedSystemIds: [earthId()],
    });
    expect(accepted).toMatchObject({ operation: 'visibility.set', acceptedVisibilityRevision: 2, replayed: false });

    const raw = await fetch(`${origin}/v1/social/visits/read`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${friend.tokens.native}`,
        'x-ks-scope': scopeOf(friend),
      },
      body: JSON.stringify({
        version: 'sharing.v1',
        target: { kind: 'handle', handle: owner.person.handle },
        capabilities: { presentations: ['list.v1'] },
      }),
    });
    expect(raw.status).toBe(200);
    expect(raw.headers.get('cache-control')).toContain('no-store');
    const text = (await raw.text()).toLowerCase();
    const body = JSON.parse(text) as {
      status: string;
      projection: { systems: { label: string; planets: unknown[] }[] };
    };
    expect(body.status).toBe('available');
    expect(body.projection.systems.map((system) => system.label)).toEqual(['earth and climate']);
    expect(body.projection.systems[0]!.planets).toHaveLength(2);
    for (const privateId of world.privateIds) expect(text).not.toContain(privateId.toLowerCase());
    for (const privateWord of ['star of', 'region ', 'anchor', 'seed', 'activity', 'universe'])
      expect(text).not.toContain(privateWord);

    expect((await visitOf(stranger, owner)).status).toBe('unavailable');
  });

  it('takes a revocation into account on the very next read', async () => {
    expect((await visitOf(friend, owner)).status).toBe('available');
    const current = await clientOf(owner).sharing.visibility({});
    await clientOf(owner).sharing.setVisibility({
      version: 'sharing.v1',
      commandId: randomUUID(),
      expectedVisibilityRevision: current.visibilityRevision,
      audience: { mode: 'nobody' },
      sharedSystemIds: [earthId()],
    });
    const refused = await visitOf(friend, owner);
    expect(refused.status).toBe('unavailable');
    expect(JSON.stringify(refused)).not.toContain('Earth');
  });

  it('refuses a visit without a session', async () => {
    const response = await fetch(`${origin}/v1/social/visits/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 'sharing.v1',
        target: { kind: 'person', personId: owner.person.personId },
        capabilities: { presentations: ['list.v1'] },
      }),
    });
    expect(response.status).toBe(401);
    const settings = await fetch(`${origin}/v1/social/visibility`, { headers: { 'x-ks-scope': scopeOf(owner) } });
    expect(settings.status).toBe(401);
  });

  it('answers a heartbeat the same whether or not availability is shared, and shows it only when chosen', async () => {
    const socket = connect(owner);
    await connected(socket);
    // Hidden by default: acknowledged, and nothing stored.
    expect(await beat(socket)).toEqual({ ok: true });
    expect(await availabilityOf(friend, owner)).toEqual({ state: 'unknown' });
    const stored = await db.db.selectFrom('social.presence').select('account_id').execute();
    expect(stored).toEqual([]);

    const current = await clientOf(owner).sharing.presencePreference({});
    expect(current).toMatchObject({ preference: 'hidden', presencePreferenceRevision: 1 });
    await clientOf(owner).sharing.setPresencePreference({
      version: 'sharing.v1',
      commandId: randomUUID(),
      expectedPresencePreferenceRevision: current.presencePreferenceRevision,
      preference: 'online',
    });
    // The server ignores a heartbeat that follows the last by less than ten seconds on one socket;
    // that first beat came before the preference, so a new connection makes a fresh one.
    const second = connect(owner);
    await connected(second);
    expect(await beat(second)).toEqual({ ok: true });
    expect(await availabilityOf(friend, owner)).toMatchObject({ state: 'online', validForMs: 30000 });
    expect(await availabilityOf(stranger, owner).catch((error: unknown) => String(error))).toContain(
      'CI friend not listed',
    );
  });

  it('refuses a heartbeat from a socket that did not authenticate', async () => {
    const socket = io(origin, {
      path: SOCKET_PATH,
      transports: ['websocket'],
      auth: { scope: scopeOf(owner) },
      reconnection: false,
    });
    sockets.push(socket);
    await expect(connected(socket)).rejects.toBeDefined();
  });
});
