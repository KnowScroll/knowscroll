import type { Kysely } from 'kysely';
import type { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { eraseExploration } from '@knowscroll/backend/infrastructure/erasure';
import { explorationStores } from '@knowscroll/backend/erasure-registry';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { clearExplorationFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { clearReasoning } from '@knowscroll/backend/reasoning/nest-providers';
import { DATABASE, PG_BOSS } from '../tokens.js';

export const CLEAR_EXPLORATION = Symbol('ClearExploration');
export type ClearExplorationUseCases = ReturnType<typeof clearExplorationFor>;

/** The API only accepts durable work; it never runs an eraser in a request. */
export function privacyWiring(lockTimeoutMs: number) {
  return [
    {
      provide: CLEAR_EXPLORATION,
      inject: [DATABASE, PG_BOSS],
      useFactory: (db: Kysely<Database>, boss: ReturnType<typeof createBoss>): ClearExplorationUseCases =>
        clearExplorationFor(db, boss, {
          reasoning: clearReasoning,
          eraseCore: async (scope) => {
            await eraseExploration(scope, explorationStores);
          },
          lockTimeoutMs,
        }),
    },
  ];
}
