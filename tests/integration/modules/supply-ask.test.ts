import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CreateContentRequest } from '@knowscroll/contracts';
import { parseDocumentV2 } from '@knowscroll/scroll-model';
import { exportCurrentPerson, personalStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { makeEnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import {
  fencePersonalRecording,
  makeWithPersonalScope,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { FENCE_PERSONAL_RECORDING } from '@knowscroll/backend/modules/identity';
import {
  contentProviders,
  makeReviewGate,
  readScrollAskFacts,
} from '@knowscroll/backend/modules/content/nest-providers';
import { identityScopeOwnerProviders } from '@knowscroll/backend/modules/identity/nest-providers';
import { experienceEvidenceReadProviders } from '@knowscroll/backend/modules/experience/nest-providers';
import { produceScrollJob } from '@knowscroll/backend/modules/content';
import { READ_EXPLORATION_SNAPSHOT } from '@knowscroll/backend/modules/personal-context';
import {
  CANCEL_CONTENT_REQUEST,
  CREATE_CONTENT_REQUEST,
  LIST_CONTENT_REQUESTS,
  READ_CONTENT_REQUEST,
  RETRY_CONTENT_REQUEST,
  RESOLVE_CONTENT_REQUEST,
  type CancelRequest,
  type CreateRequest,
  type ListRequests,
  type ReadRequest,
  type ResolveRequest,
  type RetryRequest,
} from '@knowscroll/backend/modules/supply';
import { SUPPLY_PORTS, supplyProviders } from '@knowscroll/backend/modules/supply/nest-providers';
import {
  fixtureAuthoredV2,
  fixtureResearchPageV2,
} from '../../../packages/backend/src/modules/content/production/spike-v2/writer-v2.fixture.js';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import { madeToOrderKey } from '../../../packages/backend/src/modules/content/domain/order-key.js';
import { makeReadAskOrderAudience } from '../../../packages/backend/src/modules/supply/adapters/postgres-ask-orders.js';
import { makeCheckAssetAudience } from '../../../packages/backend/src/modules/content/adapters/made-to-order.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { signal, fixtureHarness, fixtureModel } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import { answerWith, enableProductionScope, fixtureAuthored, fixtureProduction } from '../support/generated-scroll.js';
import { fixtureProductionWorker } from '../support/production-worker.js';
import { openActive } from '../support/observations.js';
import { buildFromProviders } from '../support/providers.js';
import { clearRecordingPerson, recordingPerson } from '../support/recording-person.js';
import { scrollUseCases } from '../support/scroll.js';
import { seedScroll } from '../support/thread-fixtures.js';
import { markScrollV1, v2Capabilities } from '../support/scroll-v2.js';
import type { FixturePerson } from '../support/fixtures.js';

/**
 * Ask from here (D1) and its ask orders (D-218) against a real PostgreSQL 16 database. The source Scroll is the labelled
 * Orrin fixture published as the v2 `seasons` recipe, and the writer and the scope step are labelled CI fixture models:
 * this proves what the code does with a model's answer, never what a model says. No provider network.
 */
const ASK_CAPABILITIES = v2Capabilities;

const scopeAnswer = (
  scope: 'here' | 'catalogue' | 'none',
  topicId: string | null = null,
  facetId: string | null = null,
): FixtureScenario => ({ kind: 'success', text: JSON.stringify({ scope, topicId, facetId }) });

describe('Ask orders (real PostgreSQL, CI fixture models)', () => {
  let database: TestDatabase<Database>;
  let content: Awaited<ReturnType<typeof scrollUseCases>>;
  let create: CreateRequest;
  let read: ReadRequest;
  let list: ListRequests;
  let cancel: CancelRequest;
  let retry: RetryRequest;
  let resolve: ResolveRequest;
  let production: ReturnType<typeof fixtureProductionWorker>;
  let writer: () => FixtureScenario;
  let scopeScript: () => FixtureScenario;
  let scopeModel: ReturnType<typeof fixtureModel>;
  let scroll: { readonly assetId: string; readonly revision: number };
  let stopId: string;
  let suggestions: readonly string[];
  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });

  /** Composes the use cases with the given daily caps, the way the worker's providers do. */
  function build(caps: { perDay: number; perPerson: number } = { perDay: 20, perPerson: 5 }) {
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
      [SCOPE, withScope()],
      [ENQUEUE, makeEnqueueJob(content.boss)],
      [
        CONFIG,
        {
          supplyCreateDailyCap: 10,
          supplyPlannerCreateDailyCap: 10,
          supplyAskDailyCap: caps.perDay,
          supplyAskPersonDailyCap: caps.perPerson,
        },
      ],
      [FENCE_PERSONAL_RECORDING, fencePersonalRecording],
      [READ_EXPLORATION_SNAPSHOT, content.readExploration],
      [HARNESS, fixtureHarness(database.db, { model: scopeModel }).harness],
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
  }

  beforeAll(async () => {
    database = await createTestDatabase<Database>('supply_ask');
    await enableProductionScope(database.db);
    // The source: the labelled Orrin fixture as the released v2 revision of the `seasons` recipe, as production makes it.
    const published = fixtureProduction(
      database.db,
      () => answerWith(fixtureAuthoredV2()),
      () => fixtureResearchPageV2,
    );
    expect(await published.produce('seasons', false, signal())).toMatchObject({ outcome: 'published', held: true });
    scroll = { assetId: TOPICS.seasons.assetId, revision: 1 };
    expect(await makeReviewGate(database.db).release({ ...scroll, decidedBy: 'cli:ci-reviewer' })).toMatchObject({
      kind: 'released',
    });
    const row = await database.db
      .selectFrom('content.asset_revisions')
      .select('document')
      .where('asset_id', '=', scroll.assetId)
      .where('revision', '=', 1)
      .executeTakeFirstOrThrow();
    const parsed = parseDocumentV2(row.document);
    if (parsed.kind !== 'valid') throw new Error('the CI fixture must parse');
    stopId = parsed.document.stops[0]!.id;
    suggestions = parsed.document.askSuggestions;
    content = await scrollUseCases(database, {
      recording: true,
      orderAudience: makeReadAskOrderAudience(database.db),
    });
  });
  afterAll(async () => {
    await content.close();
    await database.drop();
  });
  afterEach(() => {
    writer = () => answerWith(fixtureAuthored('plain'));
    scopeScript = () => scopeAnswer('here');
  });

  async function setup(caps?: Parameters<typeof build>[0]) {
    // Each test starts with no queued production, no ledger and no earlier asks: the caps count a day's rows.
    await sql`delete from pgboss.job where name = 'content.produce-scroll'`.execute(database.db);
    await sql`delete from supply.requests`.execute(database.db);
    await sql`delete from supply.ask_orders`.execute(database.db);
    writer = () => answerWith(fixtureAuthored('plain'));
    scopeScript = () => scopeAnswer('here');
    scopeModel = fixtureModel(() => scopeScript(), { label: 'supply-ask-scope-CI-fixture' });
    production = fixtureProductionWorker(database, () => writer());
    build(caps);
  }

  /** A person who has opened and is reading the source Scroll, so they may ask from it. */
  async function reader() {
    const person = await recordingPerson(database);
    const exposure = await openActive(content, person, scroll);
    return { person, exposure };
  }
  const askCommand = (
    exposure: Awaited<ReturnType<typeof reader>>['exposure'],
    question: string,
    over: { stop?: string; recordingGeneration?: number } = {},
  ): CreateContentRequest => ({
    version: 'content-request.v1',
    commandId: randomUUID(),
    intent: {
      kind: 'ask',
      source: { exposureId: exposure.exposureId, assetId: exposure.assetId, assetRevision: exposure.assetRevision },
      anchor: { kind: 'stop', stopId: over.stop ?? stopId },
      question,
      recordingGeneration: over.recordingGeneration ?? 1,
    },
    language: 'en',
    capabilities: ASK_CAPABILITIES,
  });
  async function ask(person: FixturePerson, command: CreateContentRequest) {
    const result = await create(person.authority, command);
    if (result.kind !== 'ok') throw new Error(`CI ask refused: ${result.reason}`);
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
  const requestRow = (requestId: string) =>
    database.db.selectFrom('supply.requests').selectAll().where('id', '=', requestId).executeTakeFirstOrThrow();
  const orderOf = async (requestId: string) => {
    const row = await requestRow(requestId);
    if (row.ask_order_id === null || row.ask_asset_id === null) throw new Error('CI: the request made no ask order');
    return { orderId: row.ask_order_id, assetId: row.ask_asset_id, recipe: madeToOrderKey(row.ask_order_id) };
  };
  const queuedProduction = async () =>
    (
      await sql<{ data: { recipe: string; take: number } }>`select data from pgboss.job
        where name = 'content.produce-scroll' and state = 'created' order by created_on`.execute(database.db)
    ).rows.map((row) => row.data);
  const count = async (
    table: 'experience.exposures' | 'evidence.observations' | 'evidence.action_events',
    universe: string,
  ) =>
    Number(
      (
        await sql<{
          n: string;
        }>`select count(*) as n from ${sql.table(table)} where universe_id = ${universe}::uuid`.execute(database.db)
      ).rows[0]!.n,
    );
  const publish = (recipe: string, take = 1) =>
    production.run(produceScrollJob(recipe, take), { signal: new AbortController().signal });

  describe('a question the Scroll itself suggests', () => {
    it('makes an ask order at once, with no model call, and says nothing of it to anyone', async () => {
      await setup();
      const { person, exposure } = await reader();
      const before = {
        exposures: await count('experience.exposures', person.universeId),
        observations: await count('evidence.observations', person.universeId),
        actions: await count('evidence.action_events', person.universeId),
      };

      const requestId = await ask(person, askCommand(exposure, suggestions[0]!));

      // The request is preparing and names real work: one order, one ledger row, one production job.
      expect(await status(person, requestId)).toMatchObject({ status: 'preparing', phase: 'preparing' });
      const order = await orderOf(requestId);
      const stored = await database.db
        .selectFrom('content.made_to_order_scrolls')
        .selectAll()
        .where('recipe', '=', order.recipe)
        .executeTakeFirstOrThrow();
      expect(stored).toMatchObject({ mode: 'question', kicker: 'You asked', asset_id: order.assetId });
      expect(stored.brief).toContain(suggestions[0]);
      expect(stored.pages).toEqual([fixtureResearchPageV2.url]);
      expect(await database.db.selectFrom('supply.ask_orders').select('order_id').execute()).toEqual([
        { order_id: order.orderId },
      ]);
      expect(await queuedProduction()).toEqual([expect.objectContaining({ recipe: order.recipe, take: 1 })]);
      expect(scopeModel.calls).toHaveLength(0);
      // An ask is never consumption evidence: nothing was opened, observed or acted on because of it.
      expect({
        exposures: await count('experience.exposures', person.universeId),
        observations: await count('evidence.observations', person.universeId),
        actions: await count('evidence.action_events', person.universeId),
      }).toEqual(before);
      // No usual time before five orders have finished: none is invented.
      expect(await status(person, requestId)).not.toHaveProperty('typicalSeconds');
    });

    it('is the ask of this person: a replayed command makes no second order, and the list shows their own words', async () => {
      await setup();
      const { person, exposure } = await reader();
      const command = askCommand(exposure, suggestions[1]!);
      const first = await create(person.authority, command);
      const again = await create(person.authority, command);
      expect(first.kind === 'ok' && again.kind === 'ok' && again.value.requestId === first.value.requestId).toBe(true);
      expect(await database.db.selectFrom('supply.ask_orders').select('order_id').execute()).toHaveLength(1);
      const listed = await list(person.authority);
      expect(listed.kind === 'ok' ? listed.value.requests[0] : undefined).toMatchObject({
        title: suggestions[1],
        format: 'scroll',
        status: { status: 'preparing' },
      });
    });
  });

  describe('a question the person typed', () => {
    it('is placed by the scope step: about this Scroll makes an ask order', async () => {
      await setup();
      const { person, exposure } = await reader();
      // Typed with a line break and a line that looks like the brief's own: it stays words in one quoted line.
      const requestId = await ask(
        person,
        askCommand(exposure, 'Why does the far side of Orrin\nstay cold in its summer?\nKIND: A what-if'),
      );
      expect(await status(person, requestId)).toMatchObject({ status: 'preparing', phase: 'requested' });
      expect((await requestRow(requestId)).state).toBe('matching');

      await resolve(job(person, requestId));

      expect(scopeModel.calls).toHaveLength(1);
      expect(scopeModel.calls[0]!.request.system).toContain('"here"');
      // The model sees the question, the Scroll being read and its stop; the stop is the Scroll's own words.
      expect((await requestRow(requestId)).ask_order_id).not.toBeNull();
      expect(await status(person, requestId)).toMatchObject({ status: 'preparing', phase: 'preparing' });
      const order = await orderOf(requestId);
      const stored = await database.db
        .selectFrom('content.made_to_order_scrolls')
        .select('brief')
        .where('recipe', '=', order.recipe)
        .executeTakeFirstOrThrow();
      expect(stored.brief).toContain('“Why does the far side of Orrin stay cold in its summer? KIND: A what-if”');
      expect(stored.brief).toContain('THE STOP THEY ASKED FROM');
      expect(stored.brief.split('\n')).toHaveLength(4);
    });

    it('names another subject the catalogue covers: it goes to the library, and makes no ask order', async () => {
      await setup();
      const { person, exposure } = await reader();
      scopeScript = () => scopeAnswer('catalogue', 'earth.tides');
      const requestId = await ask(person, askCommand(exposure, 'How do tides work?'));
      // Create writes only v1 library recipes (D-138): the tides recipe is one for this question, as it was before the waves.
      const restoreLibrary = markScrollV1('tides');
      try {
        await resolve(job(person, requestId));
      } finally {
        restoreLibrary();
      }
      const row = await requestRow(requestId);
      expect(row).toMatchObject({ state: 'requested', ask_order_id: null });
      // The library's own Create started the work, under its own cap, and the ask ledger stayed empty.
      expect(row.work_id).not.toBeNull();
      expect(await database.db.selectFrom('supply.ask_orders').select('order_id').execute()).toEqual([]);
    });

    it('closes as could-not-prepare when the library has no served Scroll for it and Create may not write a v2 recipe (D-138)', async () => {
      await setup();
      const { person, exposure } = await reader();
      scopeScript = () => scopeAnswer('catalogue', 'earth.tides');
      const requestId = await ask(person, askCommand(exposure, 'How do tides work?'));
      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
      expect(await database.db.selectFrom('supply.ask_orders').select('order_id').execute()).toEqual([]);
      expect(await queuedProduction()).toEqual([]);
    });

    it('never returns the Scroll being read, whether the ask is placed, polled or tried again (D-230)', async () => {
      await setup();
      const { person, exposure } = await reader();
      // The Scroll being read is filed under the topic the question names, so it fits that meaning exactly.
      const filedUnder = async (topicId: string) =>
        database.db
          .updateTable('content.encounter_topics')
          .set({ topic_id: topicId })
          .where('asset_id', '=', scroll.assetId)
          .where('asset_revision', '=', scroll.revision)
          .where('role', '=', 'primary')
          .execute();
      await filedUnder('earth.tides');
      scopeScript = () => scopeAnswer('catalogue', 'earth.tides');
      const requestId = await ask(person, askCommand(exposure, 'How do tides work?'));
      const restoreLibrary = markScrollV1('tides');
      try {
        // Placing it: Create starts the library's work instead of binding to the Scroll in front of the person.
        await resolve(job(person, requestId));
        expect((await requestRow(requestId)).state).toBe('requested');
        // Polling it: the same rule holds on every look.
        await resolve(job(person, requestId));
        expect(await status(person, requestId)).toMatchObject({ status: 'preparing' });
        expect((await requestRow(requestId)).content).toBeNull();
        // Trying it again after it closed: the same rule holds there too.
        await sql`update supply.requests set state = 'unavailable', reason = 'could_not_prepare' where id = ${requestId}::uuid`.execute(
          database.db,
        );
        await retry(person.authority, { version: 'content-request-retry.v1', commandId: randomUUID(), requestId });
        expect(await status(person, requestId)).not.toMatchObject({ status: 'ready' });
        expect((await requestRow(requestId)).content).toBeNull();
      } finally {
        restoreLibrary();
        await filedUnder('earth.seasons');
      }
    });

    it('is closed honestly when it is about nothing the Scroll or the catalogue covers', async () => {
      await setup();
      const { person, exposure } = await reader();
      scopeScript = () => scopeAnswer('none');
      const requestId = await ask(person, askCommand(exposure, 'Who won the match last night?'));
      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'unsupported_request' });
      expect(await queuedProduction()).toEqual([]);
    });

    it('is refused, not guessed, when the model names a topic the catalogue lacks', async () => {
      await setup();
      const { person, exposure } = await reader();
      scopeScript = () => scopeAnswer('catalogue', 'not.a.topic');
      const requestId = await ask(person, askCommand(exposure, 'Tell me about something else'));
      await resolve(job(person, requestId));
      // The schema refuses an invented id; the one repair gets the same answer; the ask closes and orders nothing.
      expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
      expect(await database.db.selectFrom('supply.ask_orders').select('order_id').execute()).toEqual([]);
    });

    it('never resends an attempt of unknown outcome: it closes as could-not-prepare', async () => {
      await setup();
      const { person, exposure } = await reader();
      scopeScript = () => ({ kind: 'timeout_after_dispatch' });
      const requestId = await ask(person, askCommand(exposure, 'Why is it colder at the far end?'));
      await resolve(job(person, requestId));
      await resolve(job(person, requestId));
      expect(scopeModel.calls).toHaveLength(1);
      expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
    });
  });

  describe('from request to a Scroll that only the asker can open', () => {
    it('binds the produced Scroll, notes how long it took, and opens it for the asker alone', async () => {
      await setup();
      const { person, exposure } = await reader();
      const stranger = await recordingPerson(database);
      const requestId = await ask(person, askCommand(exposure, suggestions[0]!));
      const order = await orderOf(requestId);

      // Production has not started: the waiter looks again later and decides nothing.
      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({ status: 'preparing' });

      expect(await publish(order.recipe)).toMatchObject({ kind: 'finished', result: { outcome: 'published' } });
      await resolve(job(person, requestId));
      const ready = await status(person, requestId);
      expect(ready).toMatchObject({ status: 'ready', content: { assetId: order.assetId } });
      expect(ready.status === 'ready' ? ready.content.metadata.title : '').not.toBe('');
      // Only the writer ran for the order: the question's scope was never asked for a suggested question.
      expect(production.fixture.calls).toHaveLength(1);
      expect(scopeModel.calls).toHaveLength(0);
      expect(
        (await database.db.selectFrom('supply.ask_orders').select('ready_at').executeTakeFirstOrThrow()).ready_at,
      ).not.toBeNull();

      // The Scroll is attributed to no topic and has no coverage: it adds no planet and no progress.
      const topics = await database.db
        .selectFrom('content.encounter_topics')
        .select('topic_id')
        .where('asset_id', '=', order.assetId)
        .execute();
      expect(topics).toEqual([]);

      const audience = makeCheckAssetAudience(database.db, [makeReadAskOrderAudience(database.db)]);
      const mayOpen = async (who: FixturePerson) =>
        (await audience({ pool: true }, who.authority, [order.assetId])).has(order.assetId);
      expect(await mayOpen(person)).toBe(true);
      // Not another person, not a system actor holding the asker's universe.
      expect(await mayOpen(stranger)).toBe(false);
      const system = { ...person.authority, actor: { kind: 'system', purpose: 'ci' } } as typeof person.authority;
      expect((await audience({ pool: true }, system, [order.assetId])).has(order.assetId)).toBe(false);
    });

    it('says how long orders usually take only from five finished ones, and then from the measured median', async () => {
      await setup();
      const { person, exposure } = await reader();
      const waiting = await ask(person, askCommand(exposure, suggestions[0]!));
      // Four finished orders are too few.
      await sql`insert into supply.ask_orders(order_id, created_at, ready_at)
        select gen_random_uuid(), now() - interval '1 hour', now() - interval '1 hour' + make_interval(secs => s)
        from unnest(array[100, 110, 120, 130]) as s`.execute(database.db);
      expect(await status(person, waiting)).not.toHaveProperty('typicalSeconds');
      await sql`insert into supply.ask_orders(order_id, created_at, ready_at)
        values (gen_random_uuid(), now() - interval '1 hour', now() - interval '1 hour' + interval '600 seconds')`.execute(
        database.db,
      );
      // The median of 100, 110, 120, 130 and 600 is 120: one slow order does not move it.
      expect(await status(person, waiting)).toMatchObject({ status: 'preparing', typicalSeconds: 120 });
      // A question still being placed is not an order yet, and says no time, however many orders have finished.
      const placing = await ask(person, askCommand(exposure, 'Why does the far side of Orrin stay cold?'));
      expect(await status(person, placing)).toMatchObject({ status: 'preparing', phase: 'requested' });
      expect(await status(person, placing)).not.toHaveProperty('typicalSeconds');
      await sql`delete from supply.ask_orders where ready_at is not null and order_id not in (select ask_order_id from supply.requests where ask_order_id is not null)`.execute(
        database.db,
      );
    });
  });

  describe('when the order cannot be made or fails', () => {
    it('answers an honest unavailable when the world cap is full, and again for a person over theirs', async () => {
      await setup({ perDay: 1, perPerson: 5 });
      const first = await reader();
      const second = await reader();
      await ask(first.person, askCommand(first.exposure, suggestions[0]!));
      const capped = await ask(second.person, askCommand(second.exposure, suggestions[0]!));
      expect(await status(second.person, capped)).toMatchObject({
        status: 'unavailable',
        reason: 'budget_unavailable',
      });
      expect((await requestRow(capped)).ask_order_id).toBeNull();

      await setup({ perDay: 50, perPerson: 1 });
      const asker = await reader();
      await ask(asker.person, askCommand(asker.exposure, suggestions[0]!));
      const over = await ask(asker.person, askCommand(asker.exposure, suggestions[1]!));
      expect(await status(asker.person, over)).toMatchObject({ status: 'unavailable', reason: 'budget_unavailable' });
      // Another person is not held back by theirs.
      const other = await reader();
      const fine = await ask(other.person, askCommand(other.exposure, suggestions[0]!));
      expect(await status(other.person, fine)).toMatchObject({ status: 'preparing' });
    });

    it('turns ask orders off with a cap of zero', async () => {
      await setup({ perDay: 0, perPerson: 5 });
      const { person, exposure } = await reader();
      const requestId = await ask(person, askCommand(exposure, suggestions[0]!));
      expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'budget_unavailable' });
      expect(await queuedProduction()).toEqual([]);
    });

    it('closes as could-not-prepare when the writer is refused, and Try again sends the next take for the same request', async () => {
      await setup();
      const { person, exposure } = await reader();
      writer = () => answerWith({ title: 'not a Scroll' });
      const requestId = await ask(person, askCommand(exposure, suggestions[0]!));
      const order = await orderOf(requestId);

      expect(await publish(order.recipe)).toMatchObject({ result: { outcome: 'rejected' } });
      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
      // Nothing is sent on its own after a refusal: the person decides.
      expect((await queuedProduction()).filter((queued) => queued.take === 2)).toEqual([]);

      writer = () => answerWith(fixtureAuthored('plain'));
      const tried = await retry(person.authority, {
        version: 'content-request-retry.v1',
        commandId: randomUUID(),
        requestId,
      });
      expect(tried).toMatchObject({ kind: 'ok', value: { outcome: 'retrying' } });
      // The same request, the same order, a second take.
      expect((await requestRow(requestId)).ask_order_id).toBe(order.orderId);
      expect(await queuedProduction()).toContainEqual(expect.objectContaining({ recipe: order.recipe, take: 2 }));
      expect(await status(person, requestId)).toMatchObject({ status: 'preparing' });

      expect(await publish(order.recipe, 2)).toMatchObject({ result: { outcome: 'published' } });
      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({ status: 'ready', content: { assetId: order.assetId } });
      // One order was made, however many takes it needed.
      expect(await database.db.selectFrom('supply.ask_orders').select('order_id').execute()).toHaveLength(1);
    });

    it('is ready again at once when its Scroll was admitted while the request read as closed', async () => {
      await setup();
      const { person, exposure } = await reader();
      const requestId = await ask(person, askCommand(exposure, suggestions[0]!));
      const order = await orderOf(requestId);
      // The Scroll is made, but the waiter never looked (a lost poll): the request closed on its wait limit.
      await publish(order.recipe);
      await sql`update supply.requests set state = 'unavailable', reason = 'could_not_prepare' where id = ${requestId}::uuid`.execute(
        database.db,
      );
      const tried = await retry(person.authority, {
        version: 'content-request-retry.v1',
        commandId: randomUUID(),
        requestId,
      });
      expect(tried).toMatchObject({ kind: 'ok', value: { outcome: 'retrying' } });
      expect(await status(person, requestId)).toMatchObject({ status: 'ready', content: { assetId: order.assetId } });
      // Nothing was produced again: the one take that was made is the one that is served.
      expect((await queuedProduction()).filter((queued) => queued.take > 1)).toEqual([]);
    });

    it('cannot be tried again once its takes are used, and a ready request is already open', async () => {
      await setup();
      const { person, exposure } = await reader();
      writer = () => answerWith({ title: 'not a Scroll' });
      const requestId = await ask(person, askCommand(exposure, suggestions[0]!));
      const order = await orderOf(requestId);
      const tryAgain = () =>
        retry(person.authority, { version: 'content-request-retry.v1', commandId: randomUUID(), requestId });
      await publish(order.recipe, 1);
      await resolve(job(person, requestId));
      expect(await tryAgain()).toMatchObject({ value: { outcome: 'retrying' } });
      await publish(order.recipe, 2);
      await resolve(job(person, requestId));
      expect(await tryAgain()).toMatchObject({ value: { outcome: 'retrying' } });
      await publish(order.recipe, 3);
      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
      // Three takes are all an order gets: the fourth never starts.
      expect(await tryAgain()).toMatchObject({ value: { outcome: 'not_retryable' } });
    });

    it('lets a cancel stand: the Scroll made later is open to nobody', async () => {
      await setup();
      const { person, exposure } = await reader();
      const requestId = await ask(person, askCommand(exposure, suggestions[0]!));
      const order = await orderOf(requestId);
      const cancelled = await cancel(person.authority, {
        version: 'content-request-cancel.v1',
        commandId: randomUUID(),
        requestId,
      });
      expect(cancelled).toMatchObject({ kind: 'ok', value: { outcome: 'cancelled' } });
      await publish(order.recipe);
      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({ status: 'cancelled' });
      const audience = makeCheckAssetAudience(database.db, [makeReadAskOrderAudience(database.db)]);
      expect((await audience({ pool: true }, person.authority, [order.assetId])).has(order.assetId)).toBe(false);
    });
  });

  describe('what a request must refuse', () => {
    it('refuses an ask while recording is paused, and one whose recording generation is out of date', async () => {
      await setup();
      const { person, exposure } = await reader();
      const stale = await create(person.authority, askCommand(exposure, suggestions[0]!, { recordingGeneration: 7 }));
      expect(stale).toEqual({ kind: 'refused', reason: 'recording_stale' });
      await sql`update identity.universes set recording_on = false, recording_generation = 2 where id = ${person.universeId}::uuid`.execute(
        database.db,
      );
      // Paused: the same ask, with the generation the client would now read, is refused too (D-083).
      expect(await create(person.authority, askCommand(exposure, suggestions[0]!, { recordingGeneration: 2 }))).toEqual(
        {
          kind: 'refused',
          reason: 'recording_paused',
        },
      );
      expect(
        await database.db
          .selectFrom('supply.requests')
          .select('id')
          .where('universe_id', '=', person.universeId)
          .execute(),
      ).toEqual([]);
      expect(await queuedProduction()).toEqual([]);
    });

    it('refuses a stop that is not in the Scroll, a source the person has not opened and a Scroll that is not a v2 Scroll', async () => {
      await setup();
      const { person, exposure } = await reader();
      expect(await create(person.authority, askCommand(exposure, suggestions[0]!, { stop: 'no-such-stop' }))).toEqual({
        kind: 'refused',
        reason: 'source_unavailable',
      });
      const stranger = await recordingPerson(database);
      expect(await create(stranger.authority, askCommand(exposure, suggestions[0]!))).toMatchObject({
        kind: 'refused',
      });
      expect(await database.db.selectFrom('supply.ask_orders').select('order_id').execute()).toEqual([]);
    });

    /** What the ask reads of one stop of one exact revision, as the person asking would. */
    const factsOf = async (ref: { assetId: string; assetRevision: number }, stop: string) => {
      const read = await withScope()((await recordingPerson(database)).authority, (tx) =>
        readScrollAskFacts(tx, ref, stop),
      );
      if (read.kind !== 'entered') throw new Error('CI scope refused');
      return read.value;
    };

    it('reads a stop of the exact revision, and nothing for a stop that is not in it or a revision that does not exist', async () => {
      await setup();
      const facts = await factsOf({ assetId: scroll.assetId, assetRevision: 1 }, stopId);
      expect(facts?.suggestions).toEqual(suggestions);
      expect(facts?.stopText).not.toBe('');
      expect(await factsOf({ assetId: scroll.assetId, assetRevision: 1 }, 'no-such-stop')).toBeUndefined();
      expect(await factsOf({ assetId: scroll.assetId, assetRevision: 2 }, stopId)).toBeUndefined();
    });

    it('reads nothing of a v1 Scroll, which has no stops and suggests nothing', async () => {
      await setup();
      const v1 = await seedScroll(database.db, 'attention-slowly');
      // The Scroll is real and admitted, so only its schema keeps it out of the ask.
      expect(await factsOf({ assetId: v1.assetId, assetRevision: 1 }, 'any-stop')).toBeUndefined();
    });

    it('reads nothing of a revision the review gate holds, so a question cannot be asked from it', async () => {
      await setup();
      // The operator's next take of the source is stored held (D-138): it is a v2 Scroll with the same stops.
      const next = fixtureProduction(
        database.db,
        () => answerWith(fixtureAuthoredV2()),
        () => fixtureResearchPageV2,
      );
      expect(await next.produce('seasons', false, signal(), false, 2)).toMatchObject({
        outcome: 'published',
        held: true,
        revision: 2,
      });
      expect(await factsOf({ assetId: scroll.assetId, assetRevision: 2 }, stopId)).toBeUndefined();
    });
  });

  describe('what the person typed is theirs', () => {
    it('is exported to them, and erased with Clear and with the person: the order keeps no words and opens for nobody', async () => {
      await setup();
      const { person, exposure } = await reader();
      scopeScript = () => scopeAnswer('here');
      const question = 'Why does the far side of Orrin stay cold in its summer?';
      const requestId = await ask(person, askCommand(exposure, question));
      await resolve(job(person, requestId));
      const order = await orderOf(requestId);
      await publish(order.recipe);
      await resolve(job(person, requestId));

      const exported = await withScope()(person.authority, (tx) =>
        exportCurrentPerson(tx, { accountId: person.accountId }, () => Promise.resolve(new Set<string>())),
      );
      expect(JSON.stringify(exported)).toContain(question);

      const erased = await withScope()(person.authority, (tx) => eraseUniverse(tx, personalStores));
      expect(erased.kind).toBe('entered');
      expect(
        await database.db
          .selectFrom('supply.requests')
          .select('id')
          .where('universe_id', '=', person.universeId)
          .execute(),
      ).toEqual([]);
      const stored = await database.db
        .selectFrom('content.made_to_order_scrolls')
        .select('brief')
        .where('recipe', '=', order.recipe)
        .executeTakeFirstOrThrow();
      expect(stored.brief).toBe('');
      const audience = makeCheckAssetAudience(database.db, [makeReadAskOrderAudience(database.db)]);
      expect((await audience({ pool: true }, person.authority, [order.assetId])).has(order.assetId)).toBe(false);
      // The ledger names no one and keeps counting.
      expect(await database.db.selectFrom('supply.ask_orders').select('order_id').execute()).toHaveLength(1);
      // Nothing is written for words that were erased: a take that comes later finds no order to write.
      expect(await publish(order.recipe, 2)).toMatchObject({ kind: 'skipped' });
    });

    it('is erased by Clear exploration too', async () => {
      await setup();
      const { person, exposure } = await reader();
      const requestId = await ask(person, askCommand(exposure, suggestions[0]!));
      const order = await orderOf(requestId);
      await clearRecordingPerson(database, content.boss, person);
      expect(
        await database.db.selectFrom('supply.requests').select('id').where('id', '=', requestId).execute(),
      ).toEqual([]);
      const stored = await database.db
        .selectFrom('content.made_to_order_scrolls')
        .select('brief')
        .where('recipe', '=', order.recipe)
        .executeTakeFirstOrThrow();
      expect(stored.brief).toBe('');
    });
  });
});
