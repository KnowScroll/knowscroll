import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AskQuickAnswer } from '@knowscroll/contracts';
import { parseDocumentV2, type ScrollDocumentV2 } from '@knowscroll/scroll-model';
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
  readScrollQuickAnswerFacts,
} from '@knowscroll/backend/modules/content/nest-providers';
import { identityScopeOwnerProviders } from '@knowscroll/backend/modules/identity/nest-providers';
import { experienceEvidenceReadProviders } from '@knowscroll/backend/modules/experience/nest-providers';
import {
  ANSWER_QUICK_ANSWER,
  ASK_QUICK_ANSWER,
  DISMISS_QUICK_ANSWER,
  READ_QUICK_ANSWER,
  READ_QUICK_ANSWER_FOR_REPORT,
  type AnswerQuickAnswerUseCase,
  type AskQuickAnswerUseCase,
  type DismissQuickAnswerUseCase,
  type ReadQuickAnswerForReport,
  type ReadQuickAnswerUseCase,
} from '@knowscroll/backend/modules/supply';
import { QUICK_ANSWER_PORTS, quickAnswerProviders } from '@knowscroll/backend/modules/supply/nest-providers';
import {
  giveUpStaleQuickAnswers,
  purgeExpiredQuickAnswers,
} from '../../../packages/backend/src/modules/supply/adapters/postgres-quick-answers.js';
import { QUICK_ANSWER_WAIT_LIMIT_MS } from '../../../packages/backend/src/modules/supply/application/quick-answers.js';
import {
  MAX_PAID_ATTEMPTS,
  NOT_COVERED_ANSWER,
} from '../../../packages/backend/src/modules/supply/domain/quick-answer.js';
import {
  fixtureAuthoredV2,
  fixtureResearchPageV2,
} from '../../../packages/backend/src/modules/content/production/spike-v2/writer-v2.fixture.js';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureHarness, fixtureModel, signal } from '../support/fixture-model.js';
import type { FixtureModelPort, FixtureScenario } from '../support/fixture-model-port.js';
import { answerWith, enableProductionScope, fixtureProduction } from '../support/generated-scroll.js';
import { reportCases } from '../support/feedback.js';
import { openActive } from '../support/observations.js';
import { buildFromProviders } from '../support/providers.js';
import { clearRecordingPerson, recordingPerson } from '../support/recording-person.js';
import { scrollUseCases } from '../support/scroll.js';
import type { FixturePerson } from '../support/fixtures.js';

/**
 * Quick answer (D-086, D-253 to D-255) against a real PostgreSQL 16 database and pg-boss. The source Scroll is the
 * labelled Orrin fixture published as the v2 `seasons` recipe, and the answer writer is a labelled CI fixture model: this
 * proves what the code does with a model's answer (the stops it may see, the caps, the retention, the erasure), never what
 * a model says. No provider network.
 */
const JOB = 'supply.answer-quick-answer';

type Stage = 'write' | 'check' | 'rewrite';
/** Which model step a request is, by what its instructions say: the rewrite, the support check, or the writer. */
const stageOf = (request: string): Stage =>
  request.includes('REWRITE AFTER A SUPPORT CHECK')
    ? 'rewrite'
    : request.includes('You check one thing in a short answer')
      ? 'check'
      : 'write';

