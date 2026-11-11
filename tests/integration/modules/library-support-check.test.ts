import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { makeReviewGate } from '@knowscroll/backend/modules/content/nest-providers';
import { parseDocumentV2 } from '@knowscroll/scroll-model';
import { ScrollProvenanceV2 } from '@knowscroll/scroll-model/internal';
import { extractResearch } from '../../../packages/backend/src/infrastructure/research/public-pages.js';
import { LIBRARY_CHECK_RULES } from '../../../packages/backend/src/modules/content/domain/library-support.js';
import { makeCheckLibrarySupport } from '../../../packages/backend/src/modules/content/production/library-support-check.js';
import { checkLibrarySupportJob } from '../../../packages/backend/src/modules/content/production/library-support-events.js';
import {
  makeRunLibrarySupportCheck,
  makeSweepLibrarySupport,
} from '../../../packages/backend/src/modules/content/production/library-support-job.js';
import {
  makeLibrarySupportReplay,
  type ReplayLine,
} from '../../../packages/backend/src/modules/content/production/library-support-replay.js';
import { makeLibrarySupportStep } from '../../../packages/backend/src/modules/content/production/library-support-step.js';
import { libraryCheckStore } from '../../../packages/backend/src/modules/content/production/library-support-store.js';
import {
  LIBRARY_SUPPORT_CHECK_VERSION,
  libraryEvidenceOf,
  sentencesOfScroll,
} from '../../../packages/backend/src/modules/content/production/library-support.js';
import {
  FIXTURE_SOURCE_V2,
  fixtureAuthoredV2,
  fixtureResearchPageV2,
} from '../../../packages/backend/src/modules/content/production/spike-v2/writer-v2.fixture.js';
import { TOPICS, type ScrollTopic } from '../../../packages/backend/src/modules/content/production/topics.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { signal } from '../support/fixture-model.js';
import type { FixtureCall, FixtureScenario } from '../support/fixture-model-port.js';
import {
  answerWith,
  enableProductionScope,
  librarySupportTarget,
  supportReply,
  supportRequestOf,
} from '../support/generated-scroll.js';
import { fixtureProductionWorker } from '../support/production-worker.js';

/**
 * The writer's recorded answer: the labelled Orrin fixture (an invented planet) with one twist reworded. Under the library's rules, the
 * fixture's own twist, "Many people expect a slanted beam to be a squeezed one, and the picture is easy to get backwards", is a sentence
 * of nine key words that shares one with its passages and states no fact a code rule could see, so a checker could neither quote a passage
 * for it nor mark it as stating no fact: the Scroll would always carry one `unclear` sentence. The reworded twist shares what it needs.
 */
function orrinAnswer() {
  const authored = fixtureAuthoredV2();
  return {
    ...authored,
    items: authored.items.map((item) =>
      item.type === 'call_it' && item.twist.startsWith('Many people expect a slanted beam')
        ? {
            ...item,
            twist: item.twist.replace(
              'Many people expect a slanted beam to be a squeezed one, and the picture is easy to get backwards.',
              'Many people expect a slanted beam to be a squeezed one, yet a beam that strikes low spreads across a wider patch.',
            ),
          }
        : item,
    ),
  };
}

/** The page the fixture serves for a recipe URL: the Orrin page. Only recipes with one page are used here. */
const orrinPageFor = (url: string) =>
  url === fixtureResearchPageV2.url
    ? fixtureResearchPageV2
    : extractResearch(
        `<html><title>CI fixture</title><main>${[...FIXTURE_SOURCE_V2, `This invented fixture page for ${url} adds nothing further about Orrin.`].map((text) => `<p>${text}</p>`).join('')}</main></html>`,
        url,
        '2026-10-20T00:00:00.000Z',
      );

const authority = { scopeId: 'scroll-supply', generation: 1 } as const;
const operator = 'cli:ci-reviewer';
const checkerReply = (call: FixtureCall) => supportReply(call, {}, LIBRARY_CHECK_RULES);

/**
 * The support check of library Scrolls (D-415) against a real PostgreSQL 16 database. The Scrolls are produced held by the real
 * production job, with the labelled Orrin fixture in place of the writer, and the checker is a labelled CI fixture: this proves what the
 * check reads, asks, stores, closes and leaves alone, never what a model says about a Scroll.
 */
