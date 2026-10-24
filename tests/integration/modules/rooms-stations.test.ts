/**
 * Room stations on a person's own map (#245, U01, U02, D-051) over real PostgreSQL: a station sits beside
 * a system the person's Geography holds, a room can sit beside different places on different maps, and a
 * station says nothing about who is in the room. Authored CI geography, no formation, no model.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { seedRooms } from '@knowscroll/backend/modules/rooms/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { joinRoom, libraryRoomSeeds, makeModerator, roomWorld, unwrap, type RoomWorld } from '../support/rooms.js';
import { seedFriend, type Friend } from '../support/talk.js';
import { authoredWorld, seedAuthoredGeography } from '../support/visit-world.js';

const version = 'rooms.v1' as const;

describe('room stations on a personal map (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;
  let rooms: Map<string, string>;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('rooms_stations');
    world = await roomWorld(database);
    await seedRooms(world.db, libraryRoomSeeds(), world.clock.now);
    const seeded = await world.db.selectFrom('rooms.rooms').select(['room_id', 'topic_id']).execute();
    rooms = new Map(seeded.map((row) => [row.topic_id, row.room_id]));
  });
  afterAll(async () => {
    await world.close();
    await database.drop();
  });

  const stationsOf = async (person: Friend) =>
    unwrap(await world.rooms.stations(person.authority, { version, readId: randomUUID() }));

  it('places a room beside each established system of the person’s own map, and nowhere else', async () => {
    const person = await seedFriend(world.db, world.friends);
    const seeded = await seedAuthoredGeography(world.db, person);
    const answer = await stationsOf(person);
    expect(answer.stations.map((station) => station.room.topic.id).sort()).toEqual(['earth', 'space']);
    for (const station of answer.stations) {
      const system = seeded.systems.find((candidate) => candidate.conceptId === station.room.topic.id);
      expect(station.placement).toEqual({ systemId: system?.id });
      expect(station.room.roomId).toBe(rooms.get(station.room.topic.id));
      expect(station.standing).toBe('none');
    }
  });

  it('has nothing to place for a person with no map, and nothing is created by asking', async () => {
    const person = await seedFriend(world.db, world.friends);
    const before = await world.db.selectFrom('rooms.members').select('room_id').execute();
    expect((await stationsOf(person)).stations).toEqual([]);
    expect(await world.db.selectFrom('rooms.members').select('room_id').execute()).toHaveLength(before.length);
  });

  it('puts the same room beside different places on different maps, and names who stands where', async () => {
    const first = await seedFriend(world.db, world.friends);
    const second = await seedFriend(world.db, world.friends);
    const firstWorld = await seedAuthoredGeography(world.db, first);
    const secondWorld = await seedAuthoredGeography(world.db, second, [authoredWorld[0]!]);
    unwrap(await joinRoom(world, second, rooms.get('earth')!));
    await makeModerator(world, 'earth', first);
    const a = (await stationsOf(first)).stations.find((station) => station.room.topic.id === 'earth');
    const b = (await stationsOf(second)).stations.find((station) => station.room.topic.id === 'earth');
    expect(a?.room.roomId).toBe(b?.room.roomId);
    expect(a?.placement.systemId).toBe(firstWorld.systems.find((system) => system.conceptId === 'earth')?.id);
    expect(b?.placement.systemId).toBe(secondWorld.systems[0]?.id);
    expect(a?.placement.systemId).not.toBe(b?.placement.systemId);
    expect([a?.standing, b?.standing]).toEqual(['moderator', 'member']);
    // The second person's map holds no space system, so no space station.
    expect((await stationsOf(second)).stations.map((station) => station.room.topic.id)).toEqual(['earth']);
  });

  it('never places a room beside a hypothetical system, and hides a closed room', async () => {
    const person = await seedFriend(world.db, world.friends);
    await seedAuthoredGeography(world.db, person, [
      { conceptId: 'earth', label: 'Earth', hypothetical: true, planets: [] },
      { conceptId: 'space', label: 'Space', planets: [] },
    ]);
    expect((await stationsOf(person)).stations.map((station) => station.room.topic.id)).toEqual(['space']);
    await world.db.updateTable('rooms.rooms').set({ status: 'closed' }).where('slug', '=', 'space').execute();
    try {
      expect((await stationsOf(person)).stations).toEqual([]);
    } finally {
      await world.db.updateTable('rooms.rooms').set({ status: 'open' }).where('slug', '=', 'space').execute();
    }
  });

  it('shows no member, count, online or activity, and the same answer shape to everyone', async () => {
    const person = await seedFriend(world.db, world.friends);
    await seedAuthoredGeography(world.db, person);
    const members = await Promise.all([seedFriend(world.db, world.friends), seedFriend(world.db, world.friends)]);
    for (const member of members) unwrap(await joinRoom(world, member, rooms.get('earth')!));
    const answer = await stationsOf(person);
    const keys = new Set<string>();
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(collect);
      else if (value !== null && typeof value === 'object')
        for (const [key, child] of Object.entries(value)) {
          keys.add(key);
          collect(child);
        }
    };
    collect(answer);
    // Only these fields exist: nothing counts, names or times anyone.
    expect([...keys].sort()).toEqual(
      [
        'accountId',
        'description',
        'id',
        'joinRule',
        'kind',
        'label',
        'name',
        'placement',
        'privacyEpoch',
        'readId',
        'room',
        'roomId',
        'scope',
        'standing',
        'stations',
        'status',
        'systemId',
        'topic',
        'version',
      ].sort(),
    );
    expect(JSON.stringify(answer)).not.toContain(members[0].accountId);
  });
});
