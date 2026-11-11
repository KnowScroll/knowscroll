import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { makeReleasePolicy, makeReviewGate } from '@knowscroll/backend/modules/content/nest-providers';
import { extractResearch } from '../../../packages/backend/src/infrastructure/research/public-pages.js';
import { LIBRARY_CHECK_RULES } from '../../../packages/backend/src/modules/content/domain/library-support.js';
import { RECIPES } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import { RELEASE_POLICY } from '../../../packages/backend/src/modules/content/domain/release-policy.js';
import { makeCheckLibrarySupport } from '../../../packages/backend/src/modules/content/production/library-support-check.js';
import { makeLibrarySupportReplay } from '../../../packages/backend/src/modules/content/production/library-support-replay.js';
import { libraryCheckStore } from '../../../packages/backend/src/modules/content/production/library-support-store.js';
import { LIBRARY_SUPPORT_CHECK_VERSION } from '../../../packages/backend/src/modules/content/production/library-support.js';
import {
  FIXTURE_SOURCE_V2,
  fixtureAuthoredV2,
  fixtureResearchPageV2,
} from '../../../packages/backend/src/modules/content/production/spike-v2/writer-v2.fixture.js';
import { SPIKE_MODEL } from '../../../packages/backend/src/modules/content/production/spike-v2/run.js';
import { TOPICS, type ScrollTopic } from '../../../packages/backend/src/modules/content/production/topics.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { signal } from '../support/fixture-model.js';
import {
  answerWith,
  enableProductionScope,
  librarySupportTarget,
  supportReply,
  supportRequestOf,
} from '../support/generated-scroll.js';
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
  const policy = () => makeReleasePolicy(database.db);
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
      expect(await assetOf(seasons)).toMatchObject({ status: 'withdrawn' });
      expect(await reviewOf(seasons)).toMatchObject({ state: 'released', decided_by: RELEASE_POLICY.decidedBy });
      const listed = await gate().list({ all: true });
      expect(listed.find((row) => row.assetId === seasons.assetId)).toMatchObject({ servedRevision: null });
      expect(await approvalsOf('earth.seasons')).toEqual([
        { approved_by: person, revoked_by: person, revoked_for: 'operator' },
        { approved_by: person, revoked_by: person, revoked_for: 'withdrawal' },
      ]);
      // Repeating it changes nothing; the topic is no longer approved for the policy.
      expect(
        await policy().withdraw({ assetId: seasons.assetId, revision: seasons.revision, withdrawnBy: person }),
      ).toMatchObject({
        kind: 'already_withdrawn',
        approval: 'already_revoked',
      });
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
});
