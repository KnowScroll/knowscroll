import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { ApiConfig, WorkerConfig } from '../../../infrastructure/config/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { uuidv7, stableUuid } from '../../../infrastructure/ids/index.js';
import type { EnqueueJob } from '../../../infrastructure/jobs/index.js';
import { requestHash, type CanonicalJson } from '../../../infrastructure/receipts/index.js';
import {
  REASONING_HARNESS,
  ROOM_REASONING_HARNESS,
  WITH_ROOM_SCOPE,
  type ImagePort,
  type ProductionReasoningHarness,
  type ReasoningHarness,
  type WithProductionScope,
} from '../../../reasoning/public.js';
import {
  CHECK_ASSET_AUDIENCE,
  READ_CONTENT_SEQUENCE,
  READ_LIBRARY_REELS,
  READ_SHAREABLE_CONTENT,
  RESOLVE_SNIPPET_ANCHOR,
  VALIDATE_SNIPPET_ANCHOR,
  type CheckAssetAudience,
  type ReadContentSequence,
  type ReadLibraryReels,
  type ReadShareableContent,
  type ResolveSnippetAnchor,
  type ValidateSnippetAnchor,
} from '../../content/public.js';
import { READ_VISITED_ASSETS, type ReadVisitedAssets } from '../../experience/public.js';
import { READ_GEOGRAPHY_SCENE_INPUT, type ReadGeographySceneInput } from '../../geography/public.js';
import {
  CHECK_PERSONAL_OWNER_ACTIVE,
  FENCE_OWN_ACCOUNT,
  FENCE_PERSONAL_RECORDING,
  type CheckPersonalOwnerActive,
  type FenceOwnAccount,
  type FencePersonalRecording,
  type WithPersonalScope,
} from '../../identity/public.js';
import {
  READ_BLOCKED_AMONG,
  READ_FRIEND_ACCOUNTS,
  READ_PUBLIC_PEOPLE,
  type ReadBlockedAmong,
  type ReadFriendAccounts,
  type ReadPublicPeople,
} from '../../social/public.js';
import { makeActivities } from '../application/activities.js';
import { makeDebateVotes } from '../application/debates.js';
import { makeFeed } from '../application/feed-reads.js';
import { makeIntroductionCommands } from '../application/introduction-commands.js';
import { makePostCommands } from '../application/post-commands.js';
import { makeScoutCommands } from '../application/scout-commands.js';
import { makeCastDue, type CastDuePorts } from '../application/cast-due.js';
import { makeCastPass, type CastPassPorts } from '../application/cast-pass.js';
import { makeContribute, type ContributePorts } from '../application/contribute.js';
import { makeDiscussionCommands } from '../application/discussion-commands.js';
import { makeDiscussionReads } from '../application/discussion-reads.js';
import { makeInhabitantCommands } from '../application/inhabitant-commands.js';
import { makeMemberCommands } from '../application/member-commands.js';
import type { RoomPorts } from '../application/ports.js';
import { makeRoomCommands } from '../application/room-commands.js';
import { makeRoomReads } from '../application/room-reads.js';
import { BACKDROP_MONEY, makeFaceBackdropOperator, type BackdropMoney } from '../application/face-backdrop.js';
import { makeFaceKitOperator } from '../application/face-kit.js';
import { makeSkyUseCases } from '../application/sky.js';
import { makeStationReads } from '../application/stations.js';
import { makeSummarise, type SummarisePorts } from '../application/summarise.js';
import { makeLaunch } from '../application/launch.js';
import { makeWatch } from '../application/watch.js';
import { makeQuestions } from '../application/questions.js';
import { makeReplay } from '../application/replay.js';
import { makeToday } from '../application/today.js';
import { LAUNCH_GAP_MINUTES_DEFAULT } from '../domain/launch.js';
import { STARS_PER_DAY_DEFAULT } from '../domain/sky.js';
import { castDueQueue, castPassQueue, contributeQueue, summariseQueue } from '../events.js';
import {
  CONTRIBUTE_AS_INHABITANT,
  DECIDE_CAST,
  HOLD_CAST,
  READ_REPORTABLE_ROOM_MESSAGE,
  READ_ROOM_BACKDROP,
  READ_ROOM_MEMBERSHIP,
  READ_ROOM_REPORTS,
  ROOM_USE_CASES,
  RUN_CAST_PASS,
  SUMMARISE,
  type ContributeAsInhabitant,
  type DecideCast,
  type HoldCast,
  type ReadRoomReports,
  type RoomUseCases,
  type RunCastPass,
  type Summarise,
} from '../public.js';
import { localBackdropMedia } from './backdrop-media.js';
import { activityStore } from './postgres-activities.js';
import { aiStore } from './postgres-ai.js';
import { castStore } from './postgres-cast.js';
import { faceStore, readApprovedBackdrop } from './postgres-face.js';
import { holdCast } from './typing-holds.js';
import { positionStore } from './postgres-positions.js';
import { presenceStore } from './postgres-presence.js';
import { readRoomMembership } from './membership-reads.js';
import { discussionStore } from './postgres-discussions.js';
import { roomStore } from './postgres-rooms.js';
import { feedReadStore } from './postgres-feed.js';
import { postStore } from './postgres-posts.js';
import { scoutReadStore } from './postgres-scouts.js';
import { launchStore } from './postgres-launch.js';
import { watchStore } from './postgres-watch.js';
import { questionStore } from './postgres-questions.js';
import { debateStore, skyStore, todayStore } from './postgres-sky.js';
import { summaryStore } from './postgres-summaries.js';
import { readReportableRoomMessage } from './report-reads.js';
import { gateSnippetAnchors } from './snippet-audience.js';

