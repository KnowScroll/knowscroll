import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  makeWithPersonalScope,
  makeWithProductionScope,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { makeReleasePolicy, makeReviewGate } from '@knowscroll/backend/modules/content/nest-providers';
import { readScrollSourcePages } from '../../../packages/backend/src/modules/content/adapters/made-to-order.js';
import { extractResearch } from '../../../packages/backend/src/infrastructure/research/public-pages.js';
import { LIBRARY_CHECK_RULES } from '../../../packages/backend/src/modules/content/domain/library-support.js';
import { RECIPES } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import { RELEASE_POLICY } from '../../../packages/backend/src/modules/content/domain/release-policy.js';
import { makeCheckLibrarySupport } from '../../../packages/backend/src/modules/content/production/library-support-check.js';
import { makeLibrarySupportReplay } from '../../../packages/backend/src/modules/content/production/library-support-replay.js';
import { releasePolicyStore } from '../../../packages/backend/src/modules/content/adapters/release-policy-store.js';
import { libraryCheckStore } from '../../../packages/backend/src/modules/content/production/library-support-store.js';
import { LIBRARY_SUPPORT_CHECK_VERSION } from '../../../packages/backend/src/modules/content/production/library-support.js';
import {
  FIXTURE_SOURCE_V2,
  fixtureAuthoredV2,
  fixtureResearchPageV2,
} from '../../../packages/backend/src/modules/content/production/spike-v2/writer-v2.fixture.js';
import { SPIKE_MODEL } from '../../../packages/backend/src/modules/content/production/spike-v2/run.js';
import { TOPICS, type ScrollTopic } from '../../../packages/backend/src/modules/content/production/topics.js';
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
import { seedPerson } from '../support/fixtures.js';
import { fixtureProductionWorker } from '../support/production-worker.js';

/**
 * The words of the labelled Orrin fixture (an invented planet) with the six sentences reworded that the library check could never quote, as in
 * `library-support-check.test.ts`: the fixture Scroll is clean unless a test makes it otherwise.
 */
const REWORDED: readonly (readonly [string, string])[] = [
  [
    'Keep your eye on the picture while you read, because it will change with every step.',
    'Keep your eye on how Orrin leans while you read, because the picture will change with every step.',
  ],
  ['First, make a guess.', 'First, guess why the north warms.'],
  ['Watch the picture as you read.', 'Watch the north of Orrin as you read.'],
  [
    'Most people pick the nearness answer at first, and it is easy to see why.',
    'Most people pick the nearest star at first, and it is easy to see why.',
  ],
  [
    'Many people expect a slanted beam to be a squeezed one, and the picture is easy to get backwards.',
    'Many people expect a slanted beam to be a squeezed one, yet a beam that strikes low spreads across a wider patch.',
  ],
];

/** The recorded answer for a recipe, drawn with the kit the recipe names. */
function answerFor(key: ScrollTopic) {
  const kit = RECIPES[key].stageKit;
  let json = JSON.stringify(fixtureAuthoredV2(kit));
  for (const [from, to] of REWORDED) {
    if (!json.includes(from)) throw new Error(`CI fixture: the sentence to reword is not there: ${from}`);
    json = json.replaceAll(from, to);
  }
  return JSON.parse(json) as unknown;
}

const orrinPageFor = (url: string) =>
  url === fixtureResearchPageV2.url
    ? fixtureResearchPageV2
    : extractResearch(
        `<html><title>CI fixture</title><main>${[...FIXTURE_SOURCE_V2, `This invented fixture page for ${url} adds nothing further about Orrin.`].map((text) => `<p>${text}</p>`).join('')}</main></html>`,
        url,
        '2026-10-20T00:00:00.000Z',
      );

const authority = { scopeId: 'scroll-supply', generation: 1 } as const;
const person = 'cli:ci-reviewer';
const on = { enabled: true, dailyCap: 5 } as const;

interface Held {
  readonly key: ScrollTopic;
  readonly assetId: string;
  readonly revision: number;
}

/**
 * The release policy of held library Scrolls (#674, D-418) against a real PostgreSQL 16 database. The Scrolls are produced held by the real
 * production job and checked by the real support-check use case, with a labelled CI fixture in place of the writer and of the checker. This
 * proves what the policy reads, releases, holds and refuses, never what a model says about a Scroll.
 */
