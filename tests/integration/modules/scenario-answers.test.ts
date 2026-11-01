/**
 * The short answer card of a what-if branch over real PostgreSQL and pg-boss (D-211, D-212): the job that a choice
 * sends in its own transaction, the writer's answer checked before it can be shown, who may read it, what removal and
 * a leaving member do to it, the wait that ends, and five branches per thread per day. The Planner and the card's
 * writer are labelled CI fixture models: nothing here is provider output.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ContentThreadRef, ScenarioCard } from '@knowscroll/contracts';
import { makeEnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import { exportCurrentPerson } from '@knowscroll/backend/erasure-registry';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  READ_SCROLL_EVIDENCE,
  READ_SCROLL_SOURCE_PAGES,
  READ_SHAREABLE_CONTENT,
  RECORD_MADE_TO_ORDER_SCROLL,
  type ReadOrderAudience,
} from '@knowscroll/backend/modules/content';
import { READ_VISITED_ASSETS } from '@knowscroll/backend/modules/experience';
import { ANNOUNCE_THREAD, READ_THREAD_STANDING, THREAD_GUEST } from '@knowscroll/backend/modules/social';
import {
  SCENARIO_USE_CASES,
  SUGGEST_SCENARIO_DRAFT,
  WRITE_SCENARIO_ANSWER,
  type ScenarioUseCases,
  type SuggestStep,
  type WriteAnswerStep,
} from '@knowscroll/backend/modules/scenarios';
import { scenarioProviders, scenarioWorkerProviders } from '@knowscroll/backend/modules/scenarios/nest-providers';
import { scenarioOrderProviders } from '@knowscroll/backend/modules/supply/nest-providers';
import {
  makeReadMadeToOrderProduction,
  readScrollEvidence,
  readScrollSourcePages,
  recordMadeToOrderScroll,
} from '../../../packages/backend/src/modules/content/adapters/made-to-order.js';
import { readShareableContent } from '../../../packages/backend/src/modules/content/adapters/shareable-content.js';
import { readVisitedAssets } from '../../../packages/backend/src/modules/experience/adapters/visited-assets.js';
import { makeReadOrderAudience } from '../../../packages/backend/src/modules/scenarios/application/audience.js';
import { makeResolveBranches } from '../../../packages/backend/src/modules/scenarios/application/resolve.js';
import { branchPoolStore } from '../../../packages/backend/src/modules/scenarios/adapters/postgres-store.js';
import { makeReadThreadStanding } from '../../../packages/backend/src/modules/social/adapters/postgres-thread-guest.js';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { answerWith } from '../support/generated-scroll.js';
import { fixtureModel, gate, protectedRequestsOf } from '../support/fixture-model.js';
import { fixtureRecordingHarness } from '../support/recording-harness.js';
import { clearRecordingPerson, pauseAndResume, recordingPerson, setRecording } from '../support/recording-person.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import { openToEveryone } from '../support/audience.js';
import { scrollUseCases } from '../support/scroll.js';
import { buildRecursively } from '../support/providers.js';
import type { FixturePerson } from '../support/fixtures.js';
import { befriend, seedFriend, talkCases, type Friend, type Friends, type Threads } from '../support/talk.js';
import { seedScroll } from '../support/thread-fixtures.js';

const threadVersion = 'content-thread.v1' as const;
const version = 'scenario.v1' as const;

const traffic = { subject: 'Traffic', statement: 'Traffic is ten times higher than in the original' };
const model = { subject: 'Model', statement: 'The same model serves every request' };
const changing = (assumption: { subject: string; statement: string }) => ({ ...assumption, replaces: null });
const batching = {
  title: 'What does batching change at ten times the traffic?',
  explanation: 'Shows how batching holds the cost per answer down.',
  changes: [changing(traffic)],
  kept: [model],
  lens: null,
  speculative: false,
  needsConfirmation: false,
};
const instances = {
  title: 'What do more instances change at ten times the traffic?',
  explanation: 'Shows how adding instances trades cost for waiting.',
  changes: [changing({ ...traffic, statement: 'Traffic is ten times higher, spread over more instances' })],
  kept: [model],
  lens: null,
  speculative: false,
  needsConfirmation: false,
};
const operatorView = {
  title: 'The view of the person on call',
  explanation: 'Looks at serving through the person who is paged.',
  changes: [],
  kept: [],
  lens: 'the view of the person on call',
  speculative: false,
  needsConfirmation: false,
};

/** Claims a Scroll's provenance records, invented for these tests: labelled CI fixtures, never product content. */
const FIXTURE_CLAIMS = [
  'Batching groups several requests so the hardware serves them together, which raises how many it finishes each second.',
  'Waiting for a batch to fill adds delay to each request that arrives early in the batch.',
  'A typical interactive service aims to answer within about 200 milliseconds for most requests.',
  'Adding instances spreads the same load over more machines but raises the cost of running them.',
].map((statement, index) => ({
  claimId: `claim-ci-${String(index + 1)}`,
  statement,
  quote: statement,
  sourceId: 's1',
  truthState: 'documented',
}));

/** An answer that passes every rule of the card for the claims above. */
const validAnswer = {
  assumption: 'We read “ten times the traffic” as ten times the requests each second, served by the same model.',
  claims: [
    {
      text: 'Batching would likely keep the cost of each answer down, because requests share the same work.',
      cites: ['e1'],
    },
    {
      text: 'Waiting for a batch to fill could slow the early requests, so the target would need care.',
      cites: ['e2'],
    },
  ],
  numbers: [{ label: 'Typical answer time', value: '200 milliseconds', cites: ['e3'] }],
};

