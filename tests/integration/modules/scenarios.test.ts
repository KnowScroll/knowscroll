/**
 * What if and Another perspective in a content thread over real PostgreSQL and pg-boss (D-049):
 * drafts that commission nothing, a choice that commissions exactly once, membership at every step,
 * hypothetical status carried down the graph, and Scrolls made for a thread that never touch the
 * real-world map. The Scenario Planner and the writer are labelled CI fixture models: nothing here is
 * provider output.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ContentThreadRef, ScenarioCard } from '@knowscroll/contracts';
import { makeEnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import { createDatabase, makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  READ_SCROLL_SOURCE_PAGES,
  READ_SHAREABLE_CONTENT,
  RECORD_MADE_TO_ORDER_SCROLL,
  SCROLL_PRODUCTION_VERSION,
  madeToOrderKey,
  type ReadOrderAudience,
} from '@knowscroll/backend/modules/content';
import { READ_THREAD_STANDING, THREAD_GUEST } from '@knowscroll/backend/modules/social';
import {
  makeCheckAssetAudience,
  makeReadMadeToOrderProduction,
  readScrollSourcePages,
  recordMadeToOrderScroll,
} from '../../../packages/backend/src/modules/content/adapters/made-to-order.js';
import {
  readDiscoveryCandidates,
  readSavedPageMetadata,
} from '../../../packages/backend/src/modules/content/adapters/discovery-store.js';
import { gateSavedPageMetadata } from '../../../packages/backend/src/modules/experience/adapters/audience-gate.js';
import {
  UNREACHABLE_TITLE,
  experienceExportRead,
} from '../../../packages/backend/src/modules/experience/adapters/export.js';
import { gateSnippetAnchors } from '../../../packages/backend/src/modules/social/adapters/snippet-audience.js';
import {
  resolveSnippetAnchor,
  validateSnippetAnchor,
} from '../../../packages/backend/src/modules/content/adapters/snippet-anchors.js';
import { readShareableContent } from '../../../packages/backend/src/modules/content/adapters/shareable-content.js';
import { makeReadOrderAudience } from '../../../packages/backend/src/modules/scenarios/application/audience.js';
import { makeResolveBranches } from '../../../packages/backend/src/modules/scenarios/application/resolve.js';
import { branchPoolStore } from '../../../packages/backend/src/modules/scenarios/adapters/postgres-store.js';
import { makeReadThreadStanding } from '../../../packages/backend/src/modules/social/adapters/postgres-thread-guest.js';
import { scenarioOrderProviders } from '@knowscroll/backend/modules/supply/nest-providers';
import {
  SCENARIO_USE_CASES,
  SUGGEST_SCENARIO_DRAFT,
  type ScenarioUseCases,
  type SuggestStep,
} from '@knowscroll/backend/modules/scenarios';
import { scenarioProviders, scenarioWorkerProviders } from '@knowscroll/backend/modules/scenarios/nest-providers';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureAuthored, answerWith } from '../support/generated-scroll.js';
import { fixtureHarness, fixtureModel, gate, protectedRequestsOf } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import { fixtureProductionWorker } from '../support/production-worker.js';
import { buildRecursively } from '../support/providers.js';
import { scrollUseCases, textCapabilities } from '../support/scroll.js';
import {
  befriend,
  friendCommand,
  pairRevision,
  seedFriend,
  talkCases,
  type Friend,
  type Friends,
  type Threads,
} from '../support/talk.js';
import { seedScroll } from '../support/thread-fixtures.js';

const threadVersion = 'content-thread.v1' as const;
const version = 'scenario.v1' as const;

const traffic = { subject: 'Traffic', statement: 'Traffic is ten times higher than in the original' };
const model = { subject: 'Model', statement: 'The same model serves every request' };
const latency = { subject: 'Latency target', statement: 'Every answer arrives within the same target' };
const batching = {
  title: 'What does batching change at ten times the traffic?',
  explanation: 'Shows how batching holds the cost per answer down.',
  changes: [traffic],
  kept: [model],
  lens: null,
  needsConfirmation: false,
};
const instances = {
  title: 'What do more instances change at ten times the traffic?',
  explanation: 'Shows how adding instances trades cost for waiting.',
  changes: [{ ...traffic, statement: 'Traffic is ten times higher, spread over more instances' }],
  kept: [model],
  lens: null,
  needsConfirmation: false,
};
const portal = {
  title: 'What if a black hole were a portal?',
  explanation: 'Reasons from a premise the physics does not support.',
  changes: [{ subject: 'Black hole', statement: 'A black hole is a doorway to somewhere else' }],
  kept: [],
  lens: null,
  needsConfirmation: true,
};
const operatorView = {
  title: 'The view of the person on call',
  explanation: 'Looks at serving through the person who is paged.',
  changes: [],
  kept: [],
  lens: 'the view of the person on call',
  needsConfirmation: false,
};

function unwrap<T>(result: { kind: 'ok'; value: T } | { kind: 'refused'; code: string }): T {
  if (result.kind !== 'ok') throw new Error(`refused: ${result.code}`);
  return result.value;
}

describe('What if and Another perspective (real PostgreSQL, CI fixture models)', () => {
  let database: TestDatabase<Database>;
  let friends: Friends;
  let threads: Threads;
  let talk: ReturnType<typeof talkCases>['talk'];
  let scenarios: ScenarioUseCases;
  let suggest: SuggestStep;
  let compose: (caps: { perDay: number; perThread: number }) => { scenarios: ScenarioUseCases; suggest: SuggestStep };
  let content: Awaited<ReturnType<typeof scrollUseCases>>;
  let production: ReturnType<typeof fixtureProductionWorker>;
  let plannerScript: (sequence: number) => FixtureScenario | Promise<FixtureScenario>;
  let plannerCalls = () => 0;
  let orderAudience: ReadOrderAudience;
  let standing: ReturnType<typeof makeReadThreadStanding>;
  /** Where each thread-standing read ran: inside a transaction (`scope`) or on the pool. */
  let standingReads: ('scope' | 'pool')[] = [];
  let announced: string[] = [];
  let sent: [string, number][] = [];

  beforeAll(async () => {
    database = await createTestDatabase<Database>('scenarios');
    await sql`update reasoning.production_scopes set enabled=true where id='scroll-supply'`.execute(database.db);
    const cases = talkCases(database.db);
    friends = cases.friends;
    threads = cases.threads;
    talk = cases.talk;
    const standingOnPool = makeReadThreadStanding(database.db);
    standing = (on, accountId, threadId) => {
      standingReads.push('scope' in on ? 'scope' : 'pool');
      return standingOnPool(on, accountId, threadId);
    };
    orderAudience = makeReadOrderAudience(branchPoolStore(database.db), standing);
    content = await scrollUseCases(database, { orderAudience });
    production = fixtureProductionWorker(database, () => answerWith(fixtureAuthored('comparison')));
    plannerScript = () => answerWith({ mode: 'options', options: [batching, instances] });
    const planner = fixtureModel((sequence) => plannerScript(sequence), { label: 'scenario-planner-CI-fixture' });
    plannerCalls = () => planner.calls.length;

    const SCOPE = Symbol('scope');
    const ENQUEUE = Symbol('enqueue');
    const DATABASE = Symbol('database');
    const CONFIG = Symbol('config');
    const HARNESS = Symbol('harness');
    /** The scenario use cases and the planner step, composed from the real providers under the given caps. */
    compose = (caps) => {
      const values = new Map<symbol, unknown>([
        [SCOPE, makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })],
        [ENQUEUE, makeEnqueueJob(content.boss)],
        [DATABASE, database.db],
        [CONFIG, { supplyScenarioDailyCap: caps.perDay, supplyScenarioThreadCap: caps.perThread }],
        [HARNESS, fixtureHarness(database.db, { model: planner }).harness],
        [THREAD_GUEST, cases.guest],
        [READ_THREAD_STANDING, standing],
        [READ_SHAREABLE_CONTENT, readShareableContent],
        [READ_SCROLL_SOURCE_PAGES, readScrollSourcePages],
        [RECORD_MADE_TO_ORDER_SCROLL, recordMadeToOrderScroll],
      ]);
      const providers = [
        ...scenarioProviders({ withPersonalScope: SCOPE, database: DATABASE, enqueueJob: ENQUEUE }),
        ...scenarioOrderProviders({ enqueueJob: ENQUEUE, config: CONFIG }),
        ...scenarioWorkerProviders({ withPersonalScope: SCOPE, database: DATABASE, harness: HARNESS }),
      ];
      const build = <T>(token: symbol) => buildRecursively(providers, token, values) as T;
      return {
        scenarios: build<ScenarioUseCases>(SCENARIO_USE_CASES),
        suggest: build<SuggestStep>(SUGGEST_SCENARIO_DRAFT),
      };
    };
    ({ scenarios, suggest } = compose({ perDay: 100, perThread: 100 }));
  });
  afterAll(async () => {
    await content.close();
    await database.drop();
  });

  // --- A thread to explore ------------------------------------------------------------------

  /** An admitted Scroll with recorded sources, as a generated one has. */
  async function seedRoot() {
    const scroll = await seedScroll(database.db, 'attention-slowly');
    await database.db
      .insertInto('content.asset_provenance')
      .values({
        asset_id: scroll.assetId,
        revision: 1,
        provenance_version: 'scroll-provenance.v1',
        provenance: JSON.stringify({
          schemaVersion: 'scroll-provenance.v1',
          // Pages of the library plan: the research boundary refuses a page outside its allowlist.
          sources: TOPICS.seasons.pages.map((url, index) => ({ sourceId: `s${index + 1}`, title: 'CI source', url })),
        }),
      })
      .execute();
    return { assetId: scroll.assetId, assetRevision: 1 };
  }

  interface Begun {
    readonly a: Friend;
    readonly b: Friend;
    readonly aRef: ContentThreadRef;
    readonly bRef: ContentThreadRef;
    readonly root: { assetId: string; assetRevision: number };
  }

  /** Asha started a thread on a generated Scroll; Ravi joined. */
  async function begun(): Promise<Begun> {
    const a = await seedFriend(database.db, friends);
    const b = await seedFriend(database.db, friends);
    await befriend(friends, a, b);
    const root = await seedRoot();
    const started = unwrap(
      await threads.create(a.authority, {
        version: threadVersion,
        commandId: randomUUID(),
        root,
        friendPersonIds: [b.person.personId],
        name: 'Serving costs',
      }),
    );
    const inbox = unwrap(await threads.inbox(b.authority, { version: threadVersion, readId: randomUUID(), limit: 50 }));
    const bRef = inbox.items[0]?.thread;
    if (!bRef) throw new Error('CI invitation missing');
    unwrap(
      await threads.respond(b.authority, {
        version: threadVersion,
        commandId: randomUUID(),
        thread: bRef,
        response: 'join',
      }),
    );
    return { a, b, aRef: started.thread, bRef, root };
  }

  const startDraft = (
    who: Friend,
    thread: ContentThreadRef,
    root: Begun['root'],
    overrides: Record<string, unknown> = {},
    commandId = randomUUID(),
  ) =>
    scenarios.draft(who.authority, {
      version,
      commandId,
      thread,
      kind: 'what_if',
      origin: { kind: 'root' },
      parent: { kind: 'root', assetRevision: root.assetRevision },
      text: 'What if traffic increases tenfold?',
      ...overrides,
    });
  const readDraft = (who: Friend, thread: ContentThreadRef, draftId: string) =>
    scenarios.readDraft(who.authority, { version, readId: randomUUID(), thread, draftId });
  const choose = (
    who: Friend,
    thread: ContentThreadRef,
    draftId: string,
    selection: Record<string, unknown> = { kind: 'suggestion', optionId: 'o1' },
    commandId = randomUUID(),
  ) => scenarios.choose(who.authority, { version, commandId, thread, draftId, selection });
  const list = async (who: Friend, thread: ContentThreadRef) =>
    unwrap(await scenarios.list(who.authority, { version, readId: randomUUID(), thread }));
  async function cards(who: Friend, thread: ContentThreadRef): Promise<readonly ScenarioCard[]> {
    const found = await list(who, thread);
    return found.status === 'ready' ? found.cards : [];
  }

  /** Starts a draft and lets the planner answer it. */
  async function drafted(who: Friend, thread: ContentThreadRef, root: Begun['root'], overrides = {}) {
    const started = unwrap(await startDraft(who, thread, root, overrides));
    await suggest(
      { v: 1, universeId: who.universeId, privacyEpoch: 1, draftId: started.draftId },
      new AbortController().signal,
    );
    return started.draftId;
  }

  const jobsOf = async (name: string) =>
    (await sql<{ id: string }>`select id from pgboss.job where name = ${name}`.execute(database.db)).rows;
  const produceJobsFor = async (recipe: string) =>
    (
      await sql<{
        id: string;
      }>`select id from pgboss.job where name = 'content.produce-scroll' and data->>'recipe' = ${recipe}`.execute(
        database.db,
      )
    ).rows;
  const counts = async () => ({
    nodes: Number(
      (
        await database.db
          .selectFrom('scenarios.nodes')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    ),
    orders: Number(
      (
        await database.db
          .selectFrom('supply.scenario_orders')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    ),
    made: Number(
      (
        await database.db
          .selectFrom('content.made_to_order_scrolls')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    ),
  });

  /** Runs the production job of a branch (the fixture writer) and the resolver sweep that binds it. */
  async function prepare(nodeId: string) {
    const recipe = madeToOrderKey(nodeId);
    const outcome = await production.run(
      { v: 1, recipe, policyVersion: SCROLL_PRODUCTION_VERSION, take: 1 },
      { signal: new AbortController().signal },
    );
    expect(outcome).toMatchObject({ kind: 'finished', result: { outcome: 'published' } });
    const summary = await resolver().resolveBranches();
    expect(summary.bound).toBeGreaterThanOrEqual(1);
  }
  /** A production job that ended rejected, as a writer that failed its checks leaves it. */
  const rejectTake = (recipe: string, take: number) =>
    sql`insert into content.scroll_production_runs (id,topic,policy_version,take,target_revision,scope_generation,state,writer_run_id,completed_at) values (${randomUUID()},${recipe},${SCROLL_PRODUCTION_VERSION},${take},1,1,'rejected',${randomUUID()},now())`.execute(
      database.db,
    );
  function resolver() {
    announced = [];
    sent = [];
    const resolveBranches = makeResolveBranches({
      store: branchPoolStore(database.db),
      readProduction: makeReadMadeToOrderProduction(database.db),
      sendProduction: (recipe, take) => {
        sent.push([recipe, take]);
        return Promise.resolve();
      },
      announce: (threadId) => {
        announced.push(threadId);
        return Promise.resolve();
      },
      now: () => new Date(),
    });
    return { resolveBranches };
  }

  // --- Tests --------------------------------------------------------------------------------

  describe('a draft', () => {
    it('stores the request and one bounded model step, and commissions nothing', async () => {
      const { a, aRef, root } = await begun();
      const before = await counts();
      const started = unwrap(await startDraft(a, aRef, root));
      expect(started).toMatchObject({ operation: 'scenario.draft', replayed: false });
      expect(await readDraft(a, aRef, started.draftId).then(unwrap)).toMatchObject({
        status: 'thinking',
        draft: { kind: 'what_if', text: 'What if traffic increases tenfold?' },
      });
      expect(await counts()).toEqual(before);
      expect((await jobsOf('scenarios.suggest-draft')).length).toBeGreaterThanOrEqual(1);
      expect(await cards(a, aRef)).toEqual([]);

      // The planner answers: directions, still nothing made, nothing ordered, no production job.
      const calls = plannerCalls();
      await suggest(
        { v: 1, universeId: a.universeId, privacyEpoch: 1, draftId: started.draftId },
        new AbortController().signal,
      );
      expect(plannerCalls()).toBe(calls + 1);
      const ready = unwrap(await readDraft(a, aRef, started.draftId));
      expect(ready).toMatchObject({ status: 'ready', mode: 'options' });
      if (ready.status === 'ready') expect(ready.options.map((option) => option.optionId)).toEqual(['o1', 'o2']);
      expect(await counts()).toEqual(before);
      expect(await cards(a, aRef)).toEqual([]);
    });

    it('returns the same draft for the same command, and is refused for another body under it', async () => {
      const { a, aRef, root } = await begun();
      const commandId = randomUUID();
      const first = unwrap(await startDraft(a, aRef, root, {}, commandId));
      const again = unwrap(await startDraft(a, aRef, root, {}, commandId));
      expect(again).toMatchObject({ draftId: first.draftId, replayed: true });
      expect(await startDraft(a, aRef, root, { text: 'Something else' }, commandId)).toEqual({
        kind: 'refused',
        code: 'command_key_reused',
      });
    });

    it('is the requester’s alone: another member cannot read it, a stranger cannot start one', async () => {
      const { a, b, aRef, bRef, root } = await begun();
      const started = unwrap(await startDraft(a, aRef, root));
      expect(unwrap(await readDraft(b, bRef, started.draftId))).toMatchObject({ status: 'unavailable' });
      const stranger = await seedFriend(database.db, friends);
      expect(await startDraft(stranger, aRef, root)).toEqual({ kind: 'refused', code: 'unavailable' });
      expect(unwrap(await readDraft(stranger, aRef, started.draftId))).toMatchObject({ status: 'unavailable' });
    });

    it('is refused for a stale parent, a message outside the thread and a thread nothing of which can be researched', async () => {
      const { a, aRef, root } = await begun();
      expect(await startDraft(a, aRef, root, { parent: { kind: 'root', assetRevision: 7 } })).toEqual({
        kind: 'refused',
        code: 'stale_revision',
      });
      expect(await startDraft(a, aRef, root, { origin: { kind: 'message', messageId: randomUUID() } })).toEqual({
        kind: 'refused',
        code: 'invalid_input',
      });
      // A root whose explanation has no recorded sources and no library recipe cannot be researched by code.
      const bare = await seedScroll(database.db, 'weight-other-worlds');
      const c = await seedFriend(database.db, friends);
      const d = await seedFriend(database.db, friends);
      await befriend(friends, c, d);
      const thread = unwrap(
        await threads.create(c.authority, {
          version: threadVersion,
          commandId: randomUUID(),
          root: { assetId: bare.assetId, assetRevision: 1 },
          friendPersonIds: [d.person.personId],
        }),
      ).thread;
      expect(await startDraft(c, thread, { assetId: bare.assetId, assetRevision: 1 })).toEqual({
        kind: 'refused',
        code: 'unsupported',
      });
    });

    it('can start from a message and a snippet, and tells the planner what they say', async () => {
      const { a, b, aRef, bRef, root } = await begun();
      const message = unwrap(
        await threads.send(b.authority, {
          version: threadVersion,
          commandId: randomUUID(),
          thread: bRef,
          body: { kind: 'text', text: 'What would actually break first if traffic jumped?' },
        }),
      );
      const started = unwrap(
        await startDraft(a, aRef, root, { origin: { kind: 'message', messageId: message.messageId } }),
      );
      const row = await database.db
        .selectFrom('scenarios.drafts')
        .select(['origin_kind', 'origin_message_id'])
        .where('draft_id', '=', started.draftId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ origin_kind: 'message', origin_message_id: message.messageId });
    });
  });

  describe('what the Scenario Planner is told', () => {
    it('is this thread’s words and the request, with no names, and nothing of another thread or a private chat', async () => {
      const { a, b, aRef, bRef, root } = await begun();
      const other = await begun();
      const say = (who: Friend, thread: ContentThreadRef, text: string) =>
        threads.send(who.authority, {
          version: threadVersion,
          commandId: randomUUID(),
          thread,
          body: { kind: 'text', text },
        });
      unwrap(await say(b, bRef, 'RAVI-THREAD-CANARY what would break first?'));
      unwrap(await say(other.a, other.aRef, 'OTHER-THREAD-CANARY something else entirely'));
      const chat = unwrap(
        await talk.conversations.start(a.authority, {
          version: 'direct-conversation.v1',
          commandId: randomUUID(),
          peerPersonId: b.person.personId,
          expectedPairRevision: await pairRevision(friends, a, b),
        }),
      );
      unwrap(
        await talk.conversations.send(a.authority, {
          version: 'direct-conversation.v1',
          commandId: randomUUID(),
          conversation: chat.conversation,
          body: { kind: 'text', text: 'PRIVATE-CHAT-CANARY not for the model' },
        }),
      );

      await drafted(a, aRef, root, { text: 'ASHA-REQUEST-CANARY what if traffic grew?' });
      const sentBytes = (await protectedRequestsOf(database.db, a.universeId))
        .map((row) => Buffer.from(row.body).toString('utf8'))
        .join('\n');
      expect(sentBytes).toContain('ASHA-REQUEST-CANARY');
      expect(sentBytes).toContain('member: RAVI-THREAD-CANARY');
      expect(sentBytes).not.toContain('OTHER-THREAD-CANARY');
      expect(sentBytes).not.toContain('PRIVATE-CHAT-CANARY');
      for (const name of [a.person.handle, b.person.handle, 'Fixture friend']) expect(sentBytes).not.toContain(name);
    });
  });

  describe('a choice', () => {
    it('is idempotent and commissions exactly one demand: a node, an order and one production job', async () => {
      const { a, aRef, root } = await begun();
      const draftId = await drafted(a, aRef, root);
      const before = await counts();
      const commandId = randomUUID();

      const first = unwrap(await choose(a, aRef, draftId, { kind: 'suggestion', optionId: 'o1' }, commandId));
      expect(first).toMatchObject({
        operation: 'scenario.choose',
        replayed: false,
        reused: false,
        node: { kind: 'what_if', status: 'preparing', hypothetical: true, revision: 1, changes: [traffic] },
      });
      const after = await counts();
      expect(after).toEqual({ nodes: before.nodes + 1, orders: before.orders + 1, made: before.made + 1 });
      const recipe = madeToOrderKey(first.node.nodeId);
      expect(await produceJobsFor(recipe)).toHaveLength(1);

      // The same command returns the same branch; nothing is ordered or queued twice.
      const again = unwrap(await choose(a, aRef, draftId, { kind: 'suggestion', optionId: 'o1' }, commandId));
      expect(again).toMatchObject({ replayed: true, node: { nodeId: first.node.nodeId } });
      expect(await counts()).toEqual(after);
      expect(await produceJobsFor(recipe)).toHaveLength(1);

      // A draft is chosen once: another command on it is refused and orders nothing.
      expect(await choose(a, aRef, draftId, { kind: 'suggestion', optionId: 'o2' })).toEqual({
        kind: 'refused',
        code: 'unavailable',
      });
      expect(await counts()).toEqual(after);
      expect(unwrap(await readDraft(a, aRef, draftId))).toMatchObject({ status: 'chosen', nodeId: first.node.nodeId });
    });

    it('serialises two identical commands that arrive together', async () => {
      const { a, aRef, root } = await begun();
      const draftId = await drafted(a, aRef, root);
      const commandId = randomUUID();
      const [one, two] = await Promise.all([
        choose(a, aRef, draftId, { kind: 'suggestion', optionId: 'o1' }, commandId),
        choose(a, aRef, draftId, { kind: 'suggestion', optionId: 'o1' }, commandId),
      ]);
      expect(unwrap(one).node.nodeId).toBe(unwrap(two).node.nodeId);
      expect([unwrap(one).replayed, unwrap(two).replayed].sort()).toEqual([false, true]);
      expect(await cards(a, aRef)).toHaveLength(1);
    });

    it('takes the member’s own complete request without waiting for the model, and drops the late answer', async () => {
      const { a, aRef, root } = await begun();
      const started = unwrap(await startDraft(a, aRef, root));
      const own = unwrap(await choose(a, aRef, started.draftId, { kind: 'own', changes: [traffic], kept: [model] }));
      expect(own.node).toMatchObject({ status: 'preparing', changes: [traffic], kept: [model], hypothetical: true });
      // The planner finishes afterwards: the draft was chosen, so the answer is not applied.
      await suggest(
        { v: 1, universeId: a.universeId, privacyEpoch: 1, draftId: started.draftId },
        new AbortController().signal,
      );
      expect(unwrap(await readDraft(a, aRef, started.draftId))).toMatchObject({ status: 'chosen' });
    });

    it('makes one branch for one idea: a second member choosing the same change reuses the first', async () => {
      const { a, b, aRef, bRef, root } = await begun();
      const forAsha = await drafted(a, aRef, root);
      const forRavi = await drafted(b, bRef, root);
      const first = unwrap(await choose(a, aRef, forAsha));
      const before = await counts();
      const second = unwrap(await choose(b, bRef, forRavi));
      expect(second).toMatchObject({ reused: true, node: { nodeId: first.node.nodeId } });
      expect(await counts()).toEqual(before);
      // Ravi’s draft points at the shared branch; both see one card.
      expect(unwrap(await readDraft(b, bRef, forRavi))).toMatchObject({ status: 'chosen', nodeId: first.node.nodeId });
      expect(await cards(b, bRef)).toHaveLength(1);
    });

    it('refuses what the step rules refuse, another member’s draft and a stale parent, writing nothing', async () => {
      const { a, b, aRef, bRef, root } = await begun();
      const draftId = await drafted(a, aRef, root);
      const before = await counts();
      expect(await choose(a, aRef, draftId, { kind: 'own', changes: [], kept: [] })).toEqual({
        kind: 'refused',
        code: 'invalid_input',
      });
      expect(await choose(a, aRef, draftId, { kind: 'own', changes: [traffic], kept: [], lens: 'a lens' })).toEqual({
        kind: 'refused',
        code: 'invalid_input',
      });
      expect(await choose(a, aRef, draftId, { kind: 'suggestion', optionId: 'o3' })).toEqual({
        kind: 'refused',
        code: 'invalid_input',
      });
      expect(await choose(b, bRef, draftId)).toEqual({ kind: 'refused', code: 'unavailable' });
      expect(await counts()).toEqual(before);
    });

    it('is refused when a cap is reached, with nothing written', async () => {
      const { a, aRef, root } = await begun();
      const draftId = await drafted(a, aRef, root);
      const before = await counts();
      const off = compose({ perDay: 0, perThread: 100 }).scenarios;
      expect(
        await off.choose(a.authority, {
          version,
          commandId: randomUUID(),
          thread: aRef,
          draftId,
          selection: { kind: 'suggestion', optionId: 'o1' },
        }),
      ).toEqual({ kind: 'refused', code: 'budget_unavailable' });
      expect(await counts()).toEqual(before);
      // The draft is still there to choose when the day allows.
      expect(unwrap(await readDraft(a, aRef, draftId))).toMatchObject({ status: 'ready' });
      expect(unwrap(await choose(a, aRef, draftId))).toMatchObject({ node: { status: 'preparing' } });
    });

    it('stops a thread at its own cap', async () => {
      const { a, aRef, root } = await begun();
      const small = compose({ perDay: 100, perThread: 1 }).scenarios;
      const chooseWith = (draftId: string, optionId: string) =>
        small.choose(a.authority, {
          version,
          commandId: randomUUID(),
          thread: aRef,
          draftId,
          selection: { kind: 'suggestion', optionId },
        });
      unwrap(await chooseWith(await drafted(a, aRef, root), 'o1'));
      expect(await chooseWith(await drafted(a, aRef, root), 'o2')).toEqual({
        kind: 'refused',
        code: 'budget_unavailable',
      });
    });
  });

  describe('membership at every step', () => {
    it('drops a late model answer when the requester’s place ended while the model thought', async () => {
      const { a, b, bRef, root } = await begun();
      const hold = gate<FixtureScenario>();
      const previous = plannerScript;
      plannerScript = () => hold.promise;
      try {
        const started = unwrap(await startDraft(b, bRef, root));
        const callsBefore = plannerCalls();
        standingReads = [];
        const running = suggest(
          { v: 1, universeId: b.universeId, privacyEpoch: 1, draftId: started.draftId },
          new AbortController().signal,
        );
        // The model has the request and is thinking: only now does Asha end Ravi's place.
        while (plannerCalls() === callsBefore) await new Promise((resolve) => setTimeout(resolve, 10));
        // Asha removes Ravi as a friend: the invitation his place rests on ends, and nothing says why.
        await friendCommand(friends, a, b, 'remove');
        hold.open(answerWith({ mode: 'options', options: [batching, instances] }));
        await running;
        const row = await database.db
          .selectFrom('scenarios.drafts')
          .select(['state', 'options'])
          .where('draft_id', '=', started.draftId)
          .executeTakeFirst();
        expect(row, 'the late answer was not stored, and the draft went with the place').toBeUndefined();
        // The check of Ravi's place ran on the transaction that applies the answer, never on a second connection.
        expect(standingReads).toEqual(['scope']);
        expect(unwrap(await readDraft(b, bRef, started.draftId))).toMatchObject({ status: 'unavailable' });
      } finally {
        plannerScript = previous;
      }
    });

    it('refuses every action of a member who left, and reads nothing for them', async () => {
      const { a, b, aRef, bRef, root } = await begun();
      const draftId = await drafted(b, bRef, root);
      unwrap(await choose(a, aRef, await drafted(a, aRef, root)));
      unwrap(await threads.leave(b.authority, { version: threadVersion, commandId: randomUUID(), thread: bRef }));
      expect(await startDraft(b, bRef, root)).toEqual({ kind: 'refused', code: 'unavailable' });
      expect(await choose(b, bRef, draftId)).toEqual({ kind: 'refused', code: 'unavailable' });
      expect(await list(b, bRef)).toMatchObject({ status: 'unavailable' });
      expect(unwrap(await readDraft(b, bRef, draftId))).toMatchObject({ status: 'unavailable' });
      expect(await cards(a, aRef)).toHaveLength(1);
    });

    it('shows a branch to the members and to no one else', async () => {
      const { a, b, aRef, bRef, root } = await begun();
      const made = unwrap(await choose(a, aRef, await drafted(a, aRef, root)));
      const stranger = await seedFriend(database.db, friends);
      expect(await list(stranger, aRef)).toMatchObject({ status: 'unavailable' });
      const seenByRavi = (await cards(b, bRef))[0];
      expect(seenByRavi).toMatchObject({ nodeId: made.node.nodeId, startedBy: { handle: a.person.handle } });
      // No card carries anyone's position, current branch or seen marker.
      expect(JSON.stringify(seenByRavi)).not.toMatch(/position|current|seen|visited/i);
    });
  });

  describe('hypothetical status and assumptions', () => {
    it('carries hypothetical status down every descendant and keeps assumptions in a perspective', async () => {
      const { a, aRef, root } = await begun();
      const first = unwrap(await choose(a, aRef, await drafted(a, aRef, root)));
      await prepare(first.node.nodeId);
      const parentCard = (await cards(a, aRef)).find((card) => card.nodeId === first.node.nodeId);
      expect(parentCard).toMatchObject({ status: 'ready', revision: 2, content: { kind: 'scroll' } });

      // Another perspective below a hypothetical stays hypothetical and changes no assumption.
      plannerScript = () => answerWith({ mode: 'direct', options: [operatorView] });
      const lensDraft = await drafted(a, aRef, root, {
        kind: 'perspective',
        text: 'Show it from the view of the person on call',
        parent: { kind: 'node', nodeId: first.node.nodeId, revision: parentCard?.revision },
      });
      const lens = unwrap(await choose(a, aRef, lensDraft));
      expect(lens.node).toMatchObject({
        kind: 'perspective',
        hypothetical: true,
        lens: 'the view of the person on call',
        changes: [],
        parentNodeId: first.node.nodeId,
      });
      const stored = await database.db
        .selectFrom('scenarios.nodes')
        .select(['assumptions', 'hypothetical'])
        .where('node_id', 'in', [first.node.nodeId, lens.node.nodeId])
        .execute();
      expect(stored.map((row) => JSON.stringify(row.assumptions))).toEqual([
        JSON.stringify([traffic]),
        JSON.stringify([traffic]),
      ]);
      // The Scroll’s framing is copied by code: the whole premise, hypothetical.
      const order = await database.db
        .selectFrom('content.made_to_order_scrolls')
        .select(['framing', 'brief', 'kicker'])
        .where('recipe', '=', madeToOrderKey(lens.node.nodeId))
        .executeTakeFirstOrThrow();
      expect(order.framing).toEqual({ kind: 'hypothetical', assumptions: [traffic.statement], kept: [] });
      expect(order.kicker).toBe('Another perspective');
      expect(order.brief).toContain('LENS: the view of the person on call');
      expect(order.brief).toContain(
        `PREMISES INHERITED FROM EARLIER BRANCHES (also hypothetical):\n- ${traffic.statement}`,
      );

      // A what-if below adds its change to the inherited premise.
      await prepare(lens.node.nodeId);
      plannerScript = () => answerWith({ mode: 'direct', options: [{ ...batching, changes: [latency], kept: [] }] });
      const lensCard = (await cards(a, aRef)).find((card) => card.nodeId === lens.node.nodeId);
      const deepDraft = await drafted(a, aRef, root, {
        text: 'And if the latency target tightened?',
        parent: { kind: 'node', nodeId: lens.node.nodeId, revision: lensCard?.revision },
      });
      const deeper = unwrap(await choose(a, aRef, deepDraft));
      const deepRow = await database.db
        .selectFrom('scenarios.nodes')
        .select(['assumptions', 'hypothetical'])
        .where('node_id', '=', deeper.node.nodeId)
        .executeTakeFirstOrThrow();
      expect(deepRow.hypothetical).toBe(true);
      expect(deepRow.assumptions).toEqual([traffic, latency]);
      plannerScript = () => answerWith({ mode: 'options', options: [batching, instances] });
    });

    it('does not call a perspective on the real subject hypothetical', async () => {
      const { a, aRef, root } = await begun();
      plannerScript = () => answerWith({ mode: 'direct', options: [operatorView] });
      try {
        const draftId = await drafted(a, aRef, root, { kind: 'perspective', text: 'From the operator’s side' });
        const lens = unwrap(await choose(a, aRef, draftId));
        expect(lens.node).toMatchObject({ kind: 'perspective', hypothetical: false });
        const order = await database.db
          .selectFrom('content.made_to_order_scrolls')
          .select(['framing', 'mode'])
          .where('recipe', '=', madeToOrderKey(lens.node.nodeId))
          .executeTakeFirstOrThrow();
        expect(order.framing).toEqual({ kind: 'perspective', lens: 'the view of the person on call' });
      } finally {
        plannerScript = () => answerWith({ mode: 'options', options: [batching, instances] });
      }
    });

    it('refuses a draft from a parent that moved since the member saw it', async () => {
      const { a, aRef, root } = await begun();
      const first = unwrap(await choose(a, aRef, await drafted(a, aRef, root)));
      // A branch that is still preparing cannot be continued: its Scroll does not exist.
      expect(
        await startDraft(a, aRef, root, { parent: { kind: 'node', nodeId: first.node.nodeId, revision: 1 } }),
      ).toEqual({ kind: 'refused', code: 'unavailable' });
      await prepare(first.node.nodeId);
      expect(
        await startDraft(a, aRef, root, { parent: { kind: 'node', nodeId: first.node.nodeId, revision: 1 } }),
      ).toEqual({ kind: 'refused', code: 'stale_revision' });
      // The current revision is accepted; a removed branch is gone.
      const current = (await cards(a, aRef)).find((card) => card.nodeId === first.node.nodeId);
      const accepted = await startDraft(a, aRef, root, {
        parent: { kind: 'node', nodeId: first.node.nodeId, revision: current?.revision },
      });
      expect(accepted.kind).toBe('ok');
      unwrap(
        await scenarios.remove(a.authority, {
          version,
          commandId: randomUUID(),
          thread: aRef,
          nodeId: first.node.nodeId,
          revision: current?.revision,
        }),
      );
      expect(
        await startDraft(a, aRef, root, {
          parent: { kind: 'node', nodeId: first.node.nodeId, revision: (current?.revision ?? 0) + 1 },
        }),
      ).toEqual({ kind: 'refused', code: 'unavailable' });
    });
  });

  describe('the Scroll made for a thread', () => {
    it('is admitted hypothetical, bound to its branch, and carries no topic or coverage of the real-world map', async () => {
      const { a, b, aRef, bRef, root } = await begun();
      const made = unwrap(await choose(a, aRef, await drafted(a, aRef, root)));
      await prepare(made.node.nodeId);
      const card = (await cards(b, bRef)).find((candidate) => candidate.nodeId === made.node.nodeId);
      expect(card).toMatchObject({ status: 'ready', revision: 2, content: { kind: 'scroll', assetRevision: 1 } });
      expect(announced).toEqual([aRef.threadId]);

      const assetId = card?.content?.assetId ?? '';
      const document = await database.db
        .selectFrom('content.asset_revisions')
        .select(['document', 'explanation_unit_id'])
        .where('asset_id', '=', assetId)
        .executeTakeFirstOrThrow();
      expect((document.document as { framing: unknown }).framing).toEqual({
        kind: 'hypothetical',
        assumptions: [traffic.statement],
        kept: [model.statement],
      });
      expect((document.document as { kicker: string }).kicker).toBe('What if');
      expect(document.explanation_unit_id).toBe(madeToOrderKey(made.node.nodeId));

      // No planet, no facet coverage, no discovery topic: it cannot grow the real-world map.
      const topics = await database.db
        .selectFrom('content.encounter_topics')
        .select('topic_id')
        .where('asset_id', '=', assetId)
        .execute();
      expect(topics).toEqual([]);
      const coverage = await sql<{
        n: string;
      }>`select count(*)::text as n from content.coverage_revisions where asset_id = ${assetId}::uuid`.execute(
        database.db,
      );
      expect(coverage.rows[0]?.n).toBe('0');
      const regionBindings = await sql<{
        n: string;
      }>`select count(*)::text as n from content.region_bindings where asset_id = ${assetId}::uuid`.execute(
        database.db,
      );
      expect(regionBindings.rows[0]?.n).toBe('0');
      const writerOutcome = await database.db
        .selectFrom('content.scroll_production_runs')
        .select(['outcomes', 'state'])
        .where('topic', '=', madeToOrderKey(made.node.nodeId))
        .executeTakeFirstOrThrow();
      expect(writerOutcome.state).toBe('published');
      expect(JSON.stringify(writerOutcome.outcomes)).not.toMatch(/attribution|coverage/);
    });

    it('opens for both members, and for no one outside the thread; a member who left loses it', async () => {
      const { a, b, aRef, bRef, root } = await begun();
      const made = unwrap(await choose(a, aRef, await drafted(a, aRef, root)));
      // Not before it exists: the audience check does not turn a missing asset into an open one.
      await prepare(made.node.nodeId);
      const assetId = (await cards(a, aRef))[0]?.content?.assetId ?? '';
      const open = (who: Friend) =>
        content.openExposure(who.authority, {
          commandId: randomUUID(),
          target: { kind: 'scroll', assetId },
          origin: { kind: 'direct' },
          capabilities: textCapabilities,
        });
      const asha = await open(a);
      const ravi = await open(b);
      expect(asha.kind).toBe('opened');
      expect(ravi.kind).toBe('opened');
      if (ravi.kind !== 'opened') throw new Error('CI open refused');
      expect((await content.readExposureDocument(b.authority, ravi.outcome.exposureId)).kind).toBe('document');

      const stranger = await seedFriend(database.db, friends);
      expect(await open(stranger)).toEqual({ kind: 'refused', reason: 'asset_not_found' });

      // Leaving the thread closes the Scroll even through an exposure opened earlier.
      unwrap(await threads.leave(b.authority, { version: threadVersion, commandId: randomUUID(), thread: bRef }));
      expect(await content.readExposureDocument(b.authority, ravi.outcome.exposureId)).toEqual({
        kind: 'refused',
        reason: 'exposure_not_found',
      });
      expect(await open(b)).toEqual({ kind: 'refused', reason: 'asset_not_found' });
      expect(
        (await content.readExposureDocument(a.authority, asha.kind === 'opened' ? asha.outcome.exposureId : '')).kind,
      ).toBe('document');
    });

    it('is never offered in Explore, never a shareable card, and is closed when its branch is removed', async () => {
      const { a, aRef, root } = await begun();
      const made = unwrap(await choose(a, aRef, await drafted(a, aRef, root)));
      await prepare(made.node.nodeId);
      const card = (await cards(a, aRef))[0];
      const assetId = card?.content?.assetId ?? '';

      const scope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
      const offered = await scope(a.authority, (tx) =>
        readDiscoveryCandidates(tx, {
          languages: ['en'],
          formats: ['scroll'],
          text: 'traffic serving',
          capabilities: { documentSchemas: ['scroll-document.v1'], blocks: {} },
        } as never),
      );
      expect(offered.kind === 'entered' ? offered.value.map((item) => item.assetId) : []).not.toContain(assetId);

      const shared = await scope(a.authority, (tx) => readShareableContent(tx, [{ assetId, assetRevision: 1 }]));
      expect(shared.kind === 'entered' ? shared.value[0] : undefined).toMatchObject({ status: 'unavailable' });

      const audience = makeCheckAssetAudience(database.db, orderAudience);
      const mayRead = async (who: Friend, id: string) => (await audience({ pool: true }, who.authority, [id])).has(id);
      expect(await mayRead(a, assetId)).toBe(true);
      unwrap(
        await scenarios.remove(a.authority, {
          version,
          commandId: randomUUID(),
          thread: aRef,
          nodeId: made.node.nodeId,
          revision: card?.revision,
        }),
      );
      expect(await mayRead(a, assetId)).toBe(false);
      // An ordinary asset is as public as it was.
      expect(await mayRead(a, randomUUID())).toBe(true);
    });
  });

  describe('who can reach a Scroll made for a thread by its ID', () => {
    /** A branch Scroll, made and bound, and the one reference every action names. */
    async function readyBranch() {
      const thread = await begun();
      const made = unwrap(await choose(thread.a, thread.aRef, await drafted(thread.a, thread.aRef, thread.root)));
      await prepare(made.node.nodeId);
      const assetId = (await cards(thread.a, thread.aRef))[0]?.content?.assetId ?? '';
      return { ...thread, assetId, target: { assetId, assetRevision: 1 } };
    }
    const save = (who: Friend, target: { assetId: string; assetRevision: number }, kind: 'save' | 'unsave' = 'save') =>
      content.applyAction(who.authority, { commandId: randomUUID(), kind, target });
    const like = (who: Friend, target: { assetId: string; assetRevision: number }) =>
      content.applyEncounterAction(who.authority, { commandId: randomUUID(), kind: 'like', target });
    const savedOf = async (who: Friend) => {
      const saved = await content.listSaved(who.authority, 10);
      return saved.kind === 'read' ? saved.items : [];
    };

    it('lets a member save and like it, and shows it in their saved list with its title', async () => {
      const { b, target } = await readyBranch();
      expect(await save(b, target)).toMatchObject({ kind: 'applied' });
      expect(await like(b, target)).toMatchObject({ kind: 'applied' });
      const [entry] = await savedOf(b);
      expect(entry).toMatchObject({ assetId: target.assetId, availability: 'available' });
      expect(entry?.metadata?.title).toBeTruthy();
      expect(entry?.metadata?.summary).toBeTruthy();
    });

    it('refuses to save or like it for anyone outside the thread, as if it were not there', async () => {
      const { target } = await readyBranch();
      const stranger = await seedFriend(database.db, friends);
      expect(await save(stranger, target)).toEqual({ kind: 'refused', reason: 'asset_not_found' });
      expect(await like(stranger, target)).toMatchObject({ kind: 'refused', code: 'ASSET_NOT_FOUND' });
      expect(await savedOf(stranger)).toEqual([]);
      // An ID is the same ID in any letter case.
      const shouted = { ...target, assetId: target.assetId.toUpperCase() };
      expect(await save(stranger, shouted)).toEqual({ kind: 'refused', reason: 'asset_not_found' });
      expect(await like(stranger, shouted)).toMatchObject({ kind: 'refused', code: 'ASSET_NOT_FOUND' });
    });

    it('is not navigated to, offered or activated by ID for anyone who is not in its thread, nor after leaving it', async () => {
      const { b, bRef, target } = await readyBranch();
      const stranger = await seedFriend(database.db, friends);
      const returnTo = (who: Friend) =>
        content.navigate(who.authority, {
          commandId: randomUUID(),
          target: { kind: 'return', ...target },
          capabilities: textCapabilities,
        });
      const exposuresOf = async (who: Friend) =>
        (
          await database.db
            .selectFrom('experience.exposures')
            .select('id')
            .where('universe_id', '=', who.universeId)
            .where('asset_id', '=', target.assetId)
            .execute()
        ).length;

      // A member is offered it; a stranger gets what anyone gets for a Scroll that is not there.
      const offered = await returnTo(b);
      expect(offered).toMatchObject({ kind: 'accepted', outcome: { status: 'ready' } });
      const nothing = { kind: 'accepted', outcome: { status: 'exhausted', reason: 'return_unavailable' } };
      const strangers = await returnTo(stranger);
      expect(strangers).toMatchObject(nothing);
      expect(strangers.kind === 'accepted' && 'offer' in strangers.outcome).toBe(false);
      expect(await exposuresOf(stranger)).toBe(0);

      // After leaving, the offer made earlier cannot be activated, a new return finds nothing, and no exposure is made.
      unwrap(await threads.leave(b.authority, { version: threadVersion, commandId: randomUUID(), thread: bRef }));
      if (offered.kind !== 'accepted' || offered.outcome.status !== 'ready') throw new Error('CI offer missing');
      const { sessionId, intentRevision, offer } = offered.outcome;
      const activated = await content.activateOffer(b.authority, {
        commandId: randomUUID(),
        target: { kind: 'offer', sessionId, offerId: offer.offerId, expectedIntentRevision: intentRevision },
      });
      expect(activated).toMatchObject({ kind: 'refused', code: 'OFFER_UNAVAILABLE' });
      expect(await returnTo(b)).toMatchObject(nothing);
      expect(await exposuresOf(b)).toBe(0);
    });

    it('is quoted by a snippet only to the members of its thread', async () => {
      const { b, bRef, target } = await readyBranch();
      const stranger = await seedFriend(database.db, friends);
      const audience = makeCheckAssetAudience(database.db, orderAudience);
      const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
      const anchor = {
        kind: 'scroll_block',
        blockId: 'no-such-block',
        blockType: 'paragraph',
        blockVersion: 1,
      } as const;
      const validate = (who: Friend) =>
        withScope(who.authority, (scope) =>
          gateSnippetAnchors(audience, validateSnippetAnchor, resolveSnippetAnchor).validateSnippet(
            scope,
            target,
            anchor,
          ),
        );
      // A member's anchor is looked at (this one names no block, so it is invalid); a stranger's is not even that.
      expect(await validate(b)).toEqual({ kind: 'entered', value: { status: 'invalid' } });
      expect(await validate(stranger)).toEqual({ kind: 'entered', value: { status: 'unavailable' } });
      unwrap(await threads.leave(b.authority, { version: threadVersion, commandId: randomUUID(), thread: bRef }));
      expect(await validate(b)).toEqual({ kind: 'entered', value: { status: 'unavailable' } });
    });

    it('keeps its title out of the data export of someone who left, and in it for someone who is in', async () => {
      const { b, bRef, target, a, aRef } = await readyBranch();
      const title = (await cards(a, aRef))[0]?.content?.title ?? '';
      expect(title).not.toBe('');
      expect(await save(b, target)).toMatchObject({ kind: 'applied' });
      expect(await like(b, target)).toMatchObject({ kind: 'applied' });
      const opened = await content.openExposure(b.authority, {
        commandId: randomUUID(),
        target: { kind: 'scroll', assetId: target.assetId },
        origin: { kind: 'direct' },
        capabilities: textCapabilities,
      });
      expect(opened.kind).toBe('opened');

      const audience = makeCheckAssetAudience(database.db, orderAudience);
      const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
      const exported = async (who: Friend) => {
        const out = await withScope(who.authority, (scope) =>
          experienceExportRead(scope, {
            accountId: who.accountId,
            reach: (assetIds) =>
              audience(
                { scope },
                { ...scope.authority, actor: { kind: 'account', accountId: who.accountId } },
                assetIds,
              ),
          }),
        );
        if (out.kind !== 'entered') throw new Error('CI export refused');
        return JSON.stringify(out.value);
      };
      const inside = await exported(b);
      expect(inside).toContain(title);
      expect(inside).not.toContain(UNREACHABLE_TITLE);

      unwrap(await threads.leave(b.authority, { version: threadVersion, commandId: randomUUID(), thread: bRef }));
      const outside = await exported(b);
      expect(outside).not.toContain(title);
      // Every line that named it still says that they did something with it, and that it is no longer theirs to read.
      expect(outside.split(UNREACHABLE_TITLE)).toHaveLength(inside.split(title).length);
    });

    it('closes it to a member who left: no new save or like, and the saved lists show it as gone', async () => {
      const { b, bRef, target } = await readyBranch();
      expect(await save(b, target)).toMatchObject({ kind: 'applied' });
      unwrap(await threads.leave(b.authority, { version: threadVersion, commandId: randomUUID(), thread: bRef }));

      expect(await like(b, target)).toMatchObject({ kind: 'refused', code: 'ASSET_NOT_FOUND' });
      expect(await save(b, target)).toEqual({ kind: 'refused', reason: 'asset_not_found' });
      // The saved list names it and says nothing of what it is.
      const [entry] = await savedOf(b);
      expect(entry).toMatchObject({ assetId: target.assetId, availability: 'withdrawn' });
      expect(entry?.metadata).toBeUndefined();
      const audience = makeCheckAssetAudience(database.db, orderAudience);
      const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
      const page = await withScope(b.authority, (scope) =>
        gateSavedPageMetadata(readSavedPageMetadata, audience)(scope, [target]),
      );
      expect(page.kind === 'entered' ? page.value[0] : undefined).toMatchObject({
        availability: 'withdrawn',
        kind: 'scroll',
      });
      expect(page.kind === 'entered' ? page.value[0] : undefined).not.toHaveProperty('metadata');
      // They can still take it off their own list.
      expect(await save(b, target, 'unsave')).toMatchObject({ kind: 'applied' });
    });

    it('asks for no second connection while a personal transaction is open: a pool of one still opens, acts and lists', async () => {
      const { a, target } = await readyBranch();
      const single = createDatabase<Database>(
        { ...database.settings, poolMax: 1, applicationName: 'scenarios-pool-of-one' },
        { onIdleClientError: () => undefined },
      );
      const small = await scrollUseCases(
        { ...database, db: single.db },
        { orderAudience: makeReadOrderAudience(branchPoolStore(single.db), makeReadThreadStanding(single.db)) },
      );
      // A check that took a second connection would wait for one forever: this fails it quickly instead.
      const within = <T>(work: Promise<T>): Promise<T> =>
        Promise.race([
          work,
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('waited for a second connection')), 5_000).unref();
          }),
        ]);
      try {
        const opened = await within(
          small.openExposure(a.authority, {
            commandId: randomUUID(),
            target: { kind: 'scroll', assetId: target.assetId },
            origin: { kind: 'direct' },
            capabilities: textCapabilities,
          }),
        );
        expect(opened.kind).toBe('opened');
        expect(
          await within(small.applyAction(a.authority, { commandId: randomUUID(), kind: 'save', target })),
        ).toMatchObject({
          kind: 'applied',
        });
        expect(
          await within(small.applyEncounterAction(a.authority, { commandId: randomUUID(), kind: 'like', target })),
        ).toMatchObject({ kind: 'applied' });
        expect(await within(small.listSaved(a.authority, 10))).toMatchObject({ kind: 'read' });
        if (opened.kind !== 'opened') return;
        expect((await within(small.readExposureDocument(a.authority, opened.outcome.exposureId))).kind).toBe(
          'document',
        );
      } finally {
        await small.close();
        await single.close();
      }
    });
  });

  describe('premises that come down from earlier branches', () => {
    it('refuses a kept line that disagrees with a premise an earlier branch holds, and keeps a replaced one in its new words', async () => {
      const { a, aRef, root } = await begun();
      const first = unwrap(await choose(a, aRef, await drafted(a, aRef, root)));
      await prepare(first.node.nodeId);
      const ready = (await cards(a, aRef)).find((card) => card.nodeId === first.node.nodeId);
      const parent = { kind: 'node', nodeId: first.node.nodeId, revision: ready?.revision };
      const below = async () => {
        const started = unwrap(await startDraft(a, aRef, root, { parent }));
        return started.draftId;
      };
      const twenty = { subject: traffic.subject, statement: 'Traffic is twenty times higher than in the original' };
      // "Traffic stays as it is" would sit beside "ten times higher": refused, nothing written.
      const before = await counts();
      expect(
        await choose(a, aRef, await below(), {
          kind: 'own',
          changes: [latency],
          kept: [{ subject: traffic.subject, statement: 'Traffic stays as it is today' }],
        }),
      ).toEqual({ kind: 'refused', code: 'invalid_input' });
      expect(await counts()).toEqual(before);
      // A change under the same subject replaces the premise: only the new words hold.
      const replaced = unwrap(await choose(a, aRef, await below(), { kind: 'own', changes: [twenty], kept: [] }));
      expect(replaced.node.assumptions.map((premise) => premise.statement)).toEqual([twenty.statement]);
    });
  });

  describe('drafts a day', () => {
    it('stops a member at twenty, counts only their own, and a refused one writes nothing', async () => {
      const { a, b, aRef, bRef, root } = await begun();
      for (let n = 0; n < 20; n++) unwrap(await startDraft(a, aRef, root));
      const before = await counts();
      expect(await startDraft(a, aRef, root)).toEqual({ kind: 'refused', code: 'budget_unavailable' });
      expect(await counts()).toEqual(before);
      const asked = await database.db
        .selectFrom('receipts.shared_commands')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('actor_account_id', '=', a.accountId)
        .where('operation', '=', 'scenarios.draft')
        .executeTakeFirstOrThrow();
      expect(Number(asked.n)).toBe(20);
      // Ravi has asked for none today.
      expect(await startDraft(b, bRef, root)).toMatchObject({ kind: 'ok' });
    });
  });

  /** Tests that script the Planner leave the default one behind them. */
  const planner = () => {
    afterEach(() => {
      plannerScript = () => answerWith({ mode: 'options', options: [batching, instances] });
    });
  };

  describe('speculative status', () => {
    planner();
    it('is kept for a confirmed direction, carried to what is built below it, and not invented for a member’s own request', async () => {
      const { a, aRef, root } = await begun();
      plannerScript = () => answerWith({ mode: 'direct', options: [portal] });
      const first = unwrap(await choose(a, aRef, await drafted(a, aRef, root)));
      expect(first.node).toMatchObject({ speculative: true, hypothetical: true });
      await prepare(first.node.nodeId);
      const parent = (await cards(a, aRef)).find((card) => card.nodeId === first.node.nodeId);
      const below = (overrides: Record<string, unknown>) => ({
        parent: { kind: 'node', nodeId: first.node.nodeId, revision: parent?.revision },
        ...overrides,
      });
      // The member's own words below it add no flag of their own, and keep the one that came down.
      const own = unwrap(
        await choose(a, aRef, unwrap(await startDraft(a, aRef, root, below({}))).draftId, {
          kind: 'own',
          changes: [latency],
          kept: [],
        }),
      );
      expect(own.node).toMatchObject({ speculative: true });
      // Another perspective on it is still reasoning from the speculative premise.
      plannerScript = () => answerWith({ mode: 'direct', options: [operatorView] });
      const lens = unwrap(
        await choose(a, aRef, await drafted(a, aRef, root, below({ kind: 'perspective', text: 'From the operator.' }))),
      );
      expect(lens.node).toMatchObject({ speculative: true, kind: 'perspective' });
      // On the root, an own request with no flag is not speculative, and a plain direction is not either.
      const plain = unwrap(
        await choose(a, aRef, unwrap(await startDraft(a, aRef, root)).draftId, {
          kind: 'own',
          changes: [traffic],
          kept: [],
        }),
      );
      expect(plain.node).toMatchObject({ speculative: false });
      const stored = await database.db
        .selectFrom('scenarios.nodes')
        .select(['node_id', 'speculative'])
        .where(
          'thread_id',
          '=',
          (
            await database.db
              .selectFrom('scenarios.nodes')
              .select('thread_id')
              .where('node_id', '=', first.node.nodeId)
              .executeTakeFirstOrThrow()
          ).thread_id,
        )
        .execute();
      expect(stored.filter((row) => row.speculative)).toHaveLength(3);
    });
  });

  describe('what a member was offered and has not made', () => {
    planner();
    const suggestionsOf = async (who: Friend, thread: ContentThreadRef) => {
      const found = await list(who, thread);
      return found.status === 'ready' ? found.suggestions : [];
    };

    it('lists the options of their own ready drafts, with no number and no branch, and nobody else’s', async () => {
      const { a, b, aRef, bRef, root } = await begun();
      plannerScript = () => answerWith({ mode: 'options', options: [batching, { ...portal }] });
      await drafted(a, aRef, root);
      const mine = await suggestionsOf(a, aRef);
      expect(mine.map((suggestion) => [suggestion.optionId, suggestion.title, suggestion.speculative])).toEqual([
        ['o1', batching.title, false],
        ['o2', portal.title, true],
      ]);
      for (const suggestion of mine) {
        expect(suggestion).toMatchObject({ kind: 'what_if' });
        expect(suggestion).not.toHaveProperty('nodeId');
        expect(suggestion).not.toHaveProperty('part');
      }
      expect(await suggestionsOf(b, bRef)).toEqual([]);
      // Nothing was made by being offered.
      expect(await cards(a, aRef)).toEqual([]);
    });

    it('leaves out a draft that is still thinking, one that failed, one that was chosen and one that expired', async () => {
      const { a, aRef, root } = await begun();
      // Thinking: started, not answered.
      unwrap(await startDraft(a, aRef, root));
      expect(await suggestionsOf(a, aRef)).toEqual([]);
      // Chosen: made into a branch, so it is a card now and no longer an offer.
      plannerScript = () => answerWith({ mode: 'options', options: [batching, instances] });
      const chosen = await drafted(a, aRef, root);
      expect(await suggestionsOf(a, aRef)).toHaveLength(2);
      unwrap(await choose(a, aRef, chosen));
      expect(await suggestionsOf(a, aRef)).toEqual([]);
      // Expired: a draft that lived out its two hours.
      const stale = await drafted(a, aRef, root, { text: 'What if traffic doubled again?' });
      expect(await suggestionsOf(a, aRef)).toHaveLength(2);
      await database.db
        .updateTable('scenarios.drafts')
        .set({ created_at: new Date(Date.now() - 3 * 3_600_000), expires_at: new Date(Date.now() - 1000) })
        .where('draft_id', '=', stale)
        .execute();
      expect(await suggestionsOf(a, aRef)).toEqual([]);
    });

    it('leaves out an offer that would continue a branch that has been removed', async () => {
      const { a, aRef, root } = await begun();
      const first = unwrap(await choose(a, aRef, await drafted(a, aRef, root)));
      await prepare(first.node.nodeId);
      const ready = (await cards(a, aRef)).find((card) => card.nodeId === first.node.nodeId);
      plannerScript = () => answerWith({ mode: 'direct', options: [{ ...batching, changes: [latency], kept: [] }] });
      await drafted(a, aRef, root, {
        text: 'And if the latency target tightened?',
        parent: { kind: 'node', nodeId: first.node.nodeId, revision: ready?.revision },
      });
      expect(await suggestionsOf(a, aRef)).toMatchObject([{ parentNodeId: first.node.nodeId }]);
      unwrap(
        await scenarios.remove(a.authority, {
          version,
          commandId: randomUUID(),
          thread: aRef,
          nodeId: first.node.nodeId,
          revision: ready?.revision,
        }),
      );
      expect(await suggestionsOf(a, aRef)).toEqual([]);
    });

    it('is nothing for a member who left', async () => {
      const { a, b, aRef, bRef, root } = await begun();
      await drafted(b, bRef, root);
      expect(await suggestionsOf(b, bRef)).toHaveLength(2);
      unwrap(await threads.leave(b.authority, { version: threadVersion, commandId: randomUUID(), thread: bRef }));
      expect(unwrap(await scenarios.list(b.authority, { version, readId: randomUUID(), thread: bRef }))).toMatchObject({
        status: 'unavailable',
      });
      expect(await suggestionsOf(a, aRef)).toEqual([]);
    });
  });

  describe('removing a branch', () => {
    it('is the starter’s alone, at the revision they saw, and the same command returns the same answer', async () => {
      const { a, b, aRef, bRef, root } = await begun();
      const made = unwrap(await choose(a, aRef, await drafted(a, aRef, root)));
      const remove = (who: Friend, thread: ContentThreadRef, revision: number, commandId = randomUUID()) =>
        scenarios.remove(who.authority, { version, commandId, thread, nodeId: made.node.nodeId, revision });
      expect(await remove(b, bRef, 1)).toEqual({ kind: 'refused', code: 'unavailable' });
      expect(await remove(a, aRef, 9)).toEqual({ kind: 'refused', code: 'stale_revision' });
      const commandId = randomUUID();
      const removed = unwrap(await remove(a, aRef, 1, commandId));
      expect(removed).toMatchObject({ operation: 'scenario.remove', nodeId: made.node.nodeId, revision: 2 });
      expect(unwrap(await remove(a, aRef, 1, commandId))).toMatchObject({ replayed: true, revision: 2 });
      expect((await cards(b, bRef))[0]).toMatchObject({ status: 'removed', revision: 2 });
      // The same idea can be asked for again.
      const again = unwrap(await choose(a, aRef, await drafted(a, aRef, root)));
      expect(again.node.nodeId).not.toBe(made.node.nodeId);
    });
  });

  describe('the resolver sweep', () => {
    it('sends the next take of a rejected one, closes a stopped one and one that waited too long', async () => {
      const { a, aRef, root } = await begun();
      const made = unwrap(await choose(a, aRef, await drafted(a, aRef, root)));
      const recipe = madeToOrderKey(made.node.nodeId);

      // A job nobody has run yet is sent again, harmlessly.
      const first = await resolver().resolveBranches();
      expect(sent).toContainEqual([recipe, 1]);
      expect(first.sent).toBeGreaterThanOrEqual(1);

      // A rejected take is followed by the next.
      await rejectTake(recipe, 1);
      await resolver().resolveBranches();
      expect(sent).toContainEqual([recipe, 2]);

      // Every take rejected: nothing can produce it, so the card says so.
      for (const take of [2, 3]) await rejectTake(recipe, take);
      const closed = await resolver().resolveBranches();
      expect(closed.failed).toBe(1);
      expect(announced).toEqual([aRef.threadId]);
      expect((await cards(a, aRef))[0]).toMatchObject({ status: 'failed', revision: 2 });
      expect((await cards(a, aRef))[0]).not.toHaveProperty('content');
      // A closed branch is left alone by later sweeps.
      await resolver().resolveBranches();
      expect(sent.filter(([sentRecipe]) => sentRecipe === recipe)).toEqual([]);
      expect((await cards(a, aRef))[0]).toMatchObject({ status: 'failed', revision: 2 });
    });

    it('closes a branch that waited past the limit', async () => {
      const { a, aRef, root } = await begun();
      const made = unwrap(await choose(a, aRef, await drafted(a, aRef, root)));
      await database.db
        .updateTable('scenarios.nodes')
        .set({ created_at: new Date(Date.now() - 31 * 60_000) })
        .where('node_id', '=', made.node.nodeId)
        .execute();
      const summary = await resolver().resolveBranches();
      expect(summary.failed).toBeGreaterThanOrEqual(1);
      expect((await cards(a, aRef))[0]).toMatchObject({ status: 'failed' });
    });
  });

  describe('Quartermaster’s Create for a branch', () => {
    it('counts the day’s orders apart from every other cap', async () => {
      const { a, aRef, root } = await begun();
      const draftId = await drafted(a, aRef, root);
      const made = unwrap(await choose(a, aRef, draftId));
      const row = await database.db
        .selectFrom('supply.scenario_orders')
        .select(['order_id', 'thread_id'])
        .where('order_id', '=', made.node.nodeId)
        .executeTakeFirstOrThrow();
      expect(row.thread_id).toBe(aRef.threadId);
      // The ledger names no person and no words.
      const columns = await sql<{
        column_name: string;
      }>`select column_name from information_schema.columns where table_schema = 'supply' and table_name = 'scenario_orders'`.execute(
        database.db,
      );
      expect(columns.rows.map((column) => column.column_name).sort()).toEqual(['created_at', 'order_id', 'thread_id']);
    });
  });
});