describe('the support check of a library Scroll (labelled CI fixtures, real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let worker: ReturnType<typeof fixtureProductionWorker>;
  /** The library checker's replies; by default every sentence is supported or states no fact. */
  let librarySupport: (check: number, call: FixtureCall) => FixtureScenario | Promise<FixtureScenario> = (
    _check,
    call,
  ) => checkerReply(call);
  let quotaSpent = false;
  const takes = new Map<ScrollTopic, number>();
  const withScope = () => makeWithProductionScope(database.db, { enabled: true, lockTimeoutMs: 5000 });
  const gate = () => makeReviewGate(database.db);
  const check = () =>
    makeCheckLibrarySupport({ db: database.db, authority, withScope: withScope(), harness: worker.harness });

  beforeAll(async () => {
    database = await createTestDatabase<Database>('library_support');
    await enableProductionScope(database.db);
    worker = fixtureProductionWorker(database, () => answerWith(orrinAnswer()), {
      research: (url) => Promise.resolve(orrinPageFor(url)),
      librarySupport: (n, call) => librarySupport(n, call),
      quota: () => ({
        verdict: quotaSpent ? 'unavailable' : 'not_applicable',
        intervalRemainingPercent: null,
        weeklyRemainingPercent: null,
      }),
    });
  });
  afterAll(async () => {
    await database.drop();
  });

  /**
   * A library recipe's next take produced by the real job and held for review. The take before it, if still held, is rejected first, so the
   * recipe may write another.
   */
  async function hold(key: ScrollTopic) {
    const take = (takes.get(key) ?? 0) + 1;
    if (take > 1) {
      const earlier = await sql<{
        revision: number;
      }>`select revision from content.revision_reviews where asset_id = ${TOPICS[key].assetId}::uuid and state = 'held'`.execute(
        database.db,
      );
      for (const row of earlier.rows)
        expect(
          await gate().reject({
            assetId: TOPICS[key].assetId,
            revision: row.revision,
            reason: 'CI fixture',
            decidedBy: operator,
          }),
        ).toMatchObject({ kind: 'rejected' });
    }
    const result = await worker.producer()(key, false, signal(), false, take);
    expect(result).toMatchObject({ outcome: 'published', held: true });
    takes.set(key, take);
    return { key, assetId: TOPICS[key].assetId, revision: result.revision! };
  }

  const reviewOf = (assetId: string, revision: number) =>
    database.db
      .selectFrom('content.revision_reviews')
      .selectAll()
      .where('asset_id', '=', assetId)
      .where('revision', '=', revision)
      .executeTakeFirstOrThrow();
  const rowOf = (assetId: string, revision: number) =>
    database.db
      .selectFrom('content.library_support_checks')
      .selectAll()
      .where('asset_id', '=', assetId)
      .where('revision', '=', revision)
      .where('checker_version', '=', LIBRARY_SUPPORT_CHECK_VERSION)
      .executeTakeFirst();
  const checkRuns = () =>
    sql<{
      id: string;
      state: string;
      closed_at: Date | null;
    }>`select id, state, closed_at from reasoning.production_runs where purpose = 'library-support-check' order by created_at, id`
      .execute(database.db)
      .then((result) => result.rows);
  const supportCalls = () => worker.librarySupportCalls.length;
  const run = (held: { assetId: string; revision: number }) =>
    check()({ assetId: held.assetId, revision: held.revision, signal: signal() });

  describe('a held revision', () => {
    let held: { assetId: string; revision: number };

    it('gets a check row: a verdict for every sentence the reader sees, the revision’s verdict decided by code, and nothing released', async () => {
      held = await hold('seasons-hemispheres');
      const before = supportCalls();
      const result = await run(held);

      expect(result.kind).toBe('stored');
      if (result.kind !== 'stored') throw new Error('CI expected a stored check');
      expect(result.check).toMatchObject({
        assetId: held.assetId,
        revision: held.revision,
        checkerVersion: 'library-support-check.v1',
        state: 'checked',
        code: null,
        verdict: 'passed',
        policyVersion: 'library-support-policy.v1',
        round: 1,
      });
      // The Orrin Scroll has 57 sentences a reader sees: six requests of at most ten.
      expect(result.check.sentenceCount).toBe(57);
      expect(result.check.sentences).toHaveLength(57);
      expect(result.check.batches).toBe(6);
      expect(supportCalls() - before).toBe(6);
      expect(result.requests).toBe(6);
      expect(result.check.sentences.every((sentence) => ['supported', 'no_claim'].includes(sentence.outcome))).toBe(
        true,
      );
      expect(result.check.sentences.find((sentence) => sentence.field === 'title')).toMatchObject({
        n: 1,
        label: true,
      });

      // One row, keyed by the revision and the checker's version.
      expect(await rowOf(held.assetId, held.revision)).toMatchObject({
        state: 'checked',
        verdict: 'passed',
        sentence_count: 57,
        batches: 6,
        requests: 6,
        check_round: 1,
      });
      // Every request was an attempt of the library checker in the ledger, in the background class; the writer's were not.
      const attempts = await sql<{
        role_id: string;
        role_version: string;
        background: boolean;
      }>`select attempt.role_id, attempt.role_version, receipt.background
        from reasoning.production_attempts attempt join reasoning.usage_receipts receipt on receipt.attempt_id = attempt.id
        join reasoning.production_runs run on run.id = attempt.run_id where run.purpose = 'library-support-check'`.execute(
        database.db,
      );
      expect(attempts.rows).toHaveLength(6);
      for (const attempt of attempts.rows)
        expect(attempt).toEqual({
          role_id: 'content.library-support-check',
          role_version: 'library-support-check.v1',
          background: true,
        });
      const writer = await sql<{
        background: boolean;
      }>`select receipt.background from reasoning.production_attempts attempt
        join reasoning.usage_receipts receipt on receipt.attempt_id = attempt.id where attempt.role_id = 'content.scroll-writer'`.execute(
        database.db,
      );
      expect(writer.rows.length).toBeGreaterThan(0);
      expect(writer.rows.every((row) => !row.background)).toBe(true);
      // Each batch's run is finished with the result.
      const runs = await checkRuns();
      expect(runs).toHaveLength(6);
      for (const finished of runs) expect(finished).toMatchObject({ state: 'completed' });
      expect(runs.every((finished) => finished.closed_at !== null)).toBe(true);

      // Nothing was released, rejected or served: the revision is held and the asset is not admitted.
      expect(await reviewOf(held.assetId, held.revision)).toMatchObject({
        state: 'held',
        decided_at: null,
        decided_by: null,
      });
      expect(
        await database.db
          .selectFrom('content.assets')
          .select('status')
          .where('id', '=', held.assetId)
          .executeTakeFirst(),
      ).toEqual({ status: 'held' });
    });

    it('shows the checker only what the reader reads: no question, option, misconception or suggestion, and the passages the Scroll cites', async () => {
      const stored = await database.db
        .selectFrom('content.asset_revisions')
        .select('document')
        .where('asset_id', '=', held.assetId)
        .executeTakeFirstOrThrow();
      const parsed = parseDocumentV2(stored.document);
      if (parsed.kind !== 'valid') throw new Error('CI expected a valid document');
      const mine = worker.librarySupportCalls.filter((call) => librarySupportTarget(call).assetId === held.assetId);
      const sent = mine.map((call) => call.request.user).join('\n');
      for (const stop of parsed.document.stops)
        if (stop.kind !== 'read') for (const option of stop.options) expect(sent).not.toContain(option);
      if (parsed.document.misconception.kind === 'myth')
        expect(sent).not.toContain(parsed.document.misconception.claim);
      for (const suggestion of parsed.document.askSuggestions) expect(sent).not.toContain(suggestion);
      // The first request carries the Scroll's own first sentences and the passages it cites.
      const [first] = mine;
      expect(supportRequestOf(first!).sentences[0]).toMatchObject({ n: 1, text: parsed.document.title, label: true });
      expect(supportRequestOf(first!).passages.size).toBeGreaterThan(3);
      expect(first!.request.system).toContain('content.library-support-check');
    });

    it('is listed for the operator with the check’s verdict and counts and no sentence, and shown with the verdict first', async () => {
      const entry = (await gate().list({ all: false })).find((listing) => listing.assetId === held.assetId)!;
      expect(entry.supportCheck).toEqual({
        checkerVersion: 'library-support-check.v1',
        policy: 'library-support-policy.v1',
        state: 'checked',
        verdict: 'passed',
        counts: {
          sentences: 57,
          supported: expect.any(Number) as number,
          unsupported: 0,
          unclear: 0,
          noClaim: expect.any(Number) as number,
        },
      });
      // The list holds the title it always did and counts; no sentence of the body.
      expect(JSON.stringify(entry)).not.toContain('Keep your eye on the picture');
      const shown = await gate().show({ assetId: held.assetId, withSources: false });
      if (shown.kind !== 'shown') throw new Error('CI expected the text');
      expect(shown.text).toContain(
        'Support check: PASSED (library-support-check.v1, library-support-policy.v1). 57 sentences',
      );
      expect(shown.text).not.toContain('Read these first:');
    });

    it('is not asked twice: a repeat and a redelivered job send nothing and change nothing, and a job for another checker version is dropped', async () => {
      const before = supportCalls();
      const stored = await rowOf(held.assetId, held.revision);
      expect(await run(held)).toMatchObject({ kind: 'reused', check: { verdict: 'passed', round: 1 } });
      const job = makeRunLibrarySupportCheck(check());
      expect(await job(checkLibrarySupportJob(held.assetId, held.revision), { signal: signal() })).toMatchObject({
        kind: 'finished',
        result: { kind: 'reused' },
      });
      expect(
        await job(
          { ...checkLibrarySupportJob(held.assetId, held.revision), checkerVersion: 'library-support-check.v0' },
          { signal: signal() },
        ),
      ).toEqual({ kind: 'skipped', reason: 'checker_version' });
      expect(supportCalls()).toBe(before);
      expect(await rowOf(held.assetId, held.revision)).toEqual(stored);
    });

    it('answers not_found for a revision that is not stored, and asks nothing', async () => {
      const before = supportCalls();
      expect(await run({ assetId: held.assetId, revision: 99 })).toEqual({
        kind: 'not_found',
        reason: 'revision_missing',
      });
      expect(supportCalls()).toBe(before);
    });
  });

  describe('a check that stops half way', () => {
    it('does not pay twice when a delivery dies after the answers and before the result: the next one reads the ledger', async () => {
      const held = await hold('seasons-limits');
      const subject = await libraryCheckStore.readSubject(database.db, held.assetId, held.revision);
      const parsed = parseDocumentV2(subject!.document);
      if (parsed.kind !== 'valid') throw new Error('CI expected a valid document');
      const evidence = libraryEvidenceOf(ScrollProvenanceV2.parse(subject!.provenance));
      const listed = sentencesOfScroll(parsed.document, evidence);
      if (listed.kind !== 'sentences') throw new Error('CI expected sentences');

      // The crashed delivery: every batch was answered and paid for, then the process died before the result was stored.
      const before = supportCalls();
      const outcome = await makeLibrarySupportStep({
        authority,
        withScope: withScope(),
        harness: worker.harness,
      }).check({
        assetId: held.assetId,
        revision: held.revision,
        round: 1,
        sentences: listed.sentences,
        passages: evidence.passages,
        signal: signal(),
      });
      expect(outcome.kind).toBe('checked');
      expect(supportCalls() - before).toBe(6);
      expect(await rowOf(held.assetId, held.revision)).toBeUndefined();
      expect((await checkRuns()).filter((entry) => entry.closed_at === null)).toHaveLength(6);

      // The redelivery asks the ledger for the answers it holds and pays for nothing.
      expect(await run(held)).toMatchObject({ kind: 'stored', check: { state: 'checked', verdict: 'passed' } });
      expect(supportCalls() - before).toBe(6);
      expect(await rowOf(held.assetId, held.revision)).toMatchObject({ state: 'checked' });
      expect((await checkRuns()).filter((entry) => entry.closed_at === null)).toEqual([]);
    });

    it('holds on an attempt of unknown outcome, stores why, leaves its run open and never resends it', async () => {
      const held = await hold('seasons');
      librarySupport = () => ({ kind: 'timeout_after_dispatch' });
      const before = supportCalls();
      try {
        expect(await run(held)).toMatchObject({
          kind: 'stored',
          check: {
            state: 'unchecked',
            code: 'outcome_unknown',
            verdict: 'unchecked',
            sentenceCount: 57,
            sentences: [],
          },
        });
        // The first batch's attempt may have reached the provider: nothing after it was sent.
        expect(supportCalls() - before).toBe(1);
        expect(await rowOf(held.assetId, held.revision)).toMatchObject({
          state: 'unchecked',
          code: 'outcome_unknown',
          verdict: 'unchecked',
        });
        const open = (await checkRuns()).filter((entry) => entry.closed_at === null);
        expect(open).toHaveLength(1);
        const attempts = await sql<{
          state: string;
        }>`select state from reasoning.production_attempts where run_id = ${open[0]!.id}::uuid`.execute(database.db);
        expect(attempts.rows).toEqual([{ state: 'unknown' }]);
        expect(await reviewOf(held.assetId, held.revision)).toMatchObject({ state: 'held' });

        // Not even when the row is lost: the ledger holds the unknown attempt, so the same run is not sent again.
        await sql`delete from content.library_support_checks where asset_id = ${held.assetId}::uuid`.execute(
          database.db,
        );
        librarySupport = (_n, call) => checkerReply(call);
        expect(await run(held)).toMatchObject({
          kind: 'stored',
          check: { state: 'unchecked', code: 'outcome_unknown' },
        });
        expect(supportCalls() - before).toBe(1);
        // And a stored check of unknown outcome is final: a repeat sends nothing either.
        expect(await run(held)).toMatchObject({ kind: 'reused' });
        expect(supportCalls() - before).toBe(1);
      } finally {
        librarySupport = (_n, call) => checkerReply(call);
      }
    });

    it('pauses on a spent quota with nothing stored and sent, and a later run resumes the same check', async () => {
      const held = await hold('seasons-hemispheres');
      quotaSpent = true;
      const before = supportCalls();
      try {
        expect(await run(held)).toEqual({ kind: 'paused', code: 'quota_unavailable' });
        expect(supportCalls()).toBe(before);
        expect(await rowOf(held.assetId, held.revision)).toBeUndefined();
      } finally {
        quotaSpent = false;
      }
      expect(await run(held)).toMatchObject({ kind: 'stored', check: { state: 'checked', round: 1 } });
      expect(supportCalls() - before).toBe(6);
    });

    it('tries a provider failure again in a new round, and a later round that succeeds replaces the failed result', async () => {
      const recovering = await hold('seasons-limits');
      let failures = 1;
      librarySupport = (_n, call) => (failures-- > 0 ? { kind: 'rate_limited' } : checkerReply(call));
      const before = supportCalls();
      try {
        expect(await run(recovering)).toMatchObject({
          kind: 'stored',
          check: { state: 'unchecked', code: 'provider_failed', verdict: 'unchecked', round: 1 },
        });
        expect(supportCalls() - before).toBe(1);
        // The failed run is finished for good; the next round is a run of its own, so the provider is asked again.
        expect(await run(recovering)).toMatchObject({
          kind: 'stored',
          check: { state: 'checked', verdict: 'passed', round: 2 },
        });
        expect(await rowOf(recovering.assetId, recovering.revision)).toMatchObject({
          state: 'checked',
          check_round: 2,
          code: null,
          sentence_count: 57,
        });
        expect(await run(recovering)).toMatchObject({ kind: 'reused', check: { state: 'checked', round: 2 } });
      } finally {
        librarySupport = (_n, call) => checkerReply(call);
      }
    });

    it('tries a provider failure at most three times, then the failure is final and a repeat sends nothing', async () => {
      const failing = await hold('seasons-hemispheres');
      librarySupport = () => ({ kind: 'server_error', status: 503 });
      const before = supportCalls();
      try {
        expect(await run(failing)).toMatchObject({ kind: 'stored', check: { code: 'provider_failed', round: 1 } });
        expect(await run(failing)).toMatchObject({ kind: 'stored', check: { code: 'provider_failed', round: 2 } });
        expect(await run(failing)).toMatchObject({ kind: 'stored', check: { code: 'provider_failed', round: 3 } });
        expect(supportCalls() - before).toBe(3);
        expect(await rowOf(failing.assetId, failing.revision)).toMatchObject({ state: 'unchecked', check_round: 3 });
        expect(await run(failing)).toMatchObject({ kind: 'reused', check: { code: 'provider_failed', round: 3 } });
        expect(supportCalls() - before).toBe(3);
      } finally {
        librarySupport = (_n, call) => checkerReply(call);
      }
    });

    it('pauses when the role’s failure brake for the day is full, storing nothing and sending nothing, because that says nothing about the revision', async () => {
      // One unknown attempt and four conclusive failures have used this role's five slots for the day (role-failure-brake.v1).
      const held = await hold('seasons');
      const before = supportCalls();
      expect(await run(held)).toEqual({ kind: 'paused', code: 'failure_brake' });
      expect(supportCalls()).toBe(before);
      expect(await rowOf(held.assetId, held.revision)).toBeUndefined();
    });
  });

  describe('the sweep', () => {
    it('hands over the held revisions that have no result, and those whose last try failed on the provider long enough ago with rounds left, and nothing else', async () => {
      const heldNow = await sql<{
        asset_id: string;
        revision: number;
      }>`select asset_id, revision from content.revision_reviews where state = 'held' order by held_at, asset_id`.execute(
        database.db,
      );
      expect(heldNow.rows.length).toBeGreaterThanOrEqual(3);
      const sent: string[] = [];
      const sweep = makeSweepLibrarySupport({
        db: database.db,
        enqueue: (job) => {
          sent.push(`${job.assetId}:${String(job.revision)}`);
          return Promise.resolve('queued');
        },
      });
      // The held revision the failure brake paused has no result, so it is due; every other held revision has a final result (checked, or
      // unchecked on an unknown attempt or a third provider failure), and the decided ones are not held.
      const target = heldNow.rows.find((row) => row.asset_id === TOPICS.seasons.assetId)!;
      const key = `${target.asset_id}:${String(target.revision)}`;
      const where = sql`asset_id = ${target.asset_id}::uuid and revision = ${target.revision}::integer`;
      expect(await sweep()).toEqual({ due: 1, queued: 1 });
      expect(sent).toEqual([key]);

      // A provider failure is due again only after an hour and while rounds are left.
      await sql`insert into content.library_support_checks (asset_id, revision, checker_version, state, code, verdict, policy_version, check_round, sentence_count, batches, requests, sentences)
        values (${target.asset_id}::uuid, ${target.revision}::integer, ${LIBRARY_SUPPORT_CHECK_VERSION}, 'unchecked', 'provider_failed', 'unchecked', 'library-support-policy.v1', 1, 57, 6, 1, '[]'::jsonb)`.execute(
        database.db,
      );
      expect(await sweep()).toEqual({ due: 0, queued: 0 });
      await sql`update content.library_support_checks set checked_at = now() - interval '2 hours' where ${where}`.execute(
        database.db,
      );
      expect(await sweep()).toEqual({ due: 1, queued: 1 });
      expect(sent).toEqual([key, key]);
      await sql`update content.library_support_checks set check_round = 3 where ${where}`.execute(database.db);
      expect(await sweep()).toEqual({ due: 0, queued: 0 });
      // An attempt of unknown outcome is never due again.
      await sql`update content.library_support_checks set check_round = 1, code = 'outcome_unknown' where ${where}`.execute(
        database.db,
      );
      expect(await sweep()).toEqual({ due: 0, queued: 0 });
    });
  });
});

