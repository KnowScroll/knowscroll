import { randomUUID } from 'node:crypto';
import { eraseCurrentExploration } from '@knowscroll/backend/erasure-registry';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import type { PgBoss } from 'pg-boss';
import { applyQueueDeclarations } from '@knowscroll/backend/infrastructure/jobs';
import { clearExplorationQueue, recoverClearOperationsQueue } from '@knowscroll/backend/modules/identity';
import { clearExplorationFor, operatorSignInUseCase } from '@knowscroll/backend/modules/identity/nest-providers';
import { clearReasoning } from '@knowscroll/backend/reasoning/nest-providers';
import type { TestDatabase } from './database.js';
import type { FixturePerson } from './fixtures.js';

/** Actions-only actual account creation: no protocol/witness/pointer seed or legacy adoption. */
export async function recordingPerson(database: TestDatabase<Database>): Promise<FixturePerson> {
  const result = await operatorSignInUseCase({
    db: database.db,
    publicOrigin: 'https://ci.invalid',
    lockTimeoutMs: 5000,
    pattern: '*@recording-fixture.test',
    world: 'ci',
    operatorSource: 'cli:ci-recording-fixture',
  })({ email: `${randomUUID()}@recording-fixture.test` });
  if (result.kind !== 'issued') throw new Error('CI_RECORDING_ACCOUNT_CREATION_REFUSED');
  const { accountId, universeId } = result.outcome;
  return { accountId, universeId, authority: { universeId, privacyEpoch: 1, actor: { kind: 'account', accountId } } };
}

/** Epoch advancement through the actual sealed Clear, preserving its lifecycle constraints. */
export async function clearRecordingPerson(database: TestDatabase<Database>, boss: PgBoss, person: FixturePerson) {
  await applyQueueDeclarations(boss, [clearExplorationQueue, recoverClearOperationsQueue]);
  const use = clearExplorationFor(database.db, boss, { reasoning: clearReasoning, eraseCore: eraseCurrentExploration });
  const commandId = randomUUID();
  const started = await use.start(
    { accountId: person.accountId, universeId: person.universeId, privacyEpoch: person.authority.privacyEpoch },
    {
      version: 'clear-exploration.v1',
      commandId,
      expectedPrivacyEpoch: person.authority.privacyEpoch,
      confirmation: 'clear-exploration-preserve-keep-and-social',
    },
  );
  if (started.kind !== 'entered' || started.value.kind !== 'ok') throw new Error('CI_RECORDING_CLEAR_REFUSED');
  await use.process({ v: 1, accountId: person.accountId, commandId });
}
