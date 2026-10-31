import { createHash } from 'node:crypto';
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
import {
  READ_LIBRARY_PASSAGES,
  READ_LIBRARY_PASSAGE_TEXT,
  type ReadLibraryPassageText,
  type ReadLibraryPassages,
} from '../../content/public.js';
import { makeRitualOperator, type RitualOperator } from '../application/ritual-batch.js';
import { dayOf } from '../domain/rituals.js';
import { RUN_NIGHTLY_RITUALS, type RunNightlyRituals } from '../public.js';
import { ritualStore } from './postgres-rituals.js';

/**
 * The operator's and the night's controls over a room's daily items (D-176): draft, list and review. Composed by an
 * operator command or a test with a database, the rooms scope's harness and the library's prose reads. Drafting a question
 * costs no call; drafting Spot the flaw makes at most one, on a run fixed by the room and day.
 */
export function composeRitualOperator(deps: {
  readonly db: Kysely<Database>;
  readonly harness: ProductionReasoningHarness;
  readonly withRoomScope: WithProductionScope;
  readonly readPassages: ReadLibraryPassages;
  readonly readPassageText: ReadLibraryPassageText;
  readonly model: string;
  readonly generation: number;
  readonly now?: () => Date;
}): RitualOperator {
  return makeRitualOperator(
    {
      store: ritualStore(deps.db),
      readPassages: deps.readPassages,
      readPassageText: deps.readPassageText,
      model: deps.model,
      generation: deps.generation,
      runIdFor: (roomId, day, kind) => stableUuid(`rooms-ritual:${roomId}:${day}:${kind}`),
      newId: uuidv7,
      sha256: (text) => createHash('sha256').update(text).digest('hex'),
      now: deps.now ?? (() => new Date()),
    },
    deps.harness,
    deps.withRoomScope,
  );
}

/**
 * The worker's night batch (`rooms.nightly-rituals`): today's UTC day for every open room that has a member. Registered
 * only where the worker holds the rooms grant; it needs the library's prose reads (`libraryPassageProviders`).
 */
export function roomsRitualProviders(tokens: { readonly database: symbol; readonly workerConfig: symbol }) {
  return [
    {
      provide: RUN_NIGHTLY_RITUALS,
      inject: [
        tokens.database,
        ROOM_REASONING_HARNESS,
        WITH_ROOM_SCOPE,
        READ_LIBRARY_PASSAGES,
        READ_LIBRARY_PASSAGE_TEXT,
        tokens.workerConfig,
      ],
      useFactory: (
        db: Kysely<Database>,
        harness: ProductionReasoningHarness,
        withRoomScope: WithProductionScope,
        readPassages: ReadLibraryPassages,
        readPassageText: ReadLibraryPassageText,
        config: WorkerConfig,
      ): RunNightlyRituals => {
        const operator = composeRitualOperator({
          db,
          harness,
          withRoomScope,
          readPassages,
          readPassageText,
          model: config.reasoning.minimax?.model ?? 'unconfigured',
          generation: config.reasoning.roomGeneration,
        });
        return async (signal) => {
          await operator.draftAll({ day: dayOf(new Date()), signal });
        };
      },
    },
  ];
}
