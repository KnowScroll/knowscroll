import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  makeAskSupportReplay,
  readCandidateInstructions,
  type CandidateCheckerInstructions,
  type ReplayResult,
} from '@knowscroll/backend/modules/content/nest-providers';
import { madeToOrderKey } from '../../../packages/backend/src/modules/content/domain/order-key.js';
import { CANDIDATE_ROLE_ID } from '../../../packages/backend/src/modules/content/production/ask-support-candidate.js';
import {
  ASK_SUPPORT_CHECK_VERSION,
  ASK_SUPPORT_INSTRUCTIONS,
} from '../../../packages/backend/src/modules/content/production/ask-support.js';
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

  const replay = (overrides: { model?: string; candidate?: CandidateCheckerInstructions } = {}) =>
    makeAskSupportReplay({
      db: database.db,
      harness: worker.harness,
      withScope: withScope(),
      authority: { scopeId: 'scroll-supply', generation: 1 },
      model: overrides.model ?? 'MiniMax-M3.1-Flash',
      newRunKey: randomUUID,
      ...(overrides.candidate === undefined ? {} : { candidate: overrides.candidate }),
    });
  async function replayed(
    target: Parameters<ReturnType<typeof replay>>[0],
    overrides: { model?: string; candidate?: CandidateCheckerInstructions } = {},
  ) {
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
    // The checker now finds the sentence that starts "Because the beam turns" unsupported, and quotes words nobody wrote for
    // the one that starts "Today a small motor": code sets that one aside (D-265).
    support = (_check, call) => {
      const { sentences } = supportRequestOf(call);
      const flagged = sentences.find((sentence) => sentence.text.startsWith('Because the beam turns'));
      const quoted = sentences.find((sentence) => sentence.text.startsWith('Today a small motor'));
      const reply = supportReply(call, {
        unsupported:
          flagged === undefined ? {} : { [flagged.n]: { kind: 'contradicted', problem: 'A passage says otherwise.' } },
      });
      if (quoted === undefined || reply.kind !== 'success') return reply;
      const parsed = JSON.parse(reply.text) as { sentences: { n: number }[] };
      return answerWith({
        sentences: parsed.sentences.map((one) =>
          one.n === quoted.n ? { n: one.n, verdict: 'supported', quote: 'words that no passage ever contained' } : one,
        ),
      });
    };

    const { results, summary } = await replayed({ kind: 'assets', assetIds: [answer.assetId] });

    expect(summary).toEqual({ answers: 1, stopped: false });
    // The answer has 19 sentences: two requests, ten sentences and nine (D-267).
    expect(worker.supportCalls.length - callsBefore).toBe(2);
    const [only] = results;
    expect(only!.line).toMatchObject({
      assetId: answer.assetId,
      outcome: 'checked',
      unsupported: 2,
      batches: 2,
      requests: 2,
      // The per-sentence codes are counted on the line; the sentences they belong to are only in the file.
      codes: { quote_not_in_cited_passages: 1 },
    });
    expect(only!.line.runIds).toHaveLength(2);
    expect(only!.line.supported + only!.line.unsupported + only!.line.noClaim).toBe(only!.line.sentences);
    // What the operator sees on the line holds counts and codes: no sentence, no title and no question.
    const line = JSON.stringify(only!.line);
    expect(line).not.toContain('Because the beam turns');
    expect(line).not.toContain('How a lamp');
    expect(line).not.toContain('Today a small motor');
    // The file's detail has every sentence with the passages it cites and the checker's verdict, flagged one included.
    expect(only!.detail!.sentences).toHaveLength(only!.line.sentences);
    const flaggedSentences = only!.detail!.sentences.filter((sentence) => sentence.verdict === 'unsupported');
    expect(flaggedSentences).toHaveLength(2);
    expect(flaggedSentences[0]).toMatchObject({ kind: 'contradicted', problem: 'A passage says otherwise.' });
    expect(flaggedSentences[0]!.text.startsWith('Because the beam turns')).toBe(true);
    expect(flaggedSentences[0]!.code).toBeUndefined();
    expect(flaggedSentences[1]).toMatchObject({ kind: 'not_stated', code: 'quote_not_in_cited_passages' });
    expect(flaggedSentences[1]!.text.startsWith('Today a small motor')).toBe(true);
    expect(only!.detail!.sentences.find((sentence) => sentence.verdict === 'supported')?.quote).toBeTruthy();
    // The checker was never shown the question, because the check does not use it.
    expect(worker.supportCalls.at(-1)!.request.user).not.toContain('a CI question');
    // Nothing was published, stored or changed: the answer, its job and its Scroll are as they were.
    expect(await contentRows()).toEqual(before);
    // The replay's own runs, one for each batch, are in the ledger and closed.
    const ledgered = await database.db
      .selectFrom('reasoning.production_runs')
      .select(['state', 'closed_at'])
      .where('id', 'in', [...only!.line.runIds!])
      .execute();
    expect(ledgered).toHaveLength(2);
    for (const run of ledgered) {
      expect(run).toMatchObject({ state: 'completed' });
      expect(run.closed_at).not.toBeNull();
    }
    support = (_check, call) => supportReply(call);
  });

  it('counts the no_claim verdicts by the ground they passed on, so the replay shows how many pass on a label or a gap line (D-266)', async () => {
    const answer = await producedOrder('question');
    // The checker marks the three short headings and the limits line as stating no fact.
    support = (_check, call) => {
      const { sentences } = supportRequestOf(call);
      const noClaim = sentences
        .filter((one) =>
          ['The beam', 'The upkeep', 'Putting it together', 'This picture ignores'].some((start) =>
            one.text.startsWith(start),
          ),
        )
        .map((one) => one.n);
      return supportReply(call, { noClaim });
    };

    const { results } = await replayed({ kind: 'assets', assetIds: [answer.assetId] });
    support = (_check, call) => supportReply(call);

    const [only] = results;
    // Every no_claim verdict of the line is counted on exactly one of the four grounds, and no rule code was needed.
    const grounds = Object.entries(only!.line.codes);
    expect(grounds.map(([key]) => key).filter((key) => !key.startsWith('no_claim_'))).toEqual([]);
    expect(
      grounds.every(([key]) => ['label', 'gap', 'question', 'unshared'].includes(key.slice('no_claim_'.length))),
    ).toBe(true);
    expect(grounds.reduce((total, [, n]) => total + n, 0)).toBe(only!.line.noClaim);
    // The three short headings passed on their label ground (a callout's title, which the fixture also leaves unquoted, is a fourth).
    expect(only!.line.codes.no_claim_label).toBeGreaterThanOrEqual(3);
    // Counts only: no sentence is printed.
    expect(JSON.stringify(only!.line)).not.toContain('The upkeep');
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
    // The first batch is asked and repaired once; the second is never asked, because none of the answer is known.
    expect(results[0]!.line).toMatchObject({
      outcome: 'unchecked',
      code: 'invalid_output',
      batches: 2,
      requests: 2,
      codes: {},
    });
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

  /** A candidate file's text: labelled CI text that names the three verdicts, never product content. */
  const CANDIDATE_TEXT =
    'CI candidate instructions: judge each sentence by the passages it cites. Reply "supported", "unsupported" or "no_claim".';
  /** Candidate instructions as the operator command reads them from a file. */
  const candidateOf = (text: string): CandidateCheckerInstructions => {
    const reading = readCandidateInstructions(new TextEncoder().encode(text));
    if (reading.kind !== 'accepted') throw new Error(`CI: the candidate was refused: ${reading.code}`);
    return reading.candidate;
  };
  const roleIdsOf = async (runIds: readonly string[]) =>
    (
      await database.db
        .selectFrom('reasoning.production_runs')
        .select('role_id')
        .where('id', 'in', [...runIds])
        .execute()
    ).map((row) => row.role_id);
  const roleVersionsOf = async (runIds: readonly string[]) =>
    (
      await database.db
        .selectFrom('reasoning.production_runs')
        .select('role_version')
        .where('id', 'in', [...runIds])
        .execute()
    ).map((row) => row.role_version);

  it('without a candidate, asks the checker with the production instructions and version and labels nothing as a candidate (D-280)', async () => {
    const answer = await producedOrder('question');
    const { results } = await replayed({ kind: 'assets', assetIds: [answer.assetId] });
    const [only] = results;
    expect(worker.supportCalls.at(-1)!.request.system).toContain(ASK_SUPPORT_INSTRUCTIONS);
    expect(only!.line).not.toHaveProperty('candidate');
    expect(only!.line).not.toHaveProperty('candidateSha256');
    expect(only!.detail).not.toHaveProperty('candidate');
    expect(new Set(await roleVersionsOf(only!.line.runIds!))).toEqual(new Set([ASK_SUPPORT_CHECK_VERSION]));
  });

  it('with a candidate, sends its instructions in place of the production ones, labels every line and detail with its hash, and stores nothing (D-280)', async () => {
    const answer = await producedOrder('question');
    const candidate = candidateOf(CANDIDATE_TEXT);
    const before = await contentRows();
    const callsBefore = worker.supportCalls.length;
    // A candidate reply goes through the production rules like any other: this one quotes words no passage holds.
    support = (_check, call) => {
      const { sentences } = supportRequestOf(call);
      const first = sentences[0]!;
      const reply = supportReply(call);
      if (reply.kind !== 'success') return reply;
      const parsed = JSON.parse(reply.text) as { sentences: { n: number }[] };
      return answerWith({
        sentences: parsed.sentences.map((one) =>
          one.n === first.n ? { n: one.n, verdict: 'supported', quote: 'words that no passage ever contained' } : one,
        ),
      });
    };

    const { results, summary } = await replayed({ kind: 'assets', assetIds: [answer.assetId] }, { candidate });
    support = (_check, call) => supportReply(call);

    expect(summary).toEqual({ answers: 1, stopped: false });
    const requests = worker.supportCalls.slice(callsBefore);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.request.system).toContain(candidate.text);
      expect(request.request.system).not.toContain(ASK_SUPPORT_INSTRUCTIONS);
    }
    const [only] = results;
    const label = { candidate: true, candidateSha256: candidate.sha256 };
    expect(only!.line).toMatchObject({ outcome: 'checked', ...label });
    expect(only!.detail).toMatchObject(label);
    // One in each of the two batches: the production rules read a candidate's reply too.
    expect(only!.line.codes).toMatchObject({ quote_not_in_cited_passages: 2 });
    // The ledger names the candidate, never the production version or role, so nothing it spent reads as the production checker's.
    expect(new Set(await roleVersionsOf(only!.line.runIds!))).toEqual(new Set([candidate.version]));
    expect(new Set(await roleIdsOf(only!.line.runIds!))).toEqual(new Set([CANDIDATE_ROLE_ID]));
    expect(candidate.version).not.toBe(ASK_SUPPORT_CHECK_VERSION);
    // Nothing was published, stored or changed.
    expect(await contentRows()).toEqual(before);
  });

  it('gives a candidate its own failure brake: a candidate that fails every time stops candidates for the day, not the production checker (D-280)', async () => {
    const answer = await producedOrder('question');
    const candidate = candidateOf(`${CANDIDATE_TEXT} This one fails.`);
    support = () => ({ kind: 'rate_limited' });
    const codes: (string | undefined)[] = [];
    try {
      // Five failed runs a day is the brake; each replay of one answer is one failed run (the provider refuses the first batch).
      for (let replays = 0; replays < 8; replays += 1) {
        const { results } = await replayed({ kind: 'assets', assetIds: [answer.assetId] }, { candidate });
        codes.push(results[0]!.line.code);
      }
    } finally {
      support = (_check, call) => supportReply(call);
    }
    expect(codes.at(-1)).toBe('refused_failure_brake');
    // The same answer, checked by the production checker, still goes through.
    const plain = await replayed({ kind: 'assets', assetIds: [answer.assetId] });
    expect(plain.results[0]!.line).toMatchObject({ outcome: 'checked' });
  });

  it('labels the lines that name no answer too, and still refuses another model before asking anything (D-280)', async () => {
    const whatIf = await producedOrder('what_if');
    const question = await producedOrder('question');
    const candidate = candidateOf(`${CANDIDATE_TEXT}Lines that carry no verdict are labelled too.`);
    const callsBefore = worker.supportCalls.length;

    const notReplayable = await replayed({ kind: 'assets', assetIds: [whatIf.assetId] }, { candidate });
    expect(notReplayable.results[0]!.line).toMatchObject({
      outcome: 'not_replayable',
      code: 'not_an_ask_answer',
      candidate: true,
      candidateSha256: candidate.sha256,
    });

    const wrongModel = await replayed(
      { kind: 'assets', assetIds: [question.assetId] },
      { candidate, model: 'some-other-model' },
    );
    expect(wrongModel.summary).toEqual({ answers: 0, stopped: true });
    expect(wrongModel.results[0]!.line).toMatchObject({
      outcome: 'model_mismatch',
      candidate: true,
      candidateSha256: candidate.sha256,
    });
    expect(worker.supportCalls.length).toBe(callsBefore);
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
