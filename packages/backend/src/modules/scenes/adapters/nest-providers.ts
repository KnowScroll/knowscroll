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
/** Enqueue only: no projector/Geography dependencies, so API and worker composition stay acyclic. */
export function sceneAppliedProviders(t: { readonly enqueueJob: symbol }) {
  return [
    {
      provide: GEOGRAPHY_APPLIED,
      inject: [t.enqueueJob],
      useFactory:
        (enqueue: EnqueueJob): GeographyApplied =>
        async (scope, input) => {
          await enqueue(scope, projectSceneQueue, {
            v: 1,
            universeId: scope.authority.universeId,
            privacyEpoch: scope.authority.privacyEpoch,
            ...input,
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
