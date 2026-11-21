import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { makeReleasePolicy, makeReviewGate } from '@knowscroll/backend/modules/content/nest-providers';
import { makeRenderScroll } from '../../../packages/backend/src/modules/content/adapters/render-scroll.js';
import { LIBRARY_CHECK_RULES } from '../../../packages/backend/src/modules/content/domain/library-support.js';
import { RELEASE_POLICY } from '../../../packages/backend/src/modules/content/domain/release-policy.js';
import { makeCheckLibrarySupport } from '../../../packages/backend/src/modules/content/production/library-support-check.js';
import { LIBRARY_SUPPORT_CHECK_VERSION } from '../../../packages/backend/src/modules/content/production/library-support.js';
import { LIBRARY_SUPPORT_V3_CHECK_VERSION } from '../../../packages/backend/src/modules/content/production/library-support-v3.js';
import { catalogueOf } from '../support/catalogue.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { signal } from '../support/fixture-model.js';
import {
  answerWith,
  enableProductionScope,
  librarySupportTarget,
  supportReply,
  supportRequestOf,
} from '../support/generated-scroll.js';
import { holdV3, recordProductionRun, type FixtureV3, type HeldV3 } from '../support/held-v3.js';
import { fixtureProductionWorker } from '../support/production-worker.js';
import { documentV3Source } from '../support/scroll.js';
import { seedDocumentV2, v2Client, v3Client } from '../support/scroll-v3.js';

const authority = { scopeId: 'scroll-supply', generation: 1 } as const;
const person = 'cli:ci-reviewer';
const on = { enabled: true, dailyCap: 5 } as const;

/**
 * The release policy over a model-written document v3 (D-435) against a real PostgreSQL 16 database: a held v3 revision is released with no person when
 * every check passes, and held, with its own code, when any one does not. The Scrolls are the labelled document v3 fixtures stored held by the stores'
 * own path, with their recipe's topic and coverage; the checker is a labelled CI fixture and the production job's record is the empty answer check a
 * document v3 has (no calls). This proves what the policy reads, releases and holds for a v3, never what a model would write.
 */
