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
import { purgeExpiredQuickAnswers } from '../../../packages/backend/src/modules/supply/adapters/postgres-quick-answers.js';
import {
  fixtureAuthoredV2,
  fixtureResearchPageV2,
} from '../../../packages/backend/src/modules/content/production/spike-v2/writer-v2.fixture.js';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureHarness, fixtureModel, signal } from '../support/fixture-model.js';
import type { FixtureModelPort } from '../support/fixture-model-port.js';
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

describe('Quick answers (real PostgreSQL, CI fixture model)', () => {
  let database: TestDatabase<Database>;
  let content: Awaited<ReturnType<typeof scrollUseCases>>;
  let ask: AskQuickAnswerUseCase;
  let read: ReadQuickAnswerUseCase;
  let dismiss: DismissQuickAnswerUseCase;
  let answer: AnswerQuickAnswerUseCase;
  let readForReport: ReadQuickAnswerForReport;
  let model: FixtureModelPort;
  let script: (sequence: number) => { kind: 'success'; text: string } | { kind: 'server_error' };
  let scroll: { readonly assetId: string; readonly revision: number };
  let document: ScrollDocumentV2;
  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });

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
      [SCOPE, withScope()],
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
    script = () => ({ kind: 'success', text: cited('e1') });
  });

  const readStops = () => document.stops.filter((stop) => stop.kind === 'read');
  /** The second read stop: the first is before it, and read stops come after it, so a leak of a later stop can be seen. */
  const anchor = () => readStops()[1]!;
  const wordsOf = (stop: ScrollDocumentV2['stops'][number]) =>
    stop.kind === 'read' ? stop.blocks.map((block) => block.text).join(' ') : stop.prompt;
  const cited = (...cites: string[]) =>
    JSON.stringify({
      question: 'What does this passage mean?',
      answer: 'The Scroll says it plainly, and this is the short version of it.',
      covered: true,
      cites,
    });

  async function setup(caps = { perDay: 20, perPerson: 10 }) {
    await sql`delete from pgboss.job where name = ${JOB}`.execute(database.db);
    await sql`delete from supply.quick_answers`.execute(database.db);
    await sql`delete from supply.quick_answer_ledger`.execute(database.db);
    script = () => ({ kind: 'success', text: cited('e1') });
    model = fixtureModel((sequence) => script(sequence), { label: 'quick-answer-CI-fixture' });
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
    it('shows the model only the stops up to the reader’s, answers, clears the words and keeps the answer a day', async () => {
      await setup();
      const person = await reader();
      const quickAnswerId = await accept(person);
      await answer(job(person, quickAnswerId), signal());

      expect(model.calls).toHaveLength(1);
      const seen = JSON.stringify(model.calls[0]!.request);
      const read = readStops();
      // The first read stop and the anchor are offered; no stop after the anchor, and no call, is.
      expect(seen).toContain(wordsOf(read[0]!).slice(0, 25));
      expect(seen).toContain(wordsOf(read[1]!).slice(0, 25));
      for (const later of read.slice(2)) expect(seen).not.toContain(wordsOf(later).slice(0, 25));
      for (const stop of document.stops.filter((candidate) => candidate.kind !== 'read'))
        expect(seen).not.toContain(wordsOf(stop).slice(0, 25));

      expect(await row(quickAnswerId)).toMatchObject({
        state: 'answered',
        passage: null,
        question: null,
        shown_question: 'What does this passage mean?',
        covered: true,
      });
      expect(await status(person, quickAnswerId)).toMatchObject({
        status: 'answered',
        label: 'Quick answer · not a checked Scroll',
        question: 'What does this passage mean?',
        covered: true,
      });
      const stored = await row(quickAnswerId);
      expect(stored.expires_at.getTime() - stored.created_at.getTime()).toBe(24 * 3_600_000);
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

    it('cites only a passage it was offered: an invented one is repaired once, then closes as unavailable, never shown', async () => {
      await setup();
      const person = await reader();
      script = () => ({ kind: 'success', text: cited('e9') });
      const quickAnswerId = await accept(person);
      await answer(job(person, quickAnswerId), signal());
      // One answer and one repair, both refused.
      expect(model.calls).toHaveLength(2);
      expect(await status(person, quickAnswerId)).toMatchObject({ status: 'unavailable', reason: 'could_not_answer' });
      expect(await row(quickAnswerId)).toMatchObject({ state: 'unavailable', answer: null, passage: null });
    });

    it('says it could not answer when the model fails, and a redelivery never pays twice', async () => {
      await setup();
      const person = await reader();
      script = () => ({ kind: 'server_error' });
      const quickAnswerId = await accept(person);
      await answer(job(person, quickAnswerId), signal());
      await answer(job(person, quickAnswerId), signal());
      expect(model.calls.length).toBeLessThanOrEqual(1);
      expect(await status(person, quickAnswerId)).toMatchObject({ status: 'unavailable' });
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
      expect(text).toContain('What does this passage mean?');
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
      expect(stored.quick_answer).toBe(
        'Q: What does this passage mean?\nA: The Scroll says it plainly, and this is the short version of it.',
      );
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
