import { recordingTransactionOf } from '../../../infrastructure/postgres/recording-scope.js';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { PgBoss } from 'pg-boss';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { makeWithPersonalScope, transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import {
  requestHash,
  findPersonalReceipt,
  insertPersonalReceipt,
  completePersonalReceipt,
  type CanonicalJson,
} from '../../../infrastructure/receipts/index.js';
import { makeEnqueueJob } from '../../../infrastructure/jobs/enqueue.js';
import { makeFormationPresentations, makeRecordFormation } from '../application/formation-presentation.js';
import { formationStore, formationRecoveryPage, formationProjectionPending } from './formation-store.js';
import { FORMATION_PRESENTATIONS } from '../public.js';
import type { FormationPorts } from '../application/ports.js';
import { expireFormationQueue } from '../events.js';
import { randomBytes } from 'node:crypto';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import {
  GEOGRAPHY_APPLIED,
  READ_GEOGRAPHY_SCENE_INPUT,
  type GeographyApplied,
  type ReadGeographySceneInput,
} from '../../geography/public.js';
import {
  CHECK_PERSONAL_OWNER_ACTIVE,
  type CheckPersonalOwnerActive,
  type WithPersonalScope,
} from '../../identity/public.js';
import type { EnqueueJob } from '../../../infrastructure/jobs/enqueue.js';
import { advanceScopeRevision } from '../../../infrastructure/postgres/personal-scope.js';
import { notifyScopeChanged } from '../../../infrastructure/notices/index.js';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import { projectSceneQueue } from '../events.js';
import { PROJECT_SCENE, READ_OWN_SCENE_MANIFEST, READ_OWN_SCENE_CHUNK } from '../public.js';
import { makeProjectScene } from '../application/project.js';
import { makeReadSceneManifest, makeReadSceneChunk } from '../application/read.js';
import type { ScenePorts } from '../application/ports.js';
import { sceneStore } from './postgres-store.js';
export const SCENE_PORTS = Symbol('scenes.ports');
/** Required fact recording + strict projection enqueue only; no projector dependency or cycle. */
export function sceneAppliedProviders(t: { readonly enqueueJob: symbol }) {
  return [
    {
      provide: GEOGRAPHY_APPLIED,
      inject: [t.enqueueJob],
      useFactory:
        (enqueue: EnqueueJob): GeographyApplied =>
        async (cap, input) => {
          recordingTransactionOf(cap);
          if (input.recordingGeneration !== cap.generation) throw new Error('SCENE_RECORDING_GENERATION');
          const scope = cap.personal;
          await makeRecordFormation(formationStore)(scope, input);
          await enqueue(scope, projectSceneQueue, {
            v: 1,
            universeId: scope.authority.universeId,
            privacyEpoch: scope.authority.privacyEpoch,
            transitionId: input.transitionId,
            geography: input.geography,
            personalRevision: input.personalRevision,
          });
        },
    },
  ];
}
export function sceneProviders(t: { readonly withPersonalScope: symbol }) {
  return [
    {
      provide: SCENE_PORTS,
      inject: [t.withPersonalScope, CHECK_PERSONAL_OWNER_ACTIVE, READ_GEOGRAPHY_SCENE_INPUT],
      useFactory: (
        withScope: WithPersonalScope,
        ownerActive: CheckPersonalOwnerActive,
        readInput: ReadGeographySceneInput,
      ): ScenePorts => ({
        withScope,
        ownerActive,
        readInput,
        store: sceneStore,
        seed: () => randomBytes(32).toString('hex'),
        hash: canonicalSha256,
        advance: advanceScopeRevision,
        notify: (scope, revision) => notifyScopeChanged(scope, { revision, eventId: uuidv7() }),
        now: () => new Date(),
      }),
    },
    { provide: PROJECT_SCENE, inject: [SCENE_PORTS], useFactory: (p: ScenePorts) => makeProjectScene(p) },
    {
      provide: READ_OWN_SCENE_MANIFEST,
      inject: [SCENE_PORTS],
      useFactory: (p: ScenePorts) => makeReadSceneManifest(p),
    },
    { provide: READ_OWN_SCENE_CHUNK, inject: [SCENE_PORTS], useFactory: (p: ScenePorts) => makeReadSceneChunk(p) },
  ];
}
export { makeProjectScene } from '../application/project.js';
export { makeReadSceneManifest, makeReadSceneChunk } from '../application/read.js';
export { sceneStore } from './postgres-store.js';
export type { ScenePorts } from '../application/ports.js';

/** Real fixed maintenance adapters; no network/provider dependency or dispatch capability. */
export function formationPortsFor(
  db: Kysely<Database>,
  boss: PgBoss,
  withScope: WithPersonalScope,
  ownerActive: CheckPersonalOwnerActive,
  readInput: ReadGeographySceneInput,
) {
  const shortScope = makeWithPersonalScope(db, { lockTimeoutMs: 250 }),
    enqueue = makeEnqueueJob(boss);
  const p: FormationPorts = {
    withScope,
    withRecoveryScope: (authority, work) =>
      shortScope(authority, async (scope) => {
        await sql`select set_config('statement_timeout','2000ms',true)`.execute(transactionOf(scope));
        return work(scope);
      }),
    ownerActive,
    readInput,
    store: formationStore,
    scenes: {
      state: (scope) => sceneStore.state(scope),
      chunk: (scope, id, revision) => sceneStore.chunk(scope, id, revision),
      pending: formationProjectionPending,
    },
    receipts: {
      async find(scope, key) {
        const r = await findPersonalReceipt(scope, key);
        if (r.kind === 'new' || r.kind === 'replay') return r;
        return {
          kind: 'refused',
          code:
            r.kind === 'key_reused'
              ? 'COMMAND_KEY_REUSED'
              : r.kind === 'epoch_mismatch'
                ? 'PRIVACY_EPOCH_CHANGED'
                : 'SERVICE_UNAVAILABLE',
        };
      },
      insert: insertPersonalReceipt,
      complete: (scope, id, outcome) => completePersonalReceipt(scope, id, outcome as { [key: string]: CanonicalJson }),
    },
    hash: (operation, input) => requestHash(operation, input as CanonicalJson),
    advance: advanceScopeRevision,
    notify: (scope, revision) => notifyScopeChanged(scope, { revision, eventId: uuidv7() }),
    newId: uuidv7,
    now: () => new Date(),
    enqueueExpiry: (scope, job, startAfter) => enqueue(scope, expireFormationQueue, { v: 1, ...job }, { startAfter }),
    readRecoveryPage: formationRecoveryPage(db, boss),
  };
  return p;
}
export function formationPresentationsFor(...args: Parameters<typeof formationPortsFor>) {
  return makeFormationPresentations(formationPortsFor(...args));
}
export function formationProviders(t: {
  readonly database: symbol;
  readonly boss: symbol;
  readonly withPersonalScope: symbol;
}) {
  return [
    {
      provide: FORMATION_PRESENTATIONS,
      inject: [t.database, t.boss, t.withPersonalScope, CHECK_PERSONAL_OWNER_ACTIVE, READ_GEOGRAPHY_SCENE_INPUT],
      useFactory: formationPresentationsFor,
    },
  ];
}
export { formationStore, formationRecoveryPage } from './formation-store.js';
export {
  makeFormationPresentations,
  makeRecordFormation,
  formationOfCommitted,
} from '../application/formation-presentation.js';
export type { FormationPorts, FormationRecord, FormationUseCases } from '../application/ports.js';
