import { readFileSync } from 'node:fs';
import type { PgBoss } from 'pg-boss';
import { createBoss, makeEnqueueJob, type EnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { RENDER_SCROLL, type ImportEditorialScroll, type RenderScroll } from '@knowscroll/backend/modules/content';
import {
  contentProviders,
  contentRenderProviders,
  importEditorialScrollUseCase,
} from '@knowscroll/backend/modules/content/nest-providers';
import {
  READ_PREPARED_ACTIVITY,
  type ProjectEncounterActivity,
  type ReconcileEncounterActivity,
  type ActivityDerivedEffect,
} from '@knowscroll/backend/modules/evidence';
import { composerProviders } from '@knowscroll/backend/modules/composer/nest-providers';
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
  READ_OBSERVATION_TAIL,
  READ_RECENT_TOPIC_IDS,
} from '@knowscroll/backend/modules/evidence';
import type { ReadPreparedEvidenceInput } from '@knowscroll/backend/modules/composer';
import type {
  NavigateEncounter,
  ActivateOffer,
  ReadExposureContext,
  ApplyEncounterAction,
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
  LIST_SAVED,
} from '@knowscroll/backend/modules/experience/nest-providers';
import type { WithPersonalScope } from '@knowscroll/backend/modules/identity';
import type { TestDatabase } from './database.js';
import { buildFromProviders } from './providers.js';

import { PROJECT_ENCOUNTER_ACTIVITY, RECONCILE_ENCOUNTER_ACTIVITY } from '@knowscroll/backend/modules/evidence';
const DATABASE = Symbol('test.database');
const SCOPE = Symbol('test.withPersonalScope');
const ENQUEUE = Symbol('test.enqueueJob');

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
    readonly activityDerived?: ActivityDerivedEffect;
    readonly activityMaterialChange?: (
      scope: Parameters<ActivityDerivedEffect['apply']>[0],
      input: { readonly sourceRevision: number },
    ) => Promise<void>;
  } = {},
): Promise<{
  readonly navigate: NavigateEncounter;
  readonly activateOffer: ActivateOffer;
  readonly readContext: ReadExposureContext;
  readonly applyEncounterAction: ApplyEncounterAction;
  readonly listSaved: ListSaved;
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
  const values = new Map<symbol, unknown>([
    [DATABASE, database.db],
    [SCOPE, options.wrapScope ? options.wrapScope(scope) : scope],
    [ENQUEUE, options.wrapEnqueue === undefined ? enqueue : options.wrapEnqueue(enqueue)],
    ...(options.activityDerived ? [[ACTIVITY_CONTEXT_EFFECT, options.activityDerived] as [symbol, unknown]] : []),
    ...contentProviders().map((provider) => [provider.provide, provider.useValue] as const),
    ...experienceEvidenceReadProviders().map((provider) => [provider.provide, provider.useValue] as const),
  ]);
  values.set(RENDER_SCROLL, buildFromProviders(contentRenderProviders({ database: DATABASE }), RENDER_SCROLL, values));
  const composer = composerProviders({ isOperator: () => false });
  for (const p of composer) values.set(p.provide, p.useValue);
  const providers = [
    ...personalContextProviders(),
    ...activityProviders({
      withPersonalScope: SCOPE,
      enqueueJob: ENQUEUE,
      derivedProjection: ACTIVITY_CONTEXT_EFFECT,
      legacyPreparedRead: true,
    }),
    ...navigationProviders({ withPersonalScope: SCOPE, enqueueJob: ENQUEUE }),
    ...experienceProviders({ database: DATABASE, withPersonalScope: SCOPE, enqueueJob: ENQUEUE }),
    ...evidenceIntakeProviders({ database: DATABASE, withPersonalScope: SCOPE, enqueueJob: ENQUEUE }),
    ...evidenceProviders({ enqueueJob: ENQUEUE, withPersonalScope: SCOPE }),
  ];
  const build = (token: symbol): unknown => buildFromProviders(providers, token, values);
  values.set(CHECK_COVERAGE_EVIDENCE, build(CHECK_COVERAGE_EVIDENCE));
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
    listSaved: build(LIST_SAVED) as ListSaved,
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
