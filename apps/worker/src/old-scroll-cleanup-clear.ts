import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { eraseCurrentExploration } from '@knowscroll/backend/erasure-registry';
import {
  isClearCore,
  makeWithClearMaintenance,
  makeWithPrivacyScope,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { requestHash } from '@knowscroll/backend/infrastructure/receipts';
import { clearStore, makeClearExploration } from '@knowscroll/backend/modules/identity/nest-providers';
import { clearReasoning } from '@knowscroll/backend/reasoning/nest-providers';

/** What became of one account's Clear. */
export type ClearOutcome =
  | { readonly accountId: string; readonly outcome: 'cleared' | 'resumed' }
  | { readonly accountId: string; readonly outcome: 'refused'; readonly code: string };

const LOCK_TIMEOUT_MS = 5_000;

/**
 * Selective Clear's use cases without a queue: the same ports the API and the worker compose (`clearExplorationFor`), but a job is
 * not enqueued. The cleanup runs the job itself, in order, and an accounting step that cannot finish yet (a paid attempt still
 * settling) stays a durable operation that the worker's recovery job finishes after it starts again.
 */
function clearWithoutQueue(db: Kysely<Database>) {
  const timing = { lockTimeoutMs: LOCK_TIMEOUT_MS };
  return makeClearExploration({
    withPrivacyScope: makeWithPrivacyScope(db, timing),
    withMaintenance: makeWithClearMaintenance(db, timing),
    withRecoveryMaintenance: makeWithClearMaintenance(db, { lockTimeoutMs: 250, statementTimeoutMs: 2000 }),
    readRecoveryCandidates: () => Promise.resolve([]),
    store: clearStore,
    reasoning: clearReasoning,
    hash: (input) => requestHash('privacy.clear-exploration', input as Parameters<typeof requestHash>[1]),
    eraseCore: async (scope) => {
      await eraseCurrentExploration(scope);
    },
    isCore: isClearCore,
    enqueue: () => Promise.resolve(),
    now: () => new Date(),
  });
}

/**
 * Clears the exploration history of every account, one account after another, with the product's own Clear (`privacy.clear-exploration`,
 * D-050): the same erasers, the same barrier, the same epoch step that makes a signed-in app drop what it holds for the account.
 * It keeps the account, its sign-in, its consents and its receipts, its friends and conversations, its Saved items and its sharing choices.
 *
 * A Clear already in flight (its barrier is set, its core not done) is finished instead of started again. An account that cannot be
 * cleared now (suspended or being deleted) is reported with the refusal and the caller stops before it removes anything else.
 * Idempotent: a person with nothing left to clear is cleared again as an empty history, and the epoch steps once more.
 */
export async function clearEveryAccount(db: Kysely<Database>): Promise<readonly ClearOutcome[]> {
  const clear = clearWithoutQueue(db);
  const universes = await sql<{
    universeId: string;
    accountId: string;
    privacyEpoch: number;
    clearOperation: string | null;
    commandId: string | null;
  }>`select universe.id as "universeId", universe.account_id as "accountId", universe.privacy_epoch as "privacyEpoch",
      universe.clear_operation_id as "clearOperation", operation.command_id as "commandId"
    from identity.universes universe
    left join identity.clear_operations operation on operation.id = universe.clear_operation_id
    order by universe.account_id`.execute(db);
  const outcomes: ClearOutcome[] = [];
  for (const universe of universes.rows) {
    const { accountId } = universe;
    if (universe.clearOperation !== null && universe.commandId !== null) {
      await clear.process({ v: 1, accountId, commandId: universe.commandId });
      outcomes.push({ accountId, outcome: 'resumed' });
      continue;
    }
    const commandId = randomUUID();
    const started = await clear.start(
      { accountId, universeId: universe.universeId, privacyEpoch: universe.privacyEpoch },
      {
        version: 'clear-exploration.v1',
        commandId,
        expectedPrivacyEpoch: universe.privacyEpoch,
        confirmation: 'clear-exploration-preserve-keep-and-social',
      },
    );
    if (started.kind === 'refused') {
      outcomes.push({ accountId, outcome: 'refused', code: started.refusal.kind });
      continue;
    }
    if (started.value.kind === 'rejected') {
      outcomes.push({ accountId, outcome: 'refused', code: started.value.code });
      continue;
    }
    await clear.process({ v: 1, accountId, commandId });
    outcomes.push({ accountId, outcome: 'cleared' });
  }
  return outcomes;
}
