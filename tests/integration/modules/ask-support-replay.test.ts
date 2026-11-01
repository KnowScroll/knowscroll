import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { makeAskSupportReplay, type ReplayResult } from '@knowscroll/backend/modules/content/nest-providers';
import { madeToOrderKey } from '../../../packages/backend/src/modules/content/domain/order-key.js';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { signal } from '../support/fixture-model.js';
import type { FixtureCall, FixtureScenario } from '../support/fixture-model-port.js';
import {
  answerWith,
  enableProductionScope,
  fixtureAnswer,
  fixtureAuthored,
  fixtureResearchPage,
  supportReply,
  supportRequestOf,
} from '../support/generated-scroll.js';
import { fixtureProductionWorker } from '../support/production-worker.js';

/**
 * The operator's replay of the support check over stored ask answers (D-250) against a real PostgreSQL 16 database. The
 * answers are labelled CI fixtures about an invented lighthouse, written to the production job by the real job, and the
 * "model" is a labelled CI fixture: this proves what the command reads, asks, prints and leaves alone, never what a model
 * says.
 */
describe('replaying the support check over stored ask answers (labelled CI fixtures, real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  /** The support checker's replies; by default every sentence is supported. */
  let support: (check: number, call: FixtureCall) => FixtureScenario | Promise<FixtureScenario> = (_check, call) =>
    supportReply(call);
  let quotaSpent = false;
  let worker: ReturnType<typeof fixtureProductionWorker>;
  const withScope = () => makeWithProductionScope(database.db, { enabled: true, lockTimeoutMs: 5000 });

  beforeAll(async () => {
    database = await createTestDatabase<Database>('ask_support_replay');
    await enableProductionScope(database.db);
    worker = fixtureProductionWorker(
      database,
      (_sequence, call) =>
        answerWith(call.request.user.includes('KIND: a CI what-if') ? fixtureAuthored('comparison') : fixtureAnswer()),
      {
        support: (check, call) => support(check, call),
        quota: () => ({
          verdict: quotaSpent ? 'unavailable' : 'not_applicable',
          intervalRemainingPercent: null,
          weeklyRemainingPercent: null,
        }),
      },
    );
  });
  afterAll(async () => {
    await database.drop();
  });

  /** An order stored the way supply stores one, produced by the real job. */
  async function producedOrder(mode: 'question' | 'what_if') {
    const recipe = madeToOrderKey(randomUUID());
    const assetId = randomUUID();
    const brief = mode === 'question' ? 'KIND: a CI question, never a person’s words' : 'KIND: a CI what-if';
    await sql`insert into content.made_to_order_scrolls (recipe, asset_id, explanation_unit_id, mode, brief, pages, kicker, framing)
      values (${recipe}, ${assetId}::uuid, ${recipe}, ${mode}, ${brief}, ${[fixtureResearchPage.url]}::text[], ${'You asked'}, ${JSON.stringify({ kind: 'factual' })}::jsonb)`.execute(
      database.db,
    );
    const result = await worker.producer()(recipe, false, signal(), false, 1);
    expect(result.outcome).toBe('published');
    return { recipe, assetId };
  }

  const replay = (overrides: { model?: string } = {}) =>
    makeAskSupportReplay({
      db: database.db,
      harness: worker.harness,
      withScope: withScope(),
      authority: { scopeId: 'scroll-supply', generation: 1 },
      model: overrides.model ?? 'MiniMax-M3.1-Flash',
      newRunKey: randomUUID,
    });
  async function replayed(target: Parameters<ReturnType<typeof replay>>[0], overrides: { model?: string } = {}) {
    const results: ReplayResult[] = [];
    const summary = await replay(overrides)(target, signal(), (result) => void results.push(result));
    return { results, summary };
  }
  const contentRows = async () => ({
    assets: Number(
      (await sql<{ n: string }>`select count(*) as n from content.assets`.execute(database.db)).rows[0]!.n,
    ),
    revisions: Number(
      (await sql<{ n: string }>`select count(*) as n from content.asset_revisions`.execute(database.db)).rows[0]!.n,
    ),
    jobs: JSON.stringify(
      (await sql`select id, state, outcomes from content.scroll_production_runs order by id`.execute(database.db)).rows,
    ),
  });

  it('checks a stored answer again, reports counts on the line and the sentences with their verdicts in the detail', async () => {
    const answer = await producedOrder('question');
    const before = await contentRows();
    const callsBefore = worker.supportCalls.length;
    // The checker now finds the sentence that starts "Because the beam turns" unsupported.
    support = (_check, call) => {
      const { sentences } = supportRequestOf(call);
      const flagged = sentences.find((sentence) => sentence.text.startsWith('Because the beam turns'))!;
      return supportReply(call, {
        unsupported: { [flagged.n]: { kind: 'contradicted', problem: 'A passage says otherwise.' } },
      });
    };

    const { results, summary } = await replayed({ kind: 'assets', assetIds: [answer.assetId] });

    expect(summary).toEqual({ answers: 1, stopped: false });
    expect(worker.supportCalls.length - callsBefore).toBe(1);
    const [only] = results;
    expect(only!.line).toMatchObject({
      assetId: answer.assetId,
      outcome: 'checked',
      unsupported: 1,
      requests: 1,
    });
    expect(only!.line.supported + only!.line.unsupported + only!.line.noClaim).toBe(only!.line.sentences);
    // What the operator sees on the line holds counts and codes: no sentence, no title and no question.
    const line = JSON.stringify(only!.line);
    expect(line).not.toContain('Because the beam turns');
    expect(line).not.toContain('How a lamp');
    // The file's detail has every sentence with the passages it cites and the checker's verdict, flagged one included.
    expect(only!.detail!.sentences).toHaveLength(only!.line.sentences);
    const flaggedSentences = only!.detail!.sentences.filter((sentence) => sentence.verdict === 'unsupported');
    expect(flaggedSentences).toHaveLength(1);
    expect(flaggedSentences[0]).toMatchObject({ kind: 'contradicted', problem: 'A passage says otherwise.' });
    expect(flaggedSentences[0]!.text.startsWith('Because the beam turns')).toBe(true);
    expect(only!.detail!.sentences.find((sentence) => sentence.verdict === 'supported')?.quote).toBeTruthy();
    // The checker was never shown the question, because the check does not use it.
    expect(worker.supportCalls.at(-1)!.request.user).not.toContain('a CI question');
    // Nothing was published, stored or changed: the answer, its job and its Scroll are as they were.
    expect(await contentRows()).toEqual(before);
    // The replay's own run is in the ledger and closed.
    const ledgered = await database.db
      .selectFrom('reasoning.production_runs')
      .select(['state', 'closed_at'])
      .where('id', '=', only!.line.runId!)
      .executeTakeFirstOrThrow();
    expect(ledgered).toMatchObject({ state: 'completed' });
    expect(ledgered.closed_at).not.toBeNull();
    support = (_check, call) => supportReply(call);
  });

  it('names an asset that is not a stored ask answer, and asks the model nothing for it', async () => {
    const whatIf = await producedOrder('what_if');
    const callsBefore = worker.supportCalls.length;
    const { results, summary } = await replayed({
      kind: 'assets',
      assetIds: [whatIf.assetId, TOPICS.tides.assetId, randomUUID()],
    });
    expect(summary).toEqual({ answers: 0, stopped: false });
    expect(results.map((result) => [result.line.outcome, result.line.code])).toEqual([
      ['not_replayable', 'not_an_ask_answer'],
      ['not_replayable', 'not_an_ask_answer'],
      ['not_replayable', 'not_an_ask_answer'],
    ]);
    expect(worker.supportCalls.length).toBe(callsBefore);
  });

  it('replays the newest published ask answers, newest first, and no other kind of order', async () => {
    const older = await producedOrder('question');
    const newer = await producedOrder('question');
    await producedOrder('what_if');
    const { results } = await replayed({ kind: 'recent', count: 2 });
    expect(results.map((result) => result.line.assetId)).toEqual([newer.assetId, older.assetId]);
  });

  it('reports a reply that stayed unusable as unchecked, with no detail', async () => {
    const answer = await producedOrder('question');
    support = () => ({ kind: 'malformed' });
    const { results } = await replayed({ kind: 'assets', assetIds: [answer.assetId] });
    support = (_check, call) => supportReply(call);
    expect(results[0]!.line).toMatchObject({ outcome: 'unchecked', code: 'invalid_output', requests: 2 });
    expect(results[0]!.detail).toBeUndefined();
  });

  it('stops at a spent quota without sending anything', async () => {
    const answer = await producedOrder('question');
    quotaSpent = true;
    try {
      const { results, summary } = await replayed({ kind: 'assets', assetIds: [answer.assetId] });
      expect(summary.stopped).toBe(true);
      expect(results[0]!.line).toMatchObject({ outcome: 'paused', code: 'quota_unavailable', requests: 0 });
    } finally {
      quotaSpent = false;
    }
  });

  it('refuses to run on a model other than the one the library is written with', async () => {
    const answer = await producedOrder('question');
    const callsBefore = worker.supportCalls.length;
    const { results, summary } = await replayed(
      { kind: 'assets', assetIds: [answer.assetId] },
      { model: 'some-other-model' },
    );
    expect(summary).toEqual({ answers: 0, stopped: true });
    expect(results[0]!.line).toMatchObject({ outcome: 'model_mismatch' });
    expect(worker.supportCalls.length).toBe(callsBefore);
  });
});
