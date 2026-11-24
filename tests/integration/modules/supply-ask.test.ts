import { catalogueOf } from '../support/catalogue.js';
import { CATALOGUE } from '@knowscroll/backend/modules/content';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CreateContentRequest } from '@knowscroll/contracts';
import { parseDocumentV2 } from '@knowscroll/scroll-model';
import { exportCurrentPerson, personalStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { stableUuid } from '@knowscroll/backend/infrastructure/ids';
import { makeEnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import {
  fencePersonalRecording,
  makeWithPersonalScope,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { FENCE_PERSONAL_RECORDING } from '@knowscroll/backend/modules/identity';
import {
  appendRelease,
  contentProviders,
  makeReadLibraryPassages,
  makeReviewGate,
  readScrollAskFacts,
} from '@knowscroll/backend/modules/content/nest-providers';
import { identityScopeOwnerProviders, recordingPolicyFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { experienceEvidenceReadProviders } from '@knowscroll/backend/modules/experience/nest-providers';
import { READ_LIBRARY_PASSAGES, produceScrollJob } from '@knowscroll/backend/modules/content';
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
import { fixtureResearchPageV2 } from '../../../packages/backend/src/modules/content/production/orrin.fixture.js';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import { madeToOrderKey } from '../../../packages/backend/src/modules/content/domain/order-key.js';
import { makeReadAskOrderAudience } from '../../../packages/backend/src/modules/supply/adapters/postgres-ask-orders.js';
import { makeCheckAssetAudience } from '../../../packages/backend/src/modules/content/adapters/made-to-order.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureModel } from '../support/fixture-model.js';
import { recordingEntries } from '../support/recording-harness.js';
import type { FixtureCall, FixtureScenario } from '../support/fixture-model-port.js';
import { enableProductionScope } from '../support/generated-scroll.js';
import { fixtureProductionWorker } from '../support/production-worker.js';
import { openActive } from '../support/observations.js';
import { buildFromProviders } from '../support/providers.js';
import { clearRecordingPerson, recordingPerson } from '../support/recording-person.js';
import { scrollUseCases } from '../support/scroll.js';
import { seedScroll } from '../support/thread-fixtures.js';
import { v2Capabilities } from '../support/scroll-v2.js';
import { storeOrderScroll } from '../support/stored-order.js';
import { storeV1 } from '../support/stored-v1.js';
import { storeV2 } from '../support/stored-v2.js';
import type { FixturePerson } from '../support/fixtures.js';

/**
 * Ask from here (D1) and its ask orders (D-218) against a real PostgreSQL 16 database. The source Scroll is the labelled
 * Orrin fixture published as the v2 `seasons` recipe, and the scope step is a labelled CI fixture model (no writer is left for an order, #818):
 * this proves what the code does with a model's answer, never what a model says. No provider network.
 */
const ASK_CAPABILITIES = v2Capabilities;

const scopeAnswer = (
  scope: 'here' | 'catalogue' | 'none',
  topicId: string | null = null,
  facetId: string | null = null,
): FixtureScenario => ({ kind: 'success', text: JSON.stringify({ scope, topicId, facetId }) });

/** The library check's answer: a Scroll by handle with words of it, or neither. */
const libraryReply = (scroll: string | null, quote: string | null): FixtureScenario => ({
  kind: 'success',
  text: JSON.stringify({ scroll, quote }),
});
const isLibraryCall = (call: FixtureCall): boolean => call.request.system.includes('supply.ask-library');
/** Words of the labelled library Scroll's first paragraph (scroll-model's tides fixture, stored as the recipe's v1 Scroll). */
const LIBRARY_QUOTE = 'a coast gets two high tides a day';
/** A question the library Scroll answers: its words share key words with the quote above. */
const TIDES_QUESTION = 'Why does a coast get two high tides a day?';

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
  /** What runs once, just before the worker enters its transaction to store a verdict: a pause or a Clear in that gap. */
  let beforeApply: () => Promise<void> = () => Promise.resolve();
  const once = (action: () => Promise<void>) => () => {
    beforeApply = () => Promise.resolve();
    return action();
  };
  let scopeScript: () => FixtureScenario | Promise<FixtureScenario>;
  let libraryScript: (call: FixtureCall) => FixtureScenario | Promise<FixtureScenario>;
  let scopeModel: ReturnType<typeof fixtureModel>;
  /** The library Scroll a question about tides may be answered by: a labelled CI v1 Scroll under `earth.tides`. */
  let library: { readonly assetId: string; readonly revision: number };
  const libraryCalls = () => scopeModel.calls.filter(isLibraryCall);
  let scroll: { readonly assetId: string; readonly revision: number };
  let stopId: string;
  let suggestions: readonly string[];
  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
  /** Pauses or resumes recording through the real policy command, from the generation the person is at. */
  async function toggleRecording(person: FixturePerson, generation: number, on: boolean) {
    expect(
      await recordingPolicyFor(database.db, { lockTimeoutMs: 5000 }).set(person.authority, {
        version: 'recording-policy.v1',
        commandId: randomUUID(),
        expectedPrivacyEpoch: person.authority.privacyEpoch,
        expectedRecordingGeneration: generation,
        on,
      }),
    ).toMatchObject({ kind: 'ok' });
  }

  /** Composes the use cases with the given daily caps, the way the worker's providers do. */
  function build(caps: { perDay: number; perPerson: number; madeToOrder?: boolean } = { perDay: 20, perPerson: 5 }) {
    const SCOPE = Symbol('scope');
    const ENQUEUE = Symbol('enqueue');
    const CONFIG = Symbol('config');
    const RECORDING = Symbol('recording-harness');
    const providers = supplyProviders({
      withPersonalScope: SCOPE,
      enqueueJob: ENQUEUE,
      config: CONFIG,
      recordingHarness: RECORDING,
    });
    const values = new Map<symbol, unknown>([
      [CATALOGUE, catalogueOf(database.db)],
      [SCOPE, withScope()],
      [ENQUEUE, makeEnqueueJob(content.boss)],
      [
        CONFIG,
        {
          supplyCreateDailyCap: 10,
          supplyPlannerCreateDailyCap: 10,
          supplyAskDailyCap: caps.perDay,
          supplyAskPersonDailyCap: caps.perPerson,
          // The suite runs with the switch on (D-436); the cases that need it off say so.
          madeToOrderEnabled: caps.madeToOrder ?? true,
        },
      ],
      [FENCE_PERSONAL_RECORDING, fencePersonalRecording],
      [READ_EXPLORATION_SNAPSHOT, content.readExploration],
      ...recordingEntries(database.db, scopeModel, RECORDING, () => beforeApply()),
      [READ_LIBRARY_PASSAGES, makeReadLibraryPassages(database.db)],
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
    // The source: the labelled Orrin fixture as the released v2 revision of the `seasons` recipe, stored as the v2 production job stored it.
    expect(await storeV2(database.db, 'seasons')).toMatchObject({ assetId: TOPICS.seasons.assetId, revision: 1 });
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
    // The library: the v1 Scroll of the tides recipe, stored as the v1 production job stored it (`storeV1`, #818).
    expect(await storeV1(database.db, 'tides')).toMatchObject({ assetId: TOPICS.tides.assetId, revision: 1 });
    library = { assetId: TOPICS.tides.assetId, revision: 1 };
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
    scopeScript = () => scopeAnswer('here');
    libraryScript = () => libraryReply(null, null);
  });

  async function setup(caps?: Parameters<typeof build>[0]) {
    // Each test starts with no queued production, no ledger and no earlier asks: the caps count a day's rows.
    await sql`delete from pgboss.job where name in ('content.produce-scroll', 'content.produce-answer')`.execute(
      database.db,
    );
    await sql`delete from supply.requests`.execute(database.db);
    await sql`delete from supply.ask_orders`.execute(database.db);
    scopeScript = () => scopeAnswer('here');
    libraryScript = () => libraryReply(null, null);
    beforeApply = () => Promise.resolve();
    scopeModel = fixtureModel((_sequence, call) => (isLibraryCall(call) ? libraryScript(call) : scopeScript()), {
      label: 'supply-ask-scope-CI-fixture',
    });
    // No writer is left for an order: the job ends `made_to_order_unavailable` before any request, so this one is never asked.
    production = fixtureProductionWorker(database, () => ({ kind: 'success', text: '{}' }));
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
  /** The production jobs waiting, on either queue: an ask order's answer is on its own, never on the library's (D-267). */
  const queuedProductionRows = async () =>
    (
      await sql<{ name: string; data: { recipe: string; take: number } }>`select name, data from pgboss.job
        where name in ('content.produce-scroll', 'content.produce-answer') and state = 'created'
        order by created_on`.execute(database.db)
    ).rows;
  const queuedProduction = async () => (await queuedProductionRows()).map((row) => row.data);
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
      // The answer to a question is on the queue whose claim covers its fourteen requests, not the library's (D-267, D-297).
      expect((await queuedProductionRows()).map((row) => row.name)).toEqual(['content.produce-answer']);
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
        // A question asked from a Scroll says so, so the app can leave it out while it is switched off (D-436).
        ask: true,
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

    describe('a question that names another subject the catalogue covers (D-251)', () => {
      /** A typed question the scope step places on a catalogue subject, resolved by the worker. */
      async function placed(topicId: string, question = TIDES_QUESTION) {
        const { person, exposure } = await reader();
        scopeScript = () => scopeAnswer('catalogue', topicId);
        const requestId = await ask(person, askCommand(exposure, question));
        await resolve(job(person, requestId));
        return { person, requestId };
      }
      /** The library check's run of one request, derived from the request's ID. */
      const libraryRunOf = (requestId: string) =>
        database.db
          .selectFrom('reasoning.business_runs')
          .select(['purpose', 'state'])
          .where('id', '=', stableUuid(`supply.ask-library:${requestId}`))
          .execute();

      it('serves a library Scroll when the checker finds that it answers, with words of it that do', async () => {
        await setup();
        libraryScript = () => libraryReply('s1', LIBRARY_QUOTE);
        const { person, requestId } = await placed('earth.tides');

        expect(await status(person, requestId)).toMatchObject({
          status: 'ready',
          content: { assetId: library.assetId },
        });
        expect(await requestRow(requestId)).toMatchObject({ state: 'ready', decision: 'reuse', ask_order_id: null });
        // The checker read the question with the words of the library Scroll, and not the Scroll being read.
        const checks = libraryCalls();
        expect(checks).toHaveLength(1);
        expect(checks[0]!.request.user).toContain(TIDES_QUESTION);
        expect(checks[0]!.request.user).toContain(LIBRARY_QUOTE);
        // Nothing was ordered, queued or counted: the library answered.
        expect(await database.db.selectFrom('supply.ask_orders').select('order_id').execute()).toEqual([]);
        expect(await queuedProduction()).toEqual([]);
        expect(await libraryRunOf(requestId)).toEqual([{ purpose: 'ask-library', state: 'completed' }]);
      });

      it('does not offer a library Scroll that does not answer: an order is made for the question instead', async () => {
        await setup();
        libraryScript = () => libraryReply(null, null);
        const { person, requestId } = await placed('earth.tides');

        expect(libraryCalls()).toHaveLength(1);
        // Not the library's Scroll: the request waits on an order made for this question, counted in the ledger.
        expect(await requestRow(requestId)).toMatchObject({ state: 'requested', decision: 'create', content: null });
        const order = await orderOf(requestId);
        expect(await status(person, requestId)).toMatchObject({ status: 'preparing', phase: 'preparing' });
        expect(await database.db.selectFrom('supply.ask_orders').select('order_id').execute()).toEqual([
          { order_id: order.orderId },
        ]);
        expect(await queuedProduction()).toEqual([expect.objectContaining({ recipe: order.recipe, take: 1 })]);
        expect(await libraryRunOf(requestId)).toEqual([{ purpose: 'ask-library', state: 'completed' }]);
      });

      it.each([
        ['a quote that is not in the Scroll', () => libraryReply('s1', 'words the Scroll never wrote at all')],
        [
          'a quote of the Scroll that is not about the question',
          () => libraryReply('s1', 'The Sun raises bulges too, but smaller ones'),
        ],
        ['a Scroll that is not a candidate', () => libraryReply('s7', LIBRARY_QUOTE)],
        ['a Scroll without a quote', () => libraryReply('s1', null)],
        [
          'an answer that is not the shape asked for',
          (): FixtureScenario => ({ kind: 'success', text: '{"ok":true}' }),
        ],
      ] as const)('offers nothing on %s, after the one repair, and makes an order', async (_name, reply) => {
        await setup();
        libraryScript = reply;
        const { requestId } = await placed('earth.tides');

        // The checker's word alone offers nothing: code needs the quote in the text. One repair, then no offer.
        expect(libraryCalls()).toHaveLength(2);
        expect(await requestRow(requestId)).toMatchObject({ state: 'requested', decision: 'create', content: null });
        expect((await requestRow(requestId)).ask_order_id).not.toBeNull();
        expect(await libraryRunOf(requestId)).toEqual([{ purpose: 'ask-library', state: 'failed' }]);
      });

      it('makes an order without asking the checker when the subject has no library Scroll', async () => {
        await setup();
        const { requestId } = await placed('earth.greenhouse-effect');
        expect(libraryCalls()).toHaveLength(0);
        expect(await requestRow(requestId)).toMatchObject({ state: 'requested', decision: 'create' });
        expect((await requestRow(requestId)).ask_order_id).not.toBeNull();
      });

      it('never starts the library for a question: no shared work, no Create cap spent', async () => {
        await setup();
        libraryScript = () => libraryReply(null, null);
        const { requestId } = await placed('earth.tides');
        expect((await requestRow(requestId)).work_id).toBeNull();
        expect(await database.db.selectFrom('supply.work').select('id').execute()).toEqual([]);
      });

      it('reads the question against the library Scroll and never against the Scroll being read', async () => {
        await setup();
        // The Scroll being read is filed under the same subject, so it fits that meaning exactly.
        await database.db
          .updateTable('content.encounter_topics')
          .set({ topic_id: 'earth.tides' })
          .where('asset_id', '=', scroll.assetId)
          .where('asset_revision', '=', scroll.revision)
          .where('role', '=', 'primary')
          .execute();
        libraryScript = () => libraryReply('s1', LIBRARY_QUOTE);
        try {
          const { person, requestId } = await placed('earth.tides');
          const listed = libraryCalls()[0]!.request.user.match(/kind="library_scroll"/gu) ?? [];
          expect(listed).toHaveLength(1);
          expect(await status(person, requestId)).toMatchObject({
            status: 'ready',
            content: { assetId: library.assetId },
          });
        } finally {
          await database.db
            .updateTable('content.encounter_topics')
            .set({ topic_id: 'earth.seasons' })
            .where('asset_id', '=', scroll.assetId)
            .where('asset_revision', '=', scroll.revision)
            .where('role', '=', 'primary')
            .execute();
        }
      });

      it('is closed honestly when the day’s ask orders are used up and the library does not answer', async () => {
        await setup({ perDay: 0, perPerson: 5 });
        libraryScript = () => libraryReply(null, null);
        const { person, requestId } = await placed('earth.tides');
        expect(await status(person, requestId)).toMatchObject({
          status: 'unavailable',
          reason: 'budget_unavailable',
          limit: { kind: 'off' },
        });
        expect((await requestRow(requestId)).ask_order_id).toBeNull();
        expect(await queuedProduction()).toEqual([]);
      });

      it('still serves a library Scroll that answers when the day’s ask orders are used up: it costs no order', async () => {
        await setup({ perDay: 0, perPerson: 5 });
        libraryScript = () => libraryReply('s1', LIBRARY_QUOTE);
        const { person, requestId } = await placed('earth.tides');
        expect(await status(person, requestId)).toMatchObject({
          status: 'ready',
          content: { assetId: library.assetId },
        });
      });

      it('never resends a check of unknown outcome: the ask closes as could-not-prepare and makes no order', async () => {
        await setup();
        libraryScript = () => ({ kind: 'timeout_after_dispatch' });
        const { person, requestId } = await placed('earth.tides');
        await resolve(job(person, requestId));
        expect(libraryCalls()).toHaveLength(1);
        expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
        expect((await requestRow(requestId)).ask_order_id).toBeNull();
        // The run stays open for an operator: an attempt that may have reached the provider is never settled by guessing.
        expect(await libraryRunOf(requestId)).toEqual([{ purpose: 'ask-library', state: 'admitted' }]);
      });

      it('does not ask the checker for a question the scope step placed with the Scroll being read, or nowhere', async () => {
        await setup();
        const { person, exposure } = await reader();
        const here = await ask(person, askCommand(exposure, 'Why does the far side of Orrin stay cold in its summer?'));
        await resolve(job(person, here));
        scopeScript = () => scopeAnswer('none');
        const nowhere = await ask(person, askCommand(exposure, 'Who won the match last night?'));
        await resolve(job(person, nowhere));
        expect(libraryCalls()).toHaveLength(0);
      });
    });

    it('never returns the Scroll being read, whether the ask is placed, polled or tried again (D-230)', async () => {
      await setup();
      const { person, exposure } = await reader();
      // The Scroll being read is filed under the topic the question names, and no other library Scroll is: the library has
      // nothing to offer, so an order is made, and no look at the request can return the Scroll in front of the person.
      const filedUnder = async (topicId: string) =>
        database.db
          .updateTable('content.encounter_topics')
          .set({ topic_id: topicId })
          .where('asset_id', '=', scroll.assetId)
          .where('asset_revision', '=', scroll.revision)
          .where('role', '=', 'primary')
          .execute();
      await filedUnder('earth.greenhouse-effect');
      scopeScript = () => scopeAnswer('catalogue', 'earth.greenhouse-effect');
      const requestId = await ask(person, askCommand(exposure, 'How does the greenhouse effect work?'));
      try {
        // Placing it: an order is made instead of binding to the Scroll in front of the person.
        await resolve(job(person, requestId));
        expect(await requestRow(requestId)).toMatchObject({ state: 'requested', content: null });
        expect((await requestRow(requestId)).ask_order_id).not.toBeNull();
        expect(libraryCalls()).toHaveLength(0);
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

      // The order's Scroll is stored as the v1 job stored it (`storeOrderScroll`, #818): nothing writes one now.
      expect(await storeOrderScroll(database.db, order.recipe)).toMatchObject({ assetId: order.assetId, revision: 1 });
      await resolve(job(person, requestId));
      const ready = await status(person, requestId);
      expect(ready).toMatchObject({ status: 'ready', content: { assetId: order.assetId } });
      expect(ready.status === 'ready' ? ready.content.metadata.title : '').not.toBe('');
      // The question's scope was never asked for a suggested question.
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
      await sql`insert into supply.ask_orders(order_id, created_at, ready_at, support_checked)
        select gen_random_uuid(), now() - interval '1 hour', now() - interval '1 hour' + make_interval(secs => s), true
        from unnest(array[100, 110, 120, 130]) as s`.execute(database.db);
      expect(await status(person, waiting)).not.toHaveProperty('typicalSeconds');
      // Orders made before the support check did not wait for it (D-252): a fifth of those is not a fifth sample.
      await sql`insert into supply.ask_orders(order_id, created_at, ready_at)
        values (gen_random_uuid(), now() - interval '1 hour', now() - interval '1 hour' + interval '5 seconds')`.execute(
        database.db,
      );
      expect(await status(person, waiting)).not.toHaveProperty('typicalSeconds');
      await sql`insert into supply.ask_orders(order_id, created_at, ready_at, support_checked)
        values (gen_random_uuid(), now() - interval '1 hour', now() - interval '1 hour' + interval '600 seconds', true)`.execute(
        database.db,
      );
      // The median of 100, 110, 120, 130 and 600 is 120: one slow order does not move it, and the unchecked order is not counted.
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

  describe('with the made-to-order switch off (D-436)', () => {
    /** The same world, composed again with the switch off: what was made before it was turned off stays in the database. */
    const switchOff = () => build({ perDay: 20, perPerson: 5, madeToOrder: false });
    /** What has been made to order so far: its ledger, its stored orders and its queued jobs. */
    const madeSoFar = async () => ({
      ledger: await database.db.selectFrom('supply.ask_orders').select('order_id').execute(),
      orders: await database.db.selectFrom('content.made_to_order_scrolls').select('recipe').execute(),
      queued: await queuedProduction(),
    });

    it('closes a suggested question at once as switched off: no order, no ledger row, no job, no model call', async () => {
      await setup({ perDay: 20, perPerson: 5, madeToOrder: false });
      const before = await madeSoFar();
      const { person, exposure } = await reader();
      const requestId = await ask(person, askCommand(exposure, suggestions[0]!));
      expect(await status(person, requestId)).toMatchObject({
        status: 'unavailable',
        reason: 'budget_unavailable',
        limit: { kind: 'off' },
      });
      expect(await requestRow(requestId)).toMatchObject({ reason: 'budget_unavailable', ask_limit: 'off' });
      expect(scopeModel.calls).toHaveLength(0);
      expect(await madeSoFar()).toEqual(before);
    });

    it('closes a typed question at create as switched off: no matching job, no scope step, no library check, no order', async () => {
      await setup({ perDay: 20, perPerson: 5, madeToOrder: false });
      const before = await madeSoFar();
      const { person, exposure } = await reader();
      const requestId = await ask(person, askCommand(exposure, 'Why does the far side of Orrin stay cold?'));
      expect(await status(person, requestId)).toMatchObject({
        status: 'unavailable',
        reason: 'budget_unavailable',
        limit: { kind: 'off' },
      });
      expect(await requestRow(requestId)).toMatchObject({ state: 'unavailable', ask_limit: 'off' });
      expect(scopeModel.calls).toHaveLength(0);
      expect(libraryCalls()).toHaveLength(0);
      expect(await madeSoFar()).toEqual(before);
      // Nothing waits for a worker: no resolver job was queued for it.
      const jobs = await sql<{
        n: string;
      }>`select count(*) as n from pgboss.job where name = 'supply.resolve-request' and data->>'requestId' = ${requestId}`.execute(
        database.db,
      );
      expect(Number(jobs.rows[0]!.n)).toBe(0);
    });

    it('closes a typed question about another subject at create as switched off, with no library check, even when a library Scroll would answer it', async () => {
      await setup({ perDay: 20, perPerson: 5, madeToOrder: false });
      libraryScript = () => libraryReply('s1', LIBRARY_QUOTE);
      scopeScript = () => scopeAnswer('catalogue', 'earth.tides');
      const before = await madeSoFar();
      const { person, exposure } = await reader();
      const requestId = await ask(person, askCommand(exposure, TIDES_QUESTION));
      expect(await status(person, requestId)).toMatchObject({
        status: 'unavailable',
        reason: 'budget_unavailable',
        limit: { kind: 'off' },
      });
      expect(scopeModel.calls).toHaveLength(0);
      expect(libraryCalls()).toHaveLength(0);
      expect(await madeSoFar()).toEqual(before);
    });

    it('closes a typed question that was already waiting to be placed when the switch was turned off, before any model call', async () => {
      await setup();
      const { person, exposure } = await reader();
      const requestId = await ask(person, askCommand(exposure, TIDES_QUESTION));
      expect((await requestRow(requestId)).state).toBe('matching');
      libraryScript = () => libraryReply('s1', LIBRARY_QUOTE);
      scopeScript = () => scopeAnswer('catalogue', 'earth.tides');
      switchOff();
      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({
        status: 'unavailable',
        reason: 'budget_unavailable',
        limit: { kind: 'off' },
      });
      expect(scopeModel.calls).toHaveLength(0);
      expect(libraryCalls()).toHaveLength(0);
      expect(await database.db.selectFrom('supply.ask_orders').select('order_id').execute()).toEqual([]);
    });

    it('closes an order made while it was on, when its request is next advanced, even if its Scroll was admitted meanwhile', async () => {
      await setup();
      const { person, exposure } = await reader();
      const requestId = await ask(person, askCommand(exposure, suggestions[0]!));
      const order = await orderOf(requestId);
      await storeOrderScroll(database.db, order.recipe);
      const queued = (await queuedProduction()).length;
      switchOff();
      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({
        status: 'unavailable',
        reason: 'budget_unavailable',
        limit: { kind: 'off' },
      });
      // Nothing new is sent for it.
      expect(await queuedProduction()).toHaveLength(queued);
    });

    it('does not try an ask order again: the receipt says not retryable and the request stays closed', async () => {
      await setup();
      const { person, exposure } = await reader();
      const requestId = await ask(person, askCommand(exposure, suggestions[0]!));
      const order = await orderOf(requestId);
      // The job ends rejected: no writer is left for an order (`made_to_order_unavailable`).
      expect(await publish(order.recipe)).toMatchObject({ result: { outcome: 'rejected' } });
      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });

      switchOff();
      const queued = (await queuedProduction()).length;
      expect(
        await retry(person.authority, { version: 'content-request-retry.v1', commandId: randomUUID(), requestId }),
      ).toMatchObject({ kind: 'ok', value: { outcome: 'not_retryable' } });
      expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
      expect(await queuedProduction()).toHaveLength(queued);
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
        limit: { kind: 'world' },
      });
      expect((await requestRow(capped)).ask_order_id).toBeNull();

      await setup({ perDay: 50, perPerson: 1 });
      const asker = await reader();
      await ask(asker.person, askCommand(asker.exposure, suggestions[0]!));
      const over = await ask(asker.person, askCommand(asker.exposure, suggestions[1]!));
      expect(await status(asker.person, over)).toMatchObject({
        status: 'unavailable',
        reason: 'budget_unavailable',
        limit: { kind: 'person', perDay: 1 },
      });
      // Another person is not held back by theirs.
      const other = await reader();
      const fine = await ask(other.person, askCommand(other.exposure, suggestions[0]!));
      expect(await status(other.person, fine)).toMatchObject({ status: 'preparing' });
    });

    it('turns ask orders off with a cap of zero', async () => {
      await setup({ perDay: 0, perPerson: 5 });
      const { person, exposure } = await reader();
      const requestId = await ask(person, askCommand(exposure, suggestions[0]!));
      expect(await status(person, requestId)).toMatchObject({
        status: 'unavailable',
        reason: 'budget_unavailable',
        limit: { kind: 'off' },
      });
      expect(await queuedProduction()).toEqual([]);
    });

    it('keeps a limit only on a request closed as budget_unavailable (migration 0103)', async () => {
      await setup({ perDay: 50, perPerson: 5 });
      const { person, exposure } = await reader();
      const waiting = await ask(person, askCommand(exposure, suggestions[0]!));
      // A request that is still preparing has no reason: a limit on it is refused, though `reason = ...` alone would be null.
      await expect(
        database.db.updateTable('supply.requests').set({ ask_limit: 'world' }).where('id', '=', waiting).execute(),
      ).rejects.toThrow(/requests_ask_limit_check/);

      await setup({ perDay: 0, perPerson: 5 });
      const other = await reader();
      const closed = await ask(other.person, askCommand(other.exposure, suggestions[0]!));
      expect(await requestRow(closed)).toMatchObject({ reason: 'budget_unavailable', ask_limit: 'off' });
      await expect(
        database.db.updateTable('supply.requests').set({ ask_limit: 'everyone' }).where('id', '=', closed).execute(),
      ).rejects.toThrow(/requests_ask_limit_check/);
    });

    it('closes as could-not-prepare when its job is rejected, and Try again sends the next take for the same request', async () => {
      await setup();
      const { person, exposure } = await reader();
      const requestId = await ask(person, askCommand(exposure, suggestions[0]!));
      const order = await orderOf(requestId);

      // The job ends rejected: no writer is left for an order (`made_to_order_unavailable`).
      expect(await publish(order.recipe)).toMatchObject({ result: { outcome: 'rejected' } });
      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
      // Nothing is sent on its own after a refusal: the person decides.
      expect((await queuedProduction()).filter((queued) => queued.take === 2)).toEqual([]);

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

      // The second take's Scroll is stored as the v1 job stored it (take 2 of the same order).
      expect(await storeOrderScroll(database.db, order.recipe)).toMatchObject({ assetId: order.assetId, revision: 1 });
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
      await storeOrderScroll(database.db, order.recipe);
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
      await storeOrderScroll(database.db, order.recipe);
      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({ status: 'cancelled' });
      const audience = makeCheckAssetAudience(database.db, [makeReadAskOrderAudience(database.db)]);
      expect((await audience({ pool: true }, person.authority, [order.assetId])).has(order.assetId)).toBe(false);
    });
  });

  describe('a person who paused and resumed recording (D-264)', () => {
    /** Pause then resume through the real policy command: generation 1 on, 2 off, 3 on. */
    async function pauseAndResume(person: FixturePerson) {
      await toggleRecording(person, 1, false);
      await toggleRecording(person, 2, true);
    }
    /** A typed question asked after the pause and resume, at the person's current generation. */
    async function askedAfterResume(question = TIDES_QUESTION) {
      const { person, exposure } = await reader();
      await pauseAndResume(person);
      const requestId = await ask(person, askCommand(exposure, question, { recordingGeneration: 3 }));
      return { person, exposure, requestId };
    }
    const runsOf = async (requestId: string) =>
      (
        await database.db
          .selectFrom('reasoning.business_runs')
          .select(['purpose', 'state', 'recording_generation'])
          .where('id', 'in', [requestId, stableUuid(`supply.ask-library:${requestId}`)])
          .orderBy('purpose')
          .execute()
      ).map((run) => ({ ...run }));
    const askOrders = () => database.db.selectFrom('supply.ask_orders').select('order_id').execute();

    it('has the question placed and an ask order made, and every run is stamped with the generation it was asked at', async () => {
      await setup();
      const { person, requestId } = await askedAfterResume();
      await resolve(job(person, requestId));
      expect(scopeModel.calls).toHaveLength(1);
      expect((await requestRow(requestId)).ask_order_id).not.toBeNull();
      expect(await status(person, requestId)).toMatchObject({ status: 'preparing', phase: 'preparing' });
      expect(await runsOf(requestId)).toEqual([{ purpose: 'ask-scope', state: 'completed', recording_generation: 3 }]);
    });

    it('has a library Scroll offered when the checker finds that it answers, under the same generation', async () => {
      await setup();
      scopeScript = () => scopeAnswer('catalogue', 'earth.tides');
      libraryScript = () => libraryReply('s1', LIBRARY_QUOTE);
      const { person, requestId } = await askedAfterResume();
      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({ status: 'ready', content: { assetId: library.assetId } });
      expect(await askOrders()).toEqual([]);
      expect(await runsOf(requestId)).toEqual([
        { purpose: 'ask-library', state: 'completed', recording_generation: 3 },
        { purpose: 'ask-scope', state: 'completed', recording_generation: 3 },
      ]);
    });

    it('does not place a question asked at an earlier generation: it closes as could-not-prepare, calls no model and makes no order', async () => {
      await setup();
      const { person, exposure } = await reader();
      const requestId = await ask(person, askCommand(exposure, TIDES_QUESTION));
      await pauseAndResume(person);
      await resolve(job(person, requestId));
      expect(scopeModel.calls).toHaveLength(0);
      expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
      expect(await askOrders()).toEqual([]);
      expect(await queuedProduction()).toEqual([]);
      expect(await runsOf(requestId)).toEqual([]);
    });

    it('drops a verdict reached across a pause and a resume: no order is made, and no run is stamped with the new generation', async () => {
      await setup();
      const { person, exposure } = await reader();
      const requestId = await ask(person, askCommand(exposure, TIDES_QUESTION));
      scopeScript = async () => {
        await pauseAndResume(person);
        return scopeAnswer('here');
      };
      await resolve(job(person, requestId));
      expect(scopeModel.calls).toHaveLength(1);
      expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
      expect(await askOrders()).toEqual([]);
      expect(await queuedProduction()).toEqual([]);
      expect(
        await database.db
          .selectFrom('reasoning.business_runs')
          .select('id')
          .where('universe_id', '=', person.universeId)
          .where('recording_generation', '=', 3)
          .execute(),
      ).toEqual([]);
      // The same person asks again at the new generation and is answered: only the old question was dropped.
      scopeScript = () => scopeAnswer('here');
      const again = await ask(person, askCommand(exposure, 'Why is it so cold there?', { recordingGeneration: 3 }));
      await resolve(job(person, again));
      expect(await status(person, again)).toMatchObject({ status: 'preparing', phase: 'preparing' });
    });

    it('applies nothing when recording is paused between the scope step and the store: no order is made', async () => {
      await setup();
      const { person, exposure } = await reader();
      const requestId = await ask(person, askCommand(exposure, TIDES_QUESTION));
      beforeApply = once(() => toggleRecording(person, 1, false));
      await resolve(job(person, requestId));
      expect(scopeModel.calls).toHaveLength(1);
      expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
      expect(await askOrders()).toEqual([]);
      expect(await queuedProduction()).toEqual([]);
      expect((await runsOf(requestId)).map((run) => run.state)).toEqual(['admitted']);
    });

    it('applies nothing when recording is cleared between the scope step and the store', async () => {
      await setup();
      const { person, exposure } = await reader();
      const requestId = await ask(person, askCommand(exposure, TIDES_QUESTION));
      beforeApply = once(() => clearRecordingPerson(database, content.boss, person));
      await resolve(job(person, requestId));
      expect(await askOrders()).toEqual([]);
      expect(await queuedProduction()).toEqual([]);
    });

    it('drops a library check reached across a pause: no Scroll is offered and no order is made', async () => {
      await setup();
      scopeScript = () => scopeAnswer('catalogue', 'earth.tides');
      const { person, exposure } = await reader();
      libraryScript = async () => {
        await toggleRecording(person, 1, false);
        return libraryReply('s1', LIBRARY_QUOTE);
      };
      const requestId = await ask(person, askCommand(exposure, TIDES_QUESTION));
      await resolve(job(person, requestId));
      expect(libraryCalls()).toHaveLength(1);
      expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
      expect(await askOrders()).toEqual([]);
    });

    it('stores nothing for a question in flight across Clear: no order, no job and nothing written for the new epoch', async () => {
      await setup();
      const { person, exposure } = await reader();
      const requestId = await ask(person, askCommand(exposure, TIDES_QUESTION));
      scopeScript = async () => {
        await clearRecordingPerson(database, content.boss, person);
        return scopeAnswer('here');
      };
      await resolve(job(person, requestId));
      expect(scopeModel.calls).toHaveLength(1);
      expect(await askOrders()).toEqual([]);
      expect(await queuedProduction()).toEqual([]);
      for (const table of ['reasoning.business_runs', 'supply.requests'] as const)
        expect(
          (
            await sql<{
              n: string;
            }>`select count(*) as n from ${sql.table(table)} where universe_id = ${person.universeId}::uuid and privacy_epoch > 1`.execute(
              database.db,
            )
          ).rows[0]!.n,
        ).toBe('0');
    });

    it('lets a cancel that arrives while the question is placed win: no order is made, and the run is left open for the ledger’s sweep', async () => {
      await setup();
      const { person, exposure } = await reader();
      const requestId = await ask(person, askCommand(exposure, TIDES_QUESTION));
      scopeScript = async () => {
        const cancelled = await cancel(person.authority, {
          version: 'content-request-cancel.v1',
          commandId: randomUUID(),
          requestId,
        });
        expect(cancelled).toMatchObject({ kind: 'ok', value: { outcome: 'cancelled' } });
        return scopeAnswer('here');
      };
      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({ status: 'cancelled' });
      expect(await askOrders()).toEqual([]);
      expect(await queuedProduction()).toEqual([]);
      expect((await runsOf(requestId)).map((run) => run.state)).toEqual(['admitted']);
    });

    it('is still refused while recording is paused, as before', async () => {
      await setup();
      const { person, exposure } = await reader();
      await pauseAndResume(person);
      await toggleRecording(person, 3, false);
      for (const generation of [3, 4])
        expect(
          await create(person.authority, askCommand(exposure, TIDES_QUESTION, { recordingGeneration: generation })),
        ).toEqual({ kind: 'refused', reason: 'recording_paused' });
      expect(scopeModel.calls).toHaveLength(0);
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

    it('reads nothing of a Scroll withdrawn since the person opened it, and refuses their question', async () => {
      await setup();
      const { person, exposure } = await reader();
      const setStatus = (status: 'admitted' | 'withdrawn') =>
        sql`update content.assets set status = ${status} where id = ${scroll.assetId}::uuid`.execute(database.db);
      const ref = { assetId: scroll.assetId, assetRevision: 1 };
      expect(await factsOf(ref, stopId)).toBeDefined();
      await setStatus('withdrawn');
      try {
        expect(await factsOf(ref, stopId)).toBeUndefined();
        expect(await create(person.authority, askCommand(exposure, suggestions[0]!))).toEqual({
          kind: 'refused',
          reason: 'source_unavailable',
        });
        expect(await database.db.selectFrom('supply.ask_orders').select('order_id').execute()).toEqual([]);
      } finally {
        await setStatus('admitted');
      }
      expect(await factsOf(ref, stopId)).toBeDefined();
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
      expect(await storeV2(database.db, 'seasons')).toMatchObject({ revision: 2 });
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
      // The stored answer holds none of the person's words: an erasure of the question does not reach the revision or the job.
      const storedOrder = await storeOrderScroll(database.db, order.recipe);
      await resolve(job(person, requestId));
      const wordsKept = async () => {
        const revisions = await database.db
          .selectFrom('content.asset_revisions')
          .selectAll()
          .where('asset_id', '=', order.assetId)
          .execute();
        const jobs = await database.db
          .selectFrom('content.scroll_production_runs')
          .select(['writer_output', 'outcomes'])
          .where('topic', '=', order.recipe)
          .execute();
        return JSON.stringify({ revisions, jobs });
      };
      // Something was stored for the order: its revision is in what the test reads, and the question is not.
      expect(await wordsKept()).toContain(storedOrder.assetId);
      expect(await wordsKept()).not.toContain(question);

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
      expect(await wordsKept()).not.toContain(question);
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

  describe('the shortlist a model is shown is frozen with the request (#674, D-419)', () => {
    it('is made from the release the question was asked at, so a redelivery after a release sends the very request the first one paid for', async () => {
      await setup();
      const { person, exposure } = await reader();
      const question = 'Why do volcanoes erupt?';
      const requestId = await ask(person, askCommand(exposure, question));
      const askedAt = (await catalogueOf(database.db).current()).releaseId;
      expect((await requestRow(requestId)).catalogue_release).toBe(askedAt);
      // After the question was asked and before a worker took it, a topic is added and made servable.
      const volcanoes = (id: string, kind: 'topic' | 'facet', parentId: string, label: string) => ({
        kind: 'add' as const,
        draft: {
          id,
          kind,
          parentId,
          label,
          meaning: `${label}: an invented topic for a test, long enough to be admitted.`,
          sceneFamily: null,
          haze: null,
          sameMeaningAs: [],
        },
      });
      expect(
        await appendRelease(
          database.db,
          [
            volcanoes('earth.volcanoes', 'topic', 'earth', 'Volcanoes'),
            volcanoes('earth.volcanoes.magma', 'facet', 'earth.volcanoes', 'Magma'),
            volcanoes('earth.volcanoes.plates', 'facet', 'earth.volcanoes', 'Plates'),
          ],
          'operator',
        ),
      ).toMatchObject({ kind: 'appended' });
      expect(
        await appendRelease(database.db, [{ kind: 'show', nodeId: 'earth.volcanoes' }], 'visibility'),
      ).toMatchObject({ kind: 'appended' });
      expect((await catalogueOf(database.db).current()).topics().map((topic) => topic.id)).toContain('earth.volcanoes');
      await resolve(job(person, requestId));
      // The first request names the topics of the release it was asked at, not the one that is current now.
      expect(scopeModel.calls).toHaveLength(1);
      expect(scopeModel.calls[0]!.request.user).toContain('earth.tides');
      expect(scopeModel.calls[0]!.request.user).not.toContain('earth.volcanoes');
      // A question asked after the release is shown the new topic.
      const later = await reader();
      const lateId = await ask(later.person, askCommand(later.exposure, question));
      expect((await requestRow(lateId)).catalogue_release).toBeGreaterThan(askedAt);
      await resolve(job(later.person, lateId));
      expect(scopeModel.calls).toHaveLength(2);
      expect(scopeModel.calls[1]!.request.user).toContain('earth.volcanoes');
    });
  });
});
