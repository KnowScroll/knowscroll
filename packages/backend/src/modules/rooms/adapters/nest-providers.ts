import type { WorkerConfig } from '../../../infrastructure/config/index.js';
import { uuidv7, stableUuid } from '../../../infrastructure/ids/index.js';
import type { EnqueueJob } from '../../../infrastructure/jobs/index.js';
import { requestHash, type CanonicalJson } from '../../../infrastructure/receipts/index.js';
import { REASONING_HARNESS, type ReasoningHarness } from '../../../reasoning/public.js';
import {
  CHECK_ASSET_AUDIENCE,
  READ_CONTENT_SEQUENCE,
  READ_SHAREABLE_CONTENT,
  RESOLVE_SNIPPET_ANCHOR,
  VALIDATE_SNIPPET_ANCHOR,
  type CheckAssetAudience,
  type ReadContentSequence,
  type ReadShareableContent,
  type ResolveSnippetAnchor,
  type ValidateSnippetAnchor,
} from '../../content/public.js';
import { READ_VISITED_ASSETS, type ReadVisitedAssets } from '../../experience/public.js';
import { READ_GEOGRAPHY_SCENE_INPUT, type ReadGeographySceneInput } from '../../geography/public.js';
import {
  CHECK_PERSONAL_OWNER_ACTIVE,
  FENCE_OWN_ACCOUNT,
  type CheckPersonalOwnerActive,
  type FenceOwnAccount,
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
import { makeContribute, type ContributePorts } from '../application/contribute.js';
import { makeDiscussionCommands } from '../application/discussion-commands.js';
import { makeDiscussionReads } from '../application/discussion-reads.js';
import { makeInhabitantCommands } from '../application/inhabitant-commands.js';
import type { RoomPorts } from '../application/ports.js';
import { makeRoomCommands } from '../application/room-commands.js';
import { makeRoomReads } from '../application/room-reads.js';
import { makeStationReads } from '../application/stations.js';
import { contributeQueue } from '../events.js';
import {
  CONTRIBUTE_AS_INHABITANT,
  READ_REPORTABLE_ROOM_MESSAGE,
  ROOM_USE_CASES,
  type ContributeAsInhabitant,
  type RoomUseCases,
} from '../public.js';
import { activityStore } from './postgres-activities.js';
import { aiStore } from './postgres-ai.js';
import { discussionStore } from './postgres-discussions.js';
import { roomStore } from './postgres-rooms.js';
import { readReportableRoomMessage } from './report-reads.js';
import { gateSnippetAnchors } from './snippet-audience.js';

/** What every room use case needs from the rest of the system, chosen by the composition root. */
export interface RoomsDeps {
  readonly withScope: WithPersonalScope;
  readonly fenceOwn: FenceOwnAccount;
  readonly readPeople: ReadPublicPeople;
  readonly readFriends: ReadFriendAccounts;
  /** Which of some accounts the caller has blocked: their words are collapsed for the caller, never for anyone else. */
  readonly readBlocked: ReadBlockedAmong;
  readonly readContent: ReadShareableContent;
  readonly readSequence: ReadContentSequence;
  readonly readVisited: ReadVisitedAssets;
  readonly validateSnippet: ValidateSnippetAnchor;
  readonly resolveSnippet: ResolveSnippetAnchor;
  /** The caller's own map, for stations; the worker never reads stations. */
  readonly readGeography?: ReadGeographySceneInput;
  /** Which Scrolls the caller may open: one made for a thread is not a room's to quote (D-049). */
  readonly checkAudience: CheckAssetAudience;
  /** Only the API enqueues the ask job; the worker consumes it and never sends one. */
  readonly enqueue?: EnqueueJob;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** The ports of the room use cases over PostgreSQL and the neighbouring modules' public reads. */
export function roomPorts(deps: RoomsDeps): RoomPorts {
  return {
    withScope: deps.withScope,
    fenceOwn: deps.fenceOwn,
    rooms: roomStore,
    discussions: discussionStore,
    ai: aiStore,
    activities: activityStore,
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
    readSequence: deps.readSequence,
    readVisited: deps.readVisited,
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
  };
}

/** Explicit backend use cases; only composition roots choose the database and neighbouring-module adapters. */
export function roomUseCases(deps: RoomsDeps): RoomUseCases {
  const ports = roomPorts(deps);
  return {
    ...makeRoomReads(ports),
    ...makeRoomCommands(ports),
    ...makeDiscussionCommands(ports),
    ...makeDiscussionReads(ports),
    ...makeInhabitantCommands(ports),
    ...makeStationReads(ports),
    ...makeActivities(ports),
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

export { seedRooms, setRoomModerator, type ModeratorOutcome } from './seed.js';

/** The API's room use cases, and the room read the report use cases ask for. */
export function roomsProviders(tokens: { readonly withPersonalScope: symbol; readonly enqueueJob: symbol }) {
  return [
    { provide: READ_REPORTABLE_ROOM_MESSAGE, useValue: readReportableRoomMessage },
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
        tokens.enqueueJob,
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
        enqueue: EnqueueJob,
      ) =>
        roomUseCases({
          withScope,
          fenceOwn,
          readPeople,
          readFriends,
          readBlocked,
          readContent,
          readSequence,
          readVisited,
          validateSnippet,
          resolveSnippet,
          readGeography,
          checkAudience,
          enqueue,
        }),
    },
  ];
}

/** The worker's inhabitant consumer. The harness refuses every call while no model provider is configured. */
export function roomsWorkerProviders(tokens: { readonly withPersonalScope: symbol; readonly workerConfig: symbol }) {
  return [
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
