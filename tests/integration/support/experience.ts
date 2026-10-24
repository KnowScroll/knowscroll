import { FENCE_OWN_ACCOUNT, READ_RECORDING_LIFECYCLE } from '@knowscroll/backend/modules/identity';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import type { PgBoss } from 'pg-boss';
import { createBoss, makeEnqueueJob, type EnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { CHECK_ASSET_AUDIENCE } from '@knowscroll/backend/modules/content';
import { contentProviders } from '@knowscroll/backend/modules/content/nest-providers';
import type { ApplyAction, ListSaved } from '@knowscroll/backend/modules/experience';
import { APPLY_ACTION, LIST_SAVED, experienceProviders } from '@knowscroll/backend/modules/experience/nest-providers';
import { openToEveryone } from './audience.js';
import type { TestDatabase } from './database.js';
import { buildFromProviders } from './providers.js';
import { scrollUseCases } from './scroll.js';

/**
 * Builds experience's real use cases from its real providers (the same factories the API's
 * composition root uses, including content's asset lookup), without Nest. `wrapEnqueue` lets a
 * test inject a failure after the job is written, to prove rollback.
 */
export async function experienceUseCases(
  database: TestDatabase<Database>,
  options: { readonly wrapEnqueue?: (enqueue: EnqueueJob) => EnqueueJob; readonly recording?: true } = {},
): Promise<{
  readonly applyAction: ApplyAction;
  readonly listSaved: ListSaved;
  readonly boss: PgBoss;
  close(): Promise<void>;
}> {
  if (options.recording) {
    const actual = await scrollUseCases(database, {
      recording: true,
      ...(options.wrapEnqueue ? { wrapEnqueue: options.wrapEnqueue } : {}),
    });
    return {
      applyAction: actual.applyAction,
      listSaved: actual.listSaved,
      boss: actual.boss,
      close: () => actual.close(),
    };
  }
  const boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
  await boss.start();
  const enqueue = makeEnqueueJob(boss);
  const identity = accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 });
  const values = new Map<symbol, unknown>([
    [FENCE_OWN_ACCOUNT, identity.fenceOwnAccount],
    [READ_RECORDING_LIFECYCLE, identity.readRecordingLifecycle],
    [DATABASE_TOKEN, database.db],
    [CHECK_ASSET_AUDIENCE, openToEveryone],
    [SCOPE_TOKEN, makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })],
    [ENQUEUE_TOKEN, options.wrapEnqueue === undefined ? enqueue : options.wrapEnqueue(enqueue)],
    ...contentProviders().map((provider) => [provider.provide, provider.useValue] as const),
  ]);
  const providers = experienceProviders({
    database: DATABASE_TOKEN,
    withPersonalScope: SCOPE_TOKEN,
    enqueueJob: ENQUEUE_TOKEN,
  });
  const build = (token: symbol): unknown => buildFromProviders(providers, token, values);
  return {
    applyAction: build(APPLY_ACTION) as ApplyAction,
    listSaved: build(LIST_SAVED) as ListSaved,
    boss,
    close: () => boss.stop({ graceful: false }),
  };
}

const DATABASE_TOKEN = Symbol('test.database');
const SCOPE_TOKEN = Symbol('test.withPersonalScope');
const ENQUEUE_TOKEN = Symbol('test.enqueueJob');
