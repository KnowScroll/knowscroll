/** Labelled fixtures for idea-room tests: the real use cases over the test database, no HTTP. */
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { PgBoss } from 'pg-boss';
import { expect } from 'vitest';
import { createBoss, makeEnqueueJob, type EnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import {
  fencePersonalRecording,
  makeWithPersonalScope,
  makeWithProductionScope,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import {
  readContentSequence,
  readLibraryReels,
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
  castDueQueue,
  DEFAULT_CAST,
  castPassQueue,
  contributeQueue,
  launchSettleQueue,
  libraryRoomSeeds,
  SETTLE_LAUNCH,
  summariseQueue,
  type CastDueJob,
  type CastPassJob,
  type ContributeJob,
  type LaunchSettleJob,
  type RoomSeed,
  type SummariseJob,
} from '@knowscroll/backend/modules/rooms';
import {
  contributeAsInhabitant,
  decideCast,
  roomUseCases,
  runCastPass,
  roomsWorkerProviders,
  runSummarise,
  seedRooms,
  settleLaunch,
  setRoomModerator,
} from '@knowscroll/backend/modules/rooms/nest-providers';
import {
  readBlockedAmong,
  readFriendAccounts,
  readPublicPeople,
} from '@knowscroll/backend/modules/social/nest-providers';
import { makeCheckAssetAudience } from '../../../packages/backend/src/modules/content/adapters/made-to-order.js';
import type {
  ProductionReasoningHarness,
  RecordingReasoningHarness,
  WithProductionScope,
} from '@knowscroll/backend/reasoning';
import {
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
  type HarnessSettings,
  type ModelPort,
} from '@knowscroll/backend/reasoning/nest-providers';
import type { TestDatabase } from './database.js';
import { fixtureSettings, silent } from './fixture-model.js';
import { roomReportsReader } from './feedback.js';
import { befriend, seedFriend, talkCases, type Friend } from './talk.js';
import { geographyReader } from './visit-world.js';

export type Rooms = ReturnType<typeof roomUseCases>;

export { DEFAULT_CAST };

/** Everything a rooms test needs over one database; `clock.now` can be moved to test the daily bound. */
export interface RoomWorld {
  readonly db: Kysely<Database>;
  readonly clock: { now: Date };
  readonly rooms: Rooms;
  readonly friends: ReturnType<typeof talkCases>['friends'];
  readonly threads: ReturnType<typeof talkCases>['threads'];
  /** The ask jobs the use cases queued, in order. */
  readonly queued: ContributeJob[];
  /** The checks of whether a resident answers, as queued (with when they were asked to run), in order. */
  readonly castChecks: { readonly job: CastDueJob; readonly startAfter: Date | undefined }[];
  /** The model calls of allowed unprompted turns, as queued, in order. */
  readonly castPasses: { readonly job: CastPassJob; readonly startAfter: Date | undefined }[];
  /** The model calls that write a window's "while you were away", as queued, in order. */
  readonly summaries: SummariseJob[];
  /** The settlements of Launches, as queued (with when they were asked to run), in order. */
  readonly launchSettles: { readonly job: LaunchSettleJob; readonly startAfter: Date | undefined }[];
  readonly boss: PgBoss;
  /** The worker's consumer over the recording-aware harness (a fixture model in tests). */
  contribute(harness: RecordingReasoningHarness): (job: ContributeJob, signal?: AbortSignal) => Promise<void>;
  /** The worker's settlement of a Launch whose play time ended (no model, no harness). */
  settle(): (job: LaunchSettleJob) => Promise<void>;
  /** The same consumer built by the worker's provider from a worker configuration, to show the configuration reaches it. */
  settleAsProvided(config: { readonly roomStarsPerDay: number }): (job: LaunchSettleJob) => Promise<void>;
  /** The worker's check of whether a resident answers a message (no model, no harness). */
  decide(): (job: CastDueJob) => Promise<void>;
  /** The worker's model call of an allowed unprompted turn, over a rooms-scope harness. */
  pass(
    harness: ProductionReasoningHarness,
    withRoomScope: WithProductionScope,
  ): (job: CastPassJob, signal?: AbortSignal) => Promise<void>;
  /** The worker's model call that writes a window's "while you were away", over a rooms-scope harness. */
  summarise(
    harness: ProductionReasoningHarness,
    withRoomScope: WithProductionScope,
  ): (job: SummariseJob, signal?: AbortSignal) => Promise<void>;
  close(): Promise<void>;
}

export interface RoomWorldOptions {
  /** Residents may speak unprompted (`KS_REASONING_ROOM_ENABLED`). Off by default, as in a world that has not turned them on. */
  readonly residentsEnabled?: boolean;
  /** Members may send scouts (`KS_ROOMS_SCOUTS_ENABLED`). Off by default, as in a world that has not turned them on. */
  readonly scoutsEnabled?: boolean;
  /** The most stars a room earns on one UTC day (`KS_ROOMS_STARS_PER_DAY`); the default is three. */
  readonly starsPerDay?: number;
  /** The rest between the start of one Launch and the next, in minutes (`KS_ROOMS_LAUNCH_GAP_MINUTES`); the default is two hours. */
  readonly launchGapMinutes?: number;
}

export async function roomWorld(
  database: TestDatabase<Database>,
  clock: { now: Date } = { now: new Date('2026-10-24T08:00:00Z') },
  options: RoomWorldOptions = {},
): Promise<RoomWorld> {
  const boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
  await boss.start();
  const forwarding = makeEnqueueJob(boss);
  const queued: ContributeJob[] = [];
  const castChecks: RoomWorld['castChecks'] = [];
  const castPasses: RoomWorld['castPasses'] = [];
  const summaries: SummariseJob[] = [];
  const launchSettles: RoomWorld['launchSettles'] = [];
  const enqueue: EnqueueJob = async (scope, queue, payload, enqueueOptions) => {
    if (queue.name === contributeQueue.name) queued.push(payload as ContributeJob);
    if (queue.name === castDueQueue.name)
      castChecks.push({ job: payload as CastDueJob, startAfter: enqueueOptions?.startAfter });
    if (queue.name === castPassQueue.name)
      castPasses.push({ job: payload as CastPassJob, startAfter: enqueueOptions?.startAfter });
    if (queue.name === summariseQueue.name) summaries.push(payload as SummariseJob);
    if (queue.name === launchSettleQueue.name)
      launchSettles.push({ job: payload as LaunchSettleJob, startAfter: enqueueOptions?.startAfter });
    // The queue refuses a start more than a day ahead of now: the same rule is held against the test clock, so a job queued too far
    // ahead still fails here. The test clock itself runs ahead of the real one and nothing consumes these jobs, so a start that is
    // valid by the test clock is forwarded as "now" to pass the real queue's check against the real time.
    const startAfter = enqueueOptions?.startAfter;
    if (startAfter !== undefined && startAfter.getTime() > clock.now.getTime() + 86_400_000)
      throw new Error('JOB_START_AFTER_INVALID');
    const forwarded =
      startAfter !== undefined && startAfter.getTime() > Date.now()
        ? { ...enqueueOptions, startAfter: new Date() }
        : enqueueOptions;
    await forwarding(scope, queue, payload, forwarded);
  };
  const access = accountAccessUseCases({ db: database.db, lockTimeoutMs: 10_000 });
  const deps = {
    withScope: makeWithPersonalScope(database.db, { lockTimeoutMs: 10_000 }),
    fenceOwn: access.fenceOwnAccount,
    fenceRecording: fencePersonalRecording,
    readPeople: readPublicPeople,
    readFriends: readFriendAccounts,
    readBlocked: readBlockedAmong,
    readContent: readShareableContent,
    readReels: readLibraryReels,
    readSequence: readContentSequence,
    readVisited: readVisitedAssets,
    readReports: roomReportsReader,
    validateSnippet: validateSnippetAnchor,
    resolveSnippet: resolveSnippetAnchor,
    readGeography: geographyReader(database.db),
    // No Scroll in these tests is made for a thread, so the audience of an order is nobody's.
    checkAudience: makeCheckAssetAudience(database.db, [() => Promise.resolve(new Set())]),
    now: () => clock.now,
    residentsEnabled: options.residentsEnabled ?? false,
    scoutsEnabled: options.scoutsEnabled ?? false,
    ...(options.starsPerDay === undefined ? {} : { starsPerDay: options.starsPerDay }),
    ...(options.launchGapMinutes === undefined ? {} : { launchGapMinutes: options.launchGapMinutes }),
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
    castChecks,
    castPasses,
    launchSettles,
    summaries,
    boss,
    settle() {
      const run = settleLaunch({ ...deps, enqueue, ownerActive });
      return (job) => run(job);
    },
    settleAsProvided(config) {
      const provider = roomsWorkerProviders({
        withPersonalScope: Symbol('withPersonalScope'),
        workerConfig: Symbol('workerConfig'),
        enqueueJob: Symbol('enqueueJob'),
      }).find((entry) => entry.provide === SETTLE_LAUNCH)!;
      // The arguments follow the provider's `inject` list: the use cases' own dependencies, then the queue and the config.
      const make = provider.useFactory as unknown as (...args: unknown[]) => (job: LaunchSettleJob) => Promise<void>;
      return make(
        deps.withScope,
        deps.fenceOwn,
        deps.readPeople,
        deps.readFriends,
        deps.readContent,
        deps.readSequence,
        deps.readVisited,
        deps.validateSnippet,
        deps.resolveSnippet,
        deps.checkAudience,
        deps.readBlocked,
        ownerActive,
        enqueue,
        { reasoning: { roomEnabled: false }, ...config },
      );
    },
    decide() {
      const decision = decideCast({ ...deps, enqueue, ownerActive, residentsEnabled: true });
      return (job) => decision(job);
    },
    pass(harness, withRoomScope) {
      const consume = runCastPass({
        ...deps,
        enqueue,
        harness,
        withRoomScope,
        ownerActive,
        model: 'fixture-model-v1',
        generation: 1,
        residentsEnabled: true,
      });
      return (job, signal = new AbortController().signal) => consume(job, signal);
    },
    summarise(harness, withRoomScope) {
      const consume = runSummarise({
        ...deps,
        enqueue,
        harness,
        withRoomScope,
        ownerActive,
        model: 'fixture-model-v1',
        generation: 1,
        residentsEnabled: true,
      });
      return (job, signal = new AbortController().signal) => consume(job, signal);
    },
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
    cast: DEFAULT_CAST,
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

/** A pointed ask: challenge a message, ask for the other side, or ask about it (D-167). */
export const askAbout = (
  world: RoomWorld,
  person: Friend,
  roomId: string,
  discussionId: string,
  kind: 'challenge' | 'other_side' | 'about',
  messageId: string,
) =>
  world.rooms.ask(person.authority, {
    version,
    commandId: randomUUID(),
    roomId,
    discussionId,
    about: { kind, messageId },
  });

/** Marks a message Useful (or takes the mark back), under a fresh command ID. */
export const markUseful = (
  world: RoomWorld,
  person: Friend,
  roomId: string,
  discussionId: string,
  messageId: string,
  useful = true,
) =>
  world.rooms.markUseful(person.authority, {
    version,
    commandId: randomUUID(),
    roomId,
    discussionId,
    messageId,
    useful,
  });

/** A moderator removes a message from view, or restores it. */
export const hideMessage = (
  world: RoomWorld,
  moderator: Friend,
  roomId: string,
  discussionId: string,
  messageId: string,
  hidden = true,
) =>
  world.rooms.hideMessage(moderator.authority, {
    version,
    commandId: randomUUID(),
    roomId,
    discussionId,
    messageId,
    hidden,
  });

/** Starts a topic from a message of the room (R3 B1). */
export const startTopicFrom = (
  world: RoomWorld,
  person: Friend,
  roomId: string,
  from: { readonly discussionId: string; readonly messageId: string },
  extra: { readonly title?: string; readonly tag?: 'question' | 'debate' | 'explainer' | 'share' } = {},
) =>
  world.rooms.create(person.authority, {
    version,
    commandId: randomUUID(),
    roomId,
    start: { kind: 'message', ...from, ...extra },
  });

/** The room's topics as the person reads them (R3 B2). */
export const topicsOf = async (
  world: RoomWorld,
  person: Friend,
  roomId: string,
  sort: 'hot' | 'new' | 'unanswered' = 'new',
  tag?: 'question' | 'debate' | 'explainer' | 'share',
) => {
  const read = unwrap(
    await world.rooms.topics(person.authority, {
      version,
      readId: randomUUID(),
      roomId,
      sort,
      ...(tag === undefined ? {} : { tag }),
    }),
  );
  if (read.status !== 'ready') throw new Error('expected ready');
  return read.topics;
};

/** The member reads their "while you were away". */
export const dismissAway = (world: RoomWorld, person: Friend, roomId: string) =>
  world.rooms.dismissAway(person.authority, { version, commandId: randomUUID(), roomId });

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

/** The caller's device says the room is open (or closed): the lease behind a face. */
export const setPresence = (world: RoomWorld, person: Friend, roomId: string, state: 'here' | 'away' = 'here') =>
  world.rooms.setPresence(person.authority, { version, roomId, state });

/** A member's own AI level, keep-out choice or notice acknowledgement, under a fresh command ID. */
export const setPreferences = (
  world: RoomWorld,
  person: Friend,
  roomId: string,
  patch: { aiLevel?: 'lively' | 'quieter' | 'off'; keepOut?: boolean; noticeSeen?: true },
) => world.rooms.setPreferences(person.authority, { version, commandId: randomUUID(), roomId, ...patch });

/** The room as this person reads it, which must be a member's view. */
export async function memberView(world: RoomWorld, person: Friend, roomId: string) {
  const view = unwrap(await world.rooms.read(person.authority, { version, readId: randomUUID(), roomId }));
  if (view.status !== 'member') throw new Error(`expected a member view, got ${view.status}`);
  return view;
}

/**
 * A harness for the nonpersonal `rooms` scope (D-162) over a model, and the scope function that closes its runs: what the
 * worker builds when residents are on. `settings` set the caps the room scope and the ambient share are held to.
 */
export function roomScope(db: Kysely<Database>, model: ModelPort, settings: HarnessSettings = fixtureSettings) {
  const withScope = makeWithProductionScope(db, { enabled: true, lockTimeoutMs: 5_000, scopeId: 'rooms' });
  const harness = makeProductionReasoningHarness(
    postgresProductionHarnessPorts({
      db,
      withProductionScope: withScope,
      enabled: true,
      scopeId: 'rooms',
      model,
      logEvent: silent,
      settings,
    }),
  );
  return { harness, withScope };
}

/**
 * The schemas of a person's own universe. Rooms are conversation, so no room command or job may write a row to any of
 * them (D-167 to D-169); a test that lists a schema that does not exist would pass for ever, so `rowsIn` refuses one.
 */
export const PERSONAL_UNIVERSE_SCHEMAS = [
  'experience',
  'geography',
  'composer',
  'planner',
  'evidence',
  'personal_context',
] as const;

/**
 * How many rows the given schemas hold in all, for proving that a feature wrote nothing there. A schema that has no
 * table (a misspelt name) throws, so the proof cannot hold for the wrong reason.
 */
export async function rowsIn(db: Kysely<Database>, schemas: readonly string[]): Promise<number> {
  const tables = await sql<{ table_schema: string; table_name: string }>`
    select table_schema, table_name from information_schema.tables
    where table_type = 'BASE TABLE' and table_schema = any(${[...schemas]})`.execute(db);
  for (const schema of schemas)
    if (!tables.rows.some((table) => table.table_schema === schema))
      throw new Error(`rowsIn: the schema "${schema}" has no tables`);
  let total = 0;
  for (const table of tables.rows) {
    const row = await sql<{ n: string }>`
      select count(*)::text as n from ${sql.table(`${table.table_schema}.${table.table_name}`)}`.execute(db);
    total += Number(row.rows[0]?.n ?? 0);
  }
  return total;
}
