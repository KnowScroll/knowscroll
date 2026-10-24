/** Labelled fixtures for idea-room tests: the real use cases over the test database, no HTTP. */
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { PgBoss } from 'pg-boss';
import { expect } from 'vitest';
import { createBoss, makeEnqueueJob, type EnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  readContentSequence,
  readShareableContent,
  resolveSnippetAnchor,
  validateSnippetAnchor,
} from '@knowscroll/backend/modules/content/nest-providers';
import { readVisitedAssets } from '@knowscroll/backend/modules/experience/nest-providers';
import {
  accountAccessUseCases,
  identityScopeOwnerProviders,
} from '@knowscroll/backend/modules/identity/nest-providers';
import type { CheckPersonalOwnerActive } from '@knowscroll/backend/modules/identity';
import {
  contributeQueue,
  libraryRoomSeeds,
  type ContributeJob,
  type RoomSeed,
} from '@knowscroll/backend/modules/rooms';
import {
  contributeAsInhabitant,
  roomUseCases,
  seedRooms,
  setRoomModerator,
} from '@knowscroll/backend/modules/rooms/nest-providers';
import {
  readBlockedAmong,
  readFriendAccounts,
  readPublicPeople,
} from '@knowscroll/backend/modules/social/nest-providers';
import { makeCheckAssetAudience } from '../../../packages/backend/src/modules/content/adapters/made-to-order.js';
import type { ReasoningHarness } from '@knowscroll/backend/reasoning';
import type { TestDatabase } from './database.js';
import { befriend, seedFriend, talkCases, type Friend } from './talk.js';
import { geographyReader } from './visit-world.js';

export type Rooms = ReturnType<typeof roomUseCases>;

/** Everything a rooms test needs over one database; `clock.now` can be moved to test the daily bound. */
export interface RoomWorld {
  readonly db: Kysely<Database>;
  readonly clock: { now: Date };
  readonly rooms: Rooms;
  readonly friends: ReturnType<typeof talkCases>['friends'];
  readonly threads: ReturnType<typeof talkCases>['threads'];
  /** The ask jobs the use cases queued, in order. */
  readonly queued: ContributeJob[];
  readonly boss: PgBoss;
  /** The worker's consumer over a harness (a fixture model in tests). */
  contribute(harness: ReasoningHarness): (job: ContributeJob, signal?: AbortSignal) => Promise<void>;
  close(): Promise<void>;
}

export async function roomWorld(
  database: TestDatabase<Database>,
  clock: { now: Date } = { now: new Date('2026-10-24T08:00:00Z') },
): Promise<RoomWorld> {
  const boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
  await boss.start();
  const forwarding = makeEnqueueJob(boss);
  const queued: ContributeJob[] = [];
  const enqueue: EnqueueJob = async (scope, queue, payload, options) => {
    if (queue.name === contributeQueue.name) queued.push(payload as ContributeJob);
    await forwarding(scope, queue, payload, options);
  };
  const access = accountAccessUseCases({ db: database.db, lockTimeoutMs: 10_000 });
  const deps = {
    withScope: makeWithPersonalScope(database.db, { lockTimeoutMs: 10_000 }),
    fenceOwn: access.fenceOwnAccount,
    readPeople: readPublicPeople,
    readFriends: readFriendAccounts,
    readBlocked: readBlockedAmong,
    readContent: readShareableContent,
    readSequence: readContentSequence,
    readVisited: readVisitedAssets,
    validateSnippet: validateSnippetAnchor,
    resolveSnippet: resolveSnippetAnchor,
    readGeography: geographyReader(database.db),
    // No Scroll in these tests is made for a thread, so the audience of an order is nobody's.
    checkAudience: makeCheckAssetAudience(database.db, () => Promise.resolve(new Set())),
    now: () => clock.now,
  };
  const ownerActive: CheckPersonalOwnerActive = identityScopeOwnerProviders()[0]!.useValue;
  const cases = talkCases(database.db, clock);
  return {
    db: database.db,
    clock,
    rooms: roomUseCases({ ...deps, enqueue }),
    friends: cases.friends,
    threads: cases.threads,
    queued,
    boss,
    contribute(harness) {
      const consume = contributeAsInhabitant({ ...deps, harness, ownerActive, model: 'fixture-model-v1' });
      return (job, signal = new AbortController().signal) => consume(job, signal);
    },
    close: () => boss.stop({ graceful: false }),
  };
}

