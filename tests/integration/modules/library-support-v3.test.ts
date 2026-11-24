import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { makeReviewGate } from '@knowscroll/backend/modules/content/nest-providers';
import { beatsOfV3 } from '@knowscroll/scroll-model';
import { ScrollProvenanceV3 } from '@knowscroll/scroll-model/internal';
import {
  LIBRARY_CHECK_RULES,
  LIBRARY_SUPPORT_POLICY,
  countsOf,
  decideRevision,
} from '../../../packages/backend/src/modules/content/domain/library-support.js';
import { makeCheckLibrarySupport } from '../../../packages/backend/src/modules/content/production/library-support-check.js';
import { checkLibrarySupportJob } from '../../../packages/backend/src/modules/content/production/library-support-events.js';
import { LIBRARY_CHECKER_VERSIONS } from '../../../packages/backend/src/modules/content/production/library-support-kinds.js';
import {
  makeRunLibrarySupportCheck,
  makeSweepLibrarySupport,
} from '../../../packages/backend/src/modules/content/production/library-support-job.js';
import { makeLibrarySupportReplay } from '../../../packages/backend/src/modules/content/production/library-support-replay.js';
import { libraryCheckStore } from '../../../packages/backend/src/modules/content/production/library-support-store.js';
import {
  LIBRARY_SUPPORT_CHECK_VERSION,
  libraryEvidenceOf,
} from '../../../packages/backend/src/modules/content/production/library-support.js';
import {
  LIBRARY_SUPPORT_V3_CHECK_VERSION,
  sentencesOfScrollV3,
} from '../../../packages/backend/src/modules/content/production/library-support-v3.js';
import { SPIKE_MODEL } from '../../../packages/backend/src/modules/content/production/spike-run.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { signal } from '../support/fixture-model.js';
import {
  answerWith,
  enableProductionScope,
  librarySupportTarget,
  supportReply,
  supportRequestOf,
} from '../support/generated-scroll.js';
import { holdV3, type HeldV3 } from '../support/held-v3.js';
import { fixtureProductionWorker } from '../support/production-worker.js';

const authority = { scopeId: 'scroll-supply', generation: 1 } as const;
const operator = 'cli:ci-reviewer';

/**
 * The support check of a document v3 Scroll (D-435) against a real PostgreSQL 16 database: a held v3 revision is read by the v3 check, under its own
 * version, by the same use case, job, sweep and replay as a v2. The Scroll is a labelled CI fixture and the checker a labelled CI fixture: this proves
 * what the check reads, asks, stores and leaves alone for a v3, never what a model says about a Scroll.
 */
