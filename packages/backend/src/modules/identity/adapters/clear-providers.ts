import type { Kysely } from 'kysely';
import type { PgBoss } from 'pg-boss';
import type { ClearReasoning } from '../../../reasoning/public.js';
import type { ClearCoreTx } from '../public.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { requestHash } from '../../../infrastructure/receipts/index.js';
import {
  makeWithClearMaintenance,
  makeWithPrivacyScope,
  isClearCore,
} from '../../../infrastructure/postgres/privacy-scope.js';
import { makeEnqueuePrivacyJob } from '../../../infrastructure/jobs/enqueue-privacy.js';
import { makeClearExploration } from '../application/clear-exploration.js';
import { clearExplorationQueue } from '../events.js';
import { readClearRecoveryCandidates, clearStore } from './clear-store.js';
/** Unmounted: composition supplies closed owner ports and explicitly installs the queue/consumer. */
export function clearExplorationFor(
  db: Kysely<Database>,
  boss: PgBoss,
  options: {
    readonly reasoning: ClearReasoning;
    readonly eraseCore: (scope: ClearCoreTx) => Promise<void>;
    readonly lockTimeoutMs?: number;
  },
) {
  const timing = { lockTimeoutMs: options.lockTimeoutMs ?? 5000 };
  return makeClearExploration({
    withPrivacyScope: makeWithPrivacyScope(db, timing),
    withMaintenance: makeWithClearMaintenance(db, timing),
    withRecoveryMaintenance: makeWithClearMaintenance(db, { lockTimeoutMs: 250, statementTimeoutMs: 2000 }),
    readRecoveryCandidates: readClearRecoveryCandidates(db, boss),
    store: clearStore,
    reasoning: options.reasoning,
    hash: (input) => requestHash('privacy.clear-exploration', input as Parameters<typeof requestHash>[1]),
    eraseCore: options.eraseCore,
    isCore: isClearCore,
    enqueue: makeEnqueuePrivacyJob(boss, clearExplorationQueue),
    now: () => new Date(),
  });
}
export { readClearRecoveryCandidates, clearStore } from './clear-store.js';