describe('measuring the check against the operator’s own decisions (labelled CI fixtures, real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let worker: ReturnType<typeof fixtureProductionWorker>;
  /** The revisions (`asset:revision`) of which the fixture checker flags a sentence. */
  const flagged = new Set<string>();
  let quotaSpent = false;
  const takes = new Map<ScrollTopic, number>();
  const withScope = () => makeWithProductionScope(database.db, { enabled: true, lockTimeoutMs: 5000 });
  const gate = () => makeReviewGate(database.db);

  beforeAll(async () => {
    database = await createTestDatabase<Database>('library_support_replay');
    await enableProductionScope(database.db);
    worker = fixtureProductionWorker(database, () => answerWith(orrinAnswer()), {
      research: (url) => Promise.resolve(orrinPageFor(url)),
      librarySupport: (_n, call) => {
        const { assetId, revision } = librarySupportTarget(call);
        const sentence = flagged.has(`${assetId}:${String(revision)}`)
          ? supportRequestOf(call).sentences.find((entry) => entry.text.startsWith('Keep your eye on the picture'))
          : undefined;
        return supportReply(
          call,
          sentence === undefined
            ? {}
            : { unsupported: { [sentence.n]: { kind: 'goes_beyond', problem: 'A passage says something narrower.' } } },
          LIBRARY_CHECK_RULES,
        );
      },
      quota: () => ({
        verdict: quotaSpent ? 'unavailable' : 'not_applicable',
        intervalRemainingPercent: null,
        weeklyRemainingPercent: null,
      }),
    });
  });
  afterAll(async () => {
    await database.drop();
  });

  /** A recipe's next take, held, then decided by the operator; `flag` makes the fixture checker flag a sentence of it. */
  async function decided(key: ScrollTopic, decision: 'released' | 'rejected', flag: boolean) {
    const take = (takes.get(key) ?? 0) + 1;
    const result = await worker.producer()(key, false, signal(), false, take);
    expect(result).toMatchObject({ outcome: 'published', held: true });
    takes.set(key, take);
    const assetId = TOPICS[key].assetId;
    if (flag) flagged.add(`${assetId}:${String(result.revision)}`);
    const done =
      decision === 'released'
        ? await gate().release({ assetId, revision: result.revision!, decidedBy: operator })
        : await gate().reject({ assetId, revision: result.revision!, reason: 'CI fixture', decidedBy: operator });
    expect(done).toMatchObject({ kind: decision });
    return { assetId, revision: result.revision! };
  }

  const replay = (model = 'MiniMax-M3.1-Flash') =>
    makeLibrarySupportReplay({
      db: database.db,
      check: makeCheckLibrarySupport({ db: database.db, authority, withScope: withScope(), harness: worker.harness }),
      model,
    });
  const lines = async (target: Parameters<ReturnType<typeof replay>>[0], model?: string) => {
    const emitted: ReplayLine[] = [];
    const summary = await replay(model)(target, signal(), (line) => void emitted.push(line));
    return { emitted, summary };
  };
  const ledgerRows = () =>
    sql`select asset_id, revision, state, decided_by from content.revision_reviews order by asset_id, revision`
      .execute(database.db)
      .then((result) => JSON.stringify(result.rows));
  const assetRows = () =>
    sql`select id, status, revision from content.assets order by id`
      .execute(database.db)
      .then((result) => JSON.stringify(result.rows));
  const storedRows = () =>
    sql<{ n: string }>`select count(*) as n from content.library_support_checks`
      .execute(database.db)
      .then((result) => Number(result.rows[0]!.n));

  // Four planted decisions over the same Orrin Scroll, two recipes with two takes each. The fixture checker flags a sentence of the second
  // and third, so the check passes the first and fourth and flags the second and third: it agrees with the operator on the first and third,
  // flags a released revision (the second) and passes a rejected one (the fourth, the dangerous number).
  let first: { assetId: string; revision: number };
  beforeAll(async () => {
    first = await decided('seasons-hemispheres', 'released', false);
    await decided('seasons-limits', 'released', true);
    await decided('seasons-hemispheres', 'rejected', true);
    await decided('seasons-limits', 'rejected', false);
  });

  it('reports a correct confusion matrix for planted released and rejected revisions, with the dangerous number and the family, and counts only', async () => {
    const decisionsBefore = await ledgerRows();
    const assetsBefore = await assetRows();
    const callsBefore = worker.librarySupportCalls.length;

    const { emitted, summary } = await lines({ since: undefined, limit: 50, maxRequests: 100 });

    // Four revisions, six requests each.
    expect(summary).toMatchObject({
      checkerVersion: 'library-support-check.v1',
      revisions: 4,
      requestsSent: 24,
      maxRequests: 100,
      stopped: null,
    });
    expect(worker.librarySupportCalls.length - callsBefore).toBe(24);
    expect(emitted).toHaveLength(4);
    for (const line of emitted)
      expect(line).toMatchObject({ outcome: 'checked', family: 'earth', sentences: 57, batches: 6, requests: 6 });
    const verdicts = emitted.map((line) => `${line.decision}:${line.verdict}`).sort();
    expect(verdicts).toEqual(['rejected:flagged', 'rejected:passed', 'released:flagged', 'released:passed']);
    for (const line of emitted.filter((entry) => entry.verdict === 'flagged'))
      expect(line).toMatchObject({ unsupported: 1, unclear: 0, kinds: { goes_beyond: 1 } });
    for (const line of emitted.filter((entry) => entry.verdict === 'passed'))
      expect(line).toMatchObject({ unsupported: 0, unclear: 0, kinds: {}, codes: {} });
    expect(emitted.find((line) => line.assetId === first.assetId && line.revision === first.revision)).toMatchObject({
      decision: 'released',
      verdict: 'passed',
      recipe: 'seasons-hemispheres',
    });

    expect(summary.agreement).toMatchObject({
      policy: 'library-support-policy.v1',
      decided: 4,
      checked: 4,
      releasedPassed: 1,
      releasedFlagged: 1,
      rejectedPassed: 1,
      rejectedFlagged: 1,
      rejectedCaught: 0.5,
      releasedPassedShare: 0.5,
      agreement: 0.5,
      notChecked: { total: 0, byCode: {} },
    });
    expect(summary.agreement.byFamily).toEqual({
      earth: { releasedPassed: 1, releasedFlagged: 1, rejectedPassed: 1, rejectedFlagged: 1, checked: 4 },
    });
    // Looser limits read the same stored results: one unsupported sentence allowed passes both flagged revisions.
    expect(
      summary.agreement.choices.find((choice) => choice.maxUnsupported === 1 && choice.maxUnclear === 0),
    ).toMatchObject({
      releasedPassed: 2,
      releasedFlagged: 0,
      rejectedPassed: 2,
      rejectedFlagged: 0,
    });

    // Counts and codes only: no sentence, title or reason on any line.
    expect(JSON.stringify({ emitted, summary })).not.toMatch(/Orrin|CI fixture|Keep your eye/u);

    // The replay decided nothing: the operator's decisions and the assets are exactly as they were.
    expect(await ledgerRows()).toBe(decisionsBefore);
    expect(await assetRows()).toBe(assetsBefore);
  });

  it('is idempotent: running it again sends nothing and reports the same agreement, one row for each revision and checker version', async () => {
    const callsBefore = worker.librarySupportCalls.length;
    const again = await lines({ since: undefined, limit: 50, maxRequests: 100 });
    expect(worker.librarySupportCalls.length).toBe(callsBefore);
    expect(again.summary).toMatchObject({ requestsSent: 0, stopped: null });
    for (const line of again.emitted) expect(line).toMatchObject({ outcome: 'reused', requests: 0 });
    expect(again.summary.agreement).toMatchObject({
      releasedPassed: 1,
      releasedFlagged: 1,
      rejectedPassed: 1,
      rejectedFlagged: 1,
    });
    expect(await storedRows()).toBe(4);
  });

  it('reads what is stored and sends nothing with --max-requests 0, and applies since and limit to the decisions', async () => {
    const callsBefore = worker.librarySupportCalls.length;
    const none = await lines({ since: undefined, limit: 50, maxRequests: 0 });
    expect(worker.librarySupportCalls.length).toBe(callsBefore);
    expect(none.summary.agreement.checked).toBe(4);
    const newest = await lines({ since: undefined, limit: 1, maxRequests: 0 });
    expect(newest.summary.revisions).toBe(1);
    expect(newest.emitted).toHaveLength(1);
    const future = await lines({ since: new Date(Date.now() + 86_400_000), limit: 50, maxRequests: 0 });
    expect(future.summary).toMatchObject({ revisions: 0, stopped: null });
    expect(future.summary.agreement).toMatchObject({ decided: 0, checked: 0, agreement: null });
  });

  it('is bounded by --max-requests: a revision whose check might pass the cap is not started, and what it did send stays within it', async () => {
    // Two new decided revisions, the newest two, with no result yet.
    await decided('seasons-hemispheres', 'rejected', false);
    await decided('seasons-limits', 'rejected', true);
    const callsBefore = worker.librarySupportCalls.length;
    // A check needs six requests and may need a seventh for the harness's repair: seven is enough for one revision and not for two.
    const { emitted, summary } = await lines({ since: undefined, limit: 2, maxRequests: 7 });
    expect(worker.librarySupportCalls.length - callsBefore).toBe(6);
    expect(summary).toMatchObject({ requestsSent: 6, maxRequests: 7, stopped: null, revisions: 2 });
    expect(emitted.filter((line) => line.outcome === 'checked')).toHaveLength(1);
    expect(emitted.filter((line) => line.outcome === 'over_cap')).toMatchObject([
      { code: 'over_request_cap', verdict: null, requests: 0 },
    ]);
    expect(summary.agreement).toMatchObject({
      decided: 2,
      checked: 1,
      notChecked: { total: 1, byCode: { not_checked: 1 } },
    });
    // Running it again with room finishes the other one and pays only for it.
    const rest = await lines({ since: undefined, limit: 2, maxRequests: 100 });
    expect(worker.librarySupportCalls.length - callsBefore).toBe(12);
    expect(rest.summary).toMatchObject({ requestsSent: 6, stopped: null });
    // Both are rejected: the clean one passes (the dangerous number) and the flagged one is caught.
    expect(rest.summary.agreement).toMatchObject({
      decided: 2,
      checked: 2,
      rejectedPassed: 1,
      rejectedFlagged: 1,
      releasedPassed: 0,
      releasedFlagged: 0,
    });
  });

  it('stops on a spent quota without storing a result, and refuses a model other than the configured one', async () => {
    await decided('seasons', 'rejected', false);
    const callsBefore = worker.librarySupportCalls.length;
    const storedBefore = await storedRows();
    quotaSpent = true;
    try {
      const paused = await lines({ since: undefined, limit: 1, maxRequests: 100 });
      expect(paused.summary).toMatchObject({ requestsSent: 0, stopped: 'paused' });
      expect(paused.emitted).toMatchObject([{ outcome: 'paused', code: 'quota_unavailable' }]);
    } finally {
      quotaSpent = false;
    }
    const wrong = await lines({ since: undefined, limit: 1, maxRequests: 100 }, 'another-model');
    expect(wrong.summary).toMatchObject({ requestsSent: 0, stopped: 'model_mismatch', revisions: 1 });
    expect(wrong.emitted).toEqual([]);
    expect(worker.librarySupportCalls.length).toBe(callsBefore);
    expect(await storedRows()).toBe(storedBefore);
  });
});