describe('Quick answers (real PostgreSQL, CI fixture model)', () => {
  let database: TestDatabase<Database>;
  let content: Awaited<ReturnType<typeof scrollUseCases>>;
  let ask: AskQuickAnswerUseCase;
  let read: ReadQuickAnswerUseCase;
  let dismiss: DismissQuickAnswerUseCase;
  let answer: AnswerQuickAnswerUseCase;
  let readForReport: ReadQuickAnswerForReport;
  let model: FixtureModelPort;
  /** What each model step answers: the writer (and its rewrite) and the support check, by the number of that kind of call so far. */
  let script: (stage: Stage, n: number) => FixtureScenario;
  const calledBefore: Record<Stage, number> = { write: 0, check: 0, rewrite: 0 };
  let scroll: { readonly assetId: string; readonly revision: number };
  let document: ScrollDocumentV2;
  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
  /** The worker's own entries into the personal scope so far, and the one (if any) on which it stops, as a crash would. */
  let workerEntries = 0;
  let workerStopsAtEntry: number | undefined;
  /** The real scope, except that a worker (a system actor) can be made to stop on a chosen entry. */
  function workerScope(): ReturnType<typeof withScope> {
    const real = withScope();
    return (authority, work) => {
      if (authority.actor.kind === 'system') {
        workerEntries += 1;
        if (workerEntries === workerStopsAtEntry)
          return Promise.reject(new Error('CI: the worker stopped before it stored the answer'));
      }
      return real(authority, work);
    };
  }

  /** Composes the use cases with the given daily caps, the way the API's and the worker's providers do. */
  function build(caps: { perDay: number; perPerson: number }) {
    const SCOPE = Symbol('scope');
    const ENQUEUE = Symbol('enqueue');
    const CONFIG = Symbol('config');
    const HARNESS = Symbol('harness');
    const providers = quickAnswerProviders({
      withPersonalScope: SCOPE,
      enqueueJob: ENQUEUE,
      config: CONFIG,
      harness: HARNESS,
    });
    const values = new Map<symbol, unknown>([
      [SCOPE, workerScope()],
      [ENQUEUE, makeEnqueueJob(content.boss)],
      [CONFIG, { supplyQuickAnswerDailyCap: caps.perDay, supplyQuickAnswerPersonDailyCap: caps.perPerson }],
      [FENCE_PERSONAL_RECORDING, fencePersonalRecording],
      [HARNESS, fixtureHarness(database.db, { model }).harness],
      ...identityScopeOwnerProviders().map((p) => [p.provide, p.useValue] as const),
      ...contentProviders().map((p) => [p.provide, p.useValue] as const),
      ...experienceEvidenceReadProviders().map((p) => [p.provide, p.useValue] as const),
    ]);
    const get = <T>(token: symbol): T => {
      const value = buildFromProviders(providers, token, values);
      values.set(token, value);
      return value as T;
    };
    get(QUICK_ANSWER_PORTS);
    ask = get(ASK_QUICK_ANSWER);
    read = get(READ_QUICK_ANSWER);
    dismiss = get(DISMISS_QUICK_ANSWER);
    answer = get(ANSWER_QUICK_ANSWER);
    readForReport = get(READ_QUICK_ANSWER_FOR_REPORT);
  }

  beforeAll(async () => {
    database = await createTestDatabase<Database>('quick_answers');
    await enableProductionScope(database.db);
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
    document = parsed.document;
    content = await scrollUseCases(database, { recording: true });
  });
  afterAll(async () => {
    await content.close();
    await database.drop();
  });
  afterEach(() => {
    script = standard;
  });

  const readStops = () => document.stops.filter((stop) => stop.kind === 'read');
  /** The second read stop: the first is before it, and read stops come after it, so a leak of a later stop can be seen. */
  const anchor = () => readStops()[1]!;
  const wordsOf = (stop: ScrollDocumentV2['stops'][number]) =>
    stop.kind === 'read' ? stop.blocks.map((block) => block.text).join(' ') : stop.prompt;
  /** The first run of words of the anchor stop with no digit: a quote that is really in the passage, to answer with and to check. */
  const tokensOf = (text: string): string[] =>
    text
      .normalize('NFKC')
      .toLowerCase()
      .replaceAll(/[‘’ʼ]/gu, "'")
      .split(/[^\p{L}\p{N}']+/u)
      .map((word) => word.replaceAll(/^'+|'+$/gu, ''))
      .filter((word) => word !== '');
  const quoteWords = (): string[] => {
    const tokens = tokensOf(wordsOf(anchor()));
    for (const size of [8, 6, 5, 4, 3])
      for (let at = 0; at + size <= tokens.length; at += 1) {
        const window = tokens.slice(at, at + size);
        if (window.every((word) => !/\p{N}/u.test(word))) return window;
      }
    throw new Error('the CI fixture has no run of words without a digit');
  };
  /** The question the writer asks of the passage, in the passage's own words, and the answer's one sentence. */
  const questionOf = () => `What does ${quoteWords().slice(0, 5).join(' ')} mean?`;
  const sentenceOf = () => `${quoteWords().join(' ')}.`;
  const writerReply = (over: Record<string, unknown> = {}): FixtureScenario => ({
    kind: 'success',
    text: JSON.stringify({ question: questionOf(), answer: sentenceOf(), covered: true, cites: ['e2'], ...over }),
  });
  const checkerReply = (...verdicts: Record<string, unknown>[]): FixtureScenario => ({
    kind: 'success',
    text: JSON.stringify({ sentences: verdicts }),
  });
  const clears = (): FixtureScenario => checkerReply({ n: 1, verdict: 'supported', quote: quoteWords().join(' ') });
  const finds = (): FixtureScenario =>
    checkerReply({ n: 1, verdict: 'unsupported', kind: 'goes_beyond', problem: 'The passage says less than this.' });
  /** The usual run: the writer answers from the passage and the check clears it. */
  const standard = (stage: Stage): FixtureScenario => (stage === 'check' ? clears() : writerReply());

  async function setup(caps = { perDay: 20, perPerson: 10 }) {
    await sql`delete from pgboss.job where name = ${JOB}`.execute(database.db);
    await sql`delete from supply.quick_answers`.execute(database.db);
    await sql`delete from supply.quick_answer_ledger`.execute(database.db);
    script = standard;
    calledBefore.write = calledBefore.check = calledBefore.rewrite = 0;
    model = fixtureModel(
      (_sequence, call) => {
        const stage = stageOf(JSON.stringify(call.request));
        calledBefore[stage] += 1;
        return script(stage, calledBefore[stage]);
      },
      { label: 'quick-answer-CI-fixture' },
    );
    build(caps);
  }

  /** A person who has opened and is reading the source Scroll, so they may ask about it. */
  async function reader() {
    const person = await recordingPerson(database);
    await openActive(content, person, scroll);
    return person;
  }
  const askCommand = (over: Partial<AskQuickAnswer> = {}): AskQuickAnswer => ({
    version: 'quick-answer-ask.v1',
    commandId: randomUUID(),
    source: { assetId: scroll.assetId, assetRevision: scroll.revision },
    stopId: anchor().id,
    passage: wordsOf(anchor()).slice(0, 30),
    recordingGeneration: 1,
    ...over,
  });
  async function accept(person: FixturePerson, command: AskQuickAnswer = askCommand()) {
    const result = await ask(person.authority, command);
    if (result.kind !== 'ok' || result.value.outcome !== 'accepted') throw new Error('CI ask not accepted');
    return result.value.quickAnswerId;
  }
  const job = (person: FixturePerson, quickAnswerId: string) => ({
    universeId: person.universeId,
    privacyEpoch: 1,
    quickAnswerId,
  });
  const row = (quickAnswerId: string) =>
    database.db
      .selectFrom('supply.quick_answers')
      .selectAll()
      .where('id', '=', quickAnswerId)
      .executeTakeFirstOrThrow();
  const queued = async () =>
    (
      await sql<{
        data: Record<string, unknown>;
      }>`select data from pgboss.job where name = ${JOB} and state = 'created'`.execute(database.db)
    ).rows.map((queuedJob) => queuedJob.data);
  const evidenceCounts = async (universe: string) =>
    Promise.all(
      ['experience.exposures', 'evidence.observations', 'evidence.action_events'].map(async (table) =>
        Number(
          (
            await sql<{
              n: string;
            }>`select count(*) as n from ${sql.table(table)} where universe_id = ${universe}::uuid`.execute(database.db)
          ).rows[0]!.n,
        ),
      ),
    );
  const status = async (person: FixturePerson, quickAnswerId: string) => {
    const result = await read(person.authority, { quickAnswerId });
    return result.kind === 'ok' ? result.value : result;
  };

  describe('asking', () => {
    it('stores the words, sends one job of IDs only, calls no model and writes no evidence', async () => {
      await setup();
      const person = await reader();
      const before = await evidenceCounts(person.universeId);
      const command = askCommand({ question: 'Why does it matter?' });
      const quickAnswerId = await accept(person, command);

      expect(await row(quickAnswerId)).toMatchObject({
        state: 'waiting',
        passage: command.passage,
        question: 'Why does it matter?',
        stop_id: anchor().id,
      });
      expect(await queued()).toEqual([{ v: 1, universeId: person.universeId, privacyEpoch: 1, quickAnswerId }]);
      // The ledger names no person and no words.
      const ledger = await database.db.selectFrom('supply.quick_answer_ledger').selectAll().execute();
      expect(ledger.map((entry) => entry.id)).toEqual([quickAnswerId]);
      expect(Object.keys(ledger[0]!).sort()).toEqual(['created_at', 'id']);
      // No model call on the HTTP path, and the ask is nothing a person read.
      expect(model.calls).toHaveLength(0);
      expect(await evidenceCounts(person.universeId)).toEqual(before);
      expect(await status(person, quickAnswerId)).toMatchObject({ status: 'waiting' });
    });

    it('answers an identical retry with the first receipt and starts nothing twice', async () => {
      await setup();
      const person = await reader();
      const command = askCommand();
      const first = await ask(person.authority, command);
      const again = await ask(person.authority, command);
      expect(again).toMatchObject({ kind: 'ok', value: { outcome: 'accepted', replayed: true } });
      expect(again.kind === 'ok' && again.value.outcome === 'accepted' && again.value.quickAnswerId).toBe(
        first.kind === 'ok' && first.value.outcome === 'accepted' && first.value.quickAnswerId,
      );
      expect(await queued()).toHaveLength(1);
      expect(await database.db.selectFrom('supply.quick_answer_ledger').select('id').execute()).toHaveLength(1);
      // The same command ID with other words is a reused key.
      expect(await ask(person.authority, { ...command, passage: wordsOf(anchor()).slice(5, 20) })).toEqual({
        kind: 'refused',
        reason: 'command_key_reused',
      });
    });

    it('is refused while recording is paused or its generation is stale, with no row and no job (D-254)', async () => {
      await setup();
      const person = await reader();
      expect(await ask(person.authority, askCommand({ recordingGeneration: 7 }))).toEqual({
        kind: 'refused',
        reason: 'recording_stale',
      });
      await sql`update identity.universes set recording_on = false, recording_generation = 2 where id = ${person.universeId}::uuid`.execute(
        database.db,
      );
      expect(await ask(person.authority, askCommand({ recordingGeneration: 2 }))).toEqual({
        kind: 'refused',
        reason: 'recording_paused',
      });
      expect(await database.db.selectFrom('supply.quick_answers').select('id').execute()).toEqual([]);
      expect(await database.db.selectFrom('supply.quick_answer_ledger').select('id').execute()).toEqual([]);
      expect(await queued()).toEqual([]);
    });

    it('refuses a Scroll the person never opened, a call, a missing stop and words from another stop', async () => {
      await setup();
      const person = await reader();
      const stranger = await recordingPerson(database);
      expect(await ask(stranger.authority, askCommand())).toEqual({ kind: 'refused', reason: 'source_unavailable' });
      const call = document.stops.find((stop) => stop.kind !== 'read')!;
      expect(await ask(person.authority, askCommand({ stopId: call.id, passage: wordsOf(call).slice(0, 20) }))).toEqual(
        {
          kind: 'refused',
          reason: 'source_unavailable',
        },
      );
      expect(await ask(person.authority, askCommand({ stopId: 'no-such-stop' }))).toEqual({
        kind: 'refused',
        reason: 'source_unavailable',
      });
      const other = readStops()[2]!;
      expect(await ask(person.authority, askCommand({ passage: wordsOf(other).slice(0, 30) }))).toEqual({
        kind: 'refused',
        reason: 'source_unavailable',
      });
      expect(await database.db.selectFrom('supply.quick_answers').select('id').execute()).toEqual([]);
    });
  });

  describe('the daily caps (an honest "not available", nothing stored)', () => {
    it('turns Quick answers off at a world cap of 0', async () => {
      await setup({ perDay: 0, perPerson: 10 });
      const person = await reader();
      expect(await ask(person.authority, askCommand())).toEqual({
        kind: 'ok',
        value: { version: 'quick-answer-receipt.v1', outcome: 'unavailable', reason: 'not_available' },
      });
      expect(await database.db.selectFrom('supply.quick_answers').select('id').execute()).toEqual([]);
      expect(await database.db.selectFrom('supply.quick_answer_ledger').select('id').execute()).toEqual([]);
      expect(await queued()).toEqual([]);
      expect(model.calls).toHaveLength(0);
    });

    it('stops one person at their own cap, and the world at its cap, whoever asks', async () => {
      await setup({ perDay: 3, perPerson: 2 });
      const [one, two] = [await reader(), await reader()];
      await accept(one);
      await accept(one);
      expect(await ask(one.authority, askCommand())).toMatchObject({
        value: { outcome: 'unavailable', reason: 'person_limit' },
      });
      await accept(two);
      // Three have been asked today in the world: the next person is told it is not available.
      const third = await reader();
      expect(await ask(third.authority, askCommand())).toMatchObject({
        value: { outcome: 'unavailable', reason: 'not_available' },
      });
      expect(await queued()).toHaveLength(3);
    });

    it('keeps the world counting after the people who asked erase their answers (the ledger names no one)', async () => {
      await setup({ perDay: 1, perPerson: 5 });
      const person = await reader();
      await accept(person);
      expect((await withScope()(person.authority, (tx) => eraseUniverse(tx, personalStores))).kind).toBe('entered');
      expect(await database.db.selectFrom('supply.quick_answers').select('id').execute()).toEqual([]);
      const next = await reader();
      expect(await ask(next.authority, askCommand())).toMatchObject({
        value: { outcome: 'unavailable', reason: 'not_available' },
      });
    });

    it('lets only so many wait at once', async () => {
      await setup();
      const person = await reader();
      for (let n = 0; n < 3; n += 1) await accept(person);
      expect(await ask(person.authority, askCommand())).toMatchObject({
        value: { outcome: 'unavailable', reason: 'too_many_open' },
      });
    });
  });

  describe('answering on the worker', () => {
    it('shows the model only the stops up to the reader’s, answers after a support check, clears the words and keeps the answer a day', async () => {
      await setup();
      const person = await reader();
      const quickAnswerId = await accept(person);
      await answer(job(person, quickAnswerId), signal());

      // The writer and the support check: two paid attempts, neither of them shown anything past the reader's stop.
      expect(model.calls).toHaveLength(2);
      const seen = model.calls.map((call) => JSON.stringify(call.request)).join('\n');
      const read = readStops();
      expect(JSON.stringify(model.calls[0]!.request)).toContain(wordsOf(read[0]!).slice(0, 25));
      expect(JSON.stringify(model.calls[0]!.request)).toContain(wordsOf(read[1]!).slice(0, 25));
      for (const later of read.slice(2)) expect(seen).not.toContain(wordsOf(later).slice(0, 25));
      for (const stop of document.stops.filter((candidate) => candidate.kind !== 'read'))
        expect(seen).not.toContain(wordsOf(stop).slice(0, 25));
      // The checker is shown the passage the answer cites and its sentence, not the whole Scroll so far.
      expect(JSON.stringify(model.calls[1]!.request)).not.toContain(wordsOf(read[0]!).slice(0, 25));

      expect(await row(quickAnswerId)).toMatchObject({
        state: 'answered',
        passage: null,
        question: null,
        shown_question: questionOf(),
        answer: sentenceOf(),
        covered: true,
      });
      expect(await status(person, quickAnswerId)).toMatchObject({
        status: 'answered',
        label: 'Quick answer · not a checked Scroll',
        question: questionOf(),
        covered: true,
      });
      const stored = await row(quickAnswerId);
      expect(stored.expires_at.getTime() - stored.created_at.getTime()).toBe(24 * 3_600_000);
      // Every run was closed in the transaction that stored the card.
      const runs = await sql<{
        state: string;
      }>`select state from reasoning.business_runs where universe_id = ${person.universeId}::uuid and owner_module = 'supply'`.execute(
        database.db,
      );
      expect(runs.rows.map((run) => run.state)).toEqual(['completed', 'completed']);
    });

    it('writes no evidence: no exposure, observation or action, from the ask or from the answer', async () => {
      await setup();
      const person = await reader();
      const before = await evidenceCounts(person.universeId);
      const quickAnswerId = await accept(person);
      await answer(job(person, quickAnswerId), signal());
      expect(await evidenceCounts(person.universeId)).toEqual(before);
      // The counter can see evidence: meeting a Scroll moves it, so a quiet ask is not a blind spot.
      const other = await recordingPerson(database);
      const untouched = await evidenceCounts(other.universeId);
      await openActive(content, other, scroll);
      expect(await evidenceCounts(other.universeId)).not.toEqual(untouched);
    });

    it('cites only a passage it was offered: an invented one is repaired once, then closes as unavailable, never shown or checked', async () => {
      await setup();
      const person = await reader();
      script = (stage) => (stage === 'check' ? clears() : writerReply({ cites: ['e9'] }));
      const quickAnswerId = await accept(person);
      await answer(job(person, quickAnswerId), signal());
      // One answer and one repair, both refused: the checker is never asked.
      expect(model.calls).toHaveLength(2);
      expect(calledBefore.check).toBe(0);
      expect(await status(person, quickAnswerId)).toMatchObject({ status: 'unavailable', reason: 'could_not_answer' });
      expect(await row(quickAnswerId)).toMatchObject({ state: 'unavailable', answer: null, passage: null });
    });

    it('says it could not answer when the model fails, and a redelivery finds the card settled and asks nothing', async () => {
      await setup();
      const person = await reader();
      script = () => ({ kind: 'server_error' });
      const quickAnswerId = await accept(person);
      await answer(job(person, quickAnswerId), signal());
      await answer(job(person, quickAnswerId), signal());
      expect(model.calls).toHaveLength(1);
      expect(await status(person, quickAnswerId)).toMatchObject({ status: 'unavailable' });
    });

    it('never pays twice for a redelivery: a worker that stopped after the model answered gets the answer from the ledger, not the model', async () => {
      await setup();
      const person = await reader();
      const quickAnswerId = await accept(person);
      // The first delivery enters the scope to read (entry 1), asks the writer and the checker, and stops before it enters to store (entry 2).
      workerEntries = 0;
      workerStopsAtEntry = 2;
      await expect(answer(job(person, quickAnswerId), signal())).rejects.toThrow('the worker stopped');
      workerStopsAtEntry = undefined;
      expect(model.calls).toHaveLength(2);
      expect(await row(quickAnswerId)).toMatchObject({ state: 'waiting' });
      // The redelivery reads the same row, reaches the ledger through the harness, and stores the answer the first one paid for.
      await answer(job(person, quickAnswerId), signal());
      expect(model.calls).toHaveLength(2);
      expect(await row(quickAnswerId)).toMatchObject({ state: 'answered', passage: null, question: null });
      // The ledger holds the two attempts, the writer's and the checker's, each once.
      const attempts = await sql<{
        n: string;
      }>`select count(*) as n from reasoning.external_attempts where universe_id = ${person.universeId}::uuid`.execute(
        database.db,
      );
      expect(Number(attempts.rows[0]!.n)).toBe(2);
    });

    it('says it could not answer, calling no model, for a person who paused and resumed recording: the personal harness runs only at the first generation', async () => {
      await setup();
      const person = await reader();
      await sql`update identity.universes set recording_on = false, recording_generation = 2 where id = ${person.universeId}::uuid`.execute(
        database.db,
      );
      await sql`update identity.universes set recording_on = true, recording_generation = 3 where id = ${person.universeId}::uuid`.execute(
        database.db,
      );
      const quickAnswerId = await accept(person, askCommand({ recordingGeneration: 3 }));
      await answer(job(person, quickAnswerId), signal());
      expect(model.calls).toHaveLength(0);
      expect(await status(person, quickAnswerId)).toMatchObject({ status: 'unavailable', reason: 'could_not_answer' });
    });

    it('drops an answer that arrives after the card was dismissed, and a dismissed card stores nothing', async () => {
      await setup();
      const person = await reader();
      const quickAnswerId = await accept(person);
      expect(await dismiss(person.authority, { quickAnswerId })).toMatchObject({ kind: 'ok' });
      expect(await row(quickAnswerId)).toMatchObject({
        state: 'dismissed',
        passage: null,
        question: null,
        answer: null,
      });
      await answer(job(person, quickAnswerId), signal());
      expect(model.calls).toHaveLength(0);
      expect(await status(person, quickAnswerId)).toEqual({ kind: 'refused', reason: 'not_found' });
    });

    it('is private: another person reads nothing, and dismissing another person’s answer changes nothing', async () => {
      await setup();
      const person = await reader();
      const stranger = await recordingPerson(database);
      const quickAnswerId = await accept(person);
      expect(await status(stranger, quickAnswerId)).toEqual({ kind: 'refused', reason: 'not_found' });
      expect(await dismiss(stranger.authority, { quickAnswerId })).toMatchObject({ kind: 'ok' });
      expect(await row(quickAnswerId)).toMatchObject({ state: 'waiting' });
    });

    it('reads a stop for the model as the facts port says: never past the anchor, never a call, nothing for a call', async () => {
      await setup();
      const person = await reader();
      const facts = async (stop: string) => {
        const entered = await withScope()(person.authority, (tx) =>
          readScrollQuickAnswerFacts(tx, { assetId: scroll.assetId, assetRevision: 1 }, stop),
        );
        return entered.kind === 'entered' ? entered.value : undefined;
      };
      const read = readStops();
      expect((await facts(read[0]!.id))?.passages.map((passage) => passage.stopId)).toEqual([read[0]!.id]);
      expect((await facts(read[1]!.id))?.passages.map((passage) => passage.stopId)).toEqual([read[0]!.id, read[1]!.id]);
      expect(await facts(document.stops.find((stop) => stop.kind !== 'read')!.id)).toBeUndefined();
      expect(await facts('no-such-stop')).toBeUndefined();
    });
  });

  describe('the support check and what code owns of a card (D-253)', () => {
    async function asked() {
      await setup();
      const person = await reader();
      return { person, quickAnswerId: await accept(person) };
    }
    const attemptsOf = async (universeId: string) =>
      Number(
        (
          await sql<{
            n: string;
          }>`select count(*) as n from reasoning.external_attempts where universe_id = ${universeId}::uuid`.execute(
            database.db,
          )
        ).rows[0]!.n,
      );

    it('shows an answer after the check clears it, and the check is shown only the passage the answer cites', async () => {
      const { person, quickAnswerId } = await asked();
      await answer(job(person, quickAnswerId), signal());
      const request = JSON.stringify(model.calls[1]!.request);
      expect(request).toContain(sentenceOf());
      expect(request).toContain('[e2]');
      expect(request).not.toContain(wordsOf(readStops()[0]!).slice(0, 25));
      expect(await status(person, quickAnswerId)).toMatchObject({ status: 'answered' });
    });

    it('rewrites once an answer with an unsupported sentence, and shows the rewrite only after its own check clears it', async () => {
      const { person, quickAnswerId } = await asked();
      script = (stage, n) =>
        stage === 'check'
          ? n === 1
            ? finds()
            : clears()
          : writerReply(stage === 'rewrite' ? {} : { answer: 'Greek astronomers measured it long before telescopes.' });
      await answer(job(person, quickAnswerId), signal());
      expect([calledBefore.write, calledBefore.check, calledBefore.rewrite]).toEqual([1, 2, 1]);
      expect(await row(quickAnswerId)).toMatchObject({ state: 'answered', answer: sentenceOf() });
      // The rewrite was told which sentence to fix by a fixed hint, not by the checker's words.
      const rewrite = JSON.stringify(model.calls[2]!.request);
      expect(rewrite).toContain('says something narrower or different');
      expect(rewrite).toContain('Greek astronomers');
      expect(rewrite).not.toContain('The passage says less than this.');
      expect(await attemptsOf(person.universeId)).toBe(4);
    });

    it('shows nothing when an outside-knowledge answer, with no digit and in plain words, is not cleared twice: no card, and nothing of it stored', async () => {
      const { person, quickAnswerId } = await asked();
      script = (stage) =>
        stage === 'check' ? finds() : writerReply({ answer: 'Greek astronomers measured it long before telescopes.' });
      await answer(job(person, quickAnswerId), signal());
      expect(model.calls).toHaveLength(4);
      const stored = await row(quickAnswerId);
      expect(stored).toMatchObject({ state: 'unavailable', answer: null, shown_question: null, passage: null });
      expect(JSON.stringify(stored)).not.toContain('Greek');
      expect(await status(person, quickAnswerId)).toMatchObject({ status: 'unavailable', reason: 'could_not_answer' });
    });

    it('is no card at all when the check fails or its reply is unusable: no checker, no card, and no rewrite', async () => {
      for (const check of [
        (): FixtureScenario => ({ kind: 'server_error' }),
        (): FixtureScenario => ({ kind: 'malformed' }),
      ]) {
        const { person, quickAnswerId } = await asked();
        script = (stage) => (stage === 'check' ? check() : writerReply());
        await answer(job(person, quickAnswerId), signal());
        expect(await row(quickAnswerId)).toMatchObject({ state: 'unavailable', answer: null, shown_question: null });
        expect(calledBefore.rewrite).toBe(0);
      }
    });

    it('treats a quote that is not in the passage as that sentence unsupported (D-265): one rewrite, and no card unless its own check clears it', async () => {
      const unquoted = (): FixtureScenario =>
        checkerReply({ n: 1, verdict: 'supported', quote: 'sunlight arrives steeper and the days run longer' });
      // Still the same finding on the rewrite: no card, nothing of the answer stored.
      const refused = await asked();
      script = (stage) => (stage === 'check' ? unquoted() : writerReply());
      await answer(job(refused.person, refused.quickAnswerId), signal());
      expect([calledBefore.write, calledBefore.check, calledBefore.rewrite]).toEqual([1, 2, 1]);
      expect(await row(refused.quickAnswerId)).toMatchObject({
        state: 'unavailable',
        answer: null,
        shown_question: null,
      });
      // The rewrite is told which sentence to fix by a fixed hint and a fixed note, never by the checker's quote.
      const rewrite = JSON.stringify(model.calls[2]!.request);
      expect(rewrite).toContain('No passage you cite states this');
      expect(rewrite).not.toContain('sunlight arrives steeper');
      // A rewrite that its own check clears is shown.
      const cleared = await asked();
      script = (stage, n) => (stage === 'check' ? (n === 1 ? unquoted() : clears()) : writerReply());
      await answer(job(cleared.person, cleared.quickAnswerId), signal());
      expect([calledBefore.write, calledBefore.check, calledBefore.rewrite]).toEqual([1, 2, 1]);
      expect(await row(cleared.quickAnswerId)).toMatchObject({ state: 'answered' });
    });

    it('shows a sentence code owns, and none of the writer’s words, for a question the passages do not cover, and checks nothing', async () => {
      const { person, quickAnswerId } = await asked();
      script = (stage) =>
        stage === 'check'
          ? clears()
          : writerReply({
              covered: false,
              cites: [],
              question: 'Who measured it?',
              answer: 'Greek astronomers measured it long before telescopes.',
            });
      await answer(job(person, quickAnswerId), signal());
      expect(model.calls).toHaveLength(1);
      const stored = await row(quickAnswerId);
      expect(stored).toMatchObject({ state: 'answered', covered: false, answer: NOT_COVERED_ANSWER });
      expect(stored.shown_question).toMatch(/^About “/u);
      expect(JSON.stringify(stored)).not.toContain('Greek');
      expect(await status(person, quickAnswerId)).toMatchObject({
        status: 'answered',
        covered: false,
        answer: NOT_COVERED_ANSWER,
      });
    });

    it('keeps to six paid attempts in the worst case: an invalid answer and its repair, an invalid check and its repair, one rewrite and its check', async () => {
      const { person, quickAnswerId } = await asked();
      script = (stage, n) => {
        if (stage === 'write') return n === 1 ? { kind: 'malformed' } : writerReply();
        if (stage === 'check') return n === 1 ? { kind: 'malformed' } : n === 2 ? finds() : clears();
        return writerReply();
      };
      await answer(job(person, quickAnswerId), signal());
      expect(model.calls).toHaveLength(MAX_PAID_ATTEMPTS);
      expect(await attemptsOf(person.universeId)).toBe(MAX_PAID_ATTEMPTS);
      expect(await row(quickAnswerId)).toMatchObject({ state: 'answered' });
    });
  });

  describe('an answer nobody waits for any more (B3)', () => {
    const longAgo = () => sql`now() - interval '1 hour'`;

    it('is settled as unavailable with its words cleared when its job arrives late, and no model is asked', async () => {
      await setup();
      const person = await reader();
      const quickAnswerId = await accept(person, askCommand({ question: 'Why does it matter?' }));
      await sql`update supply.quick_answers set created_at = ${new Date(Date.now() - 3_600_000)} where id = ${quickAnswerId}::uuid`.execute(
        database.db,
      );
      await answer(job(person, quickAnswerId), signal());
      expect(model.calls).toHaveLength(0);
      expect(await row(quickAnswerId)).toMatchObject({
        state: 'unavailable',
        passage: null,
        question: null,
        answer: null,
      });
      expect(await status(person, quickAnswerId)).toMatchObject({ status: 'unavailable', reason: 'could_not_answer' });
    });

    it('does not hold the person’s places: rows older than the wait limit are not counted, so a fourth ask is accepted', async () => {
      await setup();
      const person = await reader();
      const old: string[] = [];
      for (let n = 0; n < 3; n += 1) old.push(await accept(person));
      expect(await ask(person.authority, askCommand())).toMatchObject({
        value: { outcome: 'unavailable', reason: 'too_many_open' },
      });
      for (const quickAnswerId of old)
        await sql`update supply.quick_answers set created_at = ${new Date(Date.now() - 3_600_000)} where id = ${quickAnswerId}::uuid`.execute(
          database.db,
        );
      expect(await ask(person.authority, askCommand())).toMatchObject({ value: { outcome: 'accepted' } });
    });

    it('is closed by the scheduled purge when no job ever ran: unavailable, the words cleared, a younger answer left alone', async () => {
      await setup();
      const person = await reader();
      const stale = await accept(person, askCommand({ question: 'Why does it matter?' }));
      const young = await accept(person);
      await sql`update supply.quick_answers set created_at = ${longAgo()} where id = ${stale}::uuid`.execute(
        database.db,
      );
      expect(await giveUpStaleQuickAnswers(database.db, QUICK_ANSWER_WAIT_LIMIT_MS)(500)).toBe(1);
      expect(await row(stale)).toMatchObject({ state: 'unavailable', passage: null, question: null });
      expect(await row(young)).toMatchObject({ state: 'waiting' });
      // Nothing is left to close, and the closed one is kept until its day is over and then purged.
      expect(await giveUpStaleQuickAnswers(database.db, QUICK_ANSWER_WAIT_LIMIT_MS)(500)).toBe(0);
    });
  });

  describe('retention, export and erasure', () => {
    it('purges answers past their day and nothing else', async () => {
      await setup();
      const person = await reader();
      const old = await accept(person);
      const fresh = await accept(person);
      await sql`update supply.quick_answers set created_at = now() - interval '26 hours', expires_at = now() - interval '2 hours' where id = ${old}::uuid`.execute(
        database.db,
      );
      expect(await purgeExpiredQuickAnswers(database.db)(500)).toBe(1);
      expect((await database.db.selectFrom('supply.quick_answers').select('id').execute()).map((r) => r.id)).toEqual([
        fresh,
      ]);
      // An answer past its day reads as gone even before the purge has run.
      // The application's clock decides what a person may still read, so the test moves the row by that clock.
      const lastSecond = new Date(Date.now() - 1000);
      const dayAgo = new Date(Date.now() - 86_400_000 - 1000);
      await sql`update supply.quick_answers set expires_at = ${lastSecond}, created_at = ${dayAgo} where id = ${fresh}::uuid`.execute(
        database.db,
      );
      expect(await status(person, fresh)).toEqual({ kind: 'refused', reason: 'not_found' });
    });

    it('is in the export in the person’s own words, and Clear and account erasure remove it with its queued job', async () => {
      await setup();
      const person = await reader();
      const quickAnswerId = await accept(person);
      await answer(job(person, quickAnswerId), signal());
      await accept(person);
      // The answered one's job was run by hand above, so it is still queued beside the waiting one's.
      expect(await queued()).toHaveLength(2);

      const exported = await withScope()(person.authority, (tx) =>
        exportCurrentPerson(tx, { accountId: person.accountId }, () => Promise.resolve(new Set<string>())),
      );
      const text = JSON.stringify(exported);
      expect(text).toContain(questionOf());
      expect(text).toContain('quickAnswers');

      const erased = await withScope()(person.authority, (tx) => eraseUniverse(tx, personalStores));
      expect(erased.kind).toBe('entered');
      expect(
        await database.db
          .selectFrom('supply.quick_answers')
          .select('id')
          .where('universe_id', '=', person.universeId)
          .execute(),
      ).toEqual([]);
      expect(await queued()).toEqual([]);
    });

    it('is removed by Clear, which also removes the queued job', async () => {
      await setup();
      const person = await recordingPerson(database);
      await openActive(content, person, scroll);
      await accept(person);
      await clearRecordingPerson(database, content.boss, person);
      expect(
        await database.db
          .selectFrom('supply.quick_answers')
          .select('id')
          .where('universe_id', '=', person.universeId)
          .execute(),
      ).toEqual([]);
      expect(await queued()).toEqual([]);
    });
  });

  describe('reporting (D-255)', () => {
    it('keeps the words of the answer with the report, only for the person’s own answer about that revision', async () => {
      await setup();
      const person = await reader();
      const quickAnswerId = await accept(person);
      await answer(job(person, quickAnswerId), signal());
      const reports = reportCases(
        database.db,
        () => new Date(),
        (scope, input) => readForReport(scope, input),
      );
      const target = { assetId: scroll.assetId, assetRevision: scroll.revision };
      const sent = await reports.reportContentError(person.authority, {
        commandId: randomUUID(),
        target,
        category: 'wrong',
        anchor: { kind: 'scroll', blockId: anchor().id },
        quickAnswerId,
      });
      expect(sent).toMatchObject({ kind: 'received' });
      const stored = await database.db.selectFrom('feedback.reports').select('quick_answer').executeTakeFirstOrThrow();
      expect(stored.quick_answer).toBe(`Q: ${questionOf()}\nA: ${sentenceOf()}`);
      // Another person cannot report it, and a dismissed answer cannot be reported: a missing target.
      const stranger = await reader();
      expect(
        await reports.reportContentError(stranger.authority, {
          commandId: randomUUID(),
          target,
          category: 'wrong',
          quickAnswerId,
        }),
      ).toEqual({ kind: 'refused', reason: 'target_unavailable' });
      await dismiss(person.authority, { quickAnswerId });
      expect(
        await reports.reportContentError(person.authority, {
          commandId: randomUUID(),
          target,
          category: 'wrong',
          quickAnswerId,
        }),
      ).toEqual({ kind: 'refused', reason: 'target_unavailable' });
      // The report outlives the answer: the safety team can still read what was wrong.
      expect(await database.db.selectFrom('feedback.reports').select('quick_answer').execute()).toHaveLength(1);
    });
  });
});