describe('the support check of a document v3 Scroll (labelled CI fixtures, real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let worker: ReturnType<typeof fixtureProductionWorker>;
  /** The checker's batch to flag: the first sentence of this batch is unsupported, or none. */
  let flagBatch: number | undefined;
  const withScope = () => makeWithProductionScope(database.db, { enabled: true, lockTimeoutMs: 5000 });
  const gate = () => makeReviewGate(database.db);
  const check = () =>
    makeCheckLibrarySupport({ db: database.db, authority, withScope: withScope(), harness: worker.harness });
  const run = (held: Pick<HeldV3, 'assetId' | 'revision'>) =>
    check()({ assetId: held.assetId, revision: held.revision, signal: signal() });
  const calls = () => worker.librarySupportCalls.length;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('library_support_v3');
    await enableProductionScope(database.db);
    worker = fixtureProductionWorker(database, () => answerWith({}), {
      librarySupport: (_n, call) => {
        const [first] = supportRequestOf(call).sentences;
        return flagBatch !== undefined && librarySupportTarget(call).batch === flagBatch && first !== undefined
          ? supportReply(
              call,
              { unsupported: { [first.n]: { kind: 'goes_beyond', problem: 'A passage says something narrower.' } } },
              LIBRARY_CHECK_RULES,
            )
          : supportReply(call, {}, LIBRARY_CHECK_RULES);
      },
    });
  });
  afterAll(async () => {
    await database.drop();
  });

  const rowsOf = (held: Pick<HeldV3, 'assetId' | 'revision'>) =>
    database.db
      .selectFrom('content.library_support_checks')
      .selectAll()
      .where('asset_id', '=', held.assetId)
      .where('revision', '=', held.revision)
      .execute();

  describe('a held revision', () => {
    let held: HeldV3;

    it('gets a check row under the v3 version: a verdict for every sentence a reader of a v3 reads, decided by code, and nothing released', async () => {
      held = await holdV3(database.db, 'seasons');
      const subject = await libraryCheckStore.readSubject(database.db, held.assetId, held.revision);
      const provenance = ScrollProvenanceV3.parse(subject!.provenance);
      const listed = sentencesOfScrollV3(held.document, libraryEvidenceOf(provenance));
      if (listed.kind !== 'sentences') throw new Error('CI expected sentences');
      const before = calls();
      const result = await run(held);
      expect(result).toMatchObject({
        kind: 'stored',
        check: {
          state: 'checked',
          verdict: 'passed',
          checkerVersion: LIBRARY_SUPPORT_V3_CHECK_VERSION,
          policyVersion: LIBRARY_SUPPORT_POLICY.id,
          round: 1,
          sentenceCount: listed.sentences.length,
          batches: Math.ceil(listed.sentences.length / 13),
        },
      });
      // 96 sentences in batches of thirteen: eight requests, one for each batch.
      expect(calls() - before).toBe(Math.ceil(listed.sentences.length / 13));
      if (result.kind !== 'stored') throw new Error('CI expected a stored result');
      expect(result.check.sentences.map((sentence) => sentence.text)).toEqual(
        listed.sentences.map((sentence) => sentence.text),
      );
      expect(result.check.sentences.map((sentence) => sentence.part)).toEqual(
        listed.sentences.map((sentence) => sentence.part),
      );
      expect(decideRevision(countsOf(result.check.sentences), LIBRARY_SUPPORT_POLICY)).toBe('passed');
      // The row is the v3's alone: no result of the v2 version exists for it.
      expect((await rowsOf(held)).map((row) => row.checker_version)).toEqual([LIBRARY_SUPPORT_V3_CHECK_VERSION]);
      expect(
        await libraryCheckStore.read(database.db, held.assetId, held.revision, LIBRARY_SUPPORT_CHECK_VERSION),
      ).toBeUndefined();
      // The check released, rejected and served nothing.
      expect(
        await database.db
          .selectFrom('content.revision_reviews')
          .select('state')
          .where('asset_id', '=', held.assetId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: 'held' });
      expect(
        await database.db
          .selectFrom('content.assets')
          .select('status')
          .where('id', '=', held.assetId)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        status: 'held',
      });
    });

    it('asks the checker role of the library under the v3 version, one run for each batch, and closes them', async () => {
      const runs = await sql<{
        policy_version: string;
        role_version: string | null;
        state: string;
        closed_at: Date | null;
      }>`select policy_version, role_version, state, closed_at from reasoning.production_runs where purpose = 'library-support-check' order by created_at, id`.execute(
        database.db,
      );
      expect(runs.rows.length).toBeGreaterThan(0);
      for (const entry of runs.rows) {
        expect(entry.policy_version).toBe(LIBRARY_SUPPORT_V3_CHECK_VERSION);
        expect(entry.state).toBe('completed');
        expect(entry.closed_at).not.toBeNull();
      }
    });

    it('is not asked twice: a repeat and a redelivered job send nothing, a job for the v2 version is refused for this revision, and an unknown version is dropped', async () => {
      const before = calls();
      const stored = await rowsOf(held);
      expect(await run(held)).toMatchObject({ kind: 'reused', check: { verdict: 'passed', round: 1 } });
      const job = makeRunLibrarySupportCheck(check());
      expect(
        await job(checkLibrarySupportJob(held.assetId, held.revision, LIBRARY_SUPPORT_V3_CHECK_VERSION), {
          signal: signal(),
        }),
      ).toMatchObject({ kind: 'finished', result: { kind: 'reused' } });
      // The default job names the v2 version: the revision is a v3, so it is not checked under it.
      expect(await job(checkLibrarySupportJob(held.assetId, held.revision), { signal: signal() })).toEqual({
        kind: 'finished',
        result: { kind: 'not_found', reason: 'other_checker_version' },
      });
      expect(
        await job(
          { ...checkLibrarySupportJob(held.assetId, held.revision), checkerVersion: 'support-check-v3.00000000' },
          { signal: signal() },
        ),
      ).toEqual({ kind: 'skipped', reason: 'checker_version' });
      expect(calls()).toBe(before);
      expect(await rowsOf(held)).toEqual(stored);
    });

    it('is handed to the check queue by the sweep with the v3 version while it has no result, and not after', async () => {
      const second = await holdV3(database.db, 'fence');
      const sent: { assetId: string; revision: number; checkerVersion: string }[] = [];
      const sweep = makeSweepLibrarySupport({
        db: database.db,
        enqueue: (job) => {
          sent.push({ assetId: job.assetId, revision: job.revision, checkerVersion: job.checkerVersion });
          return Promise.resolve('queued');
        },
      });
      expect(await sweep()).toEqual({ due: 1, queued: 1 });
      expect(sent).toEqual([
        { assetId: second.assetId, revision: second.revision, checkerVersion: LIBRARY_SUPPORT_V3_CHECK_VERSION },
      ]);
      expect(checkLibrarySupportJob(second.assetId, second.revision, LIBRARY_SUPPORT_V3_CHECK_VERSION)).toEqual({
        v: 1,
        assetId: second.assetId,
        revision: second.revision,
        checkerVersion: LIBRARY_SUPPORT_V3_CHECK_VERSION,
      });
      expect(await run(second)).toMatchObject({
        kind: 'stored',
        check: { checkerVersion: LIBRARY_SUPPORT_V3_CHECK_VERSION },
      });
      expect(await sweep()).toEqual({ due: 0, queued: 0 });
    });

    it('flags a revision whose checker finds a sentence unsupported, and stores which sentence under the v3 version', async () => {
      const flagged = await holdV3(database.db, 'broad-street');
      flagBatch = 0;
      try {
        const result = await run(flagged);
        expect(result).toMatchObject({ kind: 'stored', check: { state: 'checked', verdict: 'flagged' } });
        if (result.kind !== 'stored') throw new Error('CI expected a stored result');
        expect(result.check.sentences.filter((sentence) => sentence.outcome === 'unsupported')).toHaveLength(1);
        expect(result.check.checkerVersion).toBe(LIBRARY_SUPPORT_V3_CHECK_VERSION);
      } finally {
        flagBatch = undefined;
      }
    });

    it('stores a result with a code and sends nothing for a revision whose provenance cannot be read, and for one that rests on no passage', async () => {
      const damaged = await holdV3(database.db, 'fence');
      await sql`update content.asset_provenance set provenance = '{"schemaVersion":"scroll-provenance.v3"}'::jsonb
        where asset_id = ${damaged.assetId}::uuid`.execute(database.db);
      const before = calls();
      expect(await run(damaged)).toMatchObject({
        kind: 'reused',
        check: {
          state: 'unchecked',
          code: 'provenance_unreadable',
          verdict: 'unchecked',
          checkerVersion: LIBRARY_SUPPORT_V3_CHECK_VERSION,
        },
      });
      const uncited = await holdV3(database.db, 'seasons');
      const row = await database.db
        .selectFrom('content.asset_provenance')
        .select('provenance')
        .where('asset_id', '=', uncited.assetId)
        .executeTakeFirstOrThrow();
      const provenance = row.provenance as { citations: { partId: string }[] };
      provenance.citations = provenance.citations.filter(
        (entry) => entry.partId !== beatsOfV3(uncited.document)[2]!.id,
      );
      await sql`update content.asset_provenance set provenance = ${JSON.stringify(provenance)}::jsonb where asset_id = ${uncited.assetId}::uuid`.execute(
        database.db,
      );
      expect(await run(uncited)).toMatchObject({
        kind: 'reused',
        check: { state: 'unchecked', code: 'citations_missing' },
      });
      expect(calls()).toBe(before);
    });
  });

  describe('the replay of the check against an operator’s decisions', () => {
    it('checks and measures a decided v3 revision under the v3 version, and reports both versions', async () => {
      const decided = await holdV3(database.db, 'seasons');
      expect(
        await gate().release({ assetId: decided.assetId, revision: decided.revision, decidedBy: operator }),
      ).toMatchObject({ kind: 'released' });
      const replay = makeLibrarySupportReplay({ db: database.db, check: check(), model: SPIKE_MODEL });
      const lines: { assetId: string; outcome: string; verdict: string | null }[] = [];
      const summary = await replay({ since: undefined, limit: 50, maxRequests: 500 }, signal(), (line) => {
        lines.push({ assetId: line.assetId, outcome: line.outcome, verdict: line.verdict });
      });
      expect(summary).toMatchObject({
        checkerVersion: LIBRARY_CHECKER_VERSIONS.v2,
        checkerVersionV3: LIBRARY_CHECKER_VERSIONS.v3,
        status: 'done',
      });
      expect(summary.notCoveredV3.length).toBeGreaterThan(0);
      expect(lines.find((line) => line.assetId === decided.assetId)).toEqual({
        assetId: decided.assetId,
        outcome: 'checked',
        verdict: 'passed',
      });
      expect((await rowsOf(decided)).map((row) => row.checker_version)).toEqual([LIBRARY_SUPPORT_V3_CHECK_VERSION]);
      // The person's release of a revision the check passed counts in the agreement, from the v3 result.
      expect(summary.agreement).toMatchObject({ decided: 1, checked: 1, released: 1, rejected: 0 });
      // Run again, nothing is asked: the result is reused.
      const before = calls();
      const again = await replay({ since: undefined, limit: 50, maxRequests: 500 }, signal(), () => undefined);
      expect(again.requestsSent).toBe(0);
      expect(calls()).toBe(before);
    });
  });
});
