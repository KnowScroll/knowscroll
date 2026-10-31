import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { FULL_V1_CAPABILITIES } from '@knowscroll/scroll-model';
import type { CreateContentRequest } from '@knowscroll/contracts';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { makeEnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import { requestHash } from '@knowscroll/backend/infrastructure/receipts';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { identityScopeOwnerProviders } from '@knowscroll/backend/modules/identity/nest-providers';
import { contentProviders } from '@knowscroll/backend/modules/content/nest-providers';
import { experienceEvidenceReadProviders } from '@knowscroll/backend/modules/experience/nest-providers';
import { produceScrollJob, produceScrollQueue } from '@knowscroll/backend/modules/content';
import { READ_EXPLORATION_SNAPSHOT } from '@knowscroll/backend/modules/personal-context';
import {
  CANCEL_CONTENT_REQUEST,
  CREATE_CONTENT_REQUEST,
  LIST_CONTENT_REQUESTS,
  READ_CONTENT_REQUEST,
  RETRY_CONTENT_REQUEST,
  RECORD_PLANNED_DEMAND,
  RESOLVE_CONTENT_REQUEST,
  resolveSupplyQueue,
  type CancelRequest,
  type CreateRequest,
  type ListRequests,
  type ReadRequest,
  type RetryRequest,
  type RecordPlannedDemand,
  type PlannedDemandInput,
  type ResolveRequest,
} from '@knowscroll/backend/modules/supply';
import { SUPPLY_PORTS, recoverOpenDemand, supplyProviders } from '@knowscroll/backend/modules/supply/nest-providers';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import { buildFromProviders } from '../support/providers.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureAuthored } from '../support/generated-scroll.js';
import { fixtureHarness, fixtureModel, receiptClassesOf } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import { fixtureProductionWorker, type QuotaScript } from '../support/production-worker.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { scrollUseCases, starterSource } from '../support/scroll.js';
import { markLibraryV1, markScrollV2, ORRIN_PLAN } from '../support/scroll-v2.js';

const capabilities = { ...FULL_V1_CAPABILITIES, documentSchemas: ['scroll-document.v1', 'reel-document.v1'] };
const writerAnswer = (): FixtureScenario => ({ kind: 'success', text: JSON.stringify(fixtureAuthored('diagram')) });
const matchAnswer = (topicId: string | null, facetId: string | null = null): FixtureScenario => ({
  kind: 'success',
  text: JSON.stringify({ topicId, facetId }),
});

/**
 * Quartermaster's Create end to end (D-037): a request for a topic with no admitted content commits
 * demand and a shared production job together; a worker (fixture model, real PostgreSQL and pg-boss)
 * publishes; each waiter is bound under its own authority. CI fixtures only: no provider network.
 */
describe('Supply Create (CI fixture models, real PostgreSQL and pg-boss)', () => {
  // Create commissions only v1 recipes (D-138): this file tests Create on the v1 library.
  const restoreLibrary = markLibraryV1();
  afterAll(restoreLibrary);
  let database: TestDatabase<Database>;
  let content: Awaited<ReturnType<typeof scrollUseCases>>;
  let create: CreateRequest, read: ReadRequest, list: ListRequests, cancel: CancelRequest, resolve: ResolveRequest;
  let retry: RetryRequest;
  let recordPlanned: RecordPlannedDemand;
  let production: ReturnType<typeof fixtureProductionWorker>;
  let matchModel: ReturnType<typeof fixtureModel>;
  let matchScript: (sequence: number) => FixtureScenario | Promise<FixtureScenario>;
  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });

  /** Builds the use cases with the given Create cap and production script. */
  async function build(
    options: { cap?: number; plannerCap?: number; writer?: () => FixtureScenario; quota?: QuotaScript } = {},
  ) {
    database = await createTestDatabase<Database>('supply_create');
    await sql`update reasoning.production_scopes set enabled=true where id='scroll-supply'`.execute(database.db);
    content = await scrollUseCases(database);
    production = fixtureProductionWorker(database, options.writer ?? writerAnswer, {
      ...(options.quota ? { quota: options.quota } : {}),
    });
    matchScript = () => matchAnswer(null);
    matchModel = fixtureModel((sequence) => matchScript(sequence), { label: 'supply-match-CI-fixture' });
    const SCOPE = Symbol('scope'),
      ENQUEUE = Symbol('enqueue'),
      CONFIG = Symbol('config'),
      HARNESS = Symbol('harness');
    const providers = supplyProviders({
      withPersonalScope: SCOPE,
      enqueueJob: ENQUEUE,
      config: CONFIG,
      harness: HARNESS,
    });
    const values = new Map<symbol, unknown>([
      [SCOPE, withScope()],
      [ENQUEUE, makeEnqueueJob(content.boss)],
      [
        CONFIG,
        {
          supplyCreateDailyCap: options.cap ?? 10,
          supplyPlannerCreateDailyCap: options.plannerCap ?? options.cap ?? 10,
        },
      ],
      [READ_EXPLORATION_SNAPSHOT, content.readExploration],
      [HARNESS, fixtureHarness(database.db, { model: matchModel }).harness],
      ...identityScopeOwnerProviders().map((p) => [p.provide, p.useValue] as const),
      ...contentProviders().map((p) => [p.provide, p.useValue] as const),
      ...experienceEvidenceReadProviders().map((p) => [p.provide, p.useValue] as const),
    ]);
    const get = <T>(token: symbol): T => {
      const value = buildFromProviders(providers, token, values);
      values.set(token, value);
      return value as T;
    };
    get(SUPPLY_PORTS);
    create = get(CREATE_CONTENT_REQUEST);
    read = get(READ_CONTENT_REQUEST);
    list = get(LIST_CONTENT_REQUESTS);
    cancel = get(CANCEL_CONTENT_REQUEST);
    retry = get(RETRY_CONTENT_REQUEST);
    resolve = get(RESOLVE_CONTENT_REQUEST);
    recordPlanned = get(RECORD_PLANNED_DEMAND);
  }
  afterEach(async () => {
    await content.close();
    await database.drop();
  });

  const catalogue = (
    topicId: string,
    options: { facetId?: string; format?: 'reel' | 'scroll' | 'either' } = {},
  ): CreateContentRequest => ({
    version: 'content-request.v1',
    commandId: randomUUID(),
    intent: {
      kind: 'topic',
      subject: {
        kind: 'catalogue',
        catalogueVersion: 'content-concepts.v1',
        topicId,
        ...(options.facetId === undefined ? {} : { facetId: options.facetId }),
      },
      format: options.format ?? 'scroll',
    },
    language: 'en',
    capabilities,
  });
  const freeText = (text: string): CreateContentRequest => ({
    version: 'content-request.v1',
    commandId: randomUUID(),
    intent: { kind: 'topic', subject: { kind: 'text', text }, format: 'scroll' },
    language: 'en',
    capabilities,
  });
  async function ask(person: FixturePerson, command: CreateContentRequest) {
    const result = await create(person.authority, command);
    if (result.kind !== 'ok') throw new Error(`CI request refused: ${result.reason}`);
    return result.value.requestId;
  }
  async function status(person: FixturePerson, requestId: string) {
    const result = await read(person.authority, { requestId });
    if (result.kind !== 'ok') throw new Error(`CI status refused: ${result.reason}`);
    return result.value;
  }
  const job = (person: FixturePerson, requestId: string) => ({
    v: 1 as const,
    universeId: person.universeId,
    privacyEpoch: 1,
    requestId,
  });
  const produceJobs = async () =>
    (await sql<{ id: string }>`select id from pgboss.job where name=${produceScrollQueue.name}`.execute(database.db))
      .rows;
  const resolverJobs = async (person: FixturePerson) =>
    (
      await sql<{
        start_after: Date;
      }>`select start_after from pgboss.job where name=${resolveSupplyQueue.name} and data->>'universeId'=${person.universeId} order by created_on`.execute(
        database.db,
      )
    ).rows;
  const workOf = async (requestId: string) =>
    database.db
      .selectFrom('supply.requests as request')
      .innerJoin('supply.work as work', 'work.id', 'request.work_id')
      .select(['work.id', 'work.active', 'work.production_recipe', 'request.decision'])
      .where('request.id', '=', requestId)
      .executeTakeFirstOrThrow();

  /** An admitted Scroll of the library for a topic, as authored CI content (not produced). */
  async function admit(topicId: string, title = 'Authored CI Supply fixture') {
    const source = starterSource() as {
      assetId: string;
      publication: { explanationUnitId: string };
      draft: { title: string };
    };
    source.draft.title = title;
    source.assetId = randomUUID();
    source.publication.explanationUnitId = `ci-supply-${randomUUID()}`;
    const imported = await content.importScroll(source);
    if (imported.kind !== 'imported') throw new Error('CI fixture admission refused');
    await database.db
      .insertInto('content.encounter_topics')
      .values({
        asset_id: imported.assetId,
        asset_revision: imported.revision,
        topic_id: topicId,
        role: 'primary',
        weight: 1,
      })
      .execute();
    return { assetId: imported.assetId, assetRevision: imported.revision, unit: source.publication.explanationUnitId };
  }
  /** The person opens and activates a Scroll, which is how an explanation becomes one they have met. */
  async function meet(person: FixturePerson, asset: { assetId: string }) {
    const opened = await content.openExposure(person.authority, {
      commandId: randomUUID(),
      target: { kind: 'scroll', assetId: asset.assetId },
      origin: { kind: 'direct' },
      capabilities,
    });
    if (opened.kind !== 'opened') throw new Error('CI open refused');
    const activated = await content.activateExposure(person.authority, {
      commandId: randomUUID(),
      exposureId: opened.outcome.exposureId,
    });
    if (activated.kind !== 'activated') throw new Error('CI activation refused');
  }
  const plan = (topicId: string, overrides: Partial<PlannedDemandInput> = {}): PlannedDemandInput => ({
    plannerRunId: randomUUID(),
    slot: 0,
    topicIds: [topicId],
    format: 'scroll',
    language: 'en',
    capabilities,
    alreadyMet: [],
    ...overrides,
  });
  const recordFor = (person: FixturePerson, input: PlannedDemandInput) =>
    withScope()(person.authority, (scope) => recordPlanned(scope, input)).then((result) => {
      if (result.kind !== 'entered') throw new Error('CI scope refused');
      return result.value;
    });
  const queuedProduceJobs = async () =>
    (
      await sql<{
        data: { recipe: string; take: number };
      }>`select data from pgboss.job where name=${produceScrollQueue.name} and state='created'`.execute(database.db)
    ).rows.map((row) => row.data);
  const publish = (recipe: string, take = 1) =>
    production.run(produceScrollJob(recipe, take), { signal: new AbortController().signal });

  it('commits the demand and the production job together, publishes through the worker, and resolves the waiter', async () => {
    await build();
    const person = await seedPerson(database.db);
    const requestId = await ask(person, catalogue('machine-learning.transformers'));

    expect(await status(person, requestId)).toMatchObject({ status: 'preparing', phase: 'preparing' });
    expect(await workOf(requestId)).toMatchObject({
      production_recipe: 'transformer-architecture',
      decision: 'create',
      active: true,
    });
    expect(await produceJobs()).toHaveLength(1);
    expect(production.fixture.calls).toHaveLength(0);

    // Production has not started: the waiter looks again later and decides nothing.
    await resolve(job(person, requestId));
    expect(await status(person, requestId)).toMatchObject({ status: 'preparing', requestRevision: 1 });
    const jobs = await resolverJobs(person);
    expect(jobs).toHaveLength(2);
    expect(jobs[1]!.start_after.getTime()).toBeGreaterThan(Date.now());
    // Looking again in the same slot schedules nothing new, so the polls never fork.
    await resolve(job(person, requestId));
    expect(await resolverJobs(person)).toHaveLength(2);

    expect(await publish('transformer-architecture')).toMatchObject({
      kind: 'finished',
      result: { outcome: 'published' },
    });
    await resolve(job(person, requestId));
    expect(await status(person, requestId)).toMatchObject({
      status: 'ready',
      content: { assetId: TOPICS['transformer-architecture'].assetId },
      requestRevision: 2,
    });
    expect((await workOf(requestId)).active).toBe(false);
    // Only the writer ran; nothing in the request path called a model.
    expect(production.fixture.calls).toHaveLength(1);
    expect(matchModel.calls).toHaveLength(0);
  });

  it('lets a concurrent request join the one job, and binds every waiter under its own authority', async () => {
    await build();
    const [first, second, third] = await Promise.all([
      seedPerson(database.db),
      seedPerson(database.db),
      seedPerson(database.db),
    ]);
    const command = catalogue('machine-learning.transformers');
    const [a, b, c] = await Promise.all([
      ask(first, command),
      ask(second, { ...command, commandId: randomUUID() }),
      ask(third, { ...command, commandId: randomUUID() }),
    ]);
    expect((await Promise.all([workOf(a), workOf(b), workOf(c)])).map((work) => work.decision).sort()).toEqual([
      'create',
      'join',
      'join',
    ]);
    expect(new Set((await Promise.all([workOf(a), workOf(b), workOf(c)])).map((work) => work.id)).size).toBe(1);
    expect(await produceJobs()).toHaveLength(1);

    await publish('transformer-architecture');
    // One waiter withdraws before the Scroll is ready; the others are bound.
    await cancel(third.authority, { version: 'content-request-cancel.v1', commandId: randomUUID(), requestId: c });
    for (const [person, id] of [
      [first, a],
      [second, b],
      [third, c],
    ] as const)
      await resolve(job(person, id));
    expect(await status(first, a)).toMatchObject({
      status: 'ready',
      content: { assetId: TOPICS['transformer-architecture'].assetId },
    });
    expect(await status(second, b)).toMatchObject({
      status: 'ready',
      content: { assetId: TOPICS['transformer-architecture'].assetId },
    });
    expect((await status(third, c)).status).toBe('cancelled');
  });

  it('sends one job when two different briefs choose the same recipe, and serves both', async () => {
    await build();
    const topicOnly = await seedPerson(database.db),
      facetAsk = await seedPerson(database.db);
    const a = await ask(topicOnly, catalogue('machine-learning.transformers'));
    const b = await ask(
      facetAsk,
      catalogue('machine-learning.transformers', { facetId: 'machine-learning.transformers.architecture' }),
    );
    const [workA, workB] = [await workOf(a), await workOf(b)];
    expect(workA.id).not.toBe(workB.id);
    expect([workA.production_recipe, workB.production_recipe]).toEqual([
      'transformer-architecture',
      'transformer-architecture',
    ]);
    expect(await produceJobs()).toHaveLength(1);
    await publish('transformer-architecture');
    await resolve(job(topicOnly, a));
    await resolve(job(facetAsk, b));
    expect(await status(topicOnly, a)).toMatchObject({ status: 'ready' });
    expect(await status(facetAsk, b)).toMatchObject({ status: 'ready' });
  });

  it('closes a waiter whose production ended without a Scroll, never resending an attempt of unknown outcome', async () => {
    await build({ writer: () => ({ kind: 'gateway_timeout' }) });
    const person = await seedPerson(database.db);
    const requestId = await ask(person, catalogue('earth.tides', { facetId: 'earth.tides.forcing' }));
    expect(await publish('tides')).toMatchObject({ kind: 'finished', result: { outcome: 'unknown' } });
    await resolve(job(person, requestId));
    expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
    expect((await workOf(requestId)).active).toBe(false);
    expect(await publish('tides')).toMatchObject({ kind: 'finished', result: { outcome: 'unknown' } });
    expect(production.fixture.calls).toHaveLength(1);

    // The recipe is stopped at this version: the only recipe that teaches this facet is not run again,
    // so a new request for it closes at once instead of starting anything.
    const again = await seedPerson(database.db);
    const jobsBefore = (await produceJobs()).length;
    const retry = await ask(again, catalogue('earth.tides', { facetId: 'earth.tides.forcing' }));
    expect(await status(again, retry)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
    expect(await produceJobs()).toHaveLength(jobsBefore);
  });

  describe('retrying a request that could not be prepared (E07)', () => {
    const retryCommand = (requestId: string, commandId: string = randomUUID()) => ({
      version: 'content-request-retry.v1' as const,
      commandId,
      requestId,
    });
    const rowOf = (requestId: string) =>
      database.db
        .selectFrom('supply.requests')
        .select(['state', 'reason', 'retries', 'wait_started_at', 'created_at', 'request_revision'])
        .where('id', '=', requestId)
        .executeTakeFirstOrThrow();
    const facet = () => catalogue('earth.tides', { facetId: 'earth.tides.forcing' });

    it('reopens the same request and binds it when the next take publishes; a replay changes nothing', async () => {
      let writerWorks = false;
      await build({ writer: () => (writerWorks ? writerAnswer() : { kind: 'malformed' }) });
      const person = await seedPerson(database.db);
      const requestId = await ask(person, facet());
      expect(await publish('tides', 1)).toMatchObject({ result: { outcome: 'rejected', take: 1 } });
      await resolve(job(person, requestId));
      const closed = await status(person, requestId);
      expect(closed).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });

      const command = retryCommand(requestId);
      const first = await retry(person.authority, command);
      expect(first).toMatchObject({ kind: 'ok', value: { outcome: 'retrying', requestId, replayed: false } });
      const reopened = await status(person, requestId);
      expect(reopened).toMatchObject({ status: 'preparing', requestId });
      expect(reopened.requestRevision).toBeGreaterThan(closed.requestRevision);
      expect(await rowOf(requestId)).toMatchObject({ state: 'requested', reason: null, retries: 1 });
      expect((await queuedProduceJobs()).map((queued) => queued.take)).toContain(2);
      expect(await resolverJobs(person)).not.toHaveLength(0);

      const replay = await retry(person.authority, command);
      expect(replay).toMatchObject({ kind: 'ok', value: { outcome: 'retrying', replayed: true } });
      expect(await rowOf(requestId)).toMatchObject({ retries: 1 });

      writerWorks = true;
      expect(await publish('tides', 2)).toMatchObject({ result: { outcome: 'published', take: 2 } });
      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({
        status: 'ready',
        requestId,
        content: { assetId: TOPICS.tides.assetId },
      });
    });

    it('says already_open for a request that is still preparing or ready, and changes nothing', async () => {
      await build();
      const person = await seedPerson(database.db);
      const requestId = await ask(person, catalogue('machine-learning.transformers'));
      expect(await retry(person.authority, retryCommand(requestId))).toMatchObject({
        kind: 'ok',
        value: { outcome: 'already_open' },
      });
      expect(await rowOf(requestId)).toMatchObject({ state: 'requested', retries: 0, wait_started_at: null });
      await admit('machine-learning.transformers');
      const reuse = await ask(person, catalogue('machine-learning.transformers'));
      expect(await status(person, reuse)).toMatchObject({ status: 'ready' });
      expect(await retry(person.authority, retryCommand(reuse))).toMatchObject({
        kind: 'ok',
        value: { outcome: 'already_open' },
      });
    });

    it('starts a new wait for a request the wait limit closed, so it is not closed again at once', async () => {
      await build();
      const person = await seedPerson(database.db);
      const requestId = await ask(person, catalogue('machine-learning.transformers'));
      await sql`update supply.requests set created_at = now() - interval '31 minutes', updated_at = now() - interval '31 minutes' where id = ${requestId}`.execute(
        database.db,
      );
      expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
      expect(await retry(person.authority, retryCommand(requestId))).toMatchObject({
        kind: 'ok',
        value: { outcome: 'retrying' },
      });
      expect(await status(person, requestId)).toMatchObject({ status: 'preparing', phase: 'preparing' });
      const row = await rowOf(requestId);
      expect(row.wait_started_at!.getTime()).toBeGreaterThan(row.created_at.getTime());
      // The resolver counts from the new wait: production is queued, so it waits and polls again.
      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({ status: 'preparing' });
    });

    it('never retries a free-text ask that was not matched: its attempt may have an outcome nobody saw', async () => {
      await build();
      const person = await seedPerson(database.db);
      matchScript = () => ({ kind: 'gateway_timeout' });
      const requestId = await ask(person, freeText('why is the sky blue'));
      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
      expect(await retry(person.authority, retryCommand(requestId))).toMatchObject({
        kind: 'ok',
        value: { outcome: 'not_retryable' },
      });
      await resolve(job(person, requestId));
      expect(matchModel.calls).toHaveLength(1);
      expect(await rowOf(requestId)).toMatchObject({ state: 'unavailable', retries: 0 });
    });

    it('respects the day cap, the retry limit and other closures, leaving the request as it was', async () => {
      await build({ cap: 1, writer: () => ({ kind: 'malformed' }) });
      const person = await seedPerson(database.db);
      const requestId = await ask(person, facet());
      expect(await publish('tides', 1)).toMatchObject({ result: { outcome: 'rejected' } });
      await resolve(job(person, requestId));
      // The one production of the day is used: nothing can start, so the answer is not_retryable.
      expect(await retry(person.authority, retryCommand(requestId))).toMatchObject({
        kind: 'ok',
        value: { outcome: 'not_retryable' },
      });
      expect(await rowOf(requestId)).toMatchObject({ state: 'unavailable', reason: 'could_not_prepare', retries: 0 });

      await sql`update supply.requests set retries = 3 where id = ${requestId}`.execute(database.db);
      expect(await retry(person.authority, retryCommand(requestId))).toMatchObject({
        kind: 'ok',
        value: { outcome: 'not_retryable' },
      });

      const cancelled = await ask(person, catalogue('machine-learning.transformers'));
      await cancel(person.authority, {
        version: 'content-request-cancel.v1',
        commandId: randomUUID(),
        requestId: cancelled,
      });
      expect(await retry(person.authority, retryCommand(cancelled))).toMatchObject({
        kind: 'ok',
        value: { outcome: 'not_retryable' },
      });
      const reel = await ask(person, catalogue('machine-learning.transformers', { format: 'reel' }));
      expect(await status(person, reel)).toMatchObject({ status: 'unavailable', reason: 'budget_unavailable' });
      expect(await retry(person.authority, retryCommand(reel))).toMatchObject({
        kind: 'ok',
        value: { outcome: 'not_retryable' },
      });
    });

    it('refuses a retry while the person has the most open asks they may, without a receipt, and accepts the same command once one ends', async () => {
      await build({ writer: () => ({ kind: 'malformed' }) });
      const person = await seedPerson(database.db);
      const requestId = await ask(person, facet());
      expect(await publish('tides', 1)).toMatchObject({ result: { outcome: 'rejected' } });
      await resolve(job(person, requestId));
      const open: string[] = [];
      for (let n = 0; n < 10; n += 1) open.push(await ask(person, freeText(`question number ${String(n)}`)));
      const command = retryCommand(requestId);
      expect(await retry(person.authority, command)).toEqual({ kind: 'refused', reason: 'too_many_open' });
      expect(
        await database.db
          .selectFrom('receipts.personal_commands')
          .select('command_id')
          .where('command_id', '=', command.commandId)
          .execute(),
      ).toEqual([]);
      expect(await rowOf(requestId)).toMatchObject({ state: 'unavailable', retries: 0 });
      await cancel(person.authority, {
        version: 'content-request-cancel.v1',
        commandId: randomUUID(),
        requestId: open[0]!,
      });
      expect(await retry(person.authority, command)).toMatchObject({ kind: 'ok', value: { outcome: 'retrying' } });
    });

    it('lets only one of two concurrent retries reopen the request: the other finds it open', async () => {
      await build({ writer: () => ({ kind: 'malformed' }) });
      const person = await seedPerson(database.db);
      const requestId = await ask(person, facet());
      expect(await publish('tides', 1)).toMatchObject({ result: { outcome: 'rejected' } });
      await resolve(job(person, requestId));
      const [first, second] = await Promise.all([
        retry(person.authority, retryCommand(requestId)),
        retry(person.authority, retryCommand(requestId)),
      ]);
      const outcomes = [first, second].map((result) => (result.kind === 'ok' ? result.value.outcome : result.reason));
      expect(outcomes.sort()).toEqual(['already_open', 'retrying']);
      // One reopening: one retry counted, one production take queued, one wait started.
      expect(await rowOf(requestId)).toMatchObject({ state: 'requested', retries: 1 });
      expect((await queuedProduceJobs()).filter((queued) => queued.take === 2)).toHaveLength(1);
    });

    it('answers another person and an unknown request the same way, and keeps the same command ID to its first input', async () => {
      await build({ writer: () => ({ kind: 'malformed' }) });
      const owner = await seedPerson(database.db);
      const other = await seedPerson(database.db);
      const requestId = await ask(owner, facet());
      expect(await publish('tides', 1)).toMatchObject({ result: { outcome: 'rejected' } });
      await resolve(job(owner, requestId));
      expect(await retry(other.authority, retryCommand(requestId))).toEqual({ kind: 'refused', reason: 'not_found' });
      expect(await retry(owner.authority, retryCommand(randomUUID()))).toEqual({
        kind: 'refused',
        reason: 'not_found',
      });
      const commandId = randomUUID();
      expect(await retry(owner.authority, retryCommand(requestId, commandId))).toMatchObject({
        kind: 'ok',
        value: { outcome: 'retrying' },
      });
      expect(await retry(owner.authority, retryCommand(randomUUID(), commandId))).toEqual({
        kind: 'refused',
        reason: 'command_key_reused',
      });
    });
  });

  it('prefers a recipe that has not run: a stopped recipe is skipped for a request about the whole topic', async () => {
    await build({ writer: () => ({ kind: 'malformed' }) });
    const first = await seedPerson(database.db);
    await ask(first, catalogue('earth.greenhouse-effect'));
    expect(await publish('greenhouse')).toMatchObject({ kind: 'finished', result: { outcome: 'rejected' } });
    const second = await seedPerson(database.db);
    const requestId = await ask(second, catalogue('earth.greenhouse-effect'));
    expect((await workOf(requestId)).production_recipe).toBe('greenhouse-radiation');
    expect(await status(second, requestId)).toMatchObject({ status: 'preparing' });
  });

  it('takes a rejected recipe again when it is the only one that serves the brief, and binds the new waiter when take 2 publishes', async () => {
    let writerWorks = false;
    await build({ writer: () => (writerWorks ? writerAnswer() : { kind: 'malformed' }) });
    const facet = catalogue('earth.tides', { facetId: 'earth.tides.forcing' });
    const first = await seedPerson(database.db);
    const a = await ask(first, facet);
    expect(await publish('tides', 1)).toMatchObject({ result: { outcome: 'rejected', take: 1 } });
    await resolve(job(first, a));
    expect(await status(first, a)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });

    // The recipe was rejected once and has takes left, so a new request starts take 2.
    const second = await seedPerson(database.db);
    const b = await ask(second, { ...facet, commandId: randomUUID() });
    expect((await workOf(b)).production_recipe).toBe('tides');
    expect(await status(second, b)).toMatchObject({ status: 'preparing' });
    const queued = await sql<{
      data: { take: number };
    }>`select data from pgboss.job where name=${produceScrollQueue.name}`.execute(database.db);
    expect(queued.rows.map((row) => row.data.take).sort()).toEqual([1, 2]);

    writerWorks = true;
    expect(await publish('tides', 2)).toMatchObject({ result: { outcome: 'published', take: 2 } });
    await resolve(job(second, b));
    expect(await status(second, b)).toMatchObject({ status: 'ready', content: { assetId: TOPICS.tides.assetId } });
  });

  it('validates the enqueue options it is given, and treats a duplicate as a no-op only when asked', async () => {
    await build();
    const person = await seedPerson(database.db);
    const enqueue = makeEnqueueJob(content.boss);
    const send = (options: Parameters<typeof enqueue>[3]) =>
      withScope()(person.authority, (scope) =>
        enqueue(scope, produceScrollQueue, produceScrollJob('transformer-architecture', 1), options),
      );
    await expect(send({ duplicate: 'ignore' })).rejects.toThrow('JOB_OPTIONS_INVALID');
    await expect(send({ singletonKey: 'not a key' })).rejects.toThrow('JOB_OPTIONS_INVALID');
    await expect(send({ priority: 101 })).rejects.toThrow('JOB_OPTIONS_INVALID');
    expect(await produceJobs()).toHaveLength(0);
    const once = { singletonKey: 'transformer:one', duplicate: 'ignore' as const, priority: 5 };
    await send(once);
    await send(once);
    expect(await produceJobs()).toHaveLength(1);
    // Without `duplicate`, a refused send is an error: the caller's transaction must not go on.
    await expect(send({ singletonKey: 'transformer:one' })).rejects.toThrow('did not create a job');
  });

  describe('work that was dropped, left over or too slow', () => {
    it('resumes a paused or dropped job when another person joins its group', async () => {
      let quotaSpent = true;
      await build({
        quota: () => ({
          verdict: quotaSpent ? 'unavailable' : 'not_applicable',
          intervalRemainingPercent: null,
          weeklyRemainingPercent: null,
        }),
      });
      const first = await seedPerson(database.db),
        second = await seedPerson(database.db),
        third = await seedPerson(database.db);
      const a = await ask(first, catalogue('machine-learning.transformers'));
      expect(await queuedProduceJobs()).toEqual([
        expect.objectContaining({ recipe: 'transformer-architecture', take: 1 }),
      ]);

      // The worker takes the job and pauses: the quota is spent, nothing is sent, the delivery completes.
      expect(await publish('transformer-architecture')).toMatchObject({ result: { outcome: 'paused' } });
      await sql`update pgboss.job set state='completed' where name=${produceScrollQueue.name}`.execute(database.db);
      expect(await queuedProduceJobs()).toEqual([]);

      // Joining the group sends the job again, so the work resumes instead of leaving the joiner to time out.
      const b = await ask(second, catalogue('machine-learning.transformers'));
      expect((await workOf(b)).decision).toBe('join');
      expect(await queuedProduceJobs()).toEqual([
        expect.objectContaining({ recipe: 'transformer-architecture', take: 1 }),
      ]);
      // A second joiner while that job is queued adds nothing.
      await ask(third, catalogue('machine-learning.transformers'));
      expect(await queuedProduceJobs()).toHaveLength(1);

      quotaSpent = false;
      expect(await publish('transformer-architecture')).toMatchObject({ result: { outcome: 'published' } });
      // The attempt that sent nothing before the pause must not stop the Scroll being attributed to its topic.
      expect(await database.db.selectFrom('content.encounter_topics').select('topic_id').execute()).toEqual([
        { topic_id: 'machine-learning.transformers' },
      ]);
      await resolve(job(first, a));
      await resolve(job(second, b));
      expect(await status(first, a)).toMatchObject({ status: 'ready' });
      expect(await status(second, b)).toMatchObject({ status: 'ready' });

      // A job that was dead-lettered is sent again the same way.
      await sql`delete from pgboss.job where name=${produceScrollQueue.name}`.execute(database.db);
      const fourth = await seedPerson(database.db);
      const c = await ask(fourth, catalogue('earth.tides'));
      await sql`update pgboss.job set state='failed' where name=${produceScrollQueue.name}`.execute(database.db);
      expect(await queuedProduceJobs()).toEqual([]);
      await ask(await seedPerson(database.db), catalogue('earth.tides'));
      expect(await queuedProduceJobs()).toEqual([expect.objectContaining({ recipe: 'tides', take: 1 })]);
      expect((await status(fourth, c)).status).toBe('preparing');
    });

    it('does not send a v2 recipe job again when someone joins a group that named it before the plan marked it v2', async () => {
      await build();
      const first = await seedPerson(database.db),
        second = await seedPerson(database.db);
      const a = await ask(first, catalogue('machine-learning.transformers'));
      const old = await workOf(a);
      expect(old).toMatchObject({ production_recipe: 'transformer-architecture', decision: 'create', active: true });
      await sql`delete from pgboss.job where name=${produceScrollQueue.name}`.execute(database.db);

      // The plan now makes the recipe v2: Create does not own its production (D-138).
      const undo = markScrollV2('transformer-architecture', ORRIN_PLAN);
      try {
        const b = await ask(second, catalogue('machine-learning.transformers'));
        const joined = await workOf(b);
        // The old group is closed, not joined, and the ask starts afresh on a recipe Create may write.
        expect(joined.id).not.toBe(old.id);
        expect(joined).toMatchObject({ production_recipe: 'token-embeddings', decision: 'create' });
        expect(
          await database.db
            .selectFrom('supply.work')
            .select('active')
            .where('id', '=', old.id)
            .executeTakeFirstOrThrow(),
        ).toEqual({ active: false });
        const queued = await queuedProduceJobs();
        expect(queued).toContainEqual(expect.objectContaining({ recipe: 'token-embeddings', take: 1 }));
        expect(queued.map((job) => job.recipe)).not.toContain('transformer-architecture');
        // The first person's wait ends honestly too, rather than waiting on work nobody will send.
        await resolve(job(first, a));
        expect(await status(first, a)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
      } finally {
        undo();
      }
    });

    it('advances open demand that was left from before Create: one recovery job per ask, then it is commissioned', async () => {
      await build();
      const planned = await seedPerson(database.db),
        asked = await seedPerson(database.db);
      const transformersBrief = {
        version: 'supply-brief.v1',
        rights: 'shared_admitted',
        language: 'en',
        format: 'scroll',
        subject: {
          kind: 'catalogue',
          catalogueVersion: 'content-concepts.v1',
          topicId: 'machine-learning.transformers',
        },
      } as const;
      // The state an older release left: a group with no recipe, and asks with no resolver job.
      const legacyGroup = randomUUID();
      await database.db
        .insertInto('supply.work')
        .values({
          id: legacyGroup,
          canonical_key: requestHash('supply-public-canonical.v1', transformersBrief),
          brief: JSON.stringify(transformersBrief),
        })
        .execute();
      const insertRow = async (
        person: FixturePerson,
        state: 'deferred' | 'requested',
        origin: 'planner' | 'person',
      ) => {
        const id = randomUUID();
        await database.db
          .insertInto('supply.requests')
          .values({
            universe_id: person.universeId,
            privacy_epoch: 1,
            id,
            command: JSON.stringify(catalogue('machine-learning.transformers')),
            state,
            origin,
            ...(origin === 'planner' ? { planner_run_id: randomUUID(), planner_slot: 0 } : {}),
            request_revision: 1,
            revision: 0,
            decision: 'join',
            work_id: legacyGroup,
            brief: JSON.stringify(transformersBrief),
            created_at: new Date(),
            updated_at: new Date(),
          })
          .execute();
        return id;
      };
      const plannedId = await insertRow(planned, 'deferred', 'planner');
      const askedId = await insertRow(asked, 'requested', 'person');
      expect(await status(planned, plannedId)).toMatchObject({ status: 'preparing' });

      const dry = await recoverOpenDemand(database.db, content.boss, { dryRun: true });
      expect(dry).toEqual({ open: { deferred: 1, requested: 1 }, queued: 0, alreadyQueued: 0 });
      expect(await resolverJobs(planned)).toEqual([]);
      const first = await recoverOpenDemand(database.db, content.boss, { dryRun: false });
      expect(first).toEqual({ open: { deferred: 1, requested: 1 }, queued: 2, alreadyQueued: 0 });
      // Running it again sends nothing new.
      expect(await recoverOpenDemand(database.db, content.boss, { dryRun: false })).toEqual({
        open: { deferred: 1, requested: 1 },
        queued: 0,
        alreadyQueued: 2,
      });
      expect(await resolverJobs(planned)).toHaveLength(1);

      // The resolver commissions what the old group never did, and the waiters stand on the new one.
      await resolve(job(planned, plannedId));
      await resolve(job(asked, askedId));
      expect(await produceJobs()).toHaveLength(1);
      const workIds = await database.db
        .selectFrom('supply.requests')
        .select(['id', 'work_id'])
        .where('id', 'in', [plannedId, askedId])
        .execute();
      expect(new Set(workIds.map((row) => row.work_id)).size).toBe(1);
      expect(workIds[0]!.work_id).not.toBe(legacyGroup);
      expect(
        await database.db
          .selectFrom('supply.work')
          .select(['active', 'production_recipe', 'commissioned_by'])
          .where('id', '=', workIds[0]!.work_id!)
          .executeTakeFirstOrThrow(),
      ).toEqual({ active: true, production_recipe: 'transformer-architecture', commissioned_by: 'planner' });
      expect((await status(planned, plannedId)).status).toBe('preparing');

      await publish('transformer-architecture');
      await resolve(job(planned, plannedId));
      await resolve(job(asked, askedId));
      expect(await status(planned, plannedId)).toMatchObject({ status: 'ready' });
      expect(await status(asked, askedId)).toMatchObject({ status: 'ready' });
    });

    it('binds planned demand only to content the person has not met, however it looks at plan time', async () => {
      await build();
      const person = await seedPerson(database.db);
      const read = await admit('earth.tides', 'Already read');
      await meet(person, read);
      const outcome = await recordFor(person, plan('earth.tides', { alreadyMet: [read.unit] }));
      if (outcome.kind !== 'deferred') throw new Error(`CI planned demand not deferred: ${outcome.kind}`);
      expect(await produceJobs()).toHaveLength(1);

      // The paid job is still queued and the Scroll they already read serves the topic: it must not stand in.
      await resolve(job(person, outcome.requestId));
      expect(await status(person, outcome.requestId)).toMatchObject({ status: 'preparing' });

      // What is produced is new to them: that binds.
      await publish('tides');
      await resolve(job(person, outcome.requestId));
      expect(await status(person, outcome.requestId)).toMatchObject({
        status: 'ready',
        content: { assetId: TOPICS.tides.assetId },
      });

      // Their own explicit ask for the same topic is not demand for something new, and still gets the read Scroll first.
      const other = await seedPerson(database.db);
      const own = await ask(other, catalogue('earth.tides'));
      expect(await status(other, own)).toMatchObject({ status: 'ready' });
    });

    it('closes an open request past its wait limit when it is read, though no job ever closed it', async () => {
      await build();
      const person = await seedPerson(database.db);
      const requestId = await ask(person, catalogue('machine-learning.transformers'));
      const free = await ask(person, freeText('anything at all'));
      await sql`update supply.requests set created_at = now() - interval '31 minutes', updated_at = now() - interval '31 minutes'`.execute(
        database.db,
      );
      for (const id of [requestId, free]) {
        const closed = await status(person, id);
        expect(closed).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
        expect(await status(person, id)).toEqual(closed);
      }
      const listed = await list(person.authority);
      if (listed.kind !== 'ok') throw new Error('CI list refused');
      expect(listed.value.requests.map((request) => request.status.status)).toEqual(['unavailable', 'unavailable']);
      // A cancel then finds nothing open, and the closed outcome is frozen in the row.
      expect(
        await cancel(person.authority, {
          version: 'content-request-cancel.v1',
          commandId: randomUUID(),
          requestId,
        }),
      ).toMatchObject({ kind: 'ok', value: { outcome: 'already_closed' } });
      expect(
        await database.db.selectFrom('supply.requests').select('state').where('id', '=', requestId).executeTakeFirst(),
      ).toEqual({ state: 'unavailable' });
    });

    it('limits how many asks a person may have open, without writing a receipt for a refused one', async () => {
      await build();
      const person = await seedPerson(database.db);
      const asks = [];
      for (let n = 0; n < 10; n += 1) asks.push(freeText(`question number ${String(n)}`));
      const ids: string[] = [];
      for (const command of asks) ids.push(await ask(person, command));
      const eleventh = freeText('one question too many');
      expect(await create(person.authority, eleventh)).toEqual({ kind: 'refused', reason: 'too_many_open' });
      expect(
        await database.db
          .selectFrom('receipts.personal_commands')
          .select('command_id')
          .where('command_id', '=', eleventh.commandId)
          .execute(),
      ).toEqual([]);
      // A replay of an accepted ask still replays, and closing one makes room for the same command.
      expect(await create(person.authority, asks[0]!)).toMatchObject({ kind: 'ok', value: { replayed: true } });
      await cancel(person.authority, {
        version: 'content-request-cancel.v1',
        commandId: randomUUID(),
        requestId: ids[0]!,
      });
      expect(await create(person.authority, eleventh)).toMatchObject({ kind: 'ok' });
      // The limit is per person, and the Planner's demand is not counted against it.
      expect(await create((await seedPerson(database.db)).authority, freeText('someone else'))).toMatchObject({
        kind: 'ok',
      });
    });

    it('cuts a long title to what the list allows', async () => {
      await build();
      const person = await seedPerson(database.db);
      const longTitled = await admit('earth.tides');
      // Reel titles are allowed to be longer than a Scroll's; the stored title is what the list must cut.
      await sql`alter table content.asset_revisions disable trigger user`.execute(database.db);
      await sql`update content.asset_revisions set title=${'A'.repeat(240)} where asset_id=${longTitled.assetId}::uuid`.execute(
        database.db,
      );
      await ask(person, catalogue('earth.tides'));
      await ask(person, freeText('B'.repeat(300)));
      const listed = await list(person.authority);
      if (listed.kind !== 'ok') throw new Error('CI list refused');
      expect(listed.value.requests.map((request) => request.title.length)).toEqual([160, 160]);
    });
  });

  describe('the Planner and people share Create without starving each other', () => {
    it('counts the Planner demand against its own cap, so a person explicit ask still starts work', async () => {
      await build({ cap: 3, plannerCap: 1 });
      const person = await seedPerson(database.db);
      expect(await recordFor(person, plan('machine-learning.transformers'))).toMatchObject({ kind: 'deferred' });
      // The Planner has used its one production today; a second brief of its own is not commissioned.
      expect(await recordFor(person, plan('earth.tides', { slot: 1 }))).toEqual({ kind: 'not_commissioned' });

      // People's asks have their own count: three still start, then the day's cap closes the fourth.
      const asker = await seedPerson(database.db);
      for (const topic of ['earth.tides', 'space.stars', 'space.black-holes']) {
        const id = await ask(asker, catalogue(topic));
        expect((await workOf(id)).decision).toBe('create');
        expect(await status(asker, id)).toMatchObject({ status: 'preparing' });
      }
      const over = await ask(asker, catalogue('space.exoplanets'));
      expect(await status(asker, over)).toMatchObject({ status: 'unavailable', reason: 'budget_unavailable' });
    });

    it('never lets the Planner start work when Create is off for people', async () => {
      await build({ cap: 0, plannerCap: 5 });
      const person = await seedPerson(database.db);
      expect(await recordFor(person, plan('machine-learning.transformers'))).toEqual({ kind: 'not_commissioned' });
      expect(await produceJobs()).toHaveLength(0);
    });
  });

  it('starts at most the daily cap of productions, lets a joiner in past it, and closes the rest honestly', async () => {
    await build({ cap: 1 });
    const [first, joiner, over] = await Promise.all([
      seedPerson(database.db),
      seedPerson(database.db),
      seedPerson(database.db),
    ]);
    const a = await ask(first, catalogue('machine-learning.transformers'));
    const b = await ask(joiner, catalogue('machine-learning.transformers'));
    const c = await ask(over, catalogue('earth.tides'));
    expect((await workOf(b)).decision).toBe('join');
    expect(await status(over, c)).toMatchObject({ status: 'unavailable', reason: 'budget_unavailable' });
    expect(await produceJobs()).toHaveLength(1);
    expect(await resolverJobs(over)).toHaveLength(0);
    expect(await status(first, a)).toMatchObject({ status: 'preparing' });
  });

  it('turns Create off with a zero cap, and a Reel has no production path at any cap', async () => {
    await build({ cap: 0 });
    const person = await seedPerson(database.db);
    const scroll = await ask(person, catalogue('machine-learning.transformers'));
    expect(await status(person, scroll)).toMatchObject({ status: 'unavailable', reason: 'budget_unavailable' });
    expect(await produceJobs()).toHaveLength(0);
    await content.close();
    await database.drop();
    await build({ cap: 10 });
    const other = await seedPerson(database.db);
    const reel = await ask(other, catalogue('machine-learning.transformers', { format: 'reel' }));
    expect(await status(other, reel)).toMatchObject({ status: 'unavailable', reason: 'budget_unavailable' });
    expect(await produceJobs()).toHaveLength(0);
  });

  it('stops waiting after the wait limit while production is still unfinished', async () => {
    await build();
    const person = await seedPerson(database.db);
    const requestId = await ask(person, catalogue('machine-learning.transformers'));
    await sql`update supply.requests set created_at = now() - interval '31 minutes', updated_at = now() - interval '31 minutes' where id = ${requestId}`.execute(
      database.db,
    );
    await resolve(job(person, requestId));
    expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
    // The shared work carries on: a later request Reuses what it produces.
    expect(await produceJobs()).toHaveLength(1);
  });

  it("commissions the Planner's missing supply the same way and binds it when the Scroll is published", async () => {
    await build();
    const person = await seedPerson(database.db);
    const outcome = await withScope()(person.authority, (scope) =>
      recordPlanned(scope, {
        plannerRunId: randomUUID(),
        slot: 0,
        topicIds: ['machine-learning.transformers'],
        format: 'scroll',
        language: 'en',
        capabilities,
        alreadyMet: [],
      }),
    );
    if (outcome.kind !== 'entered' || outcome.value.kind !== 'deferred') throw new Error('CI planned demand refused');
    const requestId = outcome.value.requestId;
    expect(await produceJobs()).toHaveLength(1);
    expect(await resolverJobs(person)).toHaveLength(1);
    await publish('transformer-architecture');
    await resolve(job(person, requestId));
    expect(
      await database.db.selectFrom('supply.requests').select('state').where('id', '=', requestId).executeTakeFirst(),
    ).toEqual({ state: 'ready' });
    // A planned demand is not something the person asked for: their list shows none of it.
    expect(await list(person.authority)).toMatchObject({ kind: 'ok', value: { requests: [] } });
  });

  it('lists only the person own asks, newest first, with titles that are their words or the catalogue topic', async () => {
    await build();
    const person = await seedPerson(database.db),
      stranger = await seedPerson(database.db);
    await ask(person, catalogue('earth.tides', { facetId: 'earth.tides.forcing' }));
    await ask(person, freeText('How do whales sleep?'));
    await ask(stranger, catalogue('machine-learning.transformers'));
    const listed = await list(person.authority);
    if (listed.kind !== 'ok') throw new Error('CI list refused');
    expect(listed.value.requests.map((request) => request.title)).toEqual(['How do whales sleep?', 'Tides: forcing']);
    expect(listed.value.requests.map((request) => request.status.status)).toEqual(['preparing', 'preparing']);
    expect(listed.value.requests.map((request) => request.format)).toEqual(['scroll', 'scroll']);
    expect(await list(stranger.authority)).toMatchObject({ value: { requests: [{ title: 'Transformers' }] } });
  });

  it('clears the private demand with the person but leaves the shared work and the published Scroll', async () => {
    await build();
    const person = await seedPerson(database.db);
    const requestId = await ask(person, catalogue('machine-learning.transformers'));
    await publish('transformer-architecture');
    await resolve(job(person, requestId));
    expect(await status(person, requestId)).toMatchObject({ status: 'ready' });
    const workBefore = await database.db.selectFrom('supply.work').select('id').execute();
    await withScope()(person.authority, (scope) => eraseUniverse(scope, personalStores));
    expect(
      await database.db
        .selectFrom('supply.requests')
        .select('id')
        .where('universe_id', '=', person.universeId)
        .execute(),
    ).toEqual([]);
    expect(await resolverJobs(person)).toEqual([]);
    expect(await database.db.selectFrom('supply.work').select('id').execute()).toEqual(workBefore);
    expect(
      await database.db
        .selectFrom('content.assets')
        .select('status')
        .where('id', '=', TOPICS['transformer-architecture'].assetId)
        .execute(),
    ).toEqual([{ status: 'admitted' }]);
    expect(await produceJobs()).toHaveLength(1);
  });

  describe('free-text asks', () => {
    it('maps the words to an exact catalogue topic by a model proposal, then waits for production like any ask', async () => {
      await build();
      const person = await seedPerson(database.db);
      matchScript = () => matchAnswer('earth.tides', 'earth.tides.forcing');
      const requestId = await ask(person, freeText('why does the sea go in and out'));
      expect(await status(person, requestId)).toMatchObject({ status: 'preparing', phase: 'requested' });
      expect(matchModel.calls).toHaveLength(0);

      await resolve(job(person, requestId));
      expect(matchModel.calls).toHaveLength(1);
      expect(await status(person, requestId)).toMatchObject({ status: 'preparing', phase: 'preparing' });
      const row = await database.db
        .selectFrom('supply.requests')
        .select(['state', 'decision', 'brief'])
        .where('id', '=', requestId)
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({
        state: 'requested',
        decision: 'create',
        brief: { subject: { topicId: 'earth.tides', facetId: 'earth.tides.forcing' } },
      });
      expect((await workOf(requestId)).production_recipe).toBe('tides');
      expect(await produceJobs()).toHaveLength(1);
      // The model saw the person's words and the catalogue, and nothing of the shared work does.
      expect(matchModel.calls[0]!.request.user).toContain('why does the sea go in and out');
      // The person asked in their own words, so matching counts against the whole allowance.
      expect(await receiptClassesOf(database.db, person.universeId)).toEqual([
        { role_id: 'supply.match-request', background: false },
      ]);
      expect(JSON.stringify(await database.db.selectFrom('supply.work').selectAll().execute())).not.toContain('sea go');
      expect(
        await database.db
          .selectFrom('reasoning.business_runs')
          .select('state')
          .where('id', '=', requestId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: 'completed' });

      // Redelivery of the match does nothing more, and the Scroll is bound when it is published.
      await resolve(job(person, requestId));
      expect(matchModel.calls).toHaveLength(1);
      await publish('tides');
      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({
        status: 'ready',
        content: { assetId: TOPICS.tides.assetId },
      });
    });

    it('serves a free-text ask from admitted content at once, with no production', async () => {
      await build();
      await publish('tides');
      const person = await seedPerson(database.db);
      matchScript = () => matchAnswer('earth.tides');
      const requestId = await ask(person, freeText('tides please'));
      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({ status: 'ready' });
      expect(await produceJobs()).toHaveLength(0);
      expect(await database.db.selectFrom('supply.work').select('id').execute()).toEqual([]);
    });

    it('closes honestly when no catalogue topic is what the words ask about', async () => {
      await build();
      const person = await seedPerson(database.db);
      matchScript = () => matchAnswer(null);
      const requestId = await ask(person, freeText('Live scores tonight'));
      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'unsupported_request' });
      expect(await produceJobs()).toHaveLength(0);
      expect(await database.db.selectFrom('supply.work').select('id').execute()).toEqual([]);
    });

    it('never accepts a topic that is not an exact catalogue member: one repair, then closes', async () => {
      await build();
      const person = await seedPerson(database.db);
      matchScript = () => matchAnswer('earth.volcanoes');
      const requestId = await ask(person, freeText('how do volcanoes erupt'));
      await resolve(job(person, requestId));
      expect(matchModel.calls).toHaveLength(2);
      expect(matchModel.calls[1]!.request.system).toContain('unknown_topic');
      expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
      expect(await produceJobs()).toHaveLength(0);
    });

    it('accepts the repair when it names a member', async () => {
      await build();
      const person = await seedPerson(database.db);
      matchScript = (sequence) => (sequence === 1 ? matchAnswer('earth.tide') : matchAnswer('earth.tides'));
      const requestId = await ask(person, freeText('tides'));
      await resolve(job(person, requestId));
      expect(matchModel.calls).toHaveLength(2);
      expect((await workOf(requestId)).production_recipe).toBe('tides');
    });

    it('closes without a resend when the attempt may have reached the provider, leaving its run open for an operator', async () => {
      await build();
      const person = await seedPerson(database.db);
      matchScript = () => ({ kind: 'gateway_timeout' });
      const requestId = await ask(person, freeText('why is the sky blue'));
      await resolve(job(person, requestId));
      await resolve(job(person, requestId));
      expect(matchModel.calls).toHaveLength(1);
      expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
      expect(
        await database.db
          .selectFrom('reasoning.business_runs')
          .select('state')
          .where('id', '=', requestId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: 'admitted' });
    });

    it('lets a cancel win while the model is thinking', async () => {
      await build();
      const person = await seedPerson(database.db);
      let release!: () => void;
      const hold = new Promise<FixtureScenario>((resolveHold) => {
        release = () => resolveHold(matchAnswer('earth.tides'));
      });
      matchScript = () => ({ kind: 'hold', until: hold });
      const requestId = await ask(person, freeText('tides'));
      const resolving = resolve(job(person, requestId));
      await expect.poll(() => matchModel.calls.length, { timeout: 5000 }).toBe(1);
      await cancel(person.authority, {
        version: 'content-request-cancel.v1',
        commandId: randomUUID(),
        requestId,
      });
      release();
      await resolving;
      expect((await status(person, requestId)).status).toBe('cancelled');
      expect(await produceJobs()).toHaveLength(0);
    });
  });
});
