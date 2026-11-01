import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { FULL_V1_CAPABILITIES } from '@knowscroll/scroll-model';
import type { CreateContentRequest } from '@knowscroll/contracts';
import { makeEnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import {
  fencePersonalRecording,
  makeWithPersonalScope,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { FENCE_PERSONAL_RECORDING } from '@knowscroll/backend/modules/identity';
import { identityScopeOwnerProviders } from '@knowscroll/backend/modules/identity/nest-providers';
import { contentProviders, makeReadLibraryPassages } from '@knowscroll/backend/modules/content/nest-providers';
import { experienceEvidenceReadProviders } from '@knowscroll/backend/modules/experience/nest-providers';
import { READ_LIBRARY_PASSAGES, produceScrollJob } from '@knowscroll/backend/modules/content';
import { READ_EXPLORATION_SNAPSHOT } from '@knowscroll/backend/modules/personal-context';
import {
  CREATE_CONTENT_REQUEST,
  RESOLVE_CONTENT_REQUEST,
  type CreateRequest,
  type ResolveRequest,
} from '@knowscroll/backend/modules/supply';
import { SUPPLY_PORTS, supplyProviders } from '@knowscroll/backend/modules/supply/nest-providers';
import { createTestDatabase, type TestDatabase } from './database.js';
import { fixtureAuthored } from './generated-scroll.js';
import { fixtureHarness, fixtureModel } from './fixture-model.js';
import type { FixtureScenario } from './fixture-model-port.js';
import { fixtureProductionWorker } from './production-worker.js';
import { buildFromProviders } from './providers.js';
import { seedPerson, type FixturePerson } from './fixtures.js';
import { scrollUseCases } from './scroll.js';

const capabilities = { ...FULL_V1_CAPABILITIES, documentSchemas: ['scroll-document.v1', 'reel-document.v1'] };

/** What the fixture writer answers: a valid authored Scroll, until a test sets another scenario. */
export const validWriterAnswer = (): FixtureScenario => ({
  kind: 'success',
  text: JSON.stringify(fixtureAuthored('diagram')),
});

/**
 * Quartermaster's Create over a real PostgreSQL database and pg-boss, with a labelled fixture model
 * for matching and for the Scroll writer (CI fixtures: no provider network). Tests ask for content,
 * run the production job and resolve waiters, which leaves the records the operator views read.
 */
export async function supplyWorld(purpose: string) {
  const database: TestDatabase<Database> = await createTestDatabase<Database>(purpose);
  await sql`update reasoning.production_scopes set enabled=true where id='scroll-supply'`.execute(database.db);
  const content = await scrollUseCases(database);
  let writer: () => FixtureScenario = validWriterAnswer;
  const production = fixtureProductionWorker(database, () => writer());
  const matchModel = fixtureModel(() => ({ kind: 'success', text: JSON.stringify({ topicId: null, facetId: null }) }), {
    label: 'supply-match-CI-fixture',
  });
  const SCOPE = Symbol('scope');
  const ENQUEUE = Symbol('enqueue');
  const CONFIG = Symbol('config');
  const HARNESS = Symbol('harness');
  const providers = supplyProviders({
    withPersonalScope: SCOPE,
    enqueueJob: ENQUEUE,
    config: CONFIG,
    harness: HARNESS,
  });
  const values = new Map<symbol, unknown>([
    [SCOPE, makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })],
    [ENQUEUE, makeEnqueueJob(content.boss)],
    [
      CONFIG,
      { supplyCreateDailyCap: 10, supplyPlannerCreateDailyCap: 10, supplyAskDailyCap: 20, supplyAskPersonDailyCap: 5 },
    ],
    [FENCE_PERSONAL_RECORDING, fencePersonalRecording],
    [READ_EXPLORATION_SNAPSHOT, content.readExploration],
    [HARNESS, fixtureHarness(database.db, { model: matchModel }).harness],
    [READ_LIBRARY_PASSAGES, makeReadLibraryPassages(database.db)],
    ...identityScopeOwnerProviders().map((provider) => [provider.provide, provider.useValue] as const),
    ...contentProviders().map((provider) => [provider.provide, provider.useValue] as const),
    ...experienceEvidenceReadProviders().map((provider) => [provider.provide, provider.useValue] as const),
  ]);
  const get = <T>(token: symbol): T => {
    const value = buildFromProviders(providers, token, values);
    values.set(token, value);
    return value as T;
  };
  get(SUPPLY_PORTS);
  const create = get<CreateRequest>(CREATE_CONTENT_REQUEST);
  const resolve = get<ResolveRequest>(RESOLVE_CONTENT_REQUEST);

  const catalogueRequest = (topicId: string, facetId?: string): CreateContentRequest => ({
    version: 'content-request.v1',
    commandId: randomUUID(),
    intent: {
      kind: 'topic',
      subject: {
        kind: 'catalogue',
        catalogueVersion: 'content-concepts.v1',
        topicId,
        ...(facetId === undefined ? {} : { facetId }),
      },
      format: 'scroll',
    },
    language: 'en',
    capabilities,
  });
  const textRequest = (text: string): CreateContentRequest => ({
    version: 'content-request.v1',
    commandId: randomUUID(),
    intent: { kind: 'topic', subject: { kind: 'text', text }, format: 'scroll' },
    language: 'en',
    capabilities,
  });

  return {
    database,
    content,
    production,
    seedPerson: () => seedPerson(database.db),
    /** Chooses what the Scroll writer answers from now on. */
    answerWriterWith(scenario: () => FixtureScenario) {
      writer = scenario;
    },
    async ask(person: FixturePerson, request: CreateContentRequest): Promise<string> {
      const result = await create(person.authority, request);
      if (result.kind !== 'ok') throw new Error(`CI request refused: ${result.reason}`);
      return result.value.requestId;
    },
    catalogueRequest,
    textRequest,
    resolveRequest: (person: FixturePerson, requestId: string) =>
      resolve({ v: 1 as const, universeId: person.universeId, privacyEpoch: 1, requestId }),
    runProduction: (recipe: string, take = 1) =>
      production.run(produceScrollJob(recipe, take), { signal: new AbortController().signal }),
    /** The person opens and activates a Scroll: an exposure, which is how they meet it. */
    async meet(person: FixturePerson, assetId: string): Promise<string> {
      const opened = await content.openExposure(person.authority, {
        commandId: randomUUID(),
        target: { kind: 'scroll', assetId },
        origin: { kind: 'direct' },
        capabilities,
      });
      if (opened.kind !== 'opened') throw new Error('CI open refused');
      const activated = await content.activateExposure(person.authority, {
        commandId: randomUUID(),
        exposureId: opened.outcome.exposureId,
      });
      if (activated.kind !== 'activated') throw new Error('CI activation refused');
      return opened.outcome.exposureId;
    },
    async close() {
      await content.close();
      await database.drop();
    },
  };
}

export type SupplyWorld = Awaited<ReturnType<typeof supplyWorld>>;
