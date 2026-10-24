import {
  FENCE_OWN_ACCOUNT,
  FENCE_PERSONAL_RECORDING,
  READ_RECORDING_LIFECYCLE,
} from '@knowscroll/backend/modules/identity';
import {
  accountAccessUseCases,
  identityScopeOwnerProviders,
} from '@knowscroll/backend/modules/identity/nest-providers';
import { plannerReadProviders, plannerRequestProviders } from '@knowscroll/backend/modules/planner/nest-providers';
import {
  PLANNER_MATERIAL_CHANGE,
  READ_CURRENT_PLAN,
  type PlannerMaterialChange,
} from '@knowscroll/backend/modules/planner';
import { geographyProviders } from '@knowscroll/backend/modules/geography/nest-providers';
import { GEOGRAPHY_MATERIAL_CHANGE, type MaterialGeographyChange } from '@knowscroll/backend/modules/geography';
import { sceneAppliedProviders } from '@knowscroll/backend/modules/scenes/nest-providers';
import { readFileSync } from 'node:fs';
import type { PgBoss } from 'pg-boss';
import { createBoss, makeEnqueueJob, type EnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import {
  fencePersonalRecording,
  makeWithPersonalScope,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import {
  CHECK_ASSET_AUDIENCE,
  RENDER_SCROLL,
  type ImportEditorialScroll,
  type ReadOrderAudience,
  type RenderScroll,
} from '@knowscroll/backend/modules/content';
import {
  contentProviders,
  contentRenderProviders,
  importEditorialScrollUseCase,
  madeToOrderProviders,
} from '@knowscroll/backend/modules/content/nest-providers';
import {
  READ_PREPARED_ACTIVITY,
  type ProjectEncounterActivity,
  type ReconcileEncounterActivity,
  type ActivityDerivedEffect,
} from '@knowscroll/backend/modules/evidence';
import { composerBufferProviders, composerProviders } from '@knowscroll/backend/modules/composer/nest-providers';
import { personalContextProviders } from '@knowscroll/backend/modules/personal-context/nest-providers';
import {
  ACTIVITY_CONTEXT_EFFECT,
  READ_TRUSTED_COVERAGE,
  type ReadTrustedCoverage,
  READ_EXPLORATION_SNAPSHOT,
  type ReadExplorationSnapshot,
  type ReadRecentContextTopics,
  READ_RECENT_CONTEXT_TOPICS,
  READ_COMPOSER_CONTEXT,
} from '@knowscroll/backend/modules/personal-context';
import {
  READ_ACTIVITY_STATISTICS,
  CHECK_COVERAGE_EVIDENCE,
  CHECK_RECORDING_COVERAGE_EVIDENCE,
  READ_OBSERVATION_TAIL,
  READ_RECENT_TOPIC_IDS,
} from '@knowscroll/backend/modules/evidence';
import type { ReadPreparedEvidenceInput } from '@knowscroll/backend/modules/composer';
import type {
  NavigateEncounter,
  ActivateOffer,
  ReadExposureContext,
  ApplyEncounterAction,
  ApplyAction,
  ListSaved,
} from '@knowscroll/backend/modules/experience';
import type {
  IngestObservations,
  ProjectScrollReading,
  ReadEvidenceDiagnostics,
} from '@knowscroll/backend/modules/evidence';
import {
  INGEST_OBSERVATIONS,
  PROJECT_SCROLL_READING,
  READ_EVIDENCE_DIAGNOSTICS,
  evidenceIntakeProviders,
  evidenceProviders,
  activityProviders,
  ACTIVITY_PORTS,
} from '@knowscroll/backend/modules/evidence/nest-providers';
import type { ActivateExposure, OpenExposure, ReadExposureDocument } from '@knowscroll/backend/modules/experience';
import {
  ACTIVATE_EXPOSURE,
  OPEN_EXPOSURE,
  READ_EXPOSURE_DOCUMENT,
  experienceEvidenceReadProviders,
  experienceProviders,
  navigationProviders,
  NAVIGATION_PORTS,
  NAVIGATE_ENCOUNTER,
  ACTIVATE_OFFER,
  READ_EXPOSURE_CONTEXT,
  APPLY_ENCOUNTER_ACTION,
  APPLY_ACTION,
  LIST_SAVED,
} from '@knowscroll/backend/modules/experience/nest-providers';
import type { WithPersonalScope, RecordingScopeTx } from '@knowscroll/backend/modules/identity';
import { EXPERIENCE_RECORDING_EFFECTS, type ExperienceRecordingEffects } from '@knowscroll/backend/modules/experience';
import type { TestDatabase } from './database.js';
import { buildFromProviders } from './providers.js';

import { PROJECT_ENCOUNTER_ACTIVITY, RECONCILE_ENCOUNTER_ACTIVITY } from '@knowscroll/backend/modules/evidence';
const DATABASE = Symbol('test.database');
const SCOPE = Symbol('test.withPersonalScope');
const ENQUEUE = Symbol('test.enqueueJob');
const MATERIAL_CHANGE = Symbol('test.actualPersonalMaterialChange');

/** The shipped starter Scroll's source file (an `editorial-scroll.v1` JSON), as the operator command reads it. */
export function starterSource(): { [key: string]: unknown } {
  const path = new URL(
    '../../../packages/backend/src/modules/content/starter/why-the-sky-is-blue.editorial-scroll.json',
    import.meta.url,
  );
  return JSON.parse(readFileSync(path, 'utf8')) as { [key: string]: unknown };
}

/** What the thin journey's capabilities declare: the text family and the fallback, nothing else. */
export const textCapabilities = {
  documentSchemas: ['scroll-document.v1'],
  blocks: Object.fromEntries(
    ['fallback', 'paragraph', 'subheading', 'list', 'quote', 'callout', 'disclosure'].map((type) => [type, [1]]),
  ),
};

/** Only the baseline every client must render. */
export const baselineCapabilities = {
  documentSchemas: ['scroll-document.v1'],
  blocks: Object.fromEntries(['fallback', 'paragraph', 'subheading'].map((type) => [type, [1]])),
};

/**
 * Builds the thin journey's real use cases from the real providers the API's and worker's composition
 * roots use (content, experience, evidence), without Nest. `wrapEnqueue` lets a test inject a failure
 * after the job is written, to prove rollback.
 */
export async function scrollUseCases(
  database: TestDatabase<Database>,
  options: {
    readonly wrapEnqueue?: (enqueue: EnqueueJob) => EnqueueJob;
    readonly wrapScope?: (scope: WithPersonalScope) => WithPersonalScope;
    readonly activityNow?: () => Date;
    /** Selects the actual recording-aware Experience composition, never a trusted eligibility flag. */
    readonly recording?: true;
    /** Serves worker-prepared buffers and requests the next one on activation, like the API. */
    readonly buffers?: true;
    readonly activityDerived?: ActivityDerivedEffect;
    /** Who may open a Scroll ordered from code, as the module that orders it decides. */
    readonly orderAudience?: ReadOrderAudience;
    readonly activityMaterialChange?: (
      scope: RecordingScopeTx,
      input: { readonly sourceRevision: number; readonly recordingGeneration: number },
    ) => Promise<void>;
  } = {},
): Promise<{
  readonly navigate: NavigateEncounter;
  readonly activateOffer: ActivateOffer;
  readonly readContext: ReadExposureContext;
  readonly applyEncounterAction: ApplyEncounterAction;
  readonly applyAction: ApplyAction;
  readonly listSaved: ListSaved;
  /** Actual owning effect from this fixture graph, for delegation/failure wrappers. */
  readonly activityContextEffect: ActivityDerivedEffect;
  /** Actual required Experience effects, exposed only for the selected recording fixture graph. */
  readonly recordingEffects?: ExperienceRecordingEffects;
  readonly projectActivity: ProjectEncounterActivity;
  readonly reconcileActivity: ReconcileEncounterActivity;
  readonly readPrepared: ReadPreparedEvidenceInput;
  readonly readComposerContext: ReadPreparedEvidenceInput;
  readonly readExploration: ReadExplorationSnapshot;
  readonly readTrustedCoverage: ReadTrustedCoverage;
  readonly readRecentTopics: ReadRecentContextTopics;
  readonly importScroll: ImportEditorialScroll;
  readonly openExposure: OpenExposure;
  readonly activateExposure: ActivateExposure;
  readonly readExposureDocument: ReadExposureDocument;
  readonly renderScroll: RenderScroll;
  readonly ingestObservations: IngestObservations;
  readonly readEvidenceDiagnostics: ReadEvidenceDiagnostics;
  readonly projectScrollReading: ProjectScrollReading;
  readonly boss: PgBoss;
  close(): Promise<void>;
}> {
  const boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
  await boss.start();
  const enqueue = makeEnqueueJob(boss);
  const scope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
  const identity = accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 });
  const experienceReads = experienceEvidenceReadProviders();
  const experienceReadFactories = experienceReads.filter(
    (provider): provider is Extract<typeof provider, { useFactory: unknown }> =>
      typeof provider.useFactory === 'function',
  );
  const values = new Map<symbol, unknown>([
    [FENCE_PERSONAL_RECORDING, fencePersonalRecording],
    [FENCE_OWN_ACCOUNT, identity.fenceOwnAccount],
    [READ_RECORDING_LIFECYCLE, identity.readRecordingLifecycle],
    [DATABASE, database.db],
    [SCOPE, options.wrapScope ? options.wrapScope(scope) : scope],
    [ENQUEUE, options.wrapEnqueue === undefined ? enqueue : options.wrapEnqueue(enqueue)],
    ...(options.activityDerived ? [[ACTIVITY_CONTEXT_EFFECT, options.activityDerived] as [symbol, unknown]] : []),
    ...identityScopeOwnerProviders().map((provider) => [provider.provide, provider.useValue] as const),
    ...contentProviders().map((provider) => [provider.provide, provider.useValue] as const),
    ...experienceReads.flatMap((provider) =>
      provider.useValue === undefined ? [] : [[provider.provide, provider.useValue] as const],
    ),
  ]);
  values.set(RENDER_SCROLL, buildFromProviders(contentRenderProviders({ database: DATABASE }), RENDER_SCROLL, values));
  // A Scroll ordered from code opens for no one unless a test names the audience that ordered it.
  const ORDER_AUDIENCE = Symbol('test.orderAudience');
  values.set(ORDER_AUDIENCE, options.orderAudience ?? (() => Promise.resolve(new Set<string>())));
  values.set(
    CHECK_ASSET_AUDIENCE,
    buildFromProviders(
      madeToOrderProviders({ database: DATABASE, orderAudience: ORDER_AUDIENCE }),
      CHECK_ASSET_AUDIENCE,
      values,
    ),
  );
  const composer = composerProviders({ isOperator: () => false });
  for (const p of composer) values.set(p.provide, p.useValue);
  const bufferProviders = options.buffers ? composerBufferProviders({ enqueueJob: ENQUEUE }) : [];
  for (const p of bufferProviders) if ('useValue' in p) values.set(p.provide, p.useValue);
  const providers = [
    ...bufferProviders.filter((p): p is Extract<typeof p, { useFactory: unknown }> => 'useFactory' in p),
    ...experienceReadFactories,
    ...sceneAppliedProviders({ enqueueJob: ENQUEUE }),
    ...plannerRequestProviders({ withPersonalScope: SCOPE, enqueueJob: ENQUEUE }),
    ...plannerReadProviders(),
    ...geographyProviders({ withPersonalScope: SCOPE, enqueueJob: ENQUEUE }),
    ...personalContextProviders({ readCurrentPlan: READ_CURRENT_PLAN }),
    ...activityProviders({
      withPersonalScope: SCOPE,
      enqueueJob: ENQUEUE,
      derivedProjection: ACTIVITY_CONTEXT_EFFECT,
      materialChange: MATERIAL_CHANGE,
      legacyPreparedRead: true,
    }),
    ...navigationProviders(
      { withPersonalScope: SCOPE, enqueueJob: ENQUEUE },
      {
        ...(options.recording ? { recordingEffects: EXPERIENCE_RECORDING_EFFECTS } : {}),
        ...(options.buffers ? { buffers: true } : {}),
      },
    ),
    ...experienceProviders(
      { database: DATABASE, withPersonalScope: SCOPE, enqueueJob: ENQUEUE },
      options.recording ? { recordingEffects: EXPERIENCE_RECORDING_EFFECTS } : {},
    ),
    ...evidenceIntakeProviders({ database: DATABASE, withPersonalScope: SCOPE, enqueueJob: ENQUEUE }),
    ...evidenceProviders({ enqueueJob: ENQUEUE, withPersonalScope: SCOPE }),
  ];
  // Resolve the actual request/read providers recursively; a missing or cyclic dependency refuses.
  // No successful substitute is supplied for an owning effect or a model-role proof.
  const building = new Set<symbol>();
  const build = (token: symbol): unknown => {
    if (values.has(token)) return values.get(token);
    if (building.has(token)) throw new Error('CI_RECORDING_PROVIDER_CYCLE');
    const provider = providers.find((candidate) => candidate.provide === token);
    if (!provider) throw new Error('CI_RECORDING_PROVIDER_MISSING');
    building.add(token);
    try {
      for (const dependency of provider.inject) if (!values.has(dependency)) build(dependency);
      const value = buildFromProviders(providers, token, values);
      values.set(token, value);
      return value;
    } finally {
      building.delete(token);
    }
  };
  values.set(
    MATERIAL_CHANGE,
    async (cap: RecordingScopeTx, input: { readonly sourceRevision: number; readonly recordingGeneration: number }) => {
      const planner = build(PLANNER_MATERIAL_CHANGE) as PlannerMaterialChange;
      const geography = build(GEOGRAPHY_MATERIAL_CHANGE) as MaterialGeographyChange;
      await planner(cap, input);
      await geography(cap, input);
    },
  );
  values.set(CHECK_COVERAGE_EVIDENCE, build(CHECK_COVERAGE_EVIDENCE));
  values.set(CHECK_RECORDING_COVERAGE_EVIDENCE, build(CHECK_RECORDING_COVERAGE_EVIDENCE));
  if (!options.activityDerived) values.set(ACTIVITY_CONTEXT_EFFECT, build(ACTIVITY_CONTEXT_EFFECT));
  const activityPorts = build(ACTIVITY_PORTS);
  values.set(ACTIVITY_PORTS, {
    ...(activityPorts as object),
    ...(options.activityNow ? { now: options.activityNow } : {}),
    ...(options.activityMaterialChange ? { materialChange: options.activityMaterialChange } : {}),
  });
  values.set(READ_PREPARED_ACTIVITY, build(READ_PREPARED_ACTIVITY));
  values.set(READ_ACTIVITY_STATISTICS, build(READ_ACTIVITY_STATISTICS));
  values.set(READ_OBSERVATION_TAIL, build(READ_OBSERVATION_TAIL));
  values.set(READ_RECENT_TOPIC_IDS, build(READ_RECENT_TOPIC_IDS));
  values.set(READ_EXPLORATION_SNAPSHOT, build(READ_EXPLORATION_SNAPSHOT));
  values.set(READ_COMPOSER_CONTEXT, build(READ_COMPOSER_CONTEXT));
  values.set(NAVIGATION_PORTS, build(NAVIGATION_PORTS));
  return {
    navigate: build(NAVIGATE_ENCOUNTER) as NavigateEncounter,
    activateOffer: build(ACTIVATE_OFFER) as ActivateOffer,
    readContext: build(READ_EXPOSURE_CONTEXT) as ReadExposureContext,
    applyEncounterAction: build(APPLY_ENCOUNTER_ACTION) as ApplyEncounterAction,
    applyAction: build(APPLY_ACTION) as ApplyAction,
    listSaved: build(LIST_SAVED) as ListSaved,
    activityContextEffect: values.get(ACTIVITY_CONTEXT_EFFECT) as ActivityDerivedEffect,
    ...(options.recording
      ? { recordingEffects: build(EXPERIENCE_RECORDING_EFFECTS) as ExperienceRecordingEffects }
      : {}),
    projectActivity: build(PROJECT_ENCOUNTER_ACTIVITY) as ProjectEncounterActivity,
    reconcileActivity: build(RECONCILE_ENCOUNTER_ACTIVITY) as ReconcileEncounterActivity,
    readPrepared: values.get(READ_PREPARED_ACTIVITY) as ReadPreparedEvidenceInput,
    readComposerContext: values.get(READ_COMPOSER_CONTEXT) as ReadPreparedEvidenceInput,
    readExploration: build(READ_EXPLORATION_SNAPSHOT) as ReadExplorationSnapshot,
    readTrustedCoverage: build(READ_TRUSTED_COVERAGE) as ReadTrustedCoverage,
    readRecentTopics: build(READ_RECENT_CONTEXT_TOPICS) as ReadRecentContextTopics,
    importScroll: importEditorialScrollUseCase(database.db),
    openExposure: build(OPEN_EXPOSURE) as OpenExposure,
    activateExposure: build(ACTIVATE_EXPOSURE) as ActivateExposure,
    readExposureDocument: build(READ_EXPOSURE_DOCUMENT) as ReadExposureDocument,
    renderScroll: values.get(RENDER_SCROLL) as RenderScroll,
    ingestObservations: build(INGEST_OBSERVATIONS) as IngestObservations,
    readEvidenceDiagnostics: build(READ_EVIDENCE_DIAGNOSTICS) as ReadEvidenceDiagnostics,
    projectScrollReading: build(PROJECT_SCROLL_READING) as ProjectScrollReading,
    boss,
    close: () => boss.stop({ graceful: false }),
  };
}

/** Admits the starter Scroll through the real import use case and returns its identity. */
export async function admitStarter(
  importScroll: ImportEditorialScroll,
): Promise<{ readonly assetId: string; readonly revision: number }> {
  const result = await importScroll(starterSource());
  if (result.kind !== 'imported') throw new Error(`starter admission refused: ${result.reason}`);
  return { assetId: result.assetId, revision: result.revision };
}
