import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CreateContentRequest } from '@knowscroll/contracts';
import { parseDocumentV2 } from '@knowscroll/scroll-model';
import { AuthoredScroll } from '@knowscroll/scroll-model/producer';
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
import {
  fixtureAuthoredV2,
  fixtureResearchPageV2,
} from '../../../packages/backend/src/modules/content/production/spike-v2/writer-v2.fixture.js';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import { madeToOrderKey } from '../../../packages/backend/src/modules/content/domain/order-key.js';
import {
  MAX_LABEL_WORDS,
  RULE_PROBLEMS,
  UNSUPPORTED_HINTS,
  batchesOf,
  wordsOf,
} from '../../../packages/backend/src/modules/content/domain/ask-support.js';
import {
  askSupportRepairRunId,
  askSupportRunId,
} from '../../../packages/backend/src/modules/content/production/ask-support-step.js';
import { sentencesOfAnswer } from '../../../packages/backend/src/modules/content/production/ask-support.js';
import { writerFormatOf } from '../../../packages/backend/src/modules/content/production/writer.js';
import { makeReadAskOrderAudience } from '../../../packages/backend/src/modules/supply/adapters/postgres-ask-orders.js';
import { makeCheckAssetAudience } from '../../../packages/backend/src/modules/content/adapters/made-to-order.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { signal, fixtureModel } from '../support/fixture-model.js';
import { recordingEntries } from '../support/recording-harness.js';
import type { FixtureCall, FixtureScenario } from '../support/fixture-model-port.js';
import {
  answerWith,
  enableProductionScope,
  fixtureAnswer,
  fixtureAuthored,
  fixtureProduction,
  fixtureResearchFor,
  supportReply,
  supportRequestOf,
} from '../support/generated-scroll.js';
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

