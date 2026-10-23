import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { FULL_V1_CAPABILITIES } from '@knowscroll/scroll-model';
import type { CreateContentRequest } from '@knowscroll/contracts';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { makeEnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { identityScopeOwnerProviders } from '@knowscroll/backend/modules/identity/nest-providers';
import { contentProviders } from '@knowscroll/backend/modules/content/nest-providers';
import { experienceEvidenceReadProviders } from '@knowscroll/backend/modules/experience/nest-providers';
import { produceScrollJob, produceScrollQueue } from '@knowscroll/backend/modules/content';
import {
  CANCEL_CONTENT_REQUEST,
  CREATE_CONTENT_REQUEST,
  LIST_CONTENT_REQUESTS,
  READ_CONTENT_REQUEST,
  RECORD_PLANNED_DEMAND,
  RESOLVE_CONTENT_REQUEST,
  resolveSupplyQueue,
  type CancelRequest,
  type CreateRequest,
  type ListRequests,
  type ReadRequest,
  type RecordPlannedDemand,
  type ResolveRequest,
} from '@knowscroll/backend/modules/supply';
import { SUPPLY_PORTS, supplyProviders } from '@knowscroll/backend/modules/supply/nest-providers';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import { buildFromProviders } from '../support/providers.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureAuthored } from '../support/generated-scroll.js';
import { fixtureHarness, fixtureModel } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import { fixtureProductionWorker } from '../support/production-worker.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { scrollUseCases } from '../support/scroll.js';

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
  let database: TestDatabase<Database>;
  let content: Awaited<ReturnType<typeof scrollUseCases>>;
  let create: CreateRequest, read: ReadRequest, list: ListRequests, cancel: CancelRequest, resolve: ResolveRequest;
  let recordPlanned: RecordPlannedDemand;
  let production: ReturnType<typeof fixtureProductionWorker>;
  let matchModel: ReturnType<typeof fixtureModel>;
  let matchScript: (sequence: number) => FixtureScenario | Promise<FixtureScenario>;
  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });

  /** Builds the use cases with the given Create cap and production script. */
  async function build(options: { cap?: number; writer?: () => FixtureScenario } = {}) {
    database = await createTestDatabase<Database>('supply_create');
    await sql`update reasoning.production_scopes set enabled=true where id='scroll-supply'`.execute(database.db);
    content = await scrollUseCases(database);
    production = fixtureProductionWorker(database, options.writer ?? writerAnswer);
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
      [CONFIG, { supplyCreateDailyCap: options.cap ?? 10 }],
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
  const publish = (recipe: string, take = 1) =>
    production.run(produceScrollJob(recipe, take), { signal: new AbortController().signal });

  it('commits the demand and the production job together, publishes through the worker, and resolves the waiter', async () => {
    await build();
    const person = await seedPerson(database.db);
    const requestId = await ask(person, catalogue('earth.seasons'));

    expect(await status(person, requestId)).toMatchObject({ status: 'preparing', phase: 'preparing' });
    expect(await workOf(requestId)).toMatchObject({ production_recipe: 'seasons', decision: 'create', active: true });
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

    expect(await publish('seasons')).toMatchObject({ kind: 'finished', result: { outcome: 'published' } });
    await resolve(job(person, requestId));
    expect(await status(person, requestId)).toMatchObject({
      status: 'ready',
      content: { assetId: TOPICS.seasons.assetId },
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
    const command = catalogue('earth.seasons');
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

    await publish('seasons');
    // One waiter withdraws before the Scroll is ready; the others are bound.
    await cancel(third.authority, { version: 'content-request-cancel.v1', commandId: randomUUID(), requestId: c });
    for (const [person, id] of [
      [first, a],
      [second, b],
      [third, c],
    ] as const)
      await resolve(job(person, id));
    expect(await status(first, a)).toMatchObject({ status: 'ready', content: { assetId: TOPICS.seasons.assetId } });
    expect(await status(second, b)).toMatchObject({ status: 'ready', content: { assetId: TOPICS.seasons.assetId } });
    expect((await status(third, c)).status).toBe('cancelled');
  });

  it('sends one job when two different briefs choose the same recipe, and serves both', async () => {
    await build();
    const topicOnly = await seedPerson(database.db),
      facetAsk = await seedPerson(database.db);
    const a = await ask(topicOnly, catalogue('earth.seasons'));
    const b = await ask(facetAsk, catalogue('earth.seasons', { facetId: 'earth.seasons.axial-tilt' }));
    const [workA, workB] = [await workOf(a), await workOf(b)];
    expect(workA.id).not.toBe(workB.id);
    expect([workA.production_recipe, workB.production_recipe]).toEqual(['seasons', 'seasons']);
    expect(await produceJobs()).toHaveLength(1);
    await publish('seasons');
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

  it('starts at most the daily cap of productions, lets a joiner in past it, and closes the rest honestly', async () => {
    await build({ cap: 1 });
    const [first, joiner, over] = await Promise.all([
      seedPerson(database.db),
      seedPerson(database.db),
      seedPerson(database.db),
    ]);
    const a = await ask(first, catalogue('earth.seasons'));
    const b = await ask(joiner, catalogue('earth.seasons'));
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
    const scroll = await ask(person, catalogue('earth.seasons'));
    expect(await status(person, scroll)).toMatchObject({ status: 'unavailable', reason: 'budget_unavailable' });
    expect(await produceJobs()).toHaveLength(0);
    await content.close();
    await database.drop();
    await build({ cap: 10 });
    const other = await seedPerson(database.db);
    const reel = await ask(other, catalogue('earth.seasons', { format: 'reel' }));
    expect(await status(other, reel)).toMatchObject({ status: 'unavailable', reason: 'budget_unavailable' });
    expect(await produceJobs()).toHaveLength(0);
  });

  it('stops waiting after the wait limit while production is still unfinished', async () => {
    await build();
    const person = await seedPerson(database.db);
    const requestId = await ask(person, catalogue('earth.seasons'));
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
        topicIds: ['earth.seasons'],
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
    await publish('seasons');
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
    await ask(stranger, catalogue('earth.seasons'));
    const listed = await list(person.authority);
    if (listed.kind !== 'ok') throw new Error('CI list refused');
    expect(listed.value.requests.map((request) => request.title)).toEqual(['How do whales sleep?', 'Tides: forcing']);
    expect(listed.value.requests.map((request) => request.status.status)).toEqual(['preparing', 'preparing']);
    expect(listed.value.requests.map((request) => request.format)).toEqual(['scroll', 'scroll']);
    expect(await list(stranger.authority)).toMatchObject({ value: { requests: [{ title: 'Seasons' }] } });
  });

  it('clears the private demand with the person but leaves the shared work and the published Scroll', async () => {
    await build();
    const person = await seedPerson(database.db);
    const requestId = await ask(person, catalogue('earth.seasons'));
    await publish('seasons');
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
        .where('id', '=', TOPICS.seasons.assetId)
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