function unwrap<T>(result: { kind: 'ok'; value: T } | { kind: 'refused'; code: string }): T {
  if (result.kind !== 'ok') throw new Error(`refused: ${result.code}`);
  return result.value;
}

describe('the short answer card of a what-if (real PostgreSQL, CI fixture models)', () => {
  let database: TestDatabase<Database>;
  let friends: Friends;
  let threads: Threads;
  let scenarios: ScenarioUseCases;
  let suggest: SuggestStep;
  let content: Awaited<ReturnType<typeof scrollUseCases>>;
  let orderAudience: ReadOrderAudience;
  let standing: ReturnType<typeof makeReadThreadStanding>;
  let compose: (caps: { perDay: number; perThreadPerDay: number }) => ScenarioUseCases;
  let writeAnswer: WriteAnswerStep;
  let answerScript: (sequence: number) => FixtureScenario | Promise<FixtureScenario>;
  let plannerScript: () => FixtureScenario | Promise<FixtureScenario>;
  let answerCalls = () => 0;
  let plannerCalls = () => 0;
  /** What runs once, just before a worker enters its transaction to store a result: a pause or a Clear in that gap. */
  let beforeApply: () => Promise<void> = () => Promise.resolve();
  const once = (action: () => Promise<void>) => () => {
    beforeApply = () => Promise.resolve();
    return action();
  };
  const announced: string[] = [];

  beforeAll(async () => {
    database = await createTestDatabase<Database>('scenario-answers');
    const cases = talkCases(database.db);
    friends = cases.friends;
    threads = cases.threads;
    standing = makeReadThreadStanding(database.db);
    orderAudience = makeReadOrderAudience(branchPoolStore(database.db), standing);
    content = await scrollUseCases(database, { orderAudience });
    answerScript = () => answerWith(validAnswer);
    plannerScript = () => answerWith({ mode: 'options', options: [batching, instances] });
    const planner = fixtureModel(() => plannerScript(), { label: 'scenario-planner-CI-fixture' });
    const writer = fixtureModel((sequence) => answerScript(sequence), { label: 'scenario-answer-CI-fixture' });
    answerCalls = () => writer.calls.length;
    plannerCalls = () => planner.calls.length;

    const SCOPE = Symbol('scope');
    const ENQUEUE = Symbol('enqueue');
    const DATABASE = Symbol('database');
    const CONFIG = Symbol('config');
    const HARNESS = Symbol('harness');
    const shared = (harnessModel: typeof planner, caps: { perDay: number; perThreadPerDay: number }) =>
      new Map<symbol, unknown>([
        [SCOPE, makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })],
        [ENQUEUE, makeEnqueueJob(content.boss)],
        [DATABASE, database.db],
        [CONFIG, { supplyScenarioDailyCap: caps.perDay, supplyScenarioThreadDailyCap: caps.perThreadPerDay }],
        [HARNESS, fixtureRecordingHarness(database.db, { model: harnessModel, beforeApply: () => beforeApply() }).harness],
        [THREAD_GUEST, cases.guest],
        [READ_THREAD_STANDING, standing],
        [READ_VISITED_ASSETS, readVisitedAssets],
        [READ_SHAREABLE_CONTENT, readShareableContent],
        [READ_SCROLL_SOURCE_PAGES, readScrollSourcePages],
        [READ_SCROLL_EVIDENCE, readScrollEvidence],
        [RECORD_MADE_TO_ORDER_SCROLL, recordMadeToOrderScroll],
        [
          ANNOUNCE_THREAD,
          (threadId: string) => {
            announced.push(threadId);
            return Promise.resolve();
          },
        ],
      ]);
    const providers = [
      ...scenarioProviders({ withPersonalScope: SCOPE, database: DATABASE, enqueueJob: ENQUEUE }),
      ...scenarioOrderProviders({ enqueueJob: ENQUEUE, config: CONFIG }),
      ...scenarioWorkerProviders({ withPersonalScope: SCOPE, database: DATABASE, harness: HARNESS }),
    ];
    const build = <T>(token: symbol, values: Map<symbol, unknown>) => buildRecursively(providers, token, values) as T;
    compose = (caps) => build<ScenarioUseCases>(SCENARIO_USE_CASES, shared(planner, caps));
    scenarios = compose({ perDay: 100, perThreadPerDay: 100 });
    suggest = build<SuggestStep>(SUGGEST_SCENARIO_DRAFT, shared(planner, { perDay: 100, perThreadPerDay: 100 }));
    writeAnswer = build<WriteAnswerStep>(WRITE_SCENARIO_ANSWER, shared(writer, { perDay: 100, perThreadPerDay: 100 }));
  });
  // Tests that script a model leave the defaults behind them.
  afterEach(() => {
    plannerScript = () => answerWith({ mode: 'options', options: [batching, instances] });
    answerScript = () => answerWith(validAnswer);
    beforeApply = () => Promise.resolve();
  });
  afterAll(async () => {
    await content.close();
    await database.drop();
  });

  // --- A thread to explore ------------------------------------------------------------------

  /**
   * An admitted Scroll whose provenance records sources and the claims it cites, as a generated one does.
   * `claims` can be cut short to leave nothing to cite.
   */
  async function seedRoot(claims = FIXTURE_CLAIMS) {
    const scroll = await seedScroll(database.db, 'attention-slowly');
    await database.db
      .insertInto('content.asset_provenance')
      .values({
        asset_id: scroll.assetId,
        revision: 1,
        provenance_version: 'scroll-provenance.v1',
        provenance: JSON.stringify({
          schemaVersion: 'scroll-provenance.v1',
          sources: TOPICS.seasons.pages.map((url, index) => ({
            sourceId: `s${String(index + 1)}`,
            title: 'CI source',
            url,
          })),
          claims,
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

  /** Asha started a thread on a generated Scroll; Ravi joined. `asha` is a person who can pause and clear recording. */
  async function begun(
    claims = FIXTURE_CLAIMS,
    options: { readonly asha?: FixturePerson } = {},
  ): Promise<Begun> {
    const a = await seedFriend(
      database.db,
      friends,
      options.asha === undefined ? {} : { person: options.asha },
    );
    const b = await seedFriend(database.db, friends);
    await befriend(friends, a, b);
    const root = await seedRoot(claims);
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

  /** Starts a draft, lets the Planner answer it and chooses its first direction. Returns the card as chosen. */
  async function chosen(
    who: Friend,
    thread: ContentThreadRef,
    root: Begun['root'],
    options: {
      readonly kind?: 'what_if' | 'perspective';
      readonly optionId?: string;
      readonly use?: ScenarioUseCases;
    } = {},
  ) {
    const use = options.use ?? scenarios;
    const kind = options.kind ?? 'what_if';
    const started = unwrap(
      await use.draft(who.authority, {
        version,
        commandId: randomUUID(),
        thread,
        kind,
        origin: { kind: 'root' },
        parent: { kind: 'root', assetRevision: root.assetRevision },
        text: 'What if traffic increases tenfold?',
      }),
    );
    await suggest(
      { v: 1, universeId: who.universeId, privacyEpoch: 1, draftId: started.draftId },
      new AbortController().signal,
    );
    return use.choose(who.authority, {
      version,
      commandId: randomUUID(),
      thread,
      draftId: started.draftId,
      selection: { kind: 'suggestion', optionId: options.optionId ?? 'o1' },
    });
  }

  const list = async (who: Friend, thread: ContentThreadRef) =>
    unwrap(await scenarios.list(who.authority, { version, readId: randomUUID(), thread }));
  async function cardOf(who: Friend, thread: ContentThreadRef, nodeId: string): Promise<ScenarioCard> {
    const found = await list(who, thread);
    const card = found.status === 'ready' ? found.cards.find((candidate) => candidate.nodeId === nodeId) : undefined;
    if (card === undefined) throw new Error('card missing');
    return card;
  }
  const jobsOf = async (nodeId: string) =>
    (
      await sql<{
        id: string;
      }>`select id from pgboss.job where name = 'scenarios.write-answer' and data->>'nodeId' = ${nodeId}`.execute(
        database.db,
      )
    ).rows;
  const answerRow = async (nodeId: string) =>
    database.db
      .selectFrom('scenarios.nodes')
      .select(['answer_state', 'answer', 'answer_settled_at'])
      .where('node_id', '=', nodeId)
      .executeTakeFirstOrThrow();
  /** Runs the worker's step for a branch the way its job does. */
  const write = (who: Friend, nodeId: string) =>
    writeAnswer({ v: 1, universeId: who.universeId, privacyEpoch: 1, nodeId }, new AbortController().signal);

  // --- Tests --------------------------------------------------------------------------------

  describe('choosing a what-if', () => {
    it('makes the card in the making and sends exactly one job in the same transaction', async () => {
      const { a, aRef, root } = await begun();
      const accepted = unwrap(await chosen(a, aRef, root));
      expect(accepted.node.answer).toEqual({ status: 'making' });
      expect(await jobsOf(accepted.node.nodeId)).toHaveLength(1);
      expect(await answerRow(accepted.node.nodeId)).toMatchObject({ answer_state: 'making', answer: null });
      // The job holds IDs only: the starter's universe and the branch, none of what anyone wrote.
      const payload = (
        await sql<{
          data: Record<string, unknown>;
        }>`select data from pgboss.job where name = 'scenarios.write-answer' and data->>'nodeId' = ${accepted.node.nodeId}`.execute(
          database.db,
        )
      ).rows[0]!.data;
      expect(Object.keys(payload).toSorted()).toEqual(['nodeId', 'privacyEpoch', 'universeId', 'v']);
    });

    it('is not sent again for the same idea asked twice: the second member shares the branch and its card', async () => {
      const { a, b, aRef, bRef, root } = await begun();
      const first = unwrap(await chosen(a, aRef, root));
      const second = unwrap(await chosen(b, bRef, root));
      expect(second).toMatchObject({ reused: true, node: { nodeId: first.node.nodeId } });
      expect(await jobsOf(first.node.nodeId)).toHaveLength(1);
    });

    it('gives a perspective no short answer and no job: it keeps the card it always had', async () => {
      const { a, aRef, root } = await begun();
      plannerScript = () => answerWith({ mode: 'direct', options: [operatorView] });
      const accepted = unwrap(await chosen(a, aRef, root, { kind: 'perspective' }));
      expect(accepted.node.kind).toBe('perspective');
      expect(accepted.node.answer).toBeUndefined();
      expect(await jobsOf(accepted.node.nodeId)).toHaveLength(0);
      expect(await answerRow(accepted.node.nodeId)).toMatchObject({ answer_state: null, answer: null });
      expect(await cardOf(a, aRef, accepted.node.nodeId)).not.toHaveProperty('answer');
    });
  });

  describe('the writer', () => {
    afterEach(() => {
      answerScript = () => answerWith(validAnswer);
    });

    it('writes a card that passes every rule: the assumption, the claims as one answer and the sourced figure', async () => {
      const { a, aRef, root } = await begun();
      const { node } = unwrap(await chosen(a, aRef, root));
      const before = answerCalls();
      await write(a, node.nodeId);
      expect(answerCalls()).toBe(before + 1);

      const card = await cardOf(a, aRef, node.nodeId);
      if (card.answer?.status !== 'ready') throw new Error('the card is not ready');
      const { readyAt, ...shown } = card.answer;
      expect(shown).toEqual({
        status: 'ready',
        madeBy: 'knowscroll',
        assumption: validAnswer.assumption,
        answer: validAnswer.claims.map((claim) => claim.text).join(' '),
        numbers: [{ label: 'Typical answer time', value: '200 milliseconds' }],
      });
      expect(Date.parse(readyAt)).toBeGreaterThan(Date.parse(card.createdAt) - 1);
      // What the branch changes and keeps is the checked premise, never the writer's words.
      expect(card.changes).toEqual([traffic]);
      expect(card.kept).toEqual([model]);
      // The card arrived without the branch's revision moving: nobody about to continue or remove it is made stale.
      expect(card.revision).toBe(node.revision);
      expect(announced).toContain(aRef.threadId);
    });

    it('stores the claims it cites by their IDs in the Scroll, and serves none of them', async () => {
      const { a, b, aRef, bRef, root } = await begun();
      const { node } = unwrap(await chosen(a, aRef, root));
      await write(a, node.nodeId);
      const stored = (await answerRow(node.nodeId)).answer as {
        claims: { claimIds: string[] }[];
        numbers: { claimIds: string[] }[];
      };
      expect(stored.claims.map((claim) => claim.claimIds)).toEqual([['claim-ci-1'], ['claim-ci-2']]);
      expect(stored.numbers.map((figure) => figure.claimIds)).toEqual([['claim-ci-3']]);
      for (const [reader, ref] of [
        [a, aRef],
        [b, bRef],
      ] as const)
        expect(JSON.stringify(await cardOf(reader, ref, node.nodeId))).not.toMatch(/claim-ci|claimIds|cites|"e[1-9]"/u);
    });

    it('asks the writer for the premise and the public claims only, never for what members said', async () => {
      const { a, b, aRef, bRef, root } = await begun();
      // Ravi said something in the thread: it is not the card's to read.
      unwrap(
        await threads.send(b.authority, {
          version: threadVersion,
          commandId: randomUUID(),
          thread: bRef,
          body: { kind: 'text', text: 'RAVI-THREAD-CANARY keep this out of the card' },
        }),
      );
      const { node } = unwrap(await chosen(a, aRef, root));
      await write(a, node.nodeId);
      const sent = (await protectedRequestsOf(database.db, a.universeId))
        .map((row) => Buffer.from(row.body).toString('utf8'))
        .filter((body) => body.includes('[e1]'))
        .join('\n');
      expect(sent).toContain('[e1] Batching groups several requests');
      expect(sent).toContain('Traffic is ten times higher than in the original');
      expect(sent).not.toContain('RAVI-THREAD-CANARY');
      expect(sent).not.toContain('What if traffic increases tenfold?');
      expect(sent).not.toContain(a.person.handle);
    });

    it('sends one request on the branch’s own run, and never pays twice when the job is delivered again', async () => {
      const { a, aRef, root } = await begun();
      const { node } = unwrap(await chosen(a, aRef, root));
      await write(a, node.nodeId);
      const calls = answerCalls();
      await write(a, node.nodeId);
      expect(answerCalls()).toBe(calls);
      const runs = await sql<{ id: string; owner_module: string; purpose: string }>`
        select id, owner_module, purpose from reasoning.business_runs where id = ${node.nodeId}::uuid`.execute(
        database.db,
      );
      expect(runs.rows).toEqual([{ id: node.nodeId, owner_module: 'scenarios', purpose: 'answer' }]);
    });

    it('repairs a digit no source states once, and shows the repaired card', async () => {
      const { a, aRef, root } = await begun();
      const { node } = unwrap(await chosen(a, aRef, root));
      const first = {
        ...validAnswer,
        claims: [
          {
            text: 'Batching would likely cut the cost by 40 percent, because requests share the same work.',
            cites: ['e1'],
          },
          validAnswer.claims[1],
        ],
      };
      let asked = 0;
      answerScript = () => answerWith((asked += 1) === 1 ? first : validAnswer);
      const before = answerCalls();
      await write(a, node.nodeId);
      expect(answerCalls()).toBe(before + 2);
      expect((await cardOf(a, aRef, node.nodeId)).answer).toMatchObject({ status: 'ready' });
    });

    it('ends as unavailable, after one repair, when the answer keeps citing what was not offered', async () => {
      const { a, aRef, root } = await begun();
      const { node } = unwrap(await chosen(a, aRef, root));
      answerScript = () =>
        answerWith({
          ...validAnswer,
          claims: [{ text: 'Batching would likely help, says a source nobody offered.', cites: ['e9'] }],
        });
      const before = answerCalls();
      await write(a, node.nodeId);
      expect(answerCalls()).toBe(before + 2);
      expect(await answerRow(node.nodeId)).toMatchObject({ answer_state: 'unavailable', answer: null });
      const card = await cardOf(a, aRef, node.nodeId);
      expect(card.answer).toEqual({ status: 'unavailable' });
      // The branch and its Scroll carry on as they would have.
      expect(card.status).toBe('preparing');
    });

    it('refuses a figure that hides a number in its label or writes prose in its value, and ends with no short answer', async () => {
      const figures = [
        // The review's cases: a figure in the label beside a value no passage states, and a value with prose around it.
        { label: 'Moon mass is 7.3e22 kg', value: '150', cites: ['e3'] },
        { label: 'Typical answer time', value: '200 milliseconds but ten times that', cites: ['e3'] },
        { label: 'Typical answer time', value: '300 milliseconds', cites: ['e3'] },
      ];
      for (const figure of figures) {
        const { a, aRef, root } = await begun();
        const { node } = unwrap(await chosen(a, aRef, root));
        answerScript = () => answerWith({ ...validAnswer, numbers: [figure] });
        const before = answerCalls();
        await write(a, node.nodeId);
        // One attempt and one repair, then no short answer: a figure the rules refuse is never shown.
        expect(answerCalls(), JSON.stringify(figure)).toBe(before + 2);
        expect((await cardOf(a, aRef, node.nodeId)).answer, JSON.stringify(figure)).toEqual({ status: 'unavailable' });
      }
    });

    it('refuses one short claim, which no list could carry, and ends with no short answer', async () => {
      const { a, b, aRef, bRef, root } = await begun();
      const { node } = unwrap(await chosen(a, aRef, root));
      // The review's repro: one claim of under 40 characters would store a card the contract refuses to list.
      answerScript = () =>
        answerWith({ ...validAnswer, claims: [{ text: 'Gravity would likely be stronger.', cites: ['e1'] }] });
      const before = answerCalls();
      await write(a, node.nodeId);
      expect(answerCalls()).toBe(before + 2);
      expect(await answerRow(node.nodeId)).toMatchObject({ answer_state: 'unavailable', answer: null });
      for (const [who, ref] of [
        [a, aRef],
        [b, bRef],
      ] as const)
        expect((await cardOf(who, ref, node.nodeId)).answer).toEqual({ status: 'unavailable' });
    });

    it('never fails the thread’s list for a stored card that no longer serves: it reads as no short answer', async () => {
      const { a, b, aRef, bRef, root } = await begun();
      const { node } = unwrap(await chosen(a, aRef, root));
      // A row as an older writer or a moved limit could leave it: ready, with one claim too short to make an answer.
      await sql`update scenarios.nodes set answer_state = 'ready', answer_settled_at = now(),
        answer = ${JSON.stringify({
          version: 'scenario-answer.v1',
          assumption: validAnswer.assumption,
          claims: [{ text: 'Gravity would likely be stronger.', claimIds: ['claim-ci-1'] }],
          numbers: [],
        })}::jsonb where node_id = ${node.nodeId}::uuid`.execute(database.db);
      for (const [who, ref] of [
        [a, aRef],
        [b, bRef],
      ] as const) {
        const found = await list(who, ref);
        if (found.status !== 'ready') throw new Error('the list did not come');
        expect(found.cards.find((card) => card.nodeId === node.nodeId)?.answer).toEqual({ status: 'unavailable' });
      }
    });

    it('refuses an answer with no assumption line, however good the rest is', async () => {
      const { a, aRef, root } = await begun();
      const { node } = unwrap(await chosen(a, aRef, root));
      const { assumption: _line, ...without } = validAnswer;
      answerScript = () => answerWith(without);
      await write(a, node.nodeId);
      expect((await cardOf(a, aRef, node.nodeId)).answer).toEqual({ status: 'unavailable' });
    });

    it('asks no model at all when the Scroll records too little to cite', async () => {
      const { a, aRef, root } = await begun(FIXTURE_CLAIMS.slice(0, 1));
      const { node } = unwrap(await chosen(a, aRef, root));
      const before = answerCalls();
      await write(a, node.nodeId);
      expect(answerCalls()).toBe(before);
      expect((await cardOf(a, aRef, node.nodeId)).answer).toEqual({ status: 'unavailable' });
    });

    it('ends as unavailable when the model’s outcome is unknown, and never resends that attempt', async () => {
      const { a, aRef, root } = await begun();
      const { node } = unwrap(await chosen(a, aRef, root));
      answerScript = () => ({ kind: 'timeout_after_dispatch' });
      const before = answerCalls();
      await write(a, node.nodeId);
      expect(answerCalls()).toBe(before + 1);
      expect((await cardOf(a, aRef, node.nodeId)).answer).toEqual({ status: 'unavailable' });
      await write(a, node.nodeId);
      expect(answerCalls()).toBe(before + 1);
    });

    it('is paid by the starter and for the starter only: another member’s scope asks no model', async () => {
      const { a, b, aRef, root } = await begun();
      const { node } = unwrap(await chosen(a, aRef, root));
      const before = answerCalls();
      await write(b, node.nodeId);
      expect(answerCalls()).toBe(before);
      // Ravi's scope has nothing to do for Asha's branch and ends nothing: the card is still being made for her.
      expect((await cardOf(a, aRef, node.nodeId)).answer).toEqual({ status: 'making' });
    });
  });

  describe('who reads it', () => {
    it('is the thread’s members’ alone: a stranger reads nothing of the thread, and a member who left reads nothing', async () => {
      const { a, b, aRef, bRef, root } = await begun();
      const { node } = unwrap(await chosen(a, aRef, root));
      await write(a, node.nodeId);
      expect((await cardOf(b, bRef, node.nodeId)).answer).toMatchObject({ status: 'ready' });

      const stranger = await seedFriend(database.db, friends);
      expect(
        unwrap(await scenarios.list(stranger.authority, { version, readId: randomUUID(), thread: aRef })),
      ).toMatchObject({ status: 'unavailable' });
      unwrap(await threads.leave(b.authority, { version: threadVersion, commandId: randomUUID(), thread: bRef }));
      const left = unwrap(await scenarios.list(b.authority, { version, readId: randomUUID(), thread: bRef }));
      expect(left).toMatchObject({ status: 'unavailable' });
      expect(JSON.stringify(left)).not.toContain(validAnswer.assumption);
    });

    it('tells no one where another member is: the card has no field for it, and "opened" is the caller’s own', async () => {
      const { a, b, bRef, aRef, root } = await begun();
      const { node } = unwrap(await chosen(a, aRef, root));
      await write(a, node.nodeId);
      const seenByRavi = unwrap(await scenarios.list(b.authority, { version, readId: randomUUID(), thread: bRef }));
      if (seenByRavi.status !== 'ready') throw new Error('list not ready');
      expect(seenByRavi.opened).toEqual([]);
      const card = seenByRavi.cards.find((candidate) => candidate.nodeId === node.nodeId)!;
      expect(Object.keys(card).toSorted()).toEqual(
        [
          'answer',
          'assumptions',
          'changes',
          'createdAt',
          'hypothetical',
          'kept',
          'kind',
          'nodeId',
          'origin',
          'revision',
          'speculative',
          'startedBy',
          'status',
          'title',
        ].toSorted(),
      );
    });

    it('keeps the card of a starter who left, but never writes one for them', async () => {
      const { a, b, aRef, bRef, root } = await begun();
      const { node } = unwrap(await chosen(b, bRef, root));
      unwrap(await threads.leave(b.authority, { version: threadVersion, commandId: randomUUID(), thread: bRef }));
      const before = answerCalls();
      await write(b, node.nodeId);
      expect(answerCalls()).toBe(before);
      expect((await cardOf(a, aRef, node.nodeId)).answer).toEqual({ status: 'unavailable' });
    });

    it('drops the answer when the starter left while the model thought', async () => {
      const { a, b, aRef, bRef, root } = await begun();
      const { node } = unwrap(await chosen(b, bRef, root));
      const hold = gate<FixtureScenario>();
      answerScript = () => hold.promise;
      const calls = answerCalls();
      const running = write(b, node.nodeId);
      while (answerCalls() === calls) await new Promise((resolve) => setTimeout(resolve, 10));
      unwrap(await threads.leave(b.authority, { version: threadVersion, commandId: randomUUID(), thread: bRef }));
      hold.open(answerWith(validAnswer));
      await running;
      expect(await answerRow(node.nodeId)).toMatchObject({ answer_state: 'unavailable', answer: null });
      expect((await cardOf(a, aRef, node.nodeId)).answer).toEqual({ status: 'unavailable' });
      answerScript = () => answerWith(validAnswer);
    });
  });

  describe('removal and the wait', () => {
    const remove = (who: Friend, thread: ContentThreadRef, node: { nodeId: string; revision: number }) =>
      scenarios.remove(who.authority, {
        version,
        commandId: randomUUID(),
        thread,
        nodeId: node.nodeId,
        revision: node.revision,
      });

    it('clears the answer with the branch: the removed card says nothing of what it said', async () => {
      const { a, b, aRef, bRef, root } = await begun();
      const { node } = unwrap(await chosen(a, aRef, root));
      await write(a, node.nodeId);
      unwrap(await remove(a, aRef, node));
      expect(await answerRow(node.nodeId)).toMatchObject({ answer_state: null, answer: null, answer_settled_at: null });
      for (const [who, ref] of [
        [a, aRef],
        [b, bRef],
      ] as const) {
        const card = await cardOf(who, ref, node.nodeId);
        expect(card).toMatchObject({ status: 'removed', title: 'Removed' });
        expect(card).not.toHaveProperty('answer');
        expect(JSON.stringify(card)).not.toContain(validAnswer.assumption);
      }
    });

    it('drops an answer that arrives after the branch was removed', async () => {
      const { a, aRef, root } = await begun();
      const { node } = unwrap(await chosen(a, aRef, root));
      const hold = gate<FixtureScenario>();
      answerScript = () => hold.promise;
      const calls = answerCalls();
      const running = write(a, node.nodeId);
      while (answerCalls() === calls) await new Promise((resolve) => setTimeout(resolve, 10));
      unwrap(await remove(a, aRef, node));
      hold.open(answerWith(validAnswer));
      await running;
      expect(await answerRow(node.nodeId)).toMatchObject({ answer_state: null, answer: null });
      answerScript = () => answerWith(validAnswer);
    });

    const sweep = (afterMs: number) =>
      makeResolveBranches({
        store: branchPoolStore(database.db),
        readProduction: makeReadMadeToOrderProduction(database.db),
        sendProduction: () => Promise.resolve(),
        announce: () => Promise.resolve(),
        now: () => new Date(Date.now() + afterMs),
      })();

    it('ends the wait for an answer that took too long, and leaves a young one alone', async () => {
      const { a, aRef, root } = await begun();
      const { node } = unwrap(await chosen(a, aRef, root));
      expect((await sweep(60_000)).answersEnded).toBe(0);
      // A paid attempt and its repair can take ten minutes: eleven is still waiting.
      expect((await sweep(11 * 60_000)).answersEnded).toBe(0);
      expect((await cardOf(a, aRef, node.nodeId)).answer).toEqual({ status: 'making' });
      expect((await cardOf(a, aRef, node.nodeId)).answer).toEqual({ status: 'making' });
      expect((await sweep(13 * 60_000)).answersEnded).toBeGreaterThanOrEqual(1);
      expect((await cardOf(a, aRef, node.nodeId)).answer).toEqual({ status: 'unavailable' });
      // The late answer finds the wait ended and is dropped.
      await write(a, node.nodeId);
      expect((await cardOf(a, aRef, node.nodeId)).answer).toEqual({ status: 'unavailable' });
    });
  });

  describe('the export', () => {
    const exported = async (who: Friend) => {
      const scoped = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
      const entered = await scoped(who.authority, (scope) =>
        exportCurrentPerson(scope, { accountId: who.accountId }, openToEveryone),
      );
      if (entered.kind !== 'entered') throw new Error('the export did not run');
      return entered.value.sections['scenarios'] as
        { branches: { items: { title: string; shortAnswer?: { assumption: string; text: string } }[] } } | undefined;
    };

    it('lists a short answer with the branch its starter made, and nothing of it for another member', async () => {
      const { a, b, aRef, root } = await begun();
      const { node } = unwrap(await chosen(a, aRef, root));
      await write(a, node.nodeId);
      const mine = (await exported(a))?.branches.items.find((item) => item.title === node.title);
      expect(mine?.shortAnswer).toEqual({
        assumption: validAnswer.assumption,
        text: validAnswer.claims.map((claim) => claim.text).join(' '),
      });
      // Ravi started nothing: his file has no branch of Asha's and so none of her answer.
      expect(JSON.stringify((await exported(b)) ?? {})).not.toContain(validAnswer.assumption);
    });

    it('lists a branch whose short answer never came without one', async () => {
      const { a, aRef, root } = await begun();
      const { node } = unwrap(await chosen(a, aRef, root));
      const mine = (await exported(a))?.branches.items.find((item) => item.title === node.title);
      expect(mine).toBeDefined();
      expect(mine).not.toHaveProperty('shortAnswer');
    });
  });

  describe('five a day', () => {
    const countOf = async (table: 'scenarios.nodes') =>
      (
        await database.db
          .selectFrom(table)
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow()
      ).n;
    const answerJobs = async () =>
      (
        await sql<{ n: string }>`select count(*) as n from pgboss.job where name = 'scenarios.write-answer'`.execute(
          database.db,
        )
      ).rows[0]!.n;
    const idea = (index: number) => {
      const words = ['two', 'three', 'four', 'five', 'six', 'seven'][index];
      return {
        ...batching,
        title: `What does batching change at ${words} times the traffic?`,
        changes: [changing({ ...traffic, statement: `Traffic is ${words} times higher than in the original` })],
      };
    };

    it('lets a thread make five branches a day and refuses the sixth honestly, writing nothing', async () => {
      const { a, aRef, root } = await begun();
      const small = compose({ perDay: 100, perThreadPerDay: 5 });
      for (let index = 0; index < 5; index += 1) {
        plannerScript = () => answerWith({ mode: 'direct', options: [idea(index)] });
        unwrap(await chosen(a, aRef, root, { use: small }));
      }
      const before = { nodes: await countOf('scenarios.nodes'), jobs: await answerJobs() };
      plannerScript = () => answerWith({ mode: 'direct', options: [idea(5)] });
      expect(await chosen(a, aRef, root, { use: small })).toEqual({ kind: 'refused', code: 'budget_unavailable' });
      expect(await countOf('scenarios.nodes')).toBe(before.nodes);
      expect(await answerJobs()).toBe(before.jobs);
      plannerScript = () => answerWith({ mode: 'options', options: [batching, instances] });
    });

    it('counts each thread on its own, and gives the thread its five again on the next day', async () => {
      const first = await begun();
      const other = await begun();
      const small = compose({ perDay: 100, perThreadPerDay: 1 });
      unwrap(await chosen(first.a, first.aRef, first.root, { use: small }));
      // Another thread is not affected by this one's day.
      unwrap(await chosen(other.a, other.aRef, other.root, { use: small }));
      expect(await chosen(first.a, first.aRef, first.root, { use: small, optionId: 'o2' })).toEqual({
        kind: 'refused',
        code: 'budget_unavailable',
      });
      // Yesterday's order no longer counts against today.
      await sql`update supply.scenario_orders set created_at = created_at - interval '1 day' where thread_id = ${first.aRef.threadId}::uuid`.execute(
        database.db,
      );
      expect(await chosen(first.a, first.aRef, first.root, { use: small, optionId: 'o2' })).toMatchObject({
        kind: 'ok',
      });
    });
  });

  /**
   * What and who a what-if or another perspective answers for: the planner's directions and the card's writer run at the
   * generation recording is at when their step starts (D-270). Generation 1 is on, 2 is off, and 3 is on again after a pause
   * and a resume.
   */
  describe('for a person who paused and resumed recording (D-270)', () => {
    const runsOf = async (id: string) =>
      (
        await database.db
          .selectFrom('reasoning.business_runs')
          .select(['purpose', 'state', 'recording_generation'])
          .where('id', '=', id)
          .execute()
      ).map((run) => ({ ...run }));
    const draftRow = (draftId: string) =>
      database.db
        .selectFrom('scenarios.drafts')
        .select(['state', 'failure'])
        .where('draft_id', '=', draftId)
        .executeTakeFirstOrThrow();
    const draftsFor = async (who: Friend, thread: ContentThreadRef, text = 'What if traffic increases tenfold?') =>
      unwrap(
        await scenarios.draft(who.authority, {
          version,
          commandId: randomUUID(),
          thread,
          kind: 'what_if',
          origin: { kind: 'root' },
          parent: { kind: 'root', assetRevision: 1 },
          text,
        }),
      ).draftId;
    const suggestFor = (who: Friend, draftId: string) =>
      suggest({ v: 1, universeId: who.universeId, privacyEpoch: 1, draftId }, new AbortController().signal);
    const writtenForTheNewEpoch = async (who: Friend) =>
      (
        await sql<{
          runs: string;
          drafts: string;
        }>`select (select count(*) from reasoning.business_runs where universe_id = ${who.universeId}::uuid and privacy_epoch > 1) as runs,
                  (select count(*) from scenarios.drafts where requester_universe_id = ${who.universeId}::uuid and privacy_epoch > 1) as drafts`.execute(
          database.db,
        )
      ).rows[0];
    /** A thread whose starter can pause and clear recording. */
    const withRecordingStarter = async () => begun(FIXTURE_CLAIMS, { asha: await recordingPerson(database) });

    it('has the planner’s directions made, and the run stamped with the generation it started at', async () => {
      const { a, aRef } = await withRecordingStarter();
      await pauseAndResume(database, a);
      const draftId = await draftsFor(a, aRef);
      const before = plannerCalls();
      await suggestFor(a, draftId);
      expect(plannerCalls()).toBe(before + 1);
      expect(await draftRow(draftId)).toMatchObject({ state: 'ready' });
      expect(await runsOf(draftId)).toEqual([{ purpose: 'suggest', state: 'completed', recording_generation: 3 }]);
    });

    it('has the short answer written, and the run stamped with the generation it started at', async () => {
      const { a, aRef, root } = await withRecordingStarter();
      await pauseAndResume(database, a);
      const { node } = unwrap(await chosen(a, aRef, root));
      await write(a, node.nodeId);
      expect((await cardOf(a, aRef, node.nodeId)).answer).toMatchObject({ status: 'ready' });
      expect(await runsOf(node.nodeId)).toEqual([{ purpose: 'answer', state: 'completed', recording_generation: 3 }]);
    });

    it('drops directions reached across a pause and a resume: the draft fails, and the new generation holds no run', async () => {
      const { a, aRef } = await withRecordingStarter();
      const draftId = await draftsFor(a, aRef);
      plannerScript = async () => {
        await pauseAndResume(database, a);
        return answerWith({ mode: 'options', options: [batching, instances] });
      };
      await suggestFor(a, draftId);
      expect(await draftRow(draftId)).toMatchObject({ state: 'failed', failure: 'could_not_suggest' });
      expect(
        await database.db
          .selectFrom('reasoning.business_runs')
          .select('id')
          .where('universe_id', '=', a.universeId)
          .where('recording_generation', '=', 3)
          .execute(),
      ).toEqual([]);
      // They ask again at the new generation and are answered: only the old reply was dropped.
      plannerScript = () => answerWith({ mode: 'options', options: [batching, instances] });
      const again = await draftsFor(a, aRef, 'What if traffic doubles?');
      await suggestFor(a, again);
      expect(await draftRow(again)).toMatchObject({ state: 'ready' });
    });

    it('drops a short answer reached across a pause and a resume: the card ends with none, and nothing is stamped for the new generation', async () => {
      const { a, aRef, root } = await withRecordingStarter();
      const { node } = unwrap(await chosen(a, aRef, root));
      answerScript = async () => {
        await pauseAndResume(database, a);
        return answerWith(validAnswer);
      };
      await write(a, node.nodeId);
      expect(answerCalls()).toBeGreaterThan(0);
      expect(await answerRow(node.nodeId)).toMatchObject({ answer_state: 'unavailable', answer: null });
      expect(
        (await runsOf(node.nodeId)).filter((run) => run.recording_generation === 3),
      ).toEqual([]);
    });

    it('applies nothing when recording is paused between the planner’s reply and the store', async () => {
      const { a, aRef } = await withRecordingStarter();
      const draftId = await draftsFor(a, aRef);
      beforeApply = once(() => setRecording(database, a, 1, false));
      await suggestFor(a, draftId);
      expect(await draftRow(draftId)).toMatchObject({ state: 'failed', failure: 'could_not_suggest' });
      expect((await runsOf(draftId)).map((run) => run.state)).toEqual(['admitted']);
    });

    it('applies nothing for directions or a short answer in flight across Clear: nothing is written for the new epoch', async () => {
      const { a, aRef } = await withRecordingStarter();
      const draftId = await draftsFor(a, aRef);
      plannerScript = async () => {
        await clearRecordingPerson(database, content.boss, a);
        return answerWith({ mode: 'options', options: [batching, instances] });
      };
      await suggestFor(a, draftId);
      expect(await writtenForTheNewEpoch(a)).toEqual({ runs: '0', drafts: '0' });

      // A branch made in the old epoch is cleared with it; a writer in flight for one is dropped the same way.
      const b = await withRecordingStarter();
      plannerScript = () => answerWith({ mode: 'options', options: [batching, instances] });
      const { node } = unwrap(await chosen(b.a, b.aRef, b.root));
      answerScript = async () => {
        await clearRecordingPerson(database, content.boss, b.a);
        return answerWith(validAnswer);
      };
      await write(b.a, node.nodeId);
      expect(await writtenForTheNewEpoch(b.a)).toEqual({ runs: '0', drafts: '0' });
    });

    it('is refused without a model call while recording is paused: the draft fails and the card ends with no answer', async () => {
      const { a, aRef, root } = await withRecordingStarter();
      const { node } = unwrap(await chosen(a, aRef, root));
      await setRecording(database, a, 1, false);
      const planned = plannerCalls();
      const draftId = await draftsFor(a, aRef, 'What if traffic doubles?');
      await suggestFor(a, draftId);
      expect(plannerCalls()).toBe(planned);
      expect(await draftRow(draftId)).toMatchObject({ state: 'failed', failure: 'could_not_suggest' });
      expect(await runsOf(draftId)).toEqual([]);
      const written = answerCalls();
      await write(a, node.nodeId);
      expect(answerCalls()).toBe(written);
      expect(await answerRow(node.nodeId)).toMatchObject({ answer_state: 'unavailable', answer: null });
      expect(await runsOf(node.nodeId)).toEqual([]);
    });
  });
});
