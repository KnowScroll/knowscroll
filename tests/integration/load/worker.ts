import { makeEnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import { fencePersonalRecording, makeWithPersonalScope } from '@knowscroll/backend/infrastructure/postgres';
import { RECORDING_REASONING_HARNESS } from '@knowscroll/backend/reasoning';
import { FENCE_OWN_ACCOUNT, FENCE_PERSONAL_RECORDING } from '@knowscroll/backend/modules/identity';
import {
  accountAccessUseCases,
  identityScopeOwnerProviders,
} from '@knowscroll/backend/modules/identity/nest-providers';
import { CATALOGUE } from '@knowscroll/backend/modules/content';
import { contentProviders } from '@knowscroll/backend/modules/content/nest-providers';
import { catalogueOf } from '../support/catalogue.js';
import { PREPARE_COMPOSER_BUFFER, type PrepareBuffer } from '@knowscroll/backend/modules/composer';
import { composerBufferWorkerProviders, composerProviders } from '@knowscroll/backend/modules/composer/nest-providers';
import { experienceBufferSourceProviders } from '@knowscroll/backend/modules/experience/nest-providers';
import {
  CLEAR_COVERAGE_DIRTY,
  MARK_COVERAGE_DIRTY,
  READ_COMPOSER_CONTEXT,
  READ_INTEREST_CONTEXT,
  READ_COVERAGE_DIRTY,
  READ_COVERAGE_INPUTS,
  READ_TRUSTED_COVERAGE,
} from '@knowscroll/backend/modules/personal-context';
import { personalContextProviders } from '@knowscroll/backend/modules/personal-context/nest-providers';
import { geographyProviders } from '@knowscroll/backend/modules/geography/nest-providers';
import {
  PROJECT_SCENE,
  READ_OWN_SCENE_CHUNK,
  READ_OWN_SCENE_MANIFEST,
  type ProjectScene,
  type ReadOwnSceneChunk,
  type ReadOwnSceneManifest,
} from '@knowscroll/backend/modules/scenes';
import { sceneAppliedProviders, sceneProviders } from '@knowscroll/backend/modules/scenes/nest-providers';
import { fixtureRecordingHarness } from '../support/recording-harness.js';
import type { GeographyWorld } from '../support/geography-world.js';
import { buildRecursively } from '../support/providers.js';

const SCOPE = Symbol('load.withPersonalScope');
const ENQUEUE = Symbol('load.enqueueJob');
const WORKER_CONFIG = Symbol('load.workerConfig');
const LOG = Symbol('load.logEvent');

/**
 * The worker's buffer preparation and Scenes, composed from the same provider lists the worker and the API compose (the way the
 * simulation lab's world does), over the load world's database. Jev is off and the harness has no model: preparation is the
 * deterministic ranking, which is what runs when a person has no stored assessments.
 */
export function workerParts(world: GeographyWorld, composerPolicy: 'v0' | 'v1' | 'v2') {
  const { database, c } = world;
  const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
  const { harness } = fixtureRecordingHarness(database.db, { model: undefined });
  const catalogue = catalogueOf(database.db);
  const bufferValues = new Map<symbol, unknown>([
    [CATALOGUE, catalogue],
    [SCOPE, withScope],
    [WORKER_CONFIG, { jevEnabled: false, reasoning: {} }],
    [RECORDING_REASONING_HARNESS, harness],
    [READ_COMPOSER_CONTEXT, c.readComposerContext],
    [READ_INTEREST_CONTEXT, c.readInterestContext],
    ...[
      ...experienceBufferSourceProviders(),
      ...composerProviders({ isOperator: () => false }, composerPolicy),
      ...contentProviders(),
    ].map((provider) => [provider.provide, provider.useValue] as const),
  ]);
  const prepareBuffer = buildRecursively(
    composerBufferWorkerProviders({ withPersonalScope: SCOPE, workerConfig: WORKER_CONFIG }),
    PREPARE_COMPOSER_BUFFER,
    bufferValues,
  ) as PrepareBuffer;

  const sceneProviderList = [
    ...sceneAppliedProviders({ enqueueJob: ENQUEUE }),
    ...geographyProviders({ withPersonalScope: SCOPE, enqueueJob: ENQUEUE }),
    ...sceneProviders({ withPersonalScope: SCOPE, logEvent: LOG }),
  ];
  const sceneValues = new Map<symbol, unknown>([
    [CATALOGUE, catalogue],
    [SCOPE, withScope],
    [LOG, () => undefined],
    [ENQUEUE, makeEnqueueJob(c.boss)],
    [FENCE_OWN_ACCOUNT, accountAccessUseCases({ db: database.db, lockTimeoutMs: 5_000 }).fenceOwnAccount],
    [FENCE_PERSONAL_RECORDING, fencePersonalRecording],
    [READ_TRUSTED_COVERAGE, c.readTrustedCoverage],
    [READ_COVERAGE_INPUTS, buildRecursively(personalContextProviders(), READ_COVERAGE_INPUTS, new Map())],
    [READ_COVERAGE_DIRTY, buildRecursively(personalContextProviders(), READ_COVERAGE_DIRTY, new Map())],
    [CLEAR_COVERAGE_DIRTY, buildRecursively(personalContextProviders(), CLEAR_COVERAGE_DIRTY, new Map())],
    [MARK_COVERAGE_DIRTY, buildRecursively(personalContextProviders(), MARK_COVERAGE_DIRTY, new Map())],
    ...identityScopeOwnerProviders().map((provider) => [provider.provide, provider.useValue] as const),
  ]);
  return {
    prepareBuffer,
    projectScene: buildRecursively(sceneProviderList, PROJECT_SCENE, sceneValues) as ProjectScene,
    readManifest: buildRecursively(sceneProviderList, READ_OWN_SCENE_MANIFEST, sceneValues) as ReadOwnSceneManifest,
    readChunk: buildRecursively(sceneProviderList, READ_OWN_SCENE_CHUNK, sceneValues) as ReadOwnSceneChunk,
  };
}

/** What a client that draws the whole scene declares (the capabilities scenes.test.ts uses). */
export const SCENE_CAPABILITIES = {
  version: 'scene-client.v1',
  descriptors: ['scene-descriptor.v1'],
  chunks: ['scene-chunk.v1'],
  manifests: ['scene-manifest.v1'],
  generators: ['silhouette.v1'],
  families: ['terraced.v1', 'ridged.v1', 'archipelago.v1'],
  detail: 'full',
  reducedMotion: false,
} as const;