/** The library check's answer: a Scroll by handle with words of it, or neither. */
const libraryReply = (scroll: string | null, quote: string | null): FixtureScenario => ({
  kind: 'success',
  text: JSON.stringify({ scroll, quote }),
});
const isLibraryCall = (call: FixtureCall): boolean => call.request.system.includes('supply.ask-library');
/** Words of the labelled library Scroll's first paragraph (the CI lighthouse text). */
const LIBRARY_QUOTE = 'a way to know where the land begins';

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
  /** The support checker's replies for an ask order's answer; by default every sentence is supported. */
  let supportScript: NonNullable<NonNullable<Parameters<typeof fixtureProductionWorker>[2]>['support']>;
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
  function build(caps: { perDay: number; perPerson: number } = { perDay: 20, perPerson: 5 }) {
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
    // The library: a v1 Scroll of the tides recipe, produced as it was before the waves (Create writes only v1 recipes).
    const restoreTides = markScrollV1('tides');
    try {
      const tides = fixtureProduction(
        database.db,
        () => answerWith(fixtureAuthored(writerFormatOf(TOPICS.tides))),
        fixtureResearchFor,
      );
      expect(await tides.produce('tides', false, signal())).toMatchObject({ outcome: 'published' });
    } finally {
      restoreTides();
    }
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
    writer = () => answerWith(fixtureAnswer());
    scopeScript = () => scopeAnswer('here');
    libraryScript = () => libraryReply(null, null);
    supportScript = (_check, call) => supportReply(call);
  });

  async function setup(caps?: Parameters<typeof build>[0]) {
    // Each test starts with no queued production, no ledger and no earlier asks: the caps count a day's rows.
    await sql`delete from pgboss.job where name in ('content.produce-scroll', 'content.produce-answer')`.execute(
      database.db,
    );
    await sql`delete from supply.requests`.execute(database.db);
    await sql`delete from supply.ask_orders`.execute(database.db);
    writer = () => answerWith(fixtureAnswer());
    scopeScript = () => scopeAnswer('here');
    libraryScript = () => libraryReply(null, null);
    supportScript = (_check, call) => supportReply(call);
    beforeApply = () => Promise.resolve();
    scopeModel = fixtureModel((_sequence, call) => (isLibraryCall(call) ? libraryScript(call) : scopeScript()), {
      label: 'supply-ask-scope-CI-fixture',
    });
    production = fixtureProductionWorker(database, () => writer(), {
      support: (check, call) => supportScript(check, call),
    });
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
      // The answer to a question is on the queue whose claim covers its twelve requests, not the library's (D-267).
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
      async function placed(topicId: string, question = 'How do ships know where the land begins?') {
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
        expect(checks[0]!.request.user).toContain('How do ships know where the land begins?');
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
          () => libraryReply('s1', 'In earlier times a keeper climbed the stairs'),
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
        expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'budget_unavailable' });
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

      expect(await publish(order.recipe)).toMatchObject({ kind: 'finished', result: { outcome: 'published' } });
      await resolve(job(person, requestId));
      const ready = await status(person, requestId);
      expect(ready).toMatchObject({ status: 'ready', content: { assetId: order.assetId } });
      expect(ready.status === 'ready' ? ready.content.metadata.title : '').not.toBe('');
      // The writer and the support check ran for the order; the question's scope was never asked for a suggested question.
      expect(production.writerCalls).toHaveLength(1);
      // The answer has 19 sentences: the check is two requests (D-267).
      expect(production.supportCalls).toHaveLength(2);
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

  describe('the support check of an answer (D-250)', () => {
    /** A person who asked a suggested question, so an order waits for production. */
    async function orderedAsk() {
      const { person, exposure } = await reader();
      const requestId = await ask(person, askCommand(exposure, suggestions[0]!));
      return { person, requestId, order: await orderOf(requestId), question: suggestions[0]! };
    }
    const jobsOf = (recipe: string) =>
      database.db
        .selectFrom('content.scroll_production_runs')
        .selectAll()
        .where('topic', '=', recipe)
        .orderBy('take')
        .execute();
    /** The state of the reasoning runs a job derived and used, by id; a run left open would never settle. */
    const runStates = async (ids: readonly string[]) =>
      (
        await database.db
          .selectFrom('reasoning.production_runs')
          .select(['id', 'state', 'closed_at'])
          .where('id', 'in', ids)
          .execute()
      )
        .map((run) => ({ id: run.id, state: run.state, closed: run.closed_at !== null }))
        .sort((a, b) => a.id.localeCompare(b.id));
    const storedAnswer = (assetId: string) =>
      database.db
        .selectFrom('content.asset_revisions')
        .select('document')
        .where('asset_id', '=', assetId)
        .executeTakeFirst();
    /** The number of the first sentence of the answer that starts with these words, as the checker is shown it. */
    const numberOf = (start: string) =>
      sentencesOfAnswer(AuthoredScroll.parse(fixtureAnswer())).find((sentence) => sentence.text.startsWith(start))!
        .number;
    /** The default fixture answer has 19 sentences, so a check of it is two requests (10 + 9 sentences, D-267). */
    const BATCHES = batchesOf(sentencesOfAnswer(AuthoredScroll.parse(fixtureAnswer()))).length;
    /** The ids of the runs of the checks of a draft: one for each batch. */
    const checkRuns = (jobId: string, draft: 1 | 2) =>
      Array.from({ length: BATCHES }, (_unused, batch) => askSupportRunId(jobId, draft, batch));
    /** Whether the checker's request number `check`, counted over the whole job from 1, is about the first draft. */
    const firstDraft = (check: number) => check <= BATCHES;
    const BEFORE = 'Because the beam turns';
    const BEFORE_SENTENCE = 'Because the beam turns, sailors see it only as a flash, once each turn.';
    const REPAIRED = 'Because the beam turns, sailors catch only a brief flash of it on each pass.';
    const flagged = (start: string) => ({
      unsupported: {
        [numberOf(start)]: { kind: 'goes_beyond', problem: 'The passage says something narrower than that.' },
      },
    });

    it('serves an answer after one writer request and one check, in batches, when every sentence is supported', async () => {
      await setup();
      const { person, requestId, order, question } = await orderedAsk();

      const done = await publish(order.recipe);

      // The check is inside the order's request bound of twelve, and in the same job as the writer.
      expect(BATCHES).toBe(2);
      expect(done).toMatchObject({ kind: 'finished', result: { outcome: 'published', requestBound: 12, take: 1 } });
      expect(production.writerCalls).toHaveLength(1);
      expect(production.supportCalls).toHaveLength(BATCHES);
      const [row] = await jobsOf(order.recipe);
      expect(row).toMatchObject({ state: 'published' });
      expect(row!.outcomes).toContainEqual(
        expect.objectContaining({
          role: 'support_check',
          kind: 'checked',
          draft: 1,
          batches: BATCHES,
          unsupported: [],
        }),
      );
      // Each batch is one more attempt in the ledger, in a run of its own, and the job closed them.
      expect(await runStates(checkRuns(row!.id, 1))).toEqual(
        checkRuns(row!.id, 1)
          .map((id) => ({ id, state: 'completed', closed: true }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
      // The checker read the answer’s sentences against the passages they cite, and never the person's question.
      for (const call of production.supportCalls) {
        expect(call.request.system).toContain('content.ask-support-check');
        expect(call.request.user).toContain('kind="answer_sentences"');
        expect(call.request.user).toContain('kind="cited_passages"');
        expect(call.request.user).not.toContain(question);
        expect(call.request.user).not.toContain('THE QUESTION');
      }
      // Together the batches carry every sentence of the answer once, in order, ten at most to a request.
      const asked = production.supportCalls.map((call) => supportRequestOf(call).sentences.map((one) => one.n));
      expect(asked.map((numbers) => numbers.length)).toEqual([10, 9]);
      expect(asked.flat()).toEqual(Array.from({ length: 19 }, (_unused, index) => index + 1));

      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({ status: 'ready', content: { assetId: order.assetId } });
    });

    it('repairs one unsupported sentence once, with fixed hints, checks the repair in turn and then serves it', async () => {
      await setup();
      const { person, requestId, order } = await orderedAsk();
      let writes = 0;
      writer = () => {
        writes += 1;
        return answerWith(fixtureAnswer(writes === 1 ? {} : { sentence: [BEFORE_SENTENCE, REPAIRED] }));
      };
      supportScript = (check, call) => (firstDraft(check) ? supportReply(call, flagged(BEFORE)) : supportReply(call));

      const done = await publish(order.recipe);

      expect(done).toMatchObject({ kind: 'finished', result: { outcome: 'published' } });
      expect(production.writerCalls).toHaveLength(2);
      expect(production.supportCalls).toHaveLength(2 * BATCHES);
      // The repair is the writer's second request and its only one: the revision notice, the fixed hint of the kind, the checker's
      // note as data and the draft it refers to. The harness gives it no repair of its own.
      const repair = production.writerCalls[1]!.request;
      expect(repair.system).toContain('REVISION AFTER A SUPPORT CHECK');
      expect(repair.user).toContain(`Sentence "${BEFORE}`);
      expect(repair.user).toContain(UNSUPPORTED_HINTS.goes_beyond);
      expect(repair.user).toContain('Note: The passage says something narrower than that.');
      expect(repair.user).toContain('kind="previous_draft"');
      // The second check read the repaired sentence, and it is what the person gets.
      expect(production.supportCalls.slice(BATCHES).map((call) => call.request.user)).toContainEqual(
        expect.stringContaining('a brief flash of it'),
      );
      expect(JSON.stringify((await storedAnswer(order.assetId))?.document)).toContain('a brief flash of it');

      const [row] = await jobsOf(order.recipe);
      expect(row!.writer_run_id).toBe(askSupportRepairRunId(row!.id));
      // Receipts hold numbers and kinds, never a sentence or the checker's words (D-231).
      const receipts = row!.outcomes as {
        role: string;
        kind: string;
        runId?: string;
        draft?: number;
        unsupported?: unknown;
      }[];
      expect(receipts.filter((receipt) => receipt.role === 'support_check')).toEqual([
        expect.objectContaining({
          kind: 'checked',
          draft: 1,
          unsupported: [{ number: numberOf(BEFORE), kind: 'goes_beyond' }],
        }),
        expect.objectContaining({ kind: 'checked', draft: 2, unsupported: [] }),
      ]);
      const text = JSON.stringify(receipts);
      expect(text).not.toContain(BEFORE);
      expect(text).not.toContain('narrower than that');
      // Every run closed: the first writer's, the batches of both checks and the repair.
      const superseded = receipts.find((receipt) => receipt.kind === 'draft_unsupported')!.runId!;
      const ids = [superseded, ...checkRuns(row!.id, 1), ...checkRuns(row!.id, 2), askSupportRepairRunId(row!.id)];
      const runs = await runStates(ids);
      expect(runs).toHaveLength(2 + 2 * BATCHES);
      expect(runs.every((run) => run.closed)).toBe(true);
      expect(runs.find((run) => run.id === superseded)?.state).toBe('failed');

      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({ status: 'ready', content: { assetId: order.assetId } });
    });

    describe('a draft the validator refuses for copying a passage (D-294)', () => {
      /** A passage sentence of the labelled lighthouse fixture, word for word: more than nine words in a row. */
      const COPIED = 'A prism ring around the flame gathers the light into a single beam that sweeps across the water.';
      const OWN_TAIL = 'This tail is the writer’s own sentence and the notes never repeat it.';
      const copiedDraft = () =>
        answerWith(fixtureAnswer({ sentence: [BEFORE_SENTENCE, `${COPIED} ${OWN_TAIL}`] }));
      /** The `<repair-notes>` data of a writer request, as the model would read it. */
      const notesOf = (call: FixtureCall) =>
        /<repair-notes>\n([\s\S]*?)\n<\/repair-notes>/u.exec(call.request.user)?.[1] ?? '';

      it('is repaired once with the passage words it copied named by block, and the repair is checked and served', async () => {
        await setup();
        const { person, requestId, order } = await orderedAsk();
        let writes = 0;
        writer = () => {
          writes += 1;
          return writes === 1 ? copiedDraft() : answerWith(fixtureAnswer());
        };

        const done = await publish(order.recipe);

        expect(done).toMatchObject({ kind: 'finished', result: { outcome: 'published', take: 1 } });
        // The draft and the validator's one repair; the checker read the repaired answer only, since the first never compiled.
        expect(production.writerCalls).toHaveLength(2);
        expect(production.supportCalls).toHaveLength(BATCHES);
        const [primary, repair] = production.writerCalls.map((call) => call.request);
        expect(primary!.user).not.toContain('<repair-notes>');
        expect(repair!.system).toContain('Rewrite only the sentences of this block that contain one');
        expect(repair!.system).toContain('the <repair-notes> block there holds facts about it');
        // The notes name the block and the passage's own words, and nothing the model wrote besides.
        const notes = notesOf(production.writerCalls[1]!);
        expect(notes).toContain('keep its key terms');
        expect(notes).toContain(
          'blocks[1] copies: "a prism ring around the flame gathers the light into a single beam that sweeps across the water"',
        );
        expect(notes).not.toContain('tail');
        expect(notes).not.toContain('writer’s own');
        expect(repair!.user).toContain('<previous-answer>');
        // Both writer requests are the question writer, version 6.
        const [row] = await jobsOf(order.recipe);
        const attempts = await database.db
          .selectFrom('reasoning.production_attempts')
          .select(['role_version', 'step', 'state'])
          .where('run_id', '=', row!.writer_run_id)
          .orderBy('reserved_at')
          .execute();
        expect(attempts).toEqual([
          { role_version: 'question-writer.v6', step: 'primary', state: 'succeeded' },
          { role_version: 'question-writer.v6', step: 'repair', state: 'succeeded' },
        ]);
        // The answer served has none of the copied sentence, and every sentence of it passed the check.
        const stored = JSON.stringify((await storedAnswer(order.assetId))?.document);
        expect(stored).not.toContain('gathers the light into a single beam');
        expect(row!.outcomes).toContainEqual(
          expect.objectContaining({ role: 'support_check', kind: 'checked', draft: 1, unsupported: [] }),
        );
        await resolve(job(person, requestId));
        expect(await status(person, requestId)).toMatchObject({ status: 'ready', content: { assetId: order.assetId } });
      });

      it('ends the job when the repair copies again, with no second repair and no check', async () => {
        await setup();
        const { order } = await orderedAsk();
        writer = () => copiedDraft();

        expect(await publish(order.recipe)).toMatchObject({
          result: { outcome: 'rejected', codes: ['invalid_output'] },
        });
        expect(production.writerCalls).toHaveLength(2);
        expect(production.supportCalls).toHaveLength(0);
        expect(notesOf(production.writerCalls[1]!)).toContain('blocks[1] copies: ');
        expect(await storedAnswer(order.assetId)).toBeUndefined();
      });
    });

    it('checks the title like any sentence: an unsupported title is repaired once, and the repaired title is what the person gets (B1.4)', async () => {
      await setup();
      const { order } = await orderedAsk();
      const title = 'How a lamp and a prism ring guide sailors';
      const repairedTitle = 'How a prism ring and a lamp guide sailors';
      let writes = 0;
      writer = () => {
        writes += 1;
        return answerWith(fixtureAnswer(writes === 1 ? {} : { sentence: [title, repairedTitle] }));
      };
      supportScript = (check, call) => (firstDraft(check) ? supportReply(call, flagged(title)) : supportReply(call));

      expect(await publish(order.recipe)).toMatchObject({ result: { outcome: 'published' } });

      // The checker was shown the title as the first sentence, resting on everything the answer cites.
      const { sentences } = supportRequestOf(production.supportCalls[0]!);
      expect(sentences[0]!.text).toBe(title);
      expect(sentences[0]!.cites.length).toBeGreaterThan(4);
      expect(production.writerCalls[1]!.request.user).toContain(`Sentence "${title}"`);
      expect((await storedAnswer(order.assetId))?.document).toMatchObject({ title: repairedTitle });
    });

    it('refuses when the repaired answer still has an unsupported sentence: nothing is stored and the person gets the honest state', async () => {
      await setup();
      const { person, requestId, order } = await orderedAsk();
      supportScript = (_check, call) => supportReply(call, flagged(BEFORE));

      const done = await publish(order.recipe);

      expect(done).toMatchObject({
        kind: 'finished',
        result: { outcome: 'rejected', codes: ['support_check_failed'] },
      });
      // One repair and no more: two writer requests and two checks of two batches each, inside the bound of twelve.
      expect(production.writerCalls).toHaveLength(2);
      expect(production.supportCalls).toHaveLength(2 * BATCHES);
      expect(await storedAnswer(order.assetId)).toBeUndefined();
      expect(
        await database.db.selectFrom('content.assets').select('id').where('id', '=', order.assetId).execute(),
      ).toEqual([]);
      // The person is never served an unchecked answer: the existing refusal state.
      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
      const [row] = await jobsOf(order.recipe);
      const ids = [...checkRuns(row!.id, 1), ...checkRuns(row!.id, 2), askSupportRepairRunId(row!.id)];
      expect((await runStates(ids)).every((run) => run.closed)).toBe(true);
    });

    it('lets Try again make the next take, which is checked again from the start', async () => {
      await setup();
      const { person, requestId, order } = await orderedAsk();
      supportScript = (_check, call) => supportReply(call, flagged(BEFORE));
      expect(await publish(order.recipe)).toMatchObject({ result: { outcome: 'rejected' } });
      await resolve(job(person, requestId));
      supportScript = (_check, call) => supportReply(call);
      const tried = await retry(person.authority, {
        version: 'content-request-retry.v1',
        commandId: randomUUID(),
        requestId,
      });
      expect(tried).toMatchObject({ kind: 'ok', value: { outcome: 'retrying' } });
      expect(await publish(order.recipe, 2)).toMatchObject({ result: { outcome: 'published', take: 2 } });
      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({ status: 'ready', content: { assetId: order.assetId } });
    });

    it('has no repair to give a draft the validator already repaired: an unsupported sentence ends the job at once', async () => {
      await setup();
      const { order } = await orderedAsk();
      let writes = 0;
      writer = () => {
        writes += 1;
        return writes === 1 ? answerWith({ title: 'not a Scroll' }) : answerWith(fixtureAnswer());
      };
      supportScript = (_check, call) => supportReply(call, flagged(BEFORE));

      expect(await publish(order.recipe)).toMatchObject({
        result: { outcome: 'rejected', codes: ['support_check_failed'] },
      });
      // The draft and the validator's repair were two writer requests already, so one check only.
      expect(production.writerCalls).toHaveLength(2);
      expect(production.supportCalls).toHaveLength(BATCHES);
    });

    it('ends the job when the repair an unsupported sentence earned is refused by the validator, with no second repair', async () => {
      await setup();
      const { order } = await orderedAsk();
      let writes = 0;
      writer = () => {
        writes += 1;
        return writes === 1 ? answerWith(fixtureAnswer()) : { kind: 'malformed' };
      };
      supportScript = (_check, call) => supportReply(call, flagged(BEFORE));

      expect(await publish(order.recipe)).toMatchObject({
        result: { outcome: 'rejected', codes: ['support_repair_invalid_output'] },
      });
      expect(production.writerCalls).toHaveLength(2);
      expect(production.supportCalls).toHaveLength(BATCHES);
      expect(await storedAnswer(order.assetId)).toBeUndefined();
    });

    it.each([
      ['malformed', () => ({ kind: 'malformed' }) as FixtureScenario, 'invalid_output', 2],
      ['a provider failure', () => ({ kind: 'rate_limited' }) as FixtureScenario, 'provider_failed', 1],
      [
        'a reply that skips a sentence',
        (_check: number, call: FixtureCall) =>
          answerWith({
            sentences: supportRequestOf(call)
              .sentences.slice(1)
              .map((sentence) => ({ n: sentence.n, verdict: 'no_claim' })),
          }),
        'invalid_output',
        2,
      ],
    ] as const)('never serves an unchecked answer: %s refuses the answer', async (_name, reply, code, requests) => {
      await setup();
      const { person, requestId, order } = await orderedAsk();
      supportScript = reply;

      expect(await publish(order.recipe)).toMatchObject({
        result: { outcome: 'rejected', codes: [`support_check_${code}`] },
      });
      // The first batch is asked once, and once more when its reply is unusable (the harness's single repair); the
      // second batch is never asked, because none of the answer is known.
      expect(production.supportCalls).toHaveLength(requests);
      expect(production.writerCalls).toHaveLength(1);
      expect(await storedAnswer(order.assetId)).toBeUndefined();
      const [row] = await jobsOf(order.recipe);
      expect(row!.outcomes).toContainEqual(expect.objectContaining({ role: 'support_check', kind: 'unchecked', code }));
      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
    });

    /** The reply the fixture gives, with the verdict of sentence `n` replaced. */
    function withVerdict(reply: FixtureScenario, n: number, verdict: object): FixtureScenario {
      if (reply.kind !== 'success') throw new Error('CI: the fixture reply is a success');
      const parsed = JSON.parse(reply.text) as { sentences: { n: number }[] };
      return answerWith({
        sentences: parsed.sentences.map((sentence) => (sentence.n === n ? { n, ...verdict } : sentence)),
      });
    }
    const codesOfFirstCheck = async (recipe: string) => {
      const [row] = await jobsOf(recipe);
      const receipt = (row!.outcomes as { role: string; draft?: number; unsupported?: { code?: string }[] }[]).find(
        (one) => one.role === 'support_check' && one.draft === 1,
      );
      return (receipt?.unsupported ?? []).map((one) => one.code);
    };

    it('sets aside only the sentence whose quote is not in its passages: the others keep their verdicts, the writer repairs it once, and the repair is served (D-265)', async () => {
      await setup();
      const { order } = await orderedAsk();
      const bad = numberOf(BEFORE);
      let writes = 0;
      writer = () => {
        writes += 1;
        return answerWith(fixtureAnswer(writes === 1 ? {} : { sentence: [BEFORE_SENTENCE, REPAIRED] }));
      };
      supportScript = (check, call) =>
        firstDraft(check)
          ? withVerdict(supportReply(call), bad, {
              verdict: 'supported',
              quote: 'words that no passage ever contained',
            })
          : supportReply(call);

      expect(await publish(order.recipe)).toMatchObject({ result: { outcome: 'published' } });

      // No reply was refused whole, so no harness repair was paid for: two checks of two batches, and the writer's one repair.
      expect(production.supportCalls).toHaveLength(2 * BATCHES);
      expect(production.writerCalls).toHaveLength(2);
      const [row] = await jobsOf(order.recipe);
      const receipts = row!.outcomes as { role: string; draft?: number; unsupported?: unknown }[];
      // Exactly that sentence is unsupported, with the rule its verdict broke; the second check finds nothing.
      expect(receipts.filter((receipt) => receipt.role === 'support_check')).toEqual([
        expect.objectContaining({
          draft: 1,
          kind: 'checked',
          unsupported: [{ number: bad, kind: 'not_stated', code: 'quote_not_in_cited_passages' }],
        }),
        expect.objectContaining({ draft: 2, kind: 'checked', unsupported: [] }),
      ]);
      // The writer is told the fixed hint of the kind and the fixed note of the rule, never the checker's quote.
      const repair = production.writerCalls[1]!.request.user;
      expect(repair).toContain(`Sentence "${BEFORE}`);
      expect(repair).toContain(UNSUPPORTED_HINTS.not_stated);
      expect(repair).toContain(`Note: ${RULE_PROBLEMS.quote_not_in_cited_passages}`);
      expect(repair).not.toContain('words that no passage ever contained');
      expect(JSON.stringify((await storedAnswer(order.assetId))?.document)).toContain('a brief flash of it');
    });

    it.each([
      [
        'every sentence marked as stating no fact',
        (_check: number, call: FixtureCall) =>
          answerWith({ sentences: supportRequestOf(call).sentences.map((one) => ({ n: one.n, verdict: 'no_claim' })) }),
        'no_claim_without_ground',
      ],
      [
        'a supported sentence with a quote that no cited passage contains',
        (_check: number, call: FixtureCall) =>
          answerWith({
            sentences: supportRequestOf(call).sentences.map((one) => ({
              n: one.n,
              verdict: 'supported',
              quote: 'words that no passage ever contained',
            })),
          }),
        'quote_not_in_cited_passages',
      ],
      [
        'a quote of a cited passage that is about something else, given for every sentence',
        (_check: number, call: FixtureCall) => {
          const { sentences, passages } = supportRequestOf(call);
          return answerWith({
            sentences: sentences.map((one) => ({
              n: one.n,
              verdict: 'supported',
              quote: (passages.get(one.cites[0]!) ?? '').split(/\s+/u).slice(-4).join(' '),
            })),
          });
        },
        'quote_not_about_sentence',
      ],
    ] as const)(
      'does not serve an answer whose sentences the rules set aside, and does not call the check unusable: %s',
      async (_name, reply, code) => {
        await setup();
        const { person, requestId, order } = await orderedAsk();
        supportScript = reply;

        expect(await publish(order.recipe)).toMatchObject({
          result: { outcome: 'rejected', codes: ['support_check_failed'] },
        });
        // Every reply had the shape: no harness repair was paid for. One writer repair, then the same finding again.
        expect(production.supportCalls).toHaveLength(2 * BATCHES);
        expect(production.writerCalls).toHaveLength(2);
        expect(await codesOfFirstCheck(order.recipe)).toContain(code);
        expect(await storedAnswer(order.assetId)).toBeUndefined();
        await resolve(job(person, requestId));
        expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
      },
    );

    it('accepts the short headings and a limits line as stating no fact, and serves the answer when the rest is supported', async () => {
      await setup();
      const { order } = await orderedAsk();
      const numbers = sentencesOfAnswer(AuthoredScroll.parse(fixtureAnswer()));
      const short = numbers
        .filter((one) => one.label === true && wordsOf(one.text).length <= MAX_LABEL_WORDS)
        .map((one) => one.number);
      const limits = numbers.find((one) => one.text.startsWith('This picture ignores'))!.number;
      // The headings and the callout's title are short; the title is not and is judged by a quote like a sentence.
      expect(short).toHaveLength(4);
      supportScript = (_check, call) => {
        let reply = supportReply(call);
        for (const n of [...short, limits])
          if (supportRequestOf(call).sentences.some((one) => one.n === n))
            reply = withVerdict(reply, n, { verdict: 'no_claim' });
        return reply;
      };

      expect(await publish(order.recipe)).toMatchObject({ result: { outcome: 'published' } });
      expect(production.supportCalls).toHaveLength(BATCHES);
    });

    it('does not take the title for a label that states no fact: marked so, it is unsupported, and the writer repairs it once (D-266)', async () => {
      await setup();
      const { order } = await orderedAsk();
      const title = 'How a lamp and a prism ring guide sailors';
      const repairedTitle = 'How a prism ring and a lamp guide sailors';
      let writes = 0;
      writer = () => {
        writes += 1;
        return answerWith(fixtureAnswer(writes === 1 ? {} : { sentence: [title, repairedTitle] }));
      };
      supportScript = (check, call) =>
        firstDraft(check) ? withVerdict(supportReply(call), 1, { verdict: 'no_claim' }) : supportReply(call);

      expect(await publish(order.recipe)).toMatchObject({ result: { outcome: 'published' } });

      expect(production.writerCalls).toHaveLength(2);
      expect(await codesOfFirstCheck(order.recipe)).toEqual(['no_claim_without_ground']);
      expect((await storedAnswer(order.assetId))?.document).toMatchObject({ title: repairedTitle });
    });

    it('checks an answer of 23 sentences in three requests of at most ten, each with the passages of its own sentences, and closes every run', async () => {
      await setup();
      const { order } = await orderedAsk();
      const base = fixtureAnswer();
      const longAnswer = AuthoredScroll.parse({
        ...base,
        blocks: [
          ...base.blocks.slice(0, -1),
          {
            type: 'paragraph',
            cites: ['e1', 'e6'],
            text: [
              'Winter nights are long, so the keeper tends the lamp clockwork often.',
              'A small motor now does the winding that the keeper once did.',
              'The glass prisms were kept when the clockwork was replaced.',
              'The old clockwork has been replaced, but the original prisms remain.',
            ].join(' '),
          },
          base.blocks.at(-1)!,
        ],
      });
      writer = () => answerWith(longAnswer);

      expect(await publish(order.recipe)).toMatchObject({ result: { outcome: 'published', requestBound: 12 } });

      expect(sentencesOfAnswer(longAnswer)).toHaveLength(23);
      expect(production.supportCalls).toHaveLength(3);
      const asked = production.supportCalls.map((call) => supportRequestOf(call));
      expect(asked.map((request) => request.sentences.length)).toEqual([10, 10, 3]);
      expect(asked.flatMap((request) => request.sentences.map((one) => one.n))).toEqual(
        Array.from({ length: 23 }, (_unused, index) => index + 1),
      );
      // A request carries the passages its own sentences cite, and no other.
      for (const request of asked)
        expect([...request.passages.keys()].sort()).toEqual(
          [...new Set(request.sentences.flatMap((one) => one.cites))].sort(),
        );
      const [row] = await jobsOf(order.recipe);
      const ids = Array.from({ length: 3 }, (_unused, batch) => askSupportRunId(row!.id, 1, batch));
      expect(await runStates(ids)).toEqual(
        ids.map((id) => ({ id, state: 'completed', closed: true })).sort((a, b) => a.id.localeCompare(b.id)),
      );
      expect(row!.outcomes).toContainEqual(
        expect.objectContaining({ role: 'support_check', kind: 'checked', draft: 1, sentences: 23, batches: 3 }),
      );
    });

    it('repairs one unusable reply in the whole check, wherever it happens: a second unusable reply in a later batch refuses the answer', async () => {
      await setup();
      const { order } = await orderedAsk();
      // Request 1 (batch one) is malformed and its repair is good; request 3 (batch two) is malformed and has no repair left.
      supportScript = (check, call) => (check === 1 || check === 3 ? { kind: 'malformed' } : supportReply(call));

      expect(await publish(order.recipe)).toMatchObject({
        result: { outcome: 'rejected', codes: ['support_check_invalid_output'] },
      });
      expect(production.supportCalls).toHaveLength(3);
      expect(production.writerCalls).toHaveLength(1);
      expect(await storedAnswer(order.assetId)).toBeUndefined();
    });

    it('never resends a check of unknown outcome: the job waits for an operator and Try again starts nothing', async () => {
      await setup();
      const { person, requestId, order } = await orderedAsk();
      supportScript = () => ({ kind: 'timeout_after_dispatch' });

      expect(await publish(order.recipe)).toMatchObject({
        result: { outcome: 'unknown', codes: ['support_check_outcome_unknown'] },
      });
      // A redelivery answers from the job: nothing is sent again.
      expect(await publish(order.recipe)).toMatchObject({ result: { outcome: 'unknown' } });
      expect(production.supportCalls).toHaveLength(1);
      expect(production.writerCalls).toHaveLength(1);
      expect(
        await database.db
          .selectFrom('reasoning.production_attempts')
          .select('role_id')
          .where('state', '=', 'unknown')
          .execute(),
      ).toEqual([{ role_id: 'content.ask-support-check' }]);
      await resolve(job(person, requestId));
      expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
      expect(
        await retry(person.authority, { version: 'content-request-retry.v1', commandId: randomUUID(), requestId }),
      ).toMatchObject({ value: { outcome: 'not_retryable' } });
    });

    it('pauses when the quota is spent before the check, and finishes later without asking the writer again', async () => {
      await setup();
      const { order } = await orderedAsk();
      let released = false;
      const worker = fixtureProductionWorker(database, () => writer(), {
        // The writer's request is allowed; the provider's quota is spent by the time the checker would be asked.
        quota: () => ({
          verdict: released || worker.writerCalls.length === 0 ? 'not_applicable' : 'unavailable',
          intervalRemainingPercent: null,
          weeklyRemainingPercent: null,
        }),
      });
      const produce = worker.producer();

      expect(await produce(order.recipe, false, signal(), true, 1)).toMatchObject({
        outcome: 'paused',
        codes: ['quota_unavailable'],
      });
      expect(worker.writerCalls).toHaveLength(1);
      expect(worker.supportCalls).toHaveLength(0);
      expect(await storedAnswer(order.assetId)).toBeUndefined();

      released = true;
      expect(await produce(order.recipe, false, signal(), true, 1)).toMatchObject({ outcome: 'published' });
      // The writer's kept answer was read from the ledger: no second writer request was paid for.
      expect(worker.writerCalls).toHaveLength(1);
      expect(worker.supportCalls).toHaveLength(BATCHES);
    });

    it('pauses between two batches of a check, and finishes later without paying for the first batch again', async () => {
      await setup();
      const { order } = await orderedAsk();
      let released = false;
      const worker = fixtureProductionWorker(database, () => writer(), {
        // The writer and the first batch are allowed; the quota is spent when the second batch would be asked.
        quota: () => ({
          verdict: released || worker.supportCalls.length === 0 ? 'not_applicable' : 'unavailable',
          intervalRemainingPercent: null,
          weeklyRemainingPercent: null,
        }),
      });
      const produce = worker.producer();

      expect(await produce(order.recipe, false, signal(), true, 1)).toMatchObject({
        outcome: 'paused',
        codes: ['quota_unavailable'],
      });
      expect(worker.supportCalls).toHaveLength(1);
      expect(await storedAnswer(order.assetId)).toBeUndefined();

      released = true;
      expect(await produce(order.recipe, false, signal(), true, 1)).toMatchObject({ outcome: 'published' });
      // The first batch's reply was read from the ledger: only the second batch was asked in all.
      expect(worker.writerCalls).toHaveLength(1);
      expect(worker.supportCalls).toHaveLength(BATCHES);
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

      writer = () => answerWith(fixtureAnswer());
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

  describe('a person who paused and resumed recording (D-264)', () => {
    /** Pause then resume through the real policy command: generation 1 on, 2 off, 3 on. */
    async function pauseAndResume(person: FixturePerson) {
      await toggleRecording(person, 1, false);
      await toggleRecording(person, 2, true);
    }
    /** A typed question asked after the pause and resume, at the person's current generation. */
    async function askedAfterResume(question = 'How do ships know where the land begins?') {
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
      const requestId = await ask(person, askCommand(exposure, 'How do ships know where the land begins?'));
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
      const requestId = await ask(person, askCommand(exposure, 'How do ships know where the land begins?'));
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
      const requestId = await ask(person, askCommand(exposure, 'How do ships know where the land begins?'));
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
      const requestId = await ask(person, askCommand(exposure, 'How do ships know where the land begins?'));
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
      const requestId = await ask(person, askCommand(exposure, 'How do ships know where the land begins?'));
      await resolve(job(person, requestId));
      expect(libraryCalls()).toHaveLength(1);
      expect(await status(person, requestId)).toMatchObject({ status: 'unavailable', reason: 'could_not_prepare' });
      expect(await askOrders()).toEqual([]);
    });

    it('stores nothing for a question in flight across Clear: no order, no job and nothing written for the new epoch', async () => {
      await setup();
      const { person, exposure } = await reader();
      const requestId = await ask(person, askCommand(exposure, 'How do ships know where the land begins?'));
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
      const requestId = await ask(person, askCommand(exposure, 'How do ships know where the land begins?'));
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
          await create(
            person.authority,
            askCommand(exposure, 'How do ships know where the land begins?', { recordingGeneration: generation }),
          ),
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
