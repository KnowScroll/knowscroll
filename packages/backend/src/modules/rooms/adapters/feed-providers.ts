import type { Kysely } from 'kysely';
import type { WorkerConfig } from '../../../infrastructure/config/index.js';
import { stableUuid, uuidv7 } from '../../../infrastructure/ids/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import {
  ROOM_REASONING_HARNESS,
  WITH_ROOM_SCOPE,
  type ProductionReasoningHarness,
  type WithProductionScope,
} from '../../../reasoning/public.js';
import { READ_LIBRARY_FINDS, type ReadLibraryFinds } from '../../content/public.js';
import { makeFeedHeartbeat, type FeedHeartbeat } from '../application/feed-heartbeat.js';
import { RUN_FEED_HEARTBEAT, type RunFeedHeartbeat } from '../public.js';
import { feedStore } from './postgres-feed.js';

/**
 * The residents' heartbeat over a database, the rooms scope's harness and the library's finds (v3 R-8, D-248). Composed by the
 * worker's job and by an operator command, so both look at a room the same way: the model is asked only after code chose an
 * asset and decided that a resident may post, or that the memory is due, and a look with nothing to do makes no call.
 */
export function composeFeedHeartbeat(deps: {
  readonly db: Kysely<Database>;
  readonly harness: ProductionReasoningHarness;
  readonly withRoomScope: WithProductionScope;
  readonly readFinds: ReadLibraryFinds;
  readonly model: string;
  readonly generation: number;
  readonly now?: () => Date;
}): FeedHeartbeat {
  return makeFeedHeartbeat(
    {
      store: feedStore(deps.db),
      readFinds: deps.readFinds,
      model: deps.model,
      generation: deps.generation,
      turnIdFor: (roomId, kind, slot) => stableUuid(`rooms-${kind}:${roomId}:${slot}`),
      newId: uuidv7,
      now: deps.now ?? (() => new Date()),
    },
    deps.harness,
    deps.withRoomScope,
  );
}

/**
 * The worker's heartbeat (`rooms.feed-heartbeat`). Registered only where the worker holds the rooms grant and the feed is on; it
 * needs the library's finds read (`libraryPassageProviders`).
 */
export function roomsFeedProviders(tokens: { readonly database: symbol; readonly workerConfig: symbol }) {
  return [
    {
      provide: RUN_FEED_HEARTBEAT,
      inject: [tokens.database, ROOM_REASONING_HARNESS, WITH_ROOM_SCOPE, READ_LIBRARY_FINDS, tokens.workerConfig],
      useFactory: (
        db: Kysely<Database>,
        harness: ProductionReasoningHarness,
        withRoomScope: WithProductionScope,
        readFinds: ReadLibraryFinds,
        config: WorkerConfig,
      ): RunFeedHeartbeat => {
        const heartbeat = composeFeedHeartbeat({
          db,
          harness,
          withRoomScope,
          readFinds,
          model: config.reasoning.minimax?.model ?? 'unconfigured',
          generation: config.reasoning.roomGeneration,
        });
        return async (signal, onRoomFailed) => {
          await heartbeat.lookAtAll({ signal, onRoomFailed });
        };
      },
    },
  ];
}