const version = 'rooms.v1' as const;

/** One room, defined like the operator would; returns its ID. */
export async function seedRoom(
  world: RoomWorld,
  overrides: Partial<RoomSeed> = {},
): Promise<{ readonly roomId: string; readonly slug: string }> {
  const slug = overrides.slug ?? `ci-room-${randomUUID().slice(0, 8)}`;
  const seed: RoomSeed = {
    slug,
    name: 'Fixture room',
    description: 'A CI fixture room about running models.',
    guidelines: 'Be kind.',
    topic: { kind: 'system', id: 'machine-learning' },
    joinRule: 'open',
    inhabitants: ['explainer', 'skeptic'],
    ...overrides,
  };
  await seedRooms(world.db, [seed], world.clock.now);
  const row = await world.db
    .selectFrom('rooms.rooms')
    .select('room_id')
    .where('slug', '=', slug)
    .executeTakeFirstOrThrow();
  return { roomId: row.room_id, slug };
}

/** Names an account a moderator of the room, as the operator would. */
export async function makeModerator(world: RoomWorld, slug: string, person: Friend): Promise<void> {
  expect(
    await setRoomModerator(world.db, { slug, accountId: person.accountId, moderator: true, now: world.clock.now }),
  ).toBe('set');
}

export function unwrap<T>(result: { kind: 'ok'; value: T } | { kind: 'refused'; code: string }): T {
  if (result.kind !== 'ok') throw new Error(`refused: ${result.code}`);
  return result.value;
}

export const joinRoom = (world: RoomWorld, person: Friend, roomId: string) =>
  world.rooms.join(person.authority, { version, commandId: randomUUID(), roomId });

export async function joined(world: RoomWorld, roomId: string, count: number): Promise<Friend[]> {
  const people: Friend[] = [];
  for (let index = 0; index < count; index++) {
    const person = await seedFriend(world.db, world.friends);
    unwrap(await joinRoom(world, person, roomId));
    people.push(person);
  }
  return people;
}

export const startTopic = async (world: RoomWorld, person: Friend, roomId: string, title = 'Where should it run?') =>
  unwrap(
    await world.rooms.create(person.authority, {
      version,
      commandId: randomUUID(),
      roomId,
      start: { kind: 'topic', title },
    }),
  ).discussionId;

export const say = (world: RoomWorld, person: Friend, roomId: string, discussionId: string, text: string) =>
  world.rooms.send(person.authority, {
    version,
    commandId: randomUUID(),
    roomId,
    discussionId,
    body: { kind: 'text', text },
  });

export const readDiscussion = async (world: RoomWorld, person: Friend, roomId: string, discussionId: string) =>
  unwrap(
    await world.rooms.readDiscussion(person.authority, {
      version,
      readId: randomUUID(),
      roomId,
      discussionId,
      limit: 50,
    }),
  );

export const ask = (
  world: RoomWorld,
  person: Friend,
  roomId: string,
  discussionId: string,
  inhabitant: 'explainer' | 'skeptic' = 'skeptic',
) => world.rooms.ask(person.authority, { version, commandId: randomUUID(), roomId, discussionId, inhabitant });

/** A moderator starts a poll with the given options (default: three). */
export const startPoll = (
  world: RoomWorld,
  moderator: Friend,
  roomId: string,
  options: readonly string[] = ['Batching', 'More instances', 'Shorter answers'],
  prompt = 'At 10x requests, what would you try first?',
) =>
  world.rooms.createActivity(moderator.authority, {
    version,
    commandId: randomUUID(),
    roomId,
    activity: { kind: 'poll', prompt, options },
  });

/** A member's vote; a new command ID each time, as a change of mind is. */
export const votePoll = (world: RoomWorld, person: Friend, roomId: string, activityId: string, optionId: string) =>
  world.rooms.votePoll(person.authority, { version, commandId: randomUUID(), roomId, activityId, optionId });

export const readActivity = async (world: RoomWorld, person: Friend, roomId: string, activityId: string) =>
  unwrap(await world.rooms.readActivity(person.authority, { version, readId: randomUUID(), roomId, activityId }));

export { befriend, libraryRoomSeeds };
