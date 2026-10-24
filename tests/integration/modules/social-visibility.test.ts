import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { heartbeatRecorder } from '@knowscroll/backend/modules/social/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { befriend, friendCommand, seedFriend, type Friend } from '../support/talk.js';
import {
  authoredWorld,
  expectAccepted,
  ownVisibility,
  seedAuthoredGeography,
  setVisibility,
  visit,
  visitCases,
  type SeededWorld,
} from '../support/visit-world.js';

/**
 * Visibility, presence and the friend visit (#241, D-047) against a real PostgreSQL 16 database.
 * Evidence label: authored geography rows and fixture people, the real Social and Geography adapters,
 * no provider calls and no formation. Every answer a visitor gets is searched for the owner's private
 * identities, and every "no" is compared with every other "no".
 */
describe('visibility, presence and the friend visit (real database)', () => {
  let db: TestDatabase<Database>;
  let cases: ReturnType<typeof visitCases>;
  let beat: ReturnType<typeof heartbeatRecorder>;
  beforeAll(async () => {
    db = await createTestDatabase<Database>('social_visibility');
    cases = visitCases(db.db);
    beat = heartbeatRecorder(db.db, () => cases.clock.now);
  });
  afterAll(async () => {
    await db.drop();
  });

  /** An owner with the authored world, and friends who are friends of the owner. */
  async function setup(friendCount = 1) {
    const owner = await seedFriend(db.db, cases.friends);
    const world = await seedAuthoredGeography(db.db, owner);
    const friends: Friend[] = [];
    for (let n = 0; n < friendCount; n += 1) {
      const friend = await seedFriend(db.db, cases.friends);
      await befriend(cases.friends, owner, friend);
      friends.push(friend);
    }
    return { owner, world, friends };
  }
  const systemId = (world: SeededWorld, conceptId: string) => world.systems.find((s) => s.conceptId === conceptId)!.id;
  const target = (person: Friend) => ({ kind: 'person' as const, personId: person.person.personId });
  async function visitOf(visitor: Friend, host: Friend) {
    const result = await visit(cases, visitor, target(host));
    if (result.kind !== 'ok') throw new Error('CI visit refused');
    return result.value;
  }
  /** What a visit says when it cannot be shown, without the echoes of who asked and who was asked for. */
  const unavailable = (snapshot: Awaited<ReturnType<typeof visitOf>>) => {
    expect(snapshot.status).toBe('unavailable');
    const { target: _asked, scope: _asker, ...rest } = snapshot;
    return JSON.stringify(rest);
  };
  async function availabilityOf(viewer: Friend, friend: Friend) {
    const page = await cases.friends.readFriends(viewer.authority, {
      version: 'friend-pages.v2',
      requestId: randomUUID(),
      filter: 'friends',
      limit: 20,
    });
    if (page.kind !== 'ok') throw new Error('CI roster refused');
    const item = page.value.items.find((i) => i.peer.personId === friend.person.personId);
    if (item?.state !== 'friends') throw new Error('CI friend not listed');
    return item.availability;
  }
  async function setPresence(person: Friend, preference: 'online' | 'recently_active' | 'hidden') {
    const read = await cases.visibility.readPresencePreference(person.authority);
    if (read.kind !== 'ok') throw new Error('CI presence read refused');
    return cases.visibility.setPresencePreference(person.authority, {
      version: 'sharing.v1',
      commandId: randomUUID(),
      expectedPresencePreferenceRevision: read.value.presencePreferenceRevision,
      preference,
    });
  }
  const moveClock = (ms: number) => {
    cases.clock.now = new Date(cases.clock.now.getTime() + ms);
  };
  const SECOND = 1_000,
    MINUTE = 60 * SECOND;

  describe('defaults', () => {
    it('shares nothing until the person chooses: nobody may visit and availability is hidden', async () => {
      const { owner, world } = await setup();
      const own = await ownVisibility(cases, owner);
      expect(own).toMatchObject({ visibilityRevision: 1, audience: { mode: 'nobody' } });
      expect(own.systems.map((s) => [s.label, s.shared])).toEqual([
        ['Earth and climate', false],
        ['Space', false],
      ]);
      expect(own.systems.map((s) => s.systemId).sort()).toEqual(
        [systemId(world, 'earth'), systemId(world, 'space')].sort(),
      );
      const preference = await cases.visibility.readPresencePreference(owner.authority);
      expect(preference).toMatchObject({ kind: 'ok', value: { preference: 'hidden', presencePreferenceRevision: 1 } });
    });

    it('writes nothing when settings are read', async () => {
      const { owner } = await setup();
      await ownVisibility(cases, owner);
      await cases.visibility.readPresencePreference(owner.authority);
      for (const table of ['visibility_settings', 'visibility_audience', 'presence', 'visit_publications']) {
        const rows = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(`social.${table}`)}`.execute(
          db.db,
        );
        expect(rows.rows[0]!.n).toBe(0);
      }
    });

    it('refuses a friend until the owner allows visits, with the answer a stranger gets', async () => {
      const { owner, friends } = await setup();
      const stranger = await seedFriend(db.db, cases.friends);
      const [friend] = friends as [Friend];
      const asFriend = unavailable(await visitOf(friend, owner));
      expect(unavailable(await visitOf(stranger, owner))).toBe(asFriend);
      const unknown = await visit(cases, friend, { kind: 'handle', handle: 'nobody.by.this.name' });
      expect(unknown.kind === 'ok' && unavailable(unknown.value)).toBe(asFriend);
      // Visiting yourself is not a visit.
      expect(unavailable(await visitOf(owner, owner))).toBe(asFriend);
    });
  });

  describe('who may visit', () => {
    it('shows an allowed friend the shared systems and planets by public identity, and nothing private', async () => {
      const { owner, world, friends } = await setup();
      const [friend] = friends as [Friend];
      expectAccepted(await setVisibility(cases, owner, { mode: 'all_friends' }, [systemId(world, 'earth')]));
      const answer = await visitOf(friend, owner);
      if (answer.status !== 'available') throw new Error('CI visit not available');
      expect(answer.owner).toEqual(owner.person);
      expect(answer.projection.systems).toHaveLength(1);
      expect(answer.projection.systems[0]).toMatchObject({ label: 'Earth and climate' });
      expect(answer.projection.systems[0]!.planets.map((p) => p.label)).toEqual(['Seasons', 'Tides']);

      const wire = JSON.stringify(answer).toLowerCase();
      for (const privateId of world.privateIds) expect(wire).not.toContain(privateId.toLowerCase());
      for (const privateText of ['star of', 'region ', 'axial-tilt', 'space', 'stars', 'anchor', 'seed', 'activity'])
        expect(wire).not.toContain(privateText);
      const publicIds = [
        answer.projection.systems[0]!.publicSystemId,
        ...answer.projection.systems[0]!.planets.map((p) => p.publicPlanetId),
      ];
      for (const id of publicIds) expect(world.privateIds).not.toContain(id);
      expect(answer.authority.publishedProjectionRevision).toBe(1);
    });

    it('lets only the chosen friends in', async () => {
      const { owner, world, friends } = await setup(2);
      const [chosen, other] = friends as [Friend, Friend];
      expectAccepted(
        await setVisibility(cases, owner, { mode: 'chosen_friends', personIds: [chosen.person.personId] }, [
          systemId(world, 'space'),
        ]),
      );
      expect((await visitOf(chosen, owner)).status).toBe('available');
      expect((await visitOf(other, owner)).status).toBe('unavailable');
      const own = await ownVisibility(cases, owner);
      expect(own.audience).toEqual({ mode: 'chosen_friends', personIds: [chosen.person.personId] });
    });

    it('refuses a person who is not a friend even when every friend may visit', async () => {
      const { owner, world } = await setup();
      const stranger = await seedFriend(db.db, cases.friends);
      expectAccepted(await setVisibility(cases, owner, { mode: 'all_friends' }, [systemId(world, 'earth')]));
      expect((await visitOf(stranger, owner)).status).toBe('unavailable');
    });

    it('refuses an owner who chooses a person who is not their friend, or a system that is not theirs', async () => {
      const { owner, world } = await setup();
      const stranger = await seedFriend(db.db, cases.friends);
      const outsider = await setup();
      const attempts = [
        setVisibility(cases, owner, { mode: 'chosen_friends', personIds: [stranger.person.personId] }, []),
        setVisibility(cases, owner, { mode: 'all_friends' }, [randomUUID()]),
        setVisibility(cases, owner, { mode: 'all_friends' }, [systemId(outsider.world, 'earth')]),
      ];
      for (const attempt of await Promise.all(attempts))
        expect(attempt).toEqual({ kind: 'refused', code: 'invalid_input' });
      expect((await ownVisibility(cases, owner)).visibilityRevision).toBe(1);
      expect(world.systems).toHaveLength(2);
    });

    it('offers no hypothetical system, so no hypothetical planet can be published', async () => {
      const owner = await seedFriend(db.db, cases.friends);
      const friend = await seedFriend(db.db, cases.friends);
      await befriend(cases.friends, owner, friend);
      const world = await seedAuthoredGeography(db.db, owner, [
        { conceptId: 'earth', label: 'Earth and climate', planets: [{ conceptId: 'earth.seasons', label: 'Seasons' }] },
        {
          conceptId: 'space',
          label: 'What if the Moon were closer',
          hypothetical: true,
          planets: [{ conceptId: 'space.stars', label: 'What if stars were nearer' }],
        },
      ]);
      const own = await ownVisibility(cases, owner);
      expect(own.systems.map((s) => s.label)).toEqual(['Earth and climate']);
      expect(await setVisibility(cases, owner, { mode: 'all_friends' }, [systemId(world, 'space')])).toEqual({
        kind: 'refused',
        code: 'invalid_input',
      });
      expectAccepted(await setVisibility(cases, owner, { mode: 'all_friends' }, [systemId(world, 'earth')]));
      const answer = await visitOf(friend, owner);
      if (answer.status !== 'available') throw new Error('CI visit not available');
      expect(JSON.stringify(answer)).not.toContain('What if');
    });
  });

  describe('revocation and the end of a friendship', () => {
    it('takes effect on the very next read', async () => {
      const { owner, world, friends } = await setup();
      const [friend] = friends as [Friend];
      const earth = systemId(world, 'earth');
      expectAccepted(await setVisibility(cases, owner, { mode: 'all_friends' }, [earth]));
      expect((await visitOf(friend, owner)).status).toBe('available');
      expectAccepted(await setVisibility(cases, owner, { mode: 'nobody' }, [earth]));
      const refused = await visitOf(friend, owner);
      expect(refused.status).toBe('unavailable');
      expect(JSON.stringify(refused)).not.toContain('Earth and climate');
    });

    it('unsharing a system removes it, and sharing it again makes a new public identity', async () => {
      const { owner, world, friends } = await setup();
      const [friend] = friends as [Friend];
      const earth = systemId(world, 'earth');
      expectAccepted(await setVisibility(cases, owner, { mode: 'all_friends' }, [earth]));
      const first = await visitOf(friend, owner);
      expectAccepted(await setVisibility(cases, owner, { mode: 'all_friends' }, []));
      const emptied = await visitOf(friend, owner);
      expect(emptied.status === 'available' && emptied.projection.systems).toEqual([]);
      expectAccepted(await setVisibility(cases, owner, { mode: 'all_friends' }, [earth]));
      const again = await visitOf(friend, owner);
      if (first.status !== 'available' || again.status !== 'available') throw new Error('CI visit not available');
      expect(again.projection.systems[0]!.publicSystemId).not.toBe(first.projection.systems[0]!.publicSystemId);
      // The revision of what visitors see moved with each change.
      expect(again.authority.publishedProjectionRevision).toBeGreaterThan(first.authority.publishedProjectionRevision);
    });

    it('ends when the friendship ends, and an old choice does not come back with a new friendship', async () => {
      const { owner, world, friends } = await setup();
      const [friend] = friends as [Friend];
      expectAccepted(
        await setVisibility(cases, owner, { mode: 'chosen_friends', personIds: [friend.person.personId] }, [
          systemId(world, 'earth'),
        ]),
      );
      expect((await visitOf(friend, owner)).status).toBe('available');
      expectAccepted(await friendCommand(cases.friends, owner, friend, 'remove'));
      expect((await visitOf(friend, owner)).status).toBe('unavailable');
      const chosenRows = await db.db
        .selectFrom('social.visibility_audience')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('owner_account_id', '=', owner.accountId)
        .executeTakeFirstOrThrow();
      expect(Number(chosenRows.n)).toBe(0);
      // A new request waits out the fixed seven-day window of the old friendship.
      moveClock(8 * 24 * 60 * MINUTE);
      await befriend(cases.friends, owner, friend);
      expect((await visitOf(friend, owner)).status).toBe('unavailable');
      expect((await ownVisibility(cases, owner)).audience).toEqual({ mode: 'nobody' });
    });

    it('is refused for a blocked visitor, in either direction', async () => {
      const { owner, world, friends } = await setup(2);
      const [blockedByOwner, blocker] = friends as [Friend, Friend];
      expectAccepted(await setVisibility(cases, owner, { mode: 'all_friends' }, [systemId(world, 'earth')]));
      expectAccepted(await friendCommand(cases.friends, owner, blockedByOwner, 'block'));
      expect((await visitOf(blockedByOwner, owner)).status).toBe('unavailable');
      expectAccepted(await friendCommand(cases.friends, blocker, owner, 'block'));
      expect((await visitOf(blocker, owner)).status).toBe('unavailable');
      expect((await visitOf(owner, blocker)).status).toBe('unavailable');
    });
  });

  describe('the setting commands', () => {
    it('replays the same command, refuses a reused key with another body, and a stale revision', async () => {
      const { owner, world } = await setup();
      const command = {
        version: 'sharing.v1' as const,
        commandId: randomUUID(),
        expectedVisibilityRevision: 1,
        audience: { mode: 'all_friends' as const },
        sharedSystemIds: [systemId(world, 'earth')],
      };
      const first = await cases.visibility.setVisibility(owner.authority, command);
      const replay = await cases.visibility.setVisibility(owner.authority, command);
      expect(first).toMatchObject({ kind: 'ok', value: { replayed: false, acceptedVisibilityRevision: 2 } });
      expect(replay).toMatchObject({ kind: 'ok', value: { replayed: true, acceptedVisibilityRevision: 2 } });
      expect(
        await cases.visibility.setVisibility(owner.authority, { ...command, audience: { mode: 'nobody' } }),
      ).toEqual({ kind: 'refused', code: 'command_key_reused' });
      expect(await cases.visibility.setVisibility(owner.authority, { ...command, commandId: randomUUID() })).toEqual({
        kind: 'refused',
        code: 'stale_revision',
      });
    });

    it('does not move the revision for a change that changes nothing', async () => {
      const { owner } = await setup();
      const result = await setVisibility(cases, owner, { mode: 'nobody' }, []);
      expect(result).toMatchObject({ kind: 'ok', value: { baseVisibilityRevision: 1, acceptedVisibilityRevision: 1 } });
    });

    it('keeps the two settings independent', async () => {
      const { owner, world } = await setup();
      expectAccepted(await setPresence(owner, 'online'));
      expectAccepted(await setVisibility(cases, owner, { mode: 'all_friends' }, [systemId(world, 'earth')]));
      const preference = await cases.visibility.readPresencePreference(owner.authority);
      expect(preference).toMatchObject({ value: { preference: 'online', presencePreferenceRevision: 2 } });
      expect((await ownVisibility(cases, owner)).visibilityRevision).toBe(2);
    });
  });

  describe('a refresh after the owner explores', () => {
    it('adds planets formed after the owner chose the system, and never a system they did not choose', async () => {
      const { owner, world, friends } = await setup();
      const [friend] = friends as [Friend];
      expectAccepted(await setVisibility(cases, owner, { mode: 'all_friends' }, [systemId(world, 'earth')]));
      const before = await visitOf(friend, owner);
      expect(await cases.refresh({ universeId: owner.universeId, privacyEpoch: 1 })).toBe('unchanged');
      // A later formation, as the Cartographer would write it: one more planet of the chosen system.
      const newPlanet = randomUUID();
      const earth = await db.db
        .selectFrom('geography.objects')
        .select('payload')
        .where('universe_id', '=', owner.universeId)
        .where('semantic_key', '=', 'system:earth:factual')
        .executeTakeFirstOrThrow();
      await db.db
        .insertInto('geography.objects')
        .values({
          universe_id: owner.universeId,
          privacy_epoch: 1,
          id: newPlanet,
          semantic_key: 'planet:earth.greenhouse-effect:factual',
          payload: {
            id: newPlanet,
            key: 'planet:earth.greenhouse-effect:factual',
            kind: 'planet',
            conceptId: 'earth.greenhouse-effect',
            parentKey: (earth.payload as { key: string }).key,
            truthStatus: 'factual',
            label: 'Greenhouse effect',
            labels: ['Greenhouse effect'],
            objectRevision: 1,
            originTransitionId: randomUUID(),
            activity: { availability: 'available', state: 'active' },
          },
          support_refs: JSON.stringify([]),
        })
        .execute();
      await sql`update geography.state set revision = 2, structure_revision = 2 where universe_id = ${owner.universeId}::uuid`.execute(
        db.db,
      );
      expect(await cases.refresh({ universeId: owner.universeId, privacyEpoch: 1 })).toBe('refreshed');
      const after = await visitOf(friend, owner);
      if (before.status !== 'available' || after.status !== 'available') throw new Error('CI visit not available');
      expect(after.projection.systems).toHaveLength(1);
      expect(after.projection.systems[0]!.planets.map((p) => p.label)).toEqual([
        'Greenhouse effect',
        'Seasons',
        'Tides',
      ]);
      expect(after.authority.publishedProjectionRevision).toBe(before.authority.publishedProjectionRevision + 1);
      // The planets that were already shared keep their public identity.
      const kept = before.projection.systems[0]!.planets.map((p) => p.publicPlanetId);
      for (const id of kept) expect(after.projection.systems[0]!.planets.map((p) => p.publicPlanetId)).toContain(id);
    });

    it('does nothing for a universe that shares nothing, a stale epoch or a missing universe', async () => {
      const { owner } = await setup();
      expect(await cases.refresh({ universeId: owner.universeId, privacyEpoch: 1 })).toBe('skipped');
      expect(await cases.refresh({ universeId: owner.universeId, privacyEpoch: 9 })).toBe('skipped');
      expect(await cases.refresh({ universeId: randomUUID(), privacyEpoch: 1 })).toBe('skipped');
    });
  });

  describe('availability', () => {
    it('shows no one as available until they choose, and a hidden person leaves no heartbeat', async () => {
      const { owner, friends } = await setup();
      const [friend] = friends as [Friend];
      await beat(owner.accountId);
      expect(await availabilityOf(friend, owner)).toEqual({ state: 'unknown' });
      const stored = await db.db
        .selectFrom('social.presence')
        .select('account_id')
        .where('account_id', '=', owner.accountId)
        .execute();
      expect(stored).toEqual([]);
    });

    it('shows "Online" while heartbeats come, then "Recently active", then nothing, on constant leases', async () => {
      const { owner, friends } = await setup();
      const [friend] = friends as [Friend];
      expectAccepted(await setPresence(owner, 'online'));
      expect(await availabilityOf(friend, owner)).toEqual({ state: 'unknown' });
      await beat(owner.accountId);
      const online = await availabilityOf(friend, owner);
      expect(online).toMatchObject({ state: 'online', expiryRevision: 1 });
      moveClock(20 * SECOND);
      expect(await availabilityOf(friend, owner)).toEqual(online);
      moveClock(50 * SECOND);
      const recent = await availabilityOf(friend, owner);
      expect(recent).toMatchObject({ state: 'recently_active', expiryRevision: 1 });
      moveClock(5 * MINUTE);
      expect(await availabilityOf(friend, owner)).toEqual(recent);
      moveClock(11 * MINUTE);
      expect(await availabilityOf(friend, owner)).toEqual({ state: 'unknown' });
    });

    it('makes hidden, expired and never-seen indistinguishable on the wire', async () => {
      const { owner, friends } = await setup();
      const [friend] = friends as [Friend];
      const hidden = JSON.stringify(await availabilityOf(friend, owner));
      expectAccepted(await setPresence(owner, 'online'));
      const neverSeen = JSON.stringify(await availabilityOf(friend, owner));
      await beat(owner.accountId);
      moveClock(20 * MINUTE);
      const expired = JSON.stringify(await availabilityOf(friend, owner));
      expect(neverSeen).toBe(hidden);
      expect(expired).toBe(hidden);
    });

    it('never shows more than the person chose', async () => {
      const { owner, friends } = await setup();
      const [friend] = friends as [Friend];
      expectAccepted(await setPresence(owner, 'recently_active'));
      await beat(owner.accountId);
      expect(await availabilityOf(friend, owner)).toMatchObject({ state: 'recently_active' });
    });

    it('starts a new window after a long absence, so a stale answer can be told from a fresh one', async () => {
      const { owner, friends } = await setup();
      const [friend] = friends as [Friend];
      expectAccepted(await setPresence(owner, 'online'));
      await beat(owner.accountId);
      moveClock(30 * SECOND);
      await beat(owner.accountId);
      expect(await availabilityOf(friend, owner)).toMatchObject({ expiryRevision: 1 });
      moveClock(20 * MINUTE);
      await beat(owner.accountId);
      expect(await availabilityOf(friend, owner)).toMatchObject({ state: 'online', expiryRevision: 2 });
    });

    it('deletes the stored heartbeat the moment availability is hidden', async () => {
      const { owner, friends } = await setup();
      const [friend] = friends as [Friend];
      expectAccepted(await setPresence(owner, 'online'));
      await beat(owner.accountId);
      expect((await availabilityOf(friend, owner)).state).toBe('online');
      expectAccepted(await setPresence(owner, 'hidden'));
      const rows = await db.db
        .selectFrom('social.presence')
        .select('account_id')
        .where('account_id', '=', owner.accountId)
        .execute();
      expect(rows).toEqual([]);
      expect(await availabilityOf(friend, owner)).toEqual({ state: 'unknown' });
    });

    it('shows availability in a pair read only for a current friendship', async () => {
      const { owner, friends } = await setup();
      const [friend] = friends as [Friend];
      const stranger = await seedFriend(db.db, cases.friends);
      expectAccepted(await setPresence(owner, 'online'));
      await beat(owner.accountId);
      const pairOf = async (viewer: Friend) => {
        const result = await cases.friends.readPair(viewer.authority, {
          version: 'sharing.v1',
          peerPersonId: owner.person.personId,
        });
        if (result.kind !== 'ok' || result.value.status !== 'available') throw new Error('CI pair');
        return result.value.pair;
      };
      expect(await pairOf(friend)).toMatchObject({ state: 'friends', availability: { state: 'online' } });
      expect(await pairOf(stranger)).toEqual({ state: 'none', peer: owner.person, pairRevision: 0 });
      expectAccepted(await friendCommand(cases.friends, owner, friend, 'remove'));
      expect(await pairOf(friend)).not.toHaveProperty('availability');
    });
  });

  describe('a visit is only a read', () => {
    it('changes no row anywhere and tells the owner nothing', async () => {
      const { owner, world, friends } = await setup();
      const [friend] = friends as [Friend];
      expectAccepted(await setVisibility(cases, owner, { mode: 'all_friends' }, [systemId(world, 'earth')]));
      const counts = async () => {
        const tables = await sql<{ name: string }>`
          select table_schema || '.' || table_name as name from information_schema.tables
          where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')
          order by 1`.execute(db.db);
        const result: Record<string, number> = {};
        for (const { name } of tables.rows) {
          const row = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(name)}`.execute(db.db);
          result[name] = row.rows[0]!.n;
        }
        const revisions = await db.db
          .selectFrom('identity.universes')
          .select(['id', 'revision'])
          .where('id', 'in', [owner.universeId, friend.universeId])
          .orderBy('id')
          .execute();
        return { result, revisions };
      };
      const before = await counts();
      for (let visits = 0; visits < 3; visits += 1) expect((await visitOf(friend, owner)).status).toBe('available');
      expect(await counts()).toEqual(before);
    });
  });

  describe('erasure', () => {
    it('removes the published copy with the universe and keeps the owner’s choices', async () => {
      const { owner, world, friends } = await setup();
      const [friend] = friends as [Friend];
      expectAccepted(await setVisibility(cases, owner, { mode: 'all_friends' }, [systemId(world, 'earth')]));
      const social = personalStores.find((store) => store.module === 'social')!;
      const entered = await makeWithPersonalScope(db.db, { lockTimeoutMs: 5000 })(owner.authority, (scope) =>
        social.erase(scope),
      );
      expect(entered).toMatchObject({ kind: 'entered', value: { status: 'completed' } });
      for (const table of ['visit_publications', 'visit_systems', 'visit_planets']) {
        const rows = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(`social.${table}`)}
          where universe_id = ${owner.universeId}::uuid`.execute(db.db);
        expect(rows.rows[0]!.n).toBe(0);
      }
      // The choice survives; the friend now sees an empty world, not the old one.
      expect((await ownVisibility(cases, owner)).audience).toEqual({ mode: 'all_friends' });
      const answer = await visitOf(friend, owner);
      expect(answer.status === 'available' && answer.projection.systems).toEqual([]);
    });

    it('declares every visitor store with an erasure and a Clear disposition', () => {
      const social = personalStores.find((store) => store.module === 'social')!;
      const declared = [...social.tables, ...(social.accountTables ?? [])].map((t) => `${t.schema}.${t.table}`);
      for (const table of [
        'visibility_settings',
        'visibility_audience',
        'presence',
        'visit_publications',
        'visit_systems',
        'visit_planets',
      ])
        expect(declared).toContain(`social.${table}`);
      expect(social.clearExploration?.dispositions).toMatchObject({
        'social.visibility_settings': 'preserve',
        'social.presence': 'preserve',
        'social.visit_publications': 'erase',
        'social.visit_systems': 'erase',
        'social.visit_planets': 'erase',
      });
      expect(authoredWorld.length).toBeGreaterThan(0);
    });
  });
});