/** What every room use case needs from the rest of the system, chosen by the composition root. */
export interface RoomsDeps {
  readonly withScope: WithPersonalScope;
  readonly fenceOwn: FenceOwnAccount;
  /** Only the API serves the command that reads it; the worker's jobs never ask. */
  readonly fenceRecording?: FencePersonalRecording;
  readonly readPeople: ReadPublicPeople;
  readonly readFriends: ReadFriendAccounts;
  /** Which of some accounts the caller has blocked: their words are collapsed for the caller, never for anyone else. */
  readonly readBlocked: ReadBlockedAmong;
  readonly readContent: ReadShareableContent;
  /** The library Reels under a topic, for Watch together; only the API serves the commands that read them (v3 R-10). */
  readonly readReels?: ReadLibraryReels;
  readonly readSequence: ReadContentSequence;
  readonly readVisited: ReadVisitedAssets;
  /** Reports on a room's messages, for its moderators; only the API serves that read. */
  readonly readReports?: ReadRoomReports;
  readonly validateSnippet: ValidateSnippetAnchor;
  readonly resolveSnippet: ResolveSnippetAnchor;
  /** The caller's own map, for stations; the worker never reads stations. */
  readonly readGeography?: ReadGeographySceneInput;
  /** Which Scrolls the caller may open: one made for a thread is not a room's to quote (D-049). */
  readonly checkAudience: CheckAssetAudience;
  /**
   * The API enqueues the ask job and the resident checks at send time; the worker enqueues the model call of an allowed
   * turn, a later look and the Skeptic's reply.
   */
  readonly enqueue?: EnqueueJob;
  /** Residents may speak unprompted in this world (`KS_REASONING_ROOM_ENABLED`, D-162). Off queues nothing. */
  readonly residentsEnabled?: boolean;
  /** Members may send scouts in this world (`KS_ROOMS_SCOUTS_ENABLED`, v3 R-9, D-259). Off, no scout can be set. */
  readonly scoutsEnabled?: boolean;
  /** The most stars a room earns on one UTC day (`KS_ROOMS_STARS_PER_DAY`, D-174); the default is three. */
  readonly starsPerDay?: number;
  /** The rest between the start of one Launch and the next, in minutes (`KS_ROOMS_LAUNCH_GAP_MINUTES`, D-178); the default is two hours. */
  readonly launchGapMinutes?: number;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** The ports of the room use cases over PostgreSQL and the neighbouring modules' public reads. */
export function roomPorts(deps: RoomsDeps): RoomPorts {
  return {
    withScope: deps.withScope,
    fenceOwn: deps.fenceOwn,
    fenceRecording: deps.fenceRecording ?? (() => Promise.resolve({ kind: 'unavailable' as const })),
    rooms: roomStore,
    discussions: discussionStore,
    presence: presenceStore,
    ai: aiStore,
    cast: castStore,
    positions: positionStore,
    summaries: summaryStore,
    activities: activityStore,
    sky: skyStore,
    debates: debateStore,
    today: todayStore,
    launches: launchStore,
    watches: watchStore,
    feed: feedReadStore,
    scouts: scoutReadStore,
    posts: postStore,
    questions: questionStore,
    people: {
      async byAccounts(scope, accountIds) {
        const people = await deps.readPeople(scope, { accountIds });
        return new Map(people.map((entry) => [entry.accountId, entry.person]));
      },
      async accountOf(scope, personId) {
        const [found] = await deps.readPeople(scope, { personIds: [personId] });
        return found?.accountId;
      },
      async hasProfile(scope, accountId) {
        return (await deps.readPeople(scope, { accountIds: [accountId] })).length > 0;
      },
    },
    blocked: (scope, accountId, candidates) => deps.readBlocked(scope, accountId, candidates),
    friends: {
      async accounts(scope, accountId, limit) {
        return (await deps.readFriends(scope, accountId, { limit })).map((friend) => friend.accountId);
      },
      async byPerson(scope, accountId, personId) {
        const [found] = await deps.readFriends(scope, accountId, { personId });
        return found?.accountId;
      },
    },
    readContent: deps.readContent,
    readReels: deps.readReels ?? (() => Promise.resolve([])),
    readSequence: deps.readSequence,
    readVisited: deps.readVisited,
    readReports: (scope, query) => {
      if (deps.readReports === undefined) throw new Error('ROOMS_REPORTS_NOT_CONFIGURED');
      return deps.readReports(scope, query);
    },
    ...gateSnippetAnchors(deps.checkAudience, deps.validateSnippet, deps.resolveSnippet),
    readGeography: deps.readGeography ?? (() => Promise.resolve({ kind: 'refused' as const })),
    newId: deps.newId ?? uuidv7,
    hash: (operation, input) => requestHash(operation, input as CanonicalJson),
    now: deps.now ?? (() => new Date()),
    enqueueContribution: async (scope, requestId) => {
      if (deps.enqueue === undefined) throw new Error('ROOMS_ENQUEUE_NOT_CONFIGURED');
      await deps.enqueue(
        scope,
        contributeQueue,
        { v: 1, universeId: scope.authority.universeId, privacyEpoch: scope.authority.privacyEpoch, requestId },
        { jobId: stableUuid(`rooms-contribute:${requestId}`), duplicate: 'ignore' },
      );
    },
    residentsEnabled: deps.residentsEnabled ?? false,
    scoutsEnabled: deps.scoutsEnabled ?? false,
    starsPerDay: deps.starsPerDay ?? STARS_PER_DAY_DEFAULT,
    launchGapMs: (deps.launchGapMinutes ?? LAUNCH_GAP_MINUTES_DEFAULT) * 60_000,
    enqueueCastDue: async (scope, job, startAfter) => {
      if (deps.enqueue === undefined) throw new Error('ROOMS_ENQUEUE_NOT_CONFIGURED');
      await deps.enqueue(scope, castDueQueue, job, {
        // One job per message, trigger and look: a redelivery of the send or of a look cannot queue a second.
        jobId: stableUuid(`rooms-cast-due:${job.causeMessageId}:${job.trigger}:${String(job.round)}`),
        duplicate: 'ignore',
        startAfter,
      });
    },
    enqueueSummary: async (scope, job) => {
      if (deps.enqueue === undefined) throw new Error('ROOMS_ENQUEUE_NOT_CONFIGURED');
      await deps.enqueue(scope, summariseQueue, job, {
        // One job per summary: a redelivery of the presence beat cannot queue a second call for the window.
        jobId: stableUuid(`rooms-summarise:${job.summaryId}`),
        duplicate: 'ignore',
      });
    },
    enqueueCastPass: async (scope, job, startAfter) => {
      if (deps.enqueue === undefined) throw new Error('ROOMS_ENQUEUE_NOT_CONFIGURED');
      await deps.enqueue(scope, castPassQueue, job, {
        jobId: stableUuid(`rooms-cast-pass:${job.turnId}:${String(job.round)}`),
        duplicate: 'ignore',
        ...(startAfter === undefined ? {} : { startAfter }),
      });
    },
  };
}

/** Explicit backend use cases; only composition roots choose the database and neighbouring-module adapters. */
export function roomUseCases(deps: RoomsDeps): RoomUseCases {
  const ports = roomPorts(deps);
  return {
    ...makeRoomReads(ports),
    ...makeRoomCommands(ports),
    ...makeMemberCommands(ports),
    ...makeDiscussionCommands(ports),
    ...makeDiscussionReads(ports),
    ...makeInhabitantCommands(ports),
    ...makeStationReads(ports),
    ...makeActivities(ports),
    ...makeSkyUseCases(ports),
    ...makeToday(ports),
    ...makeLaunch(ports),
    ...makeWatch(ports),
    ...makeReplay(ports),
    ...makeQuestions(ports),
    ...makeDebateVotes(ports),
    ...makeFeed(ports),
    ...makeScoutCommands(ports),
    ...makePostCommands(ports),
    ...makeIntroductionCommands(ports),
  };
}

/** The worker's consumer of `rooms.contribute`, with the harness, the owner check and the configured model. */
export function contributeAsInhabitant(
  deps: RoomsDeps & {
    readonly harness: ReasoningHarness;
    readonly ownerActive: CheckPersonalOwnerActive;
    readonly model: string;
  },
): ContributeAsInhabitant {
  const ports: ContributePorts = { ...roomPorts(deps), ownerActive: deps.ownerActive, model: deps.model };
  return makeContribute(ports, deps.harness);
}

/** The worker's check of whether a resident answers a message: the pure router, no model call. */
export function decideCast(deps: RoomsDeps & { readonly ownerActive: CheckPersonalOwnerActive }): DecideCast {
  const ports: CastDuePorts = { ...roomPorts(deps), ownerActive: deps.ownerActive };
  return makeCastDue(ports);
}

/** The worker's model call of an allowed unprompted turn, under the room scope. */
export function runCastPass(
  deps: RoomsDeps & {
    readonly harness: ProductionReasoningHarness;
    readonly withRoomScope: WithProductionScope;
    readonly ownerActive: CheckPersonalOwnerActive;
    readonly model: string;
    readonly generation: number;
  },
): RunCastPass {
  const ports: CastPassPorts = {
    ...roomPorts(deps),
    ownerActive: deps.ownerActive,
    model: deps.model,
    generation: deps.generation,
  };
  return makeCastPass(ports, deps.harness, deps.withRoomScope);
}

/** The worker's model call that writes one window's "while you were away", under the room scope. */
export function runSummarise(
  deps: RoomsDeps & {
    readonly harness: ProductionReasoningHarness;
    readonly withRoomScope: WithProductionScope;
    readonly ownerActive: CheckPersonalOwnerActive;
    readonly model: string;
    readonly generation: number;
  },
): Summarise {
  const ports: SummarisePorts = {
    ...roomPorts(deps),
    ownerActive: deps.ownerActive,
    model: deps.model,
    generation: deps.generation,
  };
  return makeSummarise(ports, deps.harness, deps.withRoomScope);
}

/**
 * The operator's controls over every room's face (D-166, D-170, D-171): kit proposals and their review, painted backdrops
 * inside the $1 cap, and the spend ledger. Composed by an operator command or a test with a database, the room scope's
 * harness and, for pictures, an image port and a media root. A missing image port or media root only refuses the commands
 * that need it.
 */
export function composeFaceOperator(deps: {
  readonly db: Kysely<Database>;
  readonly harness: ProductionReasoningHarness;
  readonly withRoomScope: WithProductionScope;
  readonly image: ImagePort | undefined;
  readonly mediaRoot: string | undefined;
  readonly model: string;
  readonly generation: number;
  /** Tests inject a smaller cap or another price; production uses the constants of the money rule. */
  readonly money?: BackdropMoney;
  readonly now?: () => Date;
}) {
  const store = faceStore(deps.db);
  const now = deps.now ?? (() => new Date());
  return {
    kit: makeFaceKitOperator(
      {
        store,
        model: deps.model,
        generation: deps.generation,
        runIdFor: (roomId, revision, sequence) =>
          stableUuid(`rooms-kit:${roomId}:${String(revision)}:${String(sequence)}`),
        now,
      },
      deps.harness,
      deps.withRoomScope,
    ),
    backdrop: makeFaceBackdropOperator({
      store,
      media: deps.mediaRoot === undefined ? undefined : localBackdropMedia(deps.mediaRoot),
      image: deps.image,
      money: deps.money ?? BACKDROP_MONEY,
      now,
      newId: uuidv7,
      sha256: (text) => createHash('sha256').update(text).digest('hex'),
    }),
  };
}

export { seedRooms, setRoomModerator, type ModeratorOutcome } from './seed.js';
export { holdCast } from './typing-holds.js';
export { readApprovedBackdrop } from './postgres-face.js';
export { composeRitualOperator, roomsRitualProviders } from './ritual-providers.js';
export {
  composeFeedHeartbeat,
  composeScoutHeartbeat,
  roomsFeedProviders,
  roomsScoutProviders,
} from './feed-providers.js';

/** The API's room use cases, and the room read the report use cases ask for. */
export function roomsProviders(tokens: {
  readonly withPersonalScope: symbol;
  readonly enqueueJob: symbol;
  readonly database: symbol;
  /** The API's configuration, for `roomResidentsEnabled`. */
  readonly apiConfig: symbol;
}) {
  return [
    { provide: READ_REPORTABLE_ROOM_MESSAGE, useValue: readReportableRoomMessage },
    {
      provide: READ_ROOM_BACKDROP,
      inject: [tokens.database],
      useFactory: (db: Kysely<Database>) => readApprovedBackdrop(db),
    },
    {
      provide: HOLD_CAST,
      inject: [tokens.database],
      useFactory: (db: Kysely<Database>): HoldCast => holdCast(db),
    },
    {
      provide: READ_ROOM_MEMBERSHIP,
      inject: [tokens.database],
      useFactory: (db: Kysely<Database>) => readRoomMembership(db),
    },
    {
      provide: ROOM_USE_CASES,
      inject: [
        tokens.withPersonalScope,
        FENCE_OWN_ACCOUNT,
        READ_PUBLIC_PEOPLE,
        READ_FRIEND_ACCOUNTS,
        READ_BLOCKED_AMONG,
        READ_SHAREABLE_CONTENT,
        READ_CONTENT_SEQUENCE,
        READ_VISITED_ASSETS,
        VALIDATE_SNIPPET_ANCHOR,
        RESOLVE_SNIPPET_ANCHOR,
        READ_GEOGRAPHY_SCENE_INPUT,
        CHECK_ASSET_AUDIENCE,
        READ_ROOM_REPORTS,
        tokens.enqueueJob,
        tokens.apiConfig,
        FENCE_PERSONAL_RECORDING,
        READ_LIBRARY_REELS,
      ],
      useFactory: (
        withScope: WithPersonalScope,
        fenceOwn: FenceOwnAccount,
        readPeople: ReadPublicPeople,
        readFriends: ReadFriendAccounts,
        readBlocked: ReadBlockedAmong,
        readContent: ReadShareableContent,
        readSequence: ReadContentSequence,
        readVisited: ReadVisitedAssets,
        validateSnippet: ValidateSnippetAnchor,
        resolveSnippet: ResolveSnippetAnchor,
        readGeography: ReadGeographySceneInput,
        checkAudience: CheckAssetAudience,
        readReports: ReadRoomReports,
        enqueue: EnqueueJob,
        config: ApiConfig,
        fenceRecording: FencePersonalRecording,
        readReels: ReadLibraryReels,
      ) =>
        roomUseCases({
          withScope,
          fenceOwn,
          fenceRecording,
          readPeople,
          readFriends,
          readBlocked,
          readContent,
          readReels,
          readSequence,
          readVisited,
          validateSnippet,
          resolveSnippet,
          readGeography,
          checkAudience,
          readReports,
          enqueue,
          residentsEnabled: config.roomResidentsEnabled,
          scoutsEnabled: config.roomScoutsEnabled,
          starsPerDay: config.roomStarsPerDay,
          launchGapMinutes: config.roomLaunchGapMinutes,
        }),
    },
  ];
}

/** The worker's inhabitant consumer. The harness refuses every call while no model provider is configured. */
export function roomsWorkerProviders(tokens: {
  readonly withPersonalScope: symbol;
  readonly workerConfig: symbol;
  readonly enqueueJob: symbol;
}) {
  return [
    {
      provide: DECIDE_CAST,
      inject: [
        tokens.withPersonalScope,
        FENCE_OWN_ACCOUNT,
        READ_PUBLIC_PEOPLE,
        READ_FRIEND_ACCOUNTS,
        READ_SHAREABLE_CONTENT,
        READ_CONTENT_SEQUENCE,
        READ_VISITED_ASSETS,
        VALIDATE_SNIPPET_ANCHOR,
        RESOLVE_SNIPPET_ANCHOR,
        CHECK_ASSET_AUDIENCE,
        READ_BLOCKED_AMONG,
        CHECK_PERSONAL_OWNER_ACTIVE,
        tokens.enqueueJob,
        tokens.workerConfig,
      ],
      useFactory: (
        withScope: WithPersonalScope,
        fenceOwn: FenceOwnAccount,
        readPeople: ReadPublicPeople,
        readFriends: ReadFriendAccounts,
        readContent: ReadShareableContent,
        readSequence: ReadContentSequence,
        readVisited: ReadVisitedAssets,
        validateSnippet: ValidateSnippetAnchor,
        resolveSnippet: ResolveSnippetAnchor,
        checkAudience: CheckAssetAudience,
        readBlocked: ReadBlockedAmong,
        ownerActive: CheckPersonalOwnerActive,
        enqueue: EnqueueJob,
        config: WorkerConfig,
      ) =>
        decideCast({
          withScope,
          fenceOwn,
          readPeople,
          readFriends,
          readContent,
          readSequence,
          readVisited,
          validateSnippet,
          resolveSnippet,
          checkAudience,
          readBlocked,
          ownerActive,
          enqueue,
          residentsEnabled: config.reasoning.roomEnabled,
        }),
    },
    {
      provide: RUN_CAST_PASS,
      inject: [
        tokens.withPersonalScope,
        FENCE_OWN_ACCOUNT,
        READ_PUBLIC_PEOPLE,
        READ_FRIEND_ACCOUNTS,
        READ_SHAREABLE_CONTENT,
        READ_CONTENT_SEQUENCE,
        READ_VISITED_ASSETS,
        VALIDATE_SNIPPET_ANCHOR,
        RESOLVE_SNIPPET_ANCHOR,
        CHECK_ASSET_AUDIENCE,
        READ_BLOCKED_AMONG,
        ROOM_REASONING_HARNESS,
        WITH_ROOM_SCOPE,
        CHECK_PERSONAL_OWNER_ACTIVE,
        tokens.enqueueJob,
        tokens.workerConfig,
      ],
      useFactory: (
        withScope: WithPersonalScope,
        fenceOwn: FenceOwnAccount,
        readPeople: ReadPublicPeople,
        readFriends: ReadFriendAccounts,
        readContent: ReadShareableContent,
        readSequence: ReadContentSequence,
        readVisited: ReadVisitedAssets,
        validateSnippet: ValidateSnippetAnchor,
        resolveSnippet: ResolveSnippetAnchor,
        checkAudience: CheckAssetAudience,
        readBlocked: ReadBlockedAmong,
        harness: ProductionReasoningHarness,
        withRoomScope: WithProductionScope,
        ownerActive: CheckPersonalOwnerActive,
        enqueue: EnqueueJob,
        config: WorkerConfig,
      ) =>
        runCastPass({
          withScope,
          fenceOwn,
          readPeople,
          readFriends,
          readContent,
          readSequence,
          readVisited,
          validateSnippet,
          resolveSnippet,
          checkAudience,
          readBlocked,
          harness,
          withRoomScope,
          ownerActive,
          enqueue,
          residentsEnabled: config.reasoning.roomEnabled,
          generation: config.reasoning.roomGeneration,
          model: config.reasoning.minimax?.model ?? 'unconfigured',
        }),
    },
    {
      provide: SUMMARISE,
      inject: [
        tokens.withPersonalScope,
        FENCE_OWN_ACCOUNT,
        READ_PUBLIC_PEOPLE,
        READ_FRIEND_ACCOUNTS,
        READ_SHAREABLE_CONTENT,
        READ_CONTENT_SEQUENCE,
        READ_VISITED_ASSETS,
        VALIDATE_SNIPPET_ANCHOR,
        RESOLVE_SNIPPET_ANCHOR,
        CHECK_ASSET_AUDIENCE,
        READ_BLOCKED_AMONG,
        ROOM_REASONING_HARNESS,
        WITH_ROOM_SCOPE,
        CHECK_PERSONAL_OWNER_ACTIVE,
        tokens.enqueueJob,
        tokens.workerConfig,
      ],
      useFactory: (
        withScope: WithPersonalScope,
        fenceOwn: FenceOwnAccount,
        readPeople: ReadPublicPeople,
        readFriends: ReadFriendAccounts,
        readContent: ReadShareableContent,
        readSequence: ReadContentSequence,
        readVisited: ReadVisitedAssets,
        validateSnippet: ValidateSnippetAnchor,
        resolveSnippet: ResolveSnippetAnchor,
        checkAudience: CheckAssetAudience,
        readBlocked: ReadBlockedAmong,
        harness: ProductionReasoningHarness,
        withRoomScope: WithProductionScope,
        ownerActive: CheckPersonalOwnerActive,
        enqueue: EnqueueJob,
        config: WorkerConfig,
      ) =>
        runSummarise({
          withScope,
          fenceOwn,
          readPeople,
          readFriends,
          readContent,
          readSequence,
          readVisited,
          validateSnippet,
          resolveSnippet,
          checkAudience,
          readBlocked,
          harness,
          withRoomScope,
          ownerActive,
          enqueue,
          residentsEnabled: config.reasoning.roomEnabled,
          generation: config.reasoning.roomGeneration,
          model: config.reasoning.minimax?.model ?? 'unconfigured',
        }),
    },
    {
      provide: CONTRIBUTE_AS_INHABITANT,
      inject: [
        tokens.withPersonalScope,
        FENCE_OWN_ACCOUNT,
        READ_PUBLIC_PEOPLE,
        READ_FRIEND_ACCOUNTS,
        READ_SHAREABLE_CONTENT,
        READ_CONTENT_SEQUENCE,
        READ_VISITED_ASSETS,
        VALIDATE_SNIPPET_ANCHOR,
        RESOLVE_SNIPPET_ANCHOR,
        CHECK_ASSET_AUDIENCE,
        READ_BLOCKED_AMONG,
        REASONING_HARNESS,
        CHECK_PERSONAL_OWNER_ACTIVE,
        tokens.workerConfig,
      ],
      useFactory: (
        withScope: WithPersonalScope,
        fenceOwn: FenceOwnAccount,
        readPeople: ReadPublicPeople,
        readFriends: ReadFriendAccounts,
        readContent: ReadShareableContent,
        readSequence: ReadContentSequence,
        readVisited: ReadVisitedAssets,
        validateSnippet: ValidateSnippetAnchor,
        resolveSnippet: ResolveSnippetAnchor,
        checkAudience: CheckAssetAudience,
        readBlocked: ReadBlockedAmong,
        harness: ReasoningHarness,
        ownerActive: CheckPersonalOwnerActive,
        config: WorkerConfig,
      ) =>
        contributeAsInhabitant({
          withScope,
          fenceOwn,
          readPeople,
          readFriends,
          readContent,
          readSequence,
          readVisited,
          validateSnippet,
          resolveSnippet,
          checkAudience,
          readBlocked,
          harness,
          ownerActive,
          model: config.reasoning.minimax?.model ?? 'unconfigured',
        }),
    },
  ];
}