describe('the release policy of held library Scrolls (labelled CI fixtures, real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let worker: ReturnType<typeof fixtureProductionWorker>;
  let currentKey: ScrollTopic = 'seasons-hemispheres';
  /** What the library checker does with the next request: pass every sentence, or find the first unsupported. */
  let checker: 'passes' | 'flags' = 'passes';
  const takes = new Map<ScrollTopic, number>();
  const gate = () => makeReviewGate(database.db);
  const policy = () => makeReleasePolicy(database.db, catalogueOf(database.db));
  const withScope = () => makeWithProductionScope(database.db, { enabled: true, lockTimeoutMs: 5000 });
  const check = () =>
    makeCheckLibrarySupport({ db: database.db, authority, withScope: withScope(), harness: worker.harness });

  beforeAll(async () => {
    database = await createTestDatabase<Database>('release_policy');
    await enableProductionScope(database.db);
    worker = fixtureProductionWorker(database, () => answerWith(answerFor(currentKey)), {
      research: (url) => Promise.resolve(orrinPageFor(url)),
      librarySupport: (_n, call) => {
        const [first] = supportRequestOf(call).sentences;
        return checker === 'flags' && librarySupportTarget(call).batch === 0 && first !== undefined
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

  /** The recipe's next take, produced by the real job and held for review. */
  async function hold(key: ScrollTopic): Promise<Held> {
    currentKey = key;
    const take = (takes.get(key) ?? 0) + 1;
    const result = await worker.producer()(key, false, signal(), false, take);
    expect(result).toMatchObject({ outcome: 'published', held: true });
    takes.set(key, take);
    return { key, assetId: TOPICS[key].assetId, revision: result.revision! };
  }

  /** A held Scroll whose support check ran and passed. */
  async function ready(key: ScrollTopic): Promise<Held> {
    const held = await hold(key);
    const result = await check()({ assetId: held.assetId, revision: held.revision, signal: signal() });
    expect(result).toMatchObject({ kind: 'stored', check: { state: 'checked', verdict: 'passed' } });
    return held;
  }

  /** Keeps a Scroll out of every later count: the test is done with it. */
  const discard = async (held: Held) =>
    expect(await gate().reject({ ...held, reason: 'CI fixture', decidedBy: person })).toMatchObject({
      kind: 'rejected',
    });

  const reviewOf = (held: Held) =>
    database.db
      .selectFrom('content.revision_reviews')
      .selectAll()
      .where('asset_id', '=', held.assetId)
      .where('revision', '=', held.revision)
      .executeTakeFirstOrThrow();
  const assetOf = (held: Held) =>
    database.db
      .selectFrom('content.assets')
      .select(['status', 'revision'])
      .where('id', '=', held.assetId)
      .executeTakeFirstOrThrow();
  const holds = async () => (await policy().status(on)).held;
  const setTopic = (held: Held, topicId: string) =>
    sql`update content.encounter_topics set topic_id = ${topicId}
      where asset_id = ${held.assetId}::uuid and asset_revision = ${held.revision}::integer and role = 'primary'`.execute(
      database.db,
    );
  const approvalsOf = (topicId: string) =>
    sql<{
      approved_by: string;
      revoked_by: string | null;
      revoked_for: string | null;
    }>`select approved_by, revoked_by, revoked_for from content.release_topic_approvals where topic_id = ${topicId} order by approved_at, id`
      .execute(database.db)
      .then((result) => result.rows);
  /** Approves a topic without the command, which refuses a sensitive one: the sweep must not rely on the command being the only way in. */
  const approveDirectly = (topicId: string) =>
    sql`insert into content.release_topic_approvals (topic_id, approved_by) values (${topicId}, ${person})
      on conflict (topic_id) where revoked_at is null do nothing`.execute(database.db);
  /** Moves every earlier policy decision to yesterday, so the day's cap starts again. */
  const startNewDay = () =>
    sql`update content.revision_reviews set decided_at = decided_at - interval '1 day'
      where decided_by like 'policy:%'`.execute(database.db);

  /** A topic a person approved: approved now, or already by an earlier test. */
  const approved = async (topicId: string) =>
    expect(['approved', 'already_approved']).toContain(
      (await policy().approveTopic({ topicId, approvedBy: person })).kind,
    );

  /** The pages a what-if of this revision may draw on: the revision's own recorded sources, so none for a Scroll nobody is served. */
  const sourcePagesOf = async (held: Held) => {
    const person = await seedPerson(database.db);
    const entered = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(person.authority, (scope) =>
      readScrollSourcePages(scope, { assetId: held.assetId, assetRevision: held.revision }),
    );
    if (entered.kind !== 'entered') throw new Error('CI scope refused');
    return entered.value;
  };

  /** A look is a hint the sweep leaves for itself; a test that changes a Scroll under it makes the sweep look again. */
  const forgetLooks = () => sql`delete from content.release_policy_looks`.execute(database.db);

  describe('the topic approval and the switch', () => {
    let seasons: Held;

    it('holds a Scroll the policy would release while the switch is off: the sweep reads nothing and changes nothing', async () => {
      seasons = await ready('seasons-hemispheres');
      expect(await policy().approveTopic({ topicId: 'earth.seasons', approvedBy: person })).toEqual({
        kind: 'approved',
        topicId: 'earth.seasons',
      });
      // On the facts the policy would release it...
      expect(await holds()).toEqual({ evaluated: 1, wouldRelease: 1, byReason: {} });
      // ...and with the switch off it does not, whatever is approved and passed.
      expect(await policy().sweep({ enabled: false, dailyCap: 5 })).toEqual({ kind: 'off' });
      expect(await reviewOf(seasons)).toMatchObject({ state: 'held', decided_at: null, decided_by: null });
      expect(await assetOf(seasons)).toMatchObject({ status: 'held' });
    });

    it('holds it while its topic is not approved, and again after the approval is revoked', async () => {
      expect(await policy().revokeTopic({ topicId: 'earth.seasons', revokedBy: person })).toEqual({
        kind: 'revoked',
        topicId: 'earth.seasons',
      });
      expect(await holds()).toEqual({ evaluated: 1, wouldRelease: 0, byReason: { topic_not_approved: 1 } });
      expect(await policy().sweep(on)).toMatchObject({ kind: 'swept', considered: 0, released: [] });
      expect(await reviewOf(seasons)).toMatchObject({ state: 'held' });
      // A revocation is kept with who made it; repeating it, or revoking what was never approved, releases and changes nothing.
      expect(await policy().revokeTopic({ topicId: 'earth.seasons', revokedBy: person })).toMatchObject({
        kind: 'already_revoked',
      });
      expect(await policy().revokeTopic({ topicId: 'space.stars', revokedBy: person })).toEqual({
        kind: 'refused',
        reason: 'never_approved',
      });
      expect(await approvalsOf('earth.seasons')).toEqual([
        { approved_by: person, revoked_by: person, revoked_for: 'operator' },
      ]);
      expect(await policy().approveTopic({ topicId: 'earth.seasons', approvedBy: person })).toMatchObject({
        kind: 'approved',
      });
      expect(await policy().approveTopic({ topicId: 'earth.seasons', approvedBy: person })).toMatchObject({
        kind: 'already_approved',
      });
      expect(await approvalsOf('earth.seasons')).toHaveLength(2);
    });

    it('never releases a sensitive topic or one the catalogue does not hold, even with an approval row in place', async () => {
      // The command refuses them...
      expect(await policy().approveTopic({ topicId: 'human-body.immune-system', approvedBy: person })).toEqual({
        kind: 'refused',
        reason: 'sensitive_topic',
        categories: ['medicine', 'health'],
      });
      expect(
        await policy().approveTopic({ topicId: 'history.industrial-revolution', approvedBy: person }),
      ).toMatchObject({ kind: 'refused', reason: 'sensitive_topic' });
      expect(await policy().approveTopic({ topicId: 'earth', approvedBy: person })).toEqual({
        kind: 'refused',
        reason: 'unknown_topic',
      });
      expect(await policy().approveTopic({ topicId: 'earth.seasons.axial-tilt', approvedBy: person })).toEqual({
        kind: 'refused',
        reason: 'unknown_topic',
      });
      // ...and the sweep does not depend on that: a row that got in another way still releases nothing.
      for (const topicId of ['human-body.immune-system', 'astrology.signs']) {
        await setTopic(seasons, topicId);
        await approveDirectly(topicId);
        await forgetLooks();
        expect(await policy().sweep(on)).toMatchObject({
          kind: 'swept',
          considered: 1,
          released: [],
          held: { sensitive: 1 },
        });
        expect(await reviewOf(seasons)).toMatchObject({ state: 'held' });
      }
      await setTopic(seasons, 'earth.seasons');
      await sql`delete from content.release_topic_approvals where topic_id in ('human-body.immune-system', 'astrology.signs')`.execute(
        database.db,
      );
      await forgetLooks();
      expect(await holds()).toMatchObject({ wouldRelease: 1 });
    });

    it('never releases a Scroll whose words are sensitive, in a topic that is not', async () => {
      const original = await database.db
        .selectFrom('content.asset_revisions')
        .select('document')
        .where('asset_id', '=', seasons.assetId)
        .where('revision', '=', seasons.revision)
        .executeTakeFirstOrThrow();
      // The Ask suggestions are the part of a Scroll the support check does not read, so the check still passes.
      await sql`update content.asset_revisions
        set document = jsonb_set(document, '{askSuggestions,1}', '"Is it legal to sell a seasons forecast?"')
        where asset_id = ${seasons.assetId}::uuid and revision = ${seasons.revision}::integer`.execute(database.db);
      expect(await policy().sweep(on)).toMatchObject({
        kind: 'swept',
        considered: 1,
        released: [],
        held: { sensitive: 1 },
      });
      expect(await holds()).toEqual({ evaluated: 1, wouldRelease: 0, byReason: { sensitive: 1 } });
      await sql`update content.asset_revisions set document = ${JSON.stringify(original.document)}::jsonb
        where asset_id = ${seasons.assetId}::uuid and revision = ${seasons.revision}::integer`.execute(database.db);
      await forgetLooks();
      expect(await holds()).toMatchObject({ wouldRelease: 1 });
    });

    it('holds it for a check that is missing, of another checker version, gave nothing, or flagged a sentence: only the current version’s passed verdict counts', async () => {
      const original = await database.db
        .selectFrom('content.library_support_checks')
        .selectAll()
        .where('asset_id', '=', seasons.assetId)
        .where('revision', '=', seasons.revision)
        .where('checker_version', '=', LIBRARY_SUPPORT_CHECK_VERSION)
        .executeTakeFirstOrThrow();
      const remove = () =>
        sql`delete from content.library_support_checks where asset_id = ${seasons.assetId}::uuid and revision = ${seasons.revision}::integer`.execute(
          database.db,
        );
      const put = (row: {
        checker_version: string;
        state: string;
        code: string | null;
        verdict: string;
        sentences: unknown[];
      }) =>
        sql`insert into content.library_support_checks (asset_id, revision, checker_version, state, code, verdict, policy_version, sentence_count, batches, requests, sentences)
          values (${seasons.assetId}::uuid, ${seasons.revision}::integer, ${row.checker_version}, ${row.state}, ${row.code}, ${row.verdict},
            ${original.policy_version}, 0, 0, 0, ${JSON.stringify(row.sentences)}::jsonb)`.execute(database.db);
      const byReason = async () => (await holds()).byReason;

      await remove();
      expect(await byReason()).toEqual({ no_support_check: 1 });
      // A result of another checker version says nothing about the sentences as they are checked now, however good it was.
      await put({
        checker_version: 'library-support-check.00000000',
        state: 'checked',
        code: null,
        verdict: 'passed',
        sentences: [],
      });
      expect(await byReason()).toEqual({ stale_support_check: 1 });
      await put({
        checker_version: LIBRARY_SUPPORT_CHECK_VERSION,
        state: 'unchecked',
        code: 'provider_failed_final',
        verdict: 'unchecked',
        sentences: [],
      });
      expect(await byReason()).toEqual({ support_unchecked: 1 });
      expect(await policy().sweep(on)).toMatchObject({ kind: 'swept', considered: 0, released: [] });
      await remove();

      // The stored verdict is decided again from the sentences: a `passed` row whose sentences hold an unsupported one is flagged.
      const sentences = original.sentences as { outcome: string }[];
      const spoiled = sentences.map((sentence, index) =>
        index === 0 ? { ...sentence, outcome: 'unsupported', kind: 'goes_beyond' } : sentence,
      );
      await sql`insert into content.library_support_checks (asset_id, revision, checker_version, state, code, verdict, policy_version, sentence_count, batches, requests, sentences)
        values (${seasons.assetId}::uuid, ${seasons.revision}::integer, ${LIBRARY_SUPPORT_CHECK_VERSION}, 'checked', null, 'passed', ${original.policy_version},
          ${original.sentence_count}, ${original.batches}, ${original.requests}, ${JSON.stringify(spoiled)}::jsonb)`.execute(
        database.db,
      );
      expect(await byReason()).toEqual({ support_flagged: 1 });
      await remove();

      await sql`insert into content.library_support_checks (asset_id, revision, checker_version, state, code, verdict, policy_version, check_round, batch_failures, sentence_count, batches, requests, sentences, checked_at)
        values (${original.asset_id}::uuid, ${original.revision}::integer, ${original.checker_version}, ${original.state}, ${original.code}, ${original.verdict},
          ${original.policy_version}, ${original.check_round}::integer, ${JSON.stringify(original.batch_failures)}::jsonb, ${original.sentence_count}::integer,
          ${original.batches}::integer, ${original.requests}::integer, ${JSON.stringify(original.sentences)}::jsonb, ${original.checked_at.toISOString()}::timestamptz)`.execute(
        database.db,
      );
      expect(await holds()).toMatchObject({ wouldRelease: 1 });
    });

    it('holds a Scroll the check flagged, which it does not even look at', async () => {
      const flagged = await hold('seasons-limits');
      checker = 'flags';
      const result = await check()({ assetId: flagged.assetId, revision: flagged.revision, signal: signal() });
      checker = 'passes';
      expect(result).toMatchObject({ kind: 'stored', check: { state: 'checked', verdict: 'flagged' } });
      // Beside the passed one: the flagged one is the only hold.
      expect(await holds()).toEqual({ evaluated: 2, wouldRelease: 1, byReason: { support_flagged: 1 } });
      await discard(flagged);
    });

    it('releases an ordinary new Scroll of an approved topic whose check passed, through the review gate, as the policy', async () => {
      const result = await policy().sweep(on);
      expect(result).toEqual({
        kind: 'swept',
        considered: 1,
        released: [{ assetId: seasons.assetId, revision: seasons.revision, topicId: 'earth.seasons' }],
        held: {},
        capReached: false,
      });
      expect(await reviewOf(seasons)).toMatchObject({
        state: 'released',
        decided_by: RELEASE_POLICY.decidedBy,
        reason: null,
      });
      expect((await reviewOf(seasons)).decided_at).toBeInstanceOf(Date);
      expect(RELEASE_POLICY.decidedBy).toMatch(/^policy:/u);
      expect(await assetOf(seasons)).toEqual({ status: 'admitted', revision: seasons.revision });
      const listed = await gate().list({ all: true });
      expect(listed.find((row) => row.assetId === seasons.assetId)).toMatchObject({
        state: 'released',
        decidedBy: RELEASE_POLICY.decidedBy,
        servedRevision: seasons.revision,
      });
      // Nothing left to release; a second sweep changes nothing.
      expect(await policy().sweep(on)).toMatchObject({ kind: 'swept', considered: 0, released: [] });
    });

    it('leaves a replacement of a served Scroll to a person: only a new asset is released by the policy', async () => {
      const second = await ready('seasons-hemispheres');
      expect(await assetOf(second)).toMatchObject({ status: 'admitted', revision: seasons.revision });
      expect(await holds()).toEqual({ evaluated: 1, wouldRelease: 0, byReason: { replaces_served: 1 } });
      expect(await policy().sweep(on)).toMatchObject({ kind: 'swept', considered: 0, released: [] });
      expect(await reviewOf(second)).toMatchObject({ state: 'held' });
      await discard(second);
    });

    it('withdraws a Scroll it released and revokes its topic in one go, with the existing withdrawal', async () => {
      expect((await sourcePagesOf(seasons)).length).toBeGreaterThan(0);
      expect(
        await policy().withdraw({ assetId: seasons.assetId, revision: seasons.revision, withdrawnBy: person }),
      ).toEqual({
        kind: 'withdrawn',
        assetId: seasons.assetId,
        revision: seasons.revision,
        topicId: 'earth.seasons',
        approval: 'revoked',
      });
      // The asset is withdrawn, so every read treats it as not served; the review row still says who released it.
      expect(await sourcePagesOf(seasons)).toEqual([]);
      expect(await assetOf(seasons)).toMatchObject({ status: 'withdrawn' });
      expect(await reviewOf(seasons)).toMatchObject({ state: 'released', decided_by: RELEASE_POLICY.decidedBy });
      const listed = await gate().list({ all: true });
      expect(listed.find((row) => row.assetId === seasons.assetId)).toMatchObject({ servedRevision: null });
      expect(await approvalsOf('earth.seasons')).toEqual([
        { approved_by: person, revoked_by: person, revoked_for: 'operator' },
        { approved_by: person, revoked_by: person, revoked_for: 'withdrawal' },
      ]);
      // Who withdrew it, when and what became of the topic's approval are kept; a repeat by another operator keeps the first.
      const audit = await sql<{
        withdrawn_by: string;
        withdrawn_at: Date;
        topic_id: string | null;
        approval: string;
      }>`select withdrawn_by, withdrawn_at, topic_id, approval from content.release_withdrawals
        where asset_id = ${seasons.assetId}::uuid and revision = ${seasons.revision}::integer`.execute(database.db);
      expect(audit.rows).toEqual([
        {
          withdrawn_by: person,
          withdrawn_at: expect.any(Date) as Date,
          topic_id: 'earth.seasons',
          approval: 'revoked',
        },
      ]);
      // Repeating it changes nothing; the topic is no longer approved for the policy.
      expect(
        await policy().withdraw({ assetId: seasons.assetId, revision: seasons.revision, withdrawnBy: person }),
      ).toMatchObject({
        kind: 'already_withdrawn',
        approval: 'already_revoked',
      });
      expect(
        await policy().withdraw({ assetId: seasons.assetId, revision: seasons.revision, withdrawnBy: 'cli:ci-second' }),
      ).toMatchObject({ kind: 'already_withdrawn' });
      expect(
        (
          await sql<{ withdrawn_by: string }>`select withdrawn_by from content.release_withdrawals
            where asset_id = ${seasons.assetId}::uuid`.execute(database.db)
        ).rows,
      ).toEqual([{ withdrawn_by: person }]);
      const later = await ready('seasons-limits');
      expect(await holds()).toEqual({ evaluated: 1, wouldRelease: 0, byReason: { topic_not_approved: 1 } });
      await discard(later);
    });
  });

  describe('the withdrawal leaves a person’s own decisions alone', () => {
    it('refuses a Scroll an operator released, one still held and one that does not exist', async () => {
      const own = await ready('stars-lifecycle');
      expect(await gate().release({ assetId: own.assetId, revision: own.revision, decidedBy: person })).toMatchObject({
        kind: 'released',
      });
      expect(await policy().withdraw({ ...own, withdrawnBy: person })).toEqual({
        kind: 'refused',
        reason: 'not_auto_released',
      });
      const waiting = await hold('stars-fusion');
      expect(await policy().withdraw({ ...waiting, withdrawnBy: person })).toEqual({
        kind: 'refused',
        reason: 'not_auto_released',
      });
      expect(
        await policy().withdraw({ assetId: '00000000-0000-4000-8000-000000000000', revision: 1, withdrawnBy: person }),
      ).toEqual({ kind: 'refused', reason: 'not_found' });
      expect(await assetOf(own)).toMatchObject({ status: 'admitted' });
      await discard(waiting);
    });

    it('is not counted by the replay of the support check: it measures against a person’s decisions only', async () => {
      // `seasons-hemispheres` was released by the policy and withdrawn above; `stars-lifecycle` by a person.
      const decided = await libraryCheckStore.decided(database.db, { since: undefined, limit: 500 });
      const released = decided.filter((entry) => entry.decision === 'released');
      expect(released.map((entry) => entry.assetId)).toEqual([TOPICS['stars-lifecycle'].assetId]);
      const byPolicy = await database.db
        .selectFrom('content.revision_reviews')
        .select(['asset_id', 'revision'])
        .where('decided_by', 'like', 'policy:%')
        .execute();
      expect(byPolicy).toHaveLength(1);
      // A person's decision on the same asset (the rejected second take) counts; the policy's release of the first does not.
      expect(
        decided.some((entry) => entry.assetId === byPolicy[0]!.asset_id && entry.revision === byPolicy[0]!.revision),
      ).toBe(false);
      // The replay itself reads what is stored (no request is allowed) and counts the same decisions.
      const replay = makeLibrarySupportReplay({ db: database.db, check: check(), model: SPIKE_MODEL });
      const summary = await replay({ since: undefined, limit: 500, maxRequests: 0 }, signal(), () => undefined);
      expect(summary.revisions).toBe(decided.length);
    });
  });

  describe('the daily cap', () => {
    it('holds under concurrent sweeps: two sweeps at a cap of one release one Scroll between them, and the next day releases the other', async () => {
      await startNewDay();
      expect(await policy().approveTopic({ topicId: 'space.stars', approvedBy: person })).toMatchObject({
        kind: 'approved',
      });
      const first = await ready('stars-colour-brightness');
      const second = await ready('stars-fusion');
      const capOne = { enabled: true, dailyCap: 1 } as const;
      const results = await Promise.all([policy().sweep(capOne), policy().sweep(capOne)]);
      const released = results.flatMap((result) => (result.kind === 'swept' ? result.released : []));
      expect(released).toHaveLength(1);
      const states = [await reviewOf(first), await reviewOf(second)].map((row) => row.state).toSorted();
      expect(states).toEqual(['held', 'released']);
      // Today's count is the one release, and a further sweep reads that and stops: nothing more goes.
      expect((await policy().status(capOne)).counts).toMatchObject({ releasedToday: 1 });
      expect(await policy().sweep(capOne)).toEqual({
        kind: 'swept',
        considered: 0,
        released: [],
        held: {},
        capReached: true,
      });
      // At a cap of two the second may go.
      expect(await policy().sweep({ enabled: true, dailyCap: 2 })).toMatchObject({ kind: 'swept', released: [{}] });
      expect((await policy().status(on)).counts).toMatchObject({ releasedToday: 2 });
      expect(await policy().sweep({ enabled: true, dailyCap: 2 })).toMatchObject({ capReached: true, released: [] });
    });
  });

  describe('what the policy is told by a model', () => {
    it('lets a raise make a Scroll wait for a person, and keeps it for good', async () => {
      expect(await policy().approveTopic({ topicId: 'space.exoplanets', approvedBy: person })).toMatchObject({
        kind: 'approved',
      });
      const raised = await ready('exoplanet-transit');
      expect(await holds()).toMatchObject({ wouldRelease: 1 });
      const raise = {
        assetId: raised.assetId,
        revision: raised.revision,
        category: 'safety',
        proposedBy: 'model:ci-risk-reader',
      } as const;
      expect(await policy().proposeRaise(raise)).toBe('recorded');
      expect(await policy().proposeRaise(raise)).toBe('already_recorded');
      expect(await policy().proposeRaise({ ...raise, assetId: '00000000-0000-4000-8000-000000000000' })).toBe(
        'not_under_review',
      );
      expect(await holds()).toEqual({ evaluated: 1, wouldRelease: 0, byReason: { sensitive: 1 } });
      expect(await policy().sweep(on)).toMatchObject({ kind: 'swept', released: [], held: { sensitive: 1 } });
      expect(await reviewOf(raised)).toMatchObject({ state: 'held' });
      // There is no lowering: a raise can be neither changed nor removed.
      await expect(
        sql`update content.release_risk_raises set category = 'law' where asset_id = ${raised.assetId}::uuid`.execute(
          database.db,
        ),
      ).rejects.toThrow(/CONTENT_RELEASE_RAISE_IMMUTABLE/u);
      await expect(
        sql`delete from content.release_risk_raises where asset_id = ${raised.assetId}::uuid`.execute(database.db),
      ).rejects.toThrow(/CONTENT_RELEASE_RAISE_IMMUTABLE/u);
      expect((await policy().status(on)).counts).toMatchObject({ raises: 1 });
      await discard(raised);
    });

    it('releases nothing of a topic the catalogue calls sensitive, produced by the real job and approved by a row', async () => {
      const body = await ready('cardiac-cycle');
      await approveDirectly('human-body.heart-and-blood');
      expect(await policy().sweep(on)).toMatchObject({
        kind: 'swept',
        considered: 1,
        released: [],
        held: { sensitive: 1 },
      });
      expect(await holds()).toEqual({ evaluated: 1, wouldRelease: 0, byReason: { sensitive: 1 } });
      expect(await reviewOf(body)).toMatchObject({ state: 'held' });
      await discard(body);
    });
  });

  describe('the status', () => {
    it('is counts only: no asset, no topic and no text', async () => {
      const status = await policy().status({ enabled: false, dailyCap: 5 });
      expect(status).toMatchObject({
        policy: RELEASE_POLICY.id,
        autoRelease: { enabled: false, dailyCap: 5 },
        counts: { releasedByPolicy: 3, withdrawnAfterPolicyRelease: 1, raises: 1 },
      });
      const printed = JSON.stringify(status);
      expect(printed).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
      expect(printed).not.toContain('earth.seasons');
      expect(printed).not.toContain('space.stars');
    });
  });

  describe('the release decision is made inside the release transaction', () => {
    let target: Held;
    const attempt = () => policy().releaseOne(target, on);
    const jobRow = () =>
      database.db
        .selectFrom('content.scroll_production_runs')
        .select(['id', 'outcomes'])
        .where('asset_id', '=', target.assetId)
        .where('asset_revision', '=', target.revision)
        .executeTakeFirstOrThrow();

    /** The coverage head of the revision gets a new revision: a retraction, or an admission again (the head only moves forward). */
    const moveCoverage = (status: 'retracted' | 'active') =>
      sql`with next as (select max(revision) + 1 as revision from content.coverage_revisions
          where asset_id = ${target.assetId}::uuid and asset_revision = ${target.revision}::integer),
        added as (insert into content.coverage_revisions (asset_id, asset_revision, revision, status, mapping_sha256, command_sha256, semantic_review_reference, mapping)
          select src.asset_id, src.asset_revision, next.revision, ${status}, src.mapping_sha256, src.command_sha256, src.semantic_review_reference, src.mapping
          from content.coverage_revisions src, next
          where src.asset_id = ${target.assetId}::uuid and src.asset_revision = ${target.revision}::integer and src.revision = 1
          returning revision)
        update content.coverage_heads set revision = (select revision from added)
        where asset_id = ${target.assetId}::uuid and asset_revision = ${target.revision}::integer`.execute(database.db);

    const checkRows = () =>
      sql<Record<string, unknown>>`select * from content.library_support_checks
        where asset_id = ${target.assetId}::uuid and revision = ${target.revision}::integer`
        .execute(database.db)
        .then((result) => result.rows);
    const putCheck = (row: {
      readonly checker_version: string;
      readonly state: string;
      readonly code: string | null;
      readonly verdict: string;
      readonly policy_version: string;
      readonly sentence_count: number;
      readonly batches: number;
      readonly requests: number;
      readonly sentences: unknown;
    }) =>
      sql`insert into content.library_support_checks (asset_id, revision, checker_version, state, code, verdict, policy_version, sentence_count, batches, requests, sentences)
        values (${target.assetId}::uuid, ${target.revision}::integer, ${row.checker_version}, ${row.state}, ${row.code}, ${row.verdict}, ${row.policy_version},
          ${row.sentence_count}::integer, ${row.batches}::integer, ${row.requests}::integer, ${JSON.stringify(row.sentences)}::jsonb)`.execute(
        database.db,
      );
    const dropChecks = () =>
      sql`delete from content.library_support_checks where asset_id = ${target.assetId}::uuid and revision = ${target.revision}::integer`.execute(
        database.db,
      );

    it('releases nothing a fact changed after it was read: each fact is read again inside the transaction, and the release is refused with its code', async () => {
      target = await ready('black-hole-formation');
      await approved('space.black-holes');
      // The sweep would find it ready, and the decision on its facts is a release.
      expect(await holds()).toEqual({ evaluated: 1, wouldRelease: 1, byReason: {} });
      const originalCheck = (await checkRows()).find(
        (row) => row['checker_version'] === LIBRARY_SUPPORT_CHECK_VERSION,
      )!;
      const spoiled = (originalCheck['sentences'] as { outcome: string }[]).map((sentence, index) =>
        index === 0 ? { ...sentence, outcome: 'unsupported', kind: 'goes_beyond' } : sentence,
      );
      const original = {
        checker_version: originalCheck['checker_version'] as string,
        state: originalCheck['state'] as string,
        code: originalCheck['code'] as string | null,
        verdict: originalCheck['verdict'] as string,
        policy_version: originalCheck['policy_version'] as string,
        sentence_count: originalCheck['sentence_count'] as number,
        batches: originalCheck['batches'] as number,
        requests: originalCheck['requests'] as number,
        sentences: originalCheck['sentences'],
      };
      const job = await jobRow();
      const document = await database.db
        .selectFrom('content.asset_revisions')
        .select('document')
        .where('asset_id', '=', target.assetId)
        .where('revision', '=', target.revision)
        .executeTakeFirstOrThrow();
      const primary = sql`asset_id = ${target.assetId}::uuid and asset_revision = ${target.revision}::integer and role = 'primary'`;

      const cases: readonly {
        readonly reason: string;
        readonly tamper: () => Promise<unknown>;
        readonly restore: () => Promise<unknown>;
      }[] = [
        {
          reason: 'topic_not_approved',
          tamper: () => policy().revokeTopic({ topicId: 'space.black-holes', revokedBy: person }),
          restore: () => policy().approveTopic({ topicId: 'space.black-holes', approvedBy: person }),
        },
        {
          reason: 'unmapped',
          tamper: () => moveCoverage('retracted'),
          restore: () => moveCoverage('active'),
        },
        {
          reason: 'sensitive',
          tamper: () => setTopic(target, 'human-body.immune-system'),
          restore: () => setTopic(target, 'space.black-holes'),
        },
        {
          reason: 'sensitive',
          tamper: () => setTopic(target, 'astrology.signs'),
          restore: () => setTopic(target, 'space.black-holes'),
        },
        {
          reason: 'no_topic',
          tamper: () => sql`delete from content.encounter_topics where ${primary}`.execute(database.db),
          restore: () =>
            sql`insert into content.encounter_topics (asset_id, asset_revision, topic_id, role, weight)
              values (${target.assetId}::uuid, ${target.revision}::integer, 'space.black-holes', 'primary', 1)`.execute(
              database.db,
            ),
        },
        {
          reason: 'no_support_check',
          tamper: dropChecks,
          restore: async () => {
            await dropChecks();
            await putCheck(original);
          },
        },
        {
          reason: 'stale_support_check',
          tamper: async () => {
            await dropChecks();
            await putCheck({ ...original, checker_version: 'library-support-check.00000000' });
          },
          restore: async () => {
            await dropChecks();
            await putCheck(original);
          },
        },
        {
          reason: 'support_unchecked',
          tamper: async () => {
            await dropChecks();
            await putCheck({
              ...original,
              state: 'unchecked',
              code: 'provider_failed_final',
              verdict: 'unchecked',
              sentence_count: 0,
              batches: 0,
              requests: 0,
              sentences: [],
            });
          },
          restore: async () => {
            await dropChecks();
            await putCheck(original);
          },
        },
        {
          reason: 'support_flagged',
          tamper: async () => {
            await dropChecks();
            await putCheck({ ...original, sentences: spoiled });
          },
          restore: async () => {
            await dropChecks();
            await putCheck(original);
          },
        },
        {
          reason: 'answer_check_not_passed',
          tamper: () =>
            sql`update content.scroll_production_runs set outcomes = '[]'::jsonb where id = ${job.id}`.execute(
              database.db,
            ),
          restore: () =>
            sql`update content.scroll_production_runs set outcomes = ${JSON.stringify(job.outcomes)}::jsonb where id = ${job.id}`.execute(
              database.db,
            ),
        },
        {
          reason: 'unreadable',
          tamper: () =>
            sql`update content.asset_revisions set document = '{}'::jsonb where asset_id = ${target.assetId}::uuid and revision = ${target.revision}::integer`.execute(
              database.db,
            ),
          restore: () =>
            sql`update content.asset_revisions set document = ${JSON.stringify(document.document)}::jsonb
              where asset_id = ${target.assetId}::uuid and revision = ${target.revision}::integer`.execute(database.db),
        },
        {
          reason: 'sensitive',
          tamper: () =>
            sql`update content.asset_revisions set document = jsonb_set(document, '{askSuggestions,0}', '"Is it legal to feed one?"')
              where asset_id = ${target.assetId}::uuid and revision = ${target.revision}::integer`.execute(database.db),
          restore: () =>
            sql`update content.asset_revisions set document = ${JSON.stringify(document.document)}::jsonb
              where asset_id = ${target.assetId}::uuid and revision = ${target.revision}::integer`.execute(database.db),
        },
      ];
      for (const { reason, tamper, restore } of cases) {
        await tamper();
        try {
          expect(await attempt(), reason).toEqual({ kind: 'refused', reason });
          expect(await reviewOf(target), reason).toMatchObject({ state: 'held', decided_by: null });
          expect(await assetOf(target), reason).toMatchObject({ status: 'held' });
        } finally {
          await restore();
        }
      }
      // The day's cap is read in the transaction too.
      expect(await policy().releaseOne(target, { dailyCap: 0 })).toEqual({
        kind: 'refused',
        reason: 'daily_cap_reached',
      });
      // With every fact restored nothing refuses it: the same facts that were refused one by one now release.
      expect(await holds()).toEqual({ evaluated: 1, wouldRelease: 1, byReason: {} });
    });

    it('releases it, as the policy and through the review gate, once every fact holds again', async () => {
      const done = await attempt();
      expect(done).toMatchObject({ kind: 'released', assetId: target.assetId, revision: target.revision });
      expect(await reviewOf(target)).toMatchObject({ state: 'released', decided_by: RELEASE_POLICY.decidedBy });
    });

    it('is not told by a raise recorded after the sweep read: the raise is read in the transaction and holds the Scroll for good', async () => {
      const raised = await ready('black-hole-evidence');
      expect(await holds()).toEqual({ evaluated: 1, wouldRelease: 1, byReason: {} });
      await policy().proposeRaise({
        assetId: raised.assetId,
        revision: raised.revision,
        category: 'law',
        proposedBy: 'model:ci-risk-reader',
      });
      expect(await policy().releaseOne(raised, on)).toEqual({ kind: 'refused', reason: 'sensitive' });
      await discard(raised);
    });

    /** Holds a transaction open (its work done, not committed) while `during` runs, then commits it. */
    async function whileHeld(
      work: (trx: Parameters<Parameters<ReturnType<typeof database.db.transaction>['execute']>[0]>[0]) => Promise<void>,
      during: () => Promise<unknown>,
    ) {
      let started!: () => void;
      let finish!: () => void;
      const hasStarted = new Promise<void>((resolve) => (started = resolve));
      const mayFinish = new Promise<void>((resolve) => (finish = resolve));
      const holder = database.db.transaction().execute(async (trx) => {
        await work(trx);
        started();
        await mayFinish;
      });
      await hasStarted;
      const pending = during();
      const settled = await Promise.race([
        pending.then(() => 'done'),
        new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 500)),
      ]);
      finish();
      await holder;
      return { settled, result: await pending };
    }

    it('waits for a revocation that is under way and then refuses: the approval is locked, not remembered', async () => {
      const waiting = await ready('exoplanet-habitable-zone');
      await approved('space.exoplanets');
      target = waiting;
      const { settled, result } = await whileHeld(
        async (trx) => {
          await sql`update content.release_topic_approvals set revoked_by = ${person}, revoked_at = now(), revoked_for = 'operator'
            where topic_id = 'space.exoplanets' and revoked_at is null`.execute(trx);
        },
        () => attempt(),
      );
      expect(settled).toBe('pending');
      expect(result).toEqual({ kind: 'refused', reason: 'topic_not_approved' });
      expect(await reviewOf(waiting)).toMatchObject({ state: 'held' });
    });

    it('waits for a coverage change that is under way and then refuses: the head is read after the asset lock', async () => {
      await approved('space.exoplanets');
      const { settled, result } = await whileHeld(
        async (trx) => {
          // As admission does: the asset's lock first, then the new head.
          await sql`select pg_advisory_xact_lock(hashtextextended(${`content.asset:${target.assetId}`}, 0))`.execute(
            trx,
          );
          await sql`with added as (insert into content.coverage_revisions (asset_id, asset_revision, revision, status, mapping_sha256, command_sha256, semantic_review_reference, mapping)
              select asset_id, asset_revision, 2, 'retracted', mapping_sha256, command_sha256, semantic_review_reference, mapping
              from content.coverage_revisions where asset_id = ${target.assetId}::uuid and asset_revision = ${target.revision}::integer and revision = 1 returning revision)
            update content.coverage_heads set revision = (select revision from added)
            where asset_id = ${target.assetId}::uuid and asset_revision = ${target.revision}::integer`.execute(trx);
        },
        () => attempt(),
      );
      expect(settled).toBe('pending');
      expect(result).toEqual({ kind: 'refused', reason: 'unmapped' });
      await discard(target);
    });
  });

  describe('the sweep pages past revisions that stay held', () => {
    const crowd = 105;
    const clones = sql`with clones as (select n, ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid as id from generate_series(1, ${crowd}::integer) n)`;

    it('releases the newest ready Scroll behind more than a page of older ones that stay held, looks at each stuck one once, and reads none of them again', async () => {
      const newest = await ready('black-hole-evidence');
      const topic = 'space.black-holes';
      await approved(topic);
      // A crowd of older held Scrolls in the same approved topic, each ready on every fact that needs no body, and each stuck on one that does: no answer check.
      const src = sql`src.asset_id = ${newest.assetId}::uuid and src.revision = ${newest.revision}::integer`;
      await sql`${clones} insert into content.assets (id, revision, kind, status) select id, 1, 'scroll', 'held' from clones`.execute(
        database.db,
      );
      await sql`${clones} insert into content.asset_revisions (asset_id, revision, provenance_kind, document_version, document, document_sha256, explanation_unit_id, language, title, reading_facts)
        select clones.id, 1, src.provenance_kind, src.document_version, src.document, src.document_sha256, src.explanation_unit_id, src.language, src.title, src.reading_facts
        from clones cross join content.asset_revisions src where ${src}`.execute(database.db);
      await sql`${clones} insert into content.revision_reviews (asset_id, revision, state, held_at)
        select id, 1, 'held', now() - interval '2 days' + n * interval '1 second' from clones`.execute(database.db);
      await sql`${clones} insert into content.encounter_topics (asset_id, asset_revision, topic_id, role, weight) select id, 1, ${topic}, 'primary', 1 from clones`.execute(
        database.db,
      );
      await sql`${clones} insert into content.coverage_revisions (asset_id, asset_revision, revision, status, mapping_sha256, command_sha256, semantic_review_reference, mapping)
        select clones.id, 1, 1, src.status, src.mapping_sha256, src.command_sha256, src.semantic_review_reference, src.mapping
        from clones cross join content.coverage_revisions src where src.asset_id = ${newest.assetId}::uuid and src.asset_revision = ${newest.revision}::integer and src.revision = 1`.execute(
        database.db,
      );
      await sql`${clones} insert into content.coverage_heads (asset_id, asset_revision, revision) select id, 1, 1 from clones`.execute(
        database.db,
      );
      await sql`${clones} insert into content.library_support_checks (asset_id, revision, checker_version, state, code, verdict, policy_version, check_round, batch_failures, sentence_count, batches, requests, sentences)
        select clones.id, 1, src.checker_version, src.state, src.code, src.verdict, src.policy_version, src.check_round, src.batch_failures, src.sentence_count, src.batches, src.requests, src.sentences
        from clones cross join content.library_support_checks src where src.asset_id = ${newest.assetId}::uuid and src.revision = ${newest.revision}::integer`.execute(
        database.db,
      );

      const result = await policy().sweep(on);
      expect(result).toMatchObject({
        kind: 'swept',
        considered: crowd + 1,
        released: [{ assetId: newest.assetId, revision: newest.revision, topicId: topic }],
        held: { answer_check_not_passed: crowd },
        capReached: false,
      });
      expect(await reviewOf(newest)).toMatchObject({ state: 'released', decided_by: RELEASE_POLICY.decidedBy });
      const looks = await sql<{
        hold_code: string;
        n: number;
      }>`select hold_code, count(*)::integer as n from content.release_policy_looks
        where asset_id::text like '00000000-0000-4000-8000-%' group by hold_code`.execute(database.db);
      expect(looks.rows).toEqual([{ hold_code: 'answer_check_not_passed', n: crowd }]);

      // The next sweep goes past them: a hold that cannot change under the rules they were judged by is not read again.
      expect(await policy().sweep(on)).toEqual({
        kind: 'swept',
        considered: 0,
        released: [],
        held: {},
        capReached: false,
      });
      // A change of the rules is a reason to look again.
      // The order of a page is the revision least recently looked at first and one never looked at before any, not the oldest hold first: a revision looked at
      // today does not stand in front of one that was not.
      const never = '00000000-0000-4000-8000-000000000050';
      await sql`delete from content.release_policy_looks where asset_id = ${never}::uuid`.execute(database.db);
      const page = await releasePolicyStore.heldSummaries(database.db, {
        checkerVersion: LIBRARY_SUPPORT_CHECK_VERSION,
        onlyReady: true,
        limit: 3,
        paging: { rulesVersion: 'no such rules', lookedBefore: '2100-01-01 00:00:00+00' },
      });
      const leastRecent = await sql<{ asset_id: string }>`select asset_id from content.release_policy_looks
        where asset_id::text like '00000000-0000-4000-8000-%' order by looked_at limit 2`.execute(database.db);
      expect(page.map((entry) => entry.assetId)).toEqual([never, ...leastRecent.rows.map((row) => row.asset_id)]);
      await sql`update content.release_policy_looks set rules_version = 'older rules'`.execute(database.db);
      expect(await policy().sweep(on)).toMatchObject({
        kind: 'swept',
        considered: crowd,
        released: [],
        held: { answer_check_not_passed: crowd },
      });
    });
  });
});