describe('the release policy over a document v3 (labelled CI fixtures, real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let worker: ReturnType<typeof fixtureProductionWorker>;
  let flagFirstBatch = false;
  const gate = () => makeReviewGate(database.db);
  const policy = () => makeReleasePolicy(database.db, catalogueOf(database.db));
  const withScope = () => makeWithProductionScope(database.db, { enabled: true, lockTimeoutMs: 5000 });
  const check = () =>
    makeCheckLibrarySupport({ db: database.db, authority, withScope: withScope(), harness: worker.harness });
  const forgetLooks = () => sql`delete from content.release_policy_looks`.execute(database.db);

  beforeAll(async () => {
    database = await createTestDatabase<Database>('release_policy_v3');
    await enableProductionScope(database.db);
    worker = fixtureProductionWorker(database, () => answerWith({}), {
      librarySupport: (_n, call) => {
        const [first] = supportRequestOf(call).sentences;
        return flagFirstBatch && librarySupportTarget(call).batch === 0 && first !== undefined
          ? supportReply(
              call,
              { unsupported: { [first.n]: { kind: 'goes_beyond', problem: 'A passage says something narrower.' } } },
              LIBRARY_CHECK_RULES,
            )
          : supportReply(call, {}, LIBRARY_CHECK_RULES);
      },
    });
    expect((await policy().approveTopic({ topicId: 'earth.seasons', approvedBy: person })).kind).toBe('approved');
  });
  afterAll(async () => {
    await database.drop();
  });

  /** A held v3 whose every check passes: topic, coverage, the empty answer check, and a passed support check of the v3 version. */
  async function ready(name: FixtureV3 = 'seasons', options: Parameters<typeof holdV3>[2] = {}): Promise<HeldV3> {
    const held = await holdV3(database.db, name, options);
    await recordProductionRun(database.db, held);
    const result = await check()({ assetId: held.assetId, revision: held.revision, signal: signal() });
    expect(result).toMatchObject({ kind: 'stored', check: { state: 'checked', verdict: 'passed' } });
    return held;
  }
  const releaseOne = (held: Pick<HeldV3, 'assetId' | 'revision'>) =>
    policy().releaseOne({ assetId: held.assetId, revision: held.revision }, { dailyCap: 5 });
  const discard = async (held: Pick<HeldV3, 'assetId' | 'revision'>) =>
    expect(await gate().reject({ ...held, reason: 'CI fixture', decidedBy: person })).toMatchObject({
      kind: 'rejected',
    });
  const reviewOf = (held: Pick<HeldV3, 'assetId' | 'revision'>) =>
    database.db
      .selectFrom('content.revision_reviews')
      .selectAll()
      .where('asset_id', '=', held.assetId)
      .where('revision', '=', held.revision)
      .executeTakeFirstOrThrow();
  const assetOf = (held: Pick<HeldV3, 'assetId'>) =>
    database.db
      .selectFrom('content.assets')
      .select(['status', 'revision'])
      .where('id', '=', held.assetId)
      .executeTakeFirstOrThrow();
  const updateDocument = (held: Pick<HeldV3, 'assetId' | 'revision'>, path: string, json: string) =>
    sql`update content.asset_revisions set document = jsonb_set(document, ${path}::text[], ${json}::jsonb)
      where asset_id = ${held.assetId}::uuid and revision = ${held.revision}::integer`.execute(database.db);
  const holdsOf = async () => (await policy().status(on)).held;

  it('releases a held document v3 with no person when every check passes, as the policy, under the same name as for a v2', async () => {
    const held = await ready();
    expect(await holdsOf()).toEqual({ evaluated: 1, wouldRelease: 1, byReason: {} });
    expect(await policy().sweep(on)).toEqual({
      kind: 'swept',
      considered: 1,
      released: [{ assetId: held.assetId, revision: held.revision, topicId: 'earth.seasons' }],
      held: {},
      capReached: false,
    });
    expect(await reviewOf(held)).toMatchObject({ state: 'released', decided_by: RELEASE_POLICY.decidedBy });
    expect(await assetOf(held)).toEqual({ status: 'admitted', revision: held.revision });
    // It is served: a client that declares the schema is given the document.
    expect(
      await makeRenderScroll(database.db)({ assetId: held.assetId, revision: held.revision, capabilities: v3Client }),
    ).toMatchObject({ kind: 'rendition' });
  });

  describe('holds a document v3 for each check that does not pass, with that check’s code', () => {
    it('holds it for a topic nobody approved or an approval that was revoked, and releases it once approved again', async () => {
      const held = await ready();
      expect((await policy().revokeTopic({ topicId: 'earth.seasons', revokedBy: person })).kind).toBe('revoked');
      expect(await releaseOne(held)).toEqual({ kind: 'refused', reason: 'topic_not_approved' });
      expect((await policy().approveTopic({ topicId: 'earth.seasons', approvedBy: person })).kind).toBe('approved');
      expect(await releaseOne(held)).toMatchObject({ kind: 'released' });
    });

    it('holds it for no primary topic', async () => {
      const held = await ready('seasons', { topic: false });
      expect(await releaseOne(held)).toEqual({ kind: 'refused', reason: 'no_topic' });
      expect(await reviewOf(held)).toMatchObject({ state: 'held' });
      await discard(held);
    });

    it('holds it as sensitive for a topic the catalogue puts there, even with an approval row in place', async () => {
      const held = await ready('fence');
      await sql`insert into content.release_topic_approvals (topic_id, approved_by) values (${held.topicId}, ${person})
        on conflict (topic_id) where revoked_at is null do nothing`.execute(database.db);
      expect(await releaseOne(held)).toEqual({ kind: 'refused', reason: 'sensitive' });
      await discard(held);
    });

    it('holds it as sensitive for words a reader of a document v3 reads, in whichever field they stand', async () => {
      const held = await ready();
      // (That the ids of its own parts are not read as words is proved on the documents themselves in `release-policy-document.test.ts`.)
      const planted: readonly (readonly [string, string])[] = [
        ['{takeaway}', '"Ask your doctor about the dose, and take the medicine as told, and rest well."'],
        ['{askSuggestions,1}', '"Is it legal to sell a seasons forecast?"'],
        ['{dek}', '"What the sky does in 2030 and after it, for anyone who looks up."'],
      ];
      for (const [path, json] of planted) {
        const before = await database.db
          .selectFrom('content.asset_revisions')
          .select('document')
          .where('asset_id', '=', held.assetId)
          .executeTakeFirstOrThrow();
        await updateDocument(held, path, json);
        await forgetLooks();
        expect(await releaseOne(held)).toEqual({ kind: 'refused', reason: 'sensitive' });
        await sql`update content.asset_revisions set document = ${JSON.stringify(before.document)}::jsonb
          where asset_id = ${held.assetId}::uuid and revision = ${held.revision}::integer`.execute(database.db);
      }
      await discard(held);
    });

    it('holds it as unreadable for a document that is no document v3, and does not let the sweep read it again until the rules change', async () => {
      const held = await ready();
      await sql`update content.asset_revisions set document = '{"schemaVersion":"scroll-document.v3"}'::jsonb
        where asset_id = ${held.assetId}::uuid and revision = ${held.revision}::integer`.execute(database.db);
      expect(await releaseOne(held)).toEqual({ kind: 'refused', reason: 'unreadable' });
      await discard(held);
    });

    it('holds it as unmapped without an active coverage head, and the review gate refuses it too', async () => {
      const held = await ready('seasons', { coverage: false });
      expect(await releaseOne(held)).toEqual({ kind: 'refused', reason: 'unmapped' });
      expect(await gate().release({ assetId: held.assetId, revision: held.revision, decidedBy: person })).toEqual({
        kind: 'refused',
        reason: 'coverage_missing',
      });
      await discard(held);
    });

    it('holds it when the production job’s answer check is missing or did not pass', async () => {
      const none = await holdV3(database.db, 'seasons');
      expect((await check()({ assetId: none.assetId, revision: none.revision, signal: signal() })).kind).toBe('stored');
      expect(await releaseOne(none)).toEqual({ kind: 'refused', reason: 'answer_check_not_passed' });
      await recordProductionRun(database.db, none, [
        { role: 'answer_check', kind: 'unchecked', draft: 1, code: 'invalid_output' },
      ]);
      expect(await releaseOne(none)).toEqual({ kind: 'refused', reason: 'answer_check_not_passed' });
      await discard(none);
    });

    it('holds it for a support check that is missing, of another checker version, gave nothing or flagged it: only the v3 version’s passed verdict counts', async () => {
      const held = await holdV3(database.db, 'seasons');
      await recordProductionRun(database.db, held);
      expect(await releaseOne(held)).toEqual({ kind: 'refused', reason: 'no_support_check' });

      // A passed result of the v2 version stands for v2 Scrolls and is no answer for this v3: it reads as another version's.
      await sql`insert into content.library_support_checks (asset_id, revision, checker_version, state, code, verdict, policy_version, check_round, sentence_count, batches, requests, sentences)
        values (${held.assetId}::uuid, ${held.revision}::integer, ${LIBRARY_SUPPORT_CHECK_VERSION}, 'checked', null, 'passed', 'library-support-policy.v2', 1, 0, 0, 0, '[]'::jsonb)`.execute(
        database.db,
      );
      expect(await releaseOne(held)).toEqual({ kind: 'refused', reason: 'stale_support_check' });
      expect(await holdsOf()).toMatchObject({ byReason: { stale_support_check: 1 } });

      await sql`insert into content.library_support_checks (asset_id, revision, checker_version, state, code, verdict, policy_version, check_round, sentence_count, batches, requests, sentences)
        values (${held.assetId}::uuid, ${held.revision}::integer, ${LIBRARY_SUPPORT_V3_CHECK_VERSION}, 'unchecked', 'provider_failed_final', 'unchecked', 'library-support-policy.v2', 3, 0, 0, 0, '[]'::jsonb)`.execute(
        database.db,
      );
      expect(await releaseOne(held)).toEqual({ kind: 'refused', reason: 'support_unchecked' });
      await sql`delete from content.library_support_checks where asset_id = ${held.assetId}::uuid and checker_version = ${LIBRARY_SUPPORT_V3_CHECK_VERSION}`.execute(
        database.db,
      );
      flagFirstBatch = true;
      try {
        expect(await check()({ assetId: held.assetId, revision: held.revision, signal: signal() })).toMatchObject({
          kind: 'stored',
          check: { state: 'checked', verdict: 'flagged' },
        });
      } finally {
        flagFirstBatch = false;
      }
      expect(await releaseOne(held)).toEqual({ kind: 'refused', reason: 'support_flagged' });
      await discard(held);
    });

    it('holds it when a stored passed verdict is no longer what its sentences say: the verdict is decided again from every stored sentence', async () => {
      const held = await ready();
      await sql`update content.library_support_checks
        set sentences = jsonb_set(sentences, '{0,outcome}', '"unsupported"')
        where asset_id = ${held.assetId}::uuid and checker_version = ${LIBRARY_SUPPORT_V3_CHECK_VERSION}`.execute(
        database.db,
      );
      expect(await releaseOne(held)).toEqual({ kind: 'refused', reason: 'support_flagged' });
      await discard(held);
    });

    it('holds a document v3 that would replace a Scroll a reader is served, for a person, and a person’s release retires the v2 it replaces (D-435)', async () => {
      const unit = documentV3Source('seasons')['explanationUnitId'] as string;
      const served = await seedDocumentV2(database.db, 'seasons-stage-ci', undefined);
      await database.db
        .updateTable('content.asset_revisions')
        .set({ explanation_unit_id: unit })
        .where('asset_id', '=', served.assetId)
        .execute();
      const held = await ready('seasons', { existing: { assetId: served.assetId, revision: 2 } });
      expect(await assetOf(held)).toEqual({ status: 'admitted', revision: 1 });
      expect(await releaseOne(held)).toEqual({ kind: 'refused', reason: 'replaces_served' });
      expect(await holdsOf()).toMatchObject({ byReason: { replaces_served: 1 } });

      // Held, the v3 retires nothing: the v2 is still served to a v2 app.
      const render = makeRenderScroll(database.db);
      expect(await render({ assetId: served.assetId, revision: 1, capabilities: v2Client })).toMatchObject({
        kind: 'rendition',
      });
      // A person releases it through the review gate; from then on revision 1 is served to no one and revision 2 to an app that declares v3.
      expect(await gate().release({ assetId: held.assetId, revision: held.revision, decidedBy: person })).toMatchObject(
        {
          kind: 'released',
          replacedRevision: 1,
        },
      );
      expect(await assetOf(held)).toEqual({ status: 'admitted', revision: 2 });
      for (const capabilities of [v2Client, v3Client])
        expect(await render({ assetId: served.assetId, revision: 1, capabilities })).toEqual({ kind: 'not_found' });
      expect(await render({ assetId: served.assetId, revision: 2, capabilities: v3Client })).toMatchObject({
        kind: 'rendition',
      });
      expect(await render({ assetId: served.assetId, revision: 2, capabilities: v2Client })).toEqual({
        kind: 'cannot_render',
        reason: 'unsupported_document',
      });
    });
  });
});
