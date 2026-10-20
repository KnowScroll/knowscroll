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
} from '@knowscroll/backend/modules/evidence/nest-providers';
import type { ActivateExposure, OpenExposure, ReadExposureDocument } from '@knowscroll/backend/modules/experience';
import {
  ACTIVATE_EXPOSURE,
  OPEN_EXPOSURE,
  READ_EXPOSURE_DOCUMENT,
  experienceEvidenceReadProviders,
  experienceProviders,
} from '@knowscroll/backend/modules/experience/nest-providers';
import type { TestDatabase } from './database.js';
import { buildFromProviders } from './providers.js';

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
  options: { readonly wrapEnqueue?: (enqueue: EnqueueJob) => EnqueueJob } = {},
): Promise<{
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
  const values = new Map<symbol, unknown>([
    [DATABASE, database.db],
    [SCOPE, makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })],
    [ENQUEUE, options.wrapEnqueue === undefined ? enqueue : options.wrapEnqueue(enqueue)],
    ...contentProviders().map((provider) => [provider.provide, provider.useValue] as const),
    ...experienceEvidenceReadProviders().map((provider) => [provider.provide, provider.useValue] as const),
  ]);
  values.set(RENDER_SCROLL, buildFromProviders(contentRenderProviders({ database: DATABASE }), RENDER_SCROLL, values));
  const providers = [
    ...experienceProviders({ database: DATABASE, withPersonalScope: SCOPE, enqueueJob: ENQUEUE }),
    ...evidenceIntakeProviders({ database: DATABASE, withPersonalScope: SCOPE, enqueueJob: ENQUEUE }),
    ...evidenceProviders({ withPersonalScope: SCOPE }),
  ];
  const build = (token: symbol): unknown => buildFromProviders(providers, token, values);
  return {
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
