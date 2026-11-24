import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SCROLL_DOCUMENT_V3_SCHEMA_VERSION } from '@knowscroll/scroll-model';
import { makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  makeReleasePolicy,
  makeReviewGate,
  readLibraryStatus,
} from '@knowscroll/backend/modules/content/nest-providers';
import { makeRenderScroll } from '../../../packages/backend/src/modules/content/adapters/render-scroll.js';
import type { ScrollV3Plan } from '../../../packages/backend/src/modules/content/domain/library/plan.js';
import { RECIPES } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import { RELEASE_POLICY } from '../../../packages/backend/src/modules/content/domain/release-policy.js';
import { makeCheckLibrarySupport } from '../../../packages/backend/src/modules/content/production/library-support-check.js';
import { LIBRARY_SUPPORT_V3_CHECK_VERSION } from '../../../packages/backend/src/modules/content/production/library-support-v3.js';
import { spikePlanV3 } from '../../../packages/backend/src/modules/content/production/spike-v3/plans.js';
import { fixtureReplyV3 } from '../../../packages/backend/src/modules/content/production/spike-v3/writer-v3.fixture.js';
import {
  productionVersionOf,
  REQUEST_BOUND_V3_PER_TOPIC,
  SCROLL_PRODUCTION_V3_FIRST_VERSION,
  SCROLL_PRODUCTION_V3_SECOND_VERSION,
  SCROLL_PRODUCTION_V3_VERSION,
  TOPICS,
} from '../../../packages/backend/src/modules/content/production/topics.js';
import { WRITER_V3_PROMPT_VERSION } from '../../../packages/backend/src/modules/content/production/writer-v3-version.js';
import { catalogueOf } from '../support/catalogue.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { signal } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import { answerWith, enableProductionScope } from '../support/generated-scroll.js';
import { quotablePassages } from '../support/held-v3.js';
import { fixtureProductionWorker, type QuotaScript } from '../support/production-worker.js';
import { orrinResearchFor } from '../support/scroll-v2.js';
import { storeV1 } from '../support/stored-v1.js';
import { v3Client } from '../support/scroll-v3.js';

const key = 'seasons';
const recipe = TOPICS[key];
// The Orrin reply the CI fixture records is written for this plan: a statement and a grid, three sections.
const V3_PLAN: ScrollV3Plan = spikePlanV3(key);
const authority = { scopeId: 'scroll-supply', generation: 1 } as const;
const person = 'cli:ci-reviewer';
const on = { enabled: true, dailyCap: 5 } as const;

/** The recorded reply with its first paragraph opening by pointing back, which the writer's own check refuses. */
function pointingBack(): unknown {
  const draft = JSON.parse(JSON.stringify(fixtureReplyV3())) as { items: { text?: string }[] };
  draft.items[1] = { ...draft.items[1], text: `This ${draft.items[1]?.text ?? ''}` };
  return draft;
}

/** The recorded reply with two links that cannot be placed (an unknown part, a phrase the paragraph never says) on a paragraph that shows nothing of its own. */
function misplacedLinks(): unknown {
  const draft = JSON.parse(JSON.stringify(fixtureReplyV3())) as { items: { text?: string; links?: unknown[] }[] };
  const words = (draft.items[2]?.text ?? '').split(' ').slice(0, 3).join(' ');
  draft.items[2] = {
    ...draft.items[2],
    links: [
      { phrase: words, part: 'Nowhere' },
      { phrase: 'a phrase this paragraph never says', part: 'value' },
    ],
  };
  return draft;
}

/** The recorded reply with a paragraph that copies a sentence of the research, the only fault it has. */
function copyingParagraph(): { items: { text?: string }[]; pictures: Record<string, unknown>[] } {
  const draft = JSON.parse(JSON.stringify(fixtureReplyV3())) as {
    items: { text?: string }[];
    pictures: Record<string, unknown>[];
  };
  draft.items[13] = {
    ...draft.items[13],
    text: 'Near the equator the noon sun stays high in every season, so the tropics change far less across the year than the poles do.',
  };
  return draft;
}

/** The same copy, and a chart written without its marks: the shape is refused before the copy rule can run. */
function copyingParagraphAndChartWithoutMarks(): unknown {
  const draft = copyingParagraph();
  draft.pictures[0] = {
    kind: 'chart',
    title: 'A chart',
    cites: ['e1'],
    form: 'bars',
    values: 'shown',
    points: [
      { label: 'A', value: '1' },
      { label: 'B', value: '2' },
    ],
  };
  return draft;
}

/**
 * Writing, publishing, checking and releasing a model-written document v3 library Scroll (#783) against real PostgreSQL. The job is the
 * production job as it is, with the real writer plan: the real role (`writerRoleV3One`, arm (a)), its validator, the harness's one repair and the
 * real compile. Only the model is a labelled CI fixture, and the Scroll it replies with is the recorded Orrin fixture (an invented planet,
 * never provider output or product content).
 */
describe('A document v3 library recipe is written, held, attributed, covered, checked and released (real PostgreSQL; fixture model)', () => {
  // The Orrin reply is written to the spike's Seasons plan: for this file the recipe takes it, and gets its own plan back after.
  const planned = RECIPES[key] as { scrollV3?: ScrollV3Plan };
  const ownPlan = planned.scrollV3;
  beforeAll(() => {
    planned.scrollV3 = V3_PLAN;
  });
  afterAll(() => {
    planned.scrollV3 = ownPlan;
  });

  let database: TestDatabase<Database>;
  beforeEach(async () => {
    database = await createTestDatabase<Database>('writer_v3_publication');
    await enableProductionScope(database.db);
  });
  afterEach(async () => {
    await database.drop();
  });

  /** The production job over a fixture model whose writer plays `writer` (its own request count, from 1) and whose research is the Orrin page. */
  const setup = (writer: (sequence: number) => FixtureScenario, quota?: QuotaScript) =>
    fixtureProductionWorker(database, writer, {
      research: (url) => Promise.resolve(orrinResearchFor(url)),
      ...(quota === undefined ? {} : { quota }),
    });
  const good = () => answerWith(fixtureReplyV3());
  const bad = () => answerWith(pointingBack());

  const produce = async () => {
    const worker = setup(good);
    return { worker, result: await worker.producer()(key, false, signal()) };
  };

  const gate = () => makeReviewGate(database.db);
  const policy = () => makeReleasePolicy(database.db, catalogueOf(database.db));
  const withScope = () => makeWithProductionScope(database.db, { enabled: true, lockTimeoutMs: 5000 });
  const reviewOf = (revision: number) =>
    database.db
      .selectFrom('content.revision_reviews')
      .selectAll()
      .where('asset_id', '=', recipe.assetId)
      .where('revision', '=', revision)
      .executeTakeFirstOrThrow();
  const storedRevision = (revision: number) =>
    database.db
      .selectFrom('content.asset_revisions')
      .select(['document', 'document_version', 'provenance_kind'])
      .where('asset_id', '=', recipe.assetId)
      .where('revision', '=', revision)
      .executeTakeFirstOrThrow();
  const provenanceOf = async (revision: number) =>
    (
      await database.db
        .selectFrom('content.asset_provenance')
        .select('provenance')
        .where('asset_id', '=', recipe.assetId)
        .where('revision', '=', revision)
        .executeTakeFirstOrThrow()
    ).provenance as { production: { kind: string; model: string; promptVersion: string; attemptIds: string[] } };
  const jobRow = () =>
    database.db
      .selectFrom('content.scroll_production_runs')
      .select(['policy_version', 'state'])
      .where('topic', '=', key)
      .executeTakeFirstOrThrow();

  /** Makes the sentences of the held revision quotable by the labelled fake checker, then runs the real v3 support check on it. */
  async function checked(worker: ReturnType<typeof fixtureProductionWorker>, revision: number) {
    const stored = await storedRevision(revision);
    await quotablePassages(database.db, {
      assetId: recipe.assetId,
      revision,
      document: stored.document as Parameters<typeof quotablePassages>[1]['document'],
    });
    return makeCheckLibrarySupport({ db: database.db, authority, withScope: withScope(), harness: worker.harness })({
      assetId: recipe.assetId,
      revision,
      signal: signal(),
    });
  }

  it('runs the job at the v3 production version, asks the arm (a) writer once, and holds the revision it stores', async () => {
    expect(productionVersionOf(key)).toBe(SCROLL_PRODUCTION_V3_VERSION);
    const { worker, result } = await produce();
    expect(result).toMatchObject({
      outcome: 'published',
      assetId: recipe.assetId,
      revision: 1,
      held: true,
      requestBound: REQUEST_BOUND_V3_PER_TOPIC,
    });
    // One writer request, in the one-reply shape; the answer check of a document v3 has no calls and sends nothing.
    expect(worker.writerCalls).toHaveLength(1);
    expect(worker.checkerCalls).toHaveLength(0);
    expect(worker.writerCalls[0]?.request.system).toContain('PICTURES.');
    expect(worker.writerCalls[0]?.request.system).not.toContain('You stage one Scroll');
    expect(await jobRow()).toEqual({ policy_version: SCROLL_PRODUCTION_V3_VERSION, state: 'published' });
    expect(await storedRevision(1)).toMatchObject({
      document_version: SCROLL_DOCUMENT_V3_SCHEMA_VERSION,
      provenance_kind: 'generated',
    });
    expect(await reviewOf(1)).toMatchObject({ state: 'held' });
    // The record of the answer check is the empty one the release policy reads.
    const outcomes = await database.db
      .selectFrom('content.scroll_production_runs')
      .select('outcomes')
      .where('topic', '=', key)
      .executeTakeFirstOrThrow();
    expect(outcomes.outcomes).toContainEqual(
      expect.objectContaining({ role: 'answer_check', kind: 'checked', verdicts: [] }),
    );
  });

  it('verifies the lineage: the receipt is not attribution_unverified, the topic is attributed and a coverage head exists', async () => {
    const { result } = await produce();
    expect(result.attempts).not.toContainEqual(expect.objectContaining({ code: 'attribution_unverified' }));
    expect(result.attempts).not.toContainEqual(expect.objectContaining({ code: 'attribution_conflict' }));
    expect(
      await database.db
        .selectFrom('content.encounter_topics')
        .select(['topic_id', 'role', 'weight'])
        .where('asset_id', '=', recipe.assetId)
        .execute(),
    ).toEqual([{ topic_id: recipe.topicId, role: 'primary', weight: 1 }]);
    const heads = await database.db
      .selectFrom('content.coverage_heads')
      .select(['asset_id', 'asset_revision'])
      .where('asset_id', '=', recipe.assetId)
      .execute();
    expect(heads).toEqual([{ asset_id: recipe.assetId, asset_revision: 1 }]);
    const { production } = await provenanceOf(1);
    expect(production).toMatchObject({
      kind: 'model',
      model: 'MiniMax-M3.1-Flash',
      promptVersion: WRITER_V3_PROMPT_VERSION,
    });
    expect(production.attemptIds).toHaveLength(1);
  });

  it('lists the held revision for the reviewer and shows it with the passages each part cites', async () => {
    await produce();
    const listed = await gate().list({ all: false });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      assetId: recipe.assetId,
      recipe: key,
      revision: 1,
      state: 'held',
      coverage: 'mapped',
      calls: 0,
      hasPicture: true,
    });
    expect(listed[0]?.v3?.beats).toBeGreaterThan(0);
    expect(Object.keys(listed[0]?.v3?.pictures ?? {}).length).toBeGreaterThan(0);

    const shown = await gate().show({ assetId: recipe.assetId, withSources: true });
    if (shown.kind !== 'shown') throw new Error('CI expected the text');
    expect(shown.text).toContain('TO SUM UP');
    expect(shown.text).toContain('PICTURE [');
    expect(shown.text).toContain('> source passage:');
    expect(shown.text).toContain('SOURCES');
  });

  it('reads the recipe as held, then as published and open to a new take only once the v3 revision is released', async () => {
    await produce();
    expect((await readLibraryStatus(database.db, [key]))[0]).toMatchObject({ state: 'held', job: 'held' });
    // The coverage head exists, so the release guard for a document v3 lets it go.
    expect(await gate().release({ assetId: recipe.assetId, revision: 1, decidedBy: person })).toMatchObject({
      kind: 'released',
    });
    expect((await readLibraryStatus(database.db, [key]))[0]).toMatchObject({
      state: 'published',
      assetId: recipe.assetId,
      revision: 1,
      regeneration: 'available',
      takesLeft: 2,
    });
  });

  it.each([
    ['first', SCROLL_PRODUCTION_V3_FIRST_VERSION, 'scroll-writer-v3.v1'],
    ['second', SCROLL_PRODUCTION_V3_SECOND_VERSION, 'scroll-writer-v3.v2'],
  ])(
    'still releases, serves and reads as published a revision written at the %s v3 version, after the version moved (D-438, D-441)',
    async (_which, earlier, earlierPrompt) => {
      await produce();
      // Make the stored revision what an earlier production version wrote: its job's policy version and the prompt version it named.
      await database.db
        .updateTable('content.scroll_production_runs')
        .set({ policy_version: earlier })
        .where('topic', '=', key)
        .execute();
      const provenance = (await provenanceOf(1)) as { production: Record<string, unknown> };
      await database.db
        .updateTable('content.asset_provenance')
        .set({
          provenance: { ...provenance, production: { ...provenance.production, promptVersion: earlierPrompt } },
        })
        .where('asset_id', '=', recipe.assetId)
        .where('revision', '=', 1)
        .execute();
      // The revision is still a valid held document v3, and a person can release it and it is served.
      expect(await gate().release({ assetId: recipe.assetId, revision: 1, decidedBy: person })).toMatchObject({
        kind: 'released',
      });
      expect(
        await makeRenderScroll(database.db)({ assetId: recipe.assetId, revision: 1, capabilities: v3Client }),
      ).toMatchObject({ kind: 'rendition' });
      // The recipe's served Scroll is a document v3, so it is published and `produce-library` has nothing to queue for it; the
      // takes of the old version are not counted at the new one.
      expect((await readLibraryStatus(database.db, [key]))[0]).toMatchObject({
        state: 'published',
        assetId: recipe.assetId,
        revision: 1,
        takes: 0,
      });
    },
  );

  describe('checked and released', () => {
    it('is checked by the v3 support check, then released by the release policy with no person when every check passes', async () => {
      const { worker, result } = await produce();
      expect(await checked(worker, result.revision!)).toMatchObject({
        kind: 'stored',
        check: { state: 'checked', verdict: 'passed', checkerVersion: LIBRARY_SUPPORT_V3_CHECK_VERSION },
      });
      expect((await policy().approveTopic({ topicId: recipe.topicId, approvedBy: person })).kind).toBe('approved');
      expect(await policy().sweep(on)).toMatchObject({
        kind: 'swept',
        released: [{ assetId: recipe.assetId, revision: 1, topicId: recipe.topicId }],
        held: {},
      });
      expect(await reviewOf(1)).toMatchObject({ state: 'released', decided_by: RELEASE_POLICY.decidedBy });
      expect(
        await database.db
          .selectFrom('content.assets')
          .select(['status', 'revision'])
          .where('id', '=', recipe.assetId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'admitted', revision: 1 });
      // It is served: a client that declares the schema is given the document.
      expect(
        await makeRenderScroll(database.db)({ assetId: recipe.assetId, revision: 1, capabilities: v3Client }),
      ).toMatchObject({ kind: 'rendition' });
    });

    it('releases the revision with no person when it replaces a served v1, and the v1 is served to no one afterwards (D-435, decisions 6 and 9; was: held replaces_served for a person)', async () => {
      // The earlier revision: the recipe's v1 Scroll, published straight to readers as it was before the plan marked it (stored as the v1 job stored it, #818).
      expect(await storeV1(database.db, key)).toMatchObject({ assetId: recipe.assetId, revision: 1 });

      const worker = setup(good);
      const result = await worker.producer()(key, false, signal());
      expect(result).toMatchObject({ outcome: 'published', revision: 2, held: true });
      expect(await checked(worker, 2)).toMatchObject({
        kind: 'stored',
        check: { state: 'checked', verdict: 'passed' },
      });
      expect((await policy().approveTopic({ topicId: recipe.topicId, approvedBy: person })).kind).toMatch(/approved/u);
      const render = makeRenderScroll(database.db);
      // Held, it retires nothing: the v1 is still served.
      expect(await render({ assetId: recipe.assetId, revision: 1, capabilities: v3Client })).toMatchObject({
        kind: 'rendition',
      });
      expect(await policy().sweep(on)).toMatchObject({
        kind: 'swept',
        released: [{ assetId: recipe.assetId, revision: 2, topicId: recipe.topicId }],
      });
      expect(await reviewOf(2)).toMatchObject({ state: 'released', decided_by: RELEASE_POLICY.decidedBy });
      expect(await render({ assetId: recipe.assetId, revision: 1, capabilities: v3Client })).toEqual({
        kind: 'not_found',
      });
      expect(await render({ assetId: recipe.assetId, revision: 2, capabilities: v3Client })).toMatchObject({
        kind: 'rendition',
      });
    });

    it('holds a new v3 that would replace a served v3 for a person: replaces_served until a person releases it', async () => {
      await produce();
      expect(await gate().release({ assetId: recipe.assetId, revision: 1, decidedBy: person })).toMatchObject({
        kind: 'released',
      });
      const worker = setup(good);
      const result = await worker.producer()(key, false, signal(), false, 2);
      expect(result).toMatchObject({ outcome: 'published', revision: 2, held: true });
      expect(await checked(worker, 2)).toMatchObject({
        kind: 'stored',
        check: { state: 'checked', verdict: 'passed' },
      });
      expect((await policy().approveTopic({ topicId: recipe.topicId, approvedBy: person })).kind).toMatch(/approved/u);
      expect(await policy().releaseOne({ assetId: recipe.assetId, revision: 2 }, { dailyCap: 5 })).toEqual({
        kind: 'refused',
        reason: 'replaces_served',
      });
      expect(await policy().sweep(on)).toMatchObject({ kind: 'swept', released: [] });
      expect(await reviewOf(2)).toMatchObject({ state: 'held' });
      expect(await gate().release({ assetId: recipe.assetId, revision: 2, decidedBy: person })).toMatchObject({
        kind: 'released',
        replacedRevision: 1,
      });
    });
  });

  describe('a reply the writer’s own check refuses', () => {
    it('is repaired once by the harness, and the repaired reply is accepted: two writer requests, both in the Scroll’s lineage', async () => {
      const worker = setup((sequence) => (sequence === 1 ? bad() : good()));
      const result = await worker.producer()(key, false, signal());
      expect(result).toMatchObject({ outcome: 'published', revision: 1, held: true });
      expect(worker.writerCalls).toHaveLength(2);
      // The repair is told the finding by its fixed code, and carries the refused answer as data.
      expect(worker.writerCalls[1]?.request.system).toContain('first_beat_points_back');
      expect(worker.writerCalls[1]?.request.user).toContain('<previous-answer>');
      const { production } = await provenanceOf(1);
      expect(production.attemptIds).toHaveLength(2);
      expect(production.promptVersion).toBe(WRITER_V3_PROMPT_VERSION);
      expect(result.attempts).not.toContainEqual(expect.objectContaining({ code: 'attribution_unverified' }));
      expect(await reviewOf(1)).toMatchObject({ state: 'held' });
    });

    it('tells the repair the part and the words when the copy is the only fault: the fixed hint in the findings, the quoted run in the repair notes (D-441)', async () => {
      const worker = setup((sequence) => (sequence === 1 ? answerWith(copyingParagraph()) : good()));
      const result = await worker.producer()(key, false, signal());
      expect(result).toMatchObject({ outcome: 'published', revision: 1, held: true });
      expect(worker.writerCalls).toHaveLength(2);
      const repair = worker.writerCalls[1]?.request;
      expect(repair?.system).toContain('copied_passage');
      expect(repair?.system).toContain('The repair notes, when there are any, name the part and quote the words.');
      expect(repair?.user).toContain('<repair-notes>');
      expect(repair?.user).toContain(
        'items[13]: Nine or more words in a row match the research, in the text: "near the equator the noon sun stays high in every season so the tropics change …". Rewrite them in your own words, with a different sentence structure.',
      );
      expect(worker.writerCalls[0]?.request.user).not.toContain('<repair-notes>');
    });

    it('names the copy to the repair when the first write was refused for its shape too: a chart without its marks hid the copy rule (D-441)', async () => {
      const worker = setup((sequence) =>
        sequence === 1 ? answerWith(copyingParagraphAndChartWithoutMarks()) : good(),
      );
      const result = await worker.producer()(key, false, signal());
      expect(result).toMatchObject({ outcome: 'published', revision: 1, held: true });
      expect(worker.writerCalls).toHaveLength(2);
      const repair = worker.writerCalls[1]?.request;
      expect(repair?.system).not.toContain('copied_passage');
      expect(repair?.user).toContain(
        'items[13]: Nine or more words in a row match the research, in the text: "near the equator',
      );
    });

    it('is published on the first write when its only fault is a link that cannot be placed: no repair, the links left out and counted (D-438)', async () => {
      const worker = setup(() => answerWith(misplacedLinks()));
      const result = await worker.producer()(key, false, signal());
      expect(result).toMatchObject({ outcome: 'published', revision: 1, held: true });
      expect(worker.writerCalls).toHaveLength(1);
      const { production } = await provenanceOf(1);
      expect(production.attemptIds).toHaveLength(1);
      expect(result.attempts).not.toContainEqual(expect.objectContaining({ code: 'attribution_unverified' }));
      // The stored document is the recorded one: neither misplaced link is in it.
      const stored = await storedRevision(1);
      expect(JSON.stringify(stored.document)).not.toContain('Nowhere');
      expect(JSON.stringify(stored.document)).not.toContain('never says');
      const outcomes = await database.db
        .selectFrom('content.scroll_production_runs')
        .select('outcomes')
        .where('topic', '=', key)
        .executeTakeFirstOrThrow();
      expect(outcomes.outcomes).toContainEqual({ role: 'checks', kind: 'links_dropped', dropped: 2 });
    });

    it('records no links_dropped receipt when every link is placed', async () => {
      await produce();
      const outcomes = await database.db
        .selectFrom('content.scroll_production_runs')
        .select('outcomes')
        .where('topic', '=', key)
        .executeTakeFirstOrThrow();
      expect(outcomes.outcomes).not.toContainEqual(expect.objectContaining({ kind: 'links_dropped' }));
    });

    it('ends the job rejected when the repair is refused too, with nothing stored and no third request', async () => {
      const worker = setup(() => bad());
      const result = await worker.producer()(key, false, signal());
      expect(result).toMatchObject({ outcome: 'rejected', codes: ['invalid_output'] });
      expect(worker.writerCalls).toHaveLength(2);
      expect(await jobRow()).toEqual({ policy_version: SCROLL_PRODUCTION_V3_VERSION, state: 'rejected' });
      expect(
        await database.db
          .selectFrom('content.asset_revisions')
          .select('revision')
          .where('asset_id', '=', recipe.assetId)
          .execute(),
      ).toEqual([]);
      // A rejected take is final for itself: asking for it again reports it and sends nothing.
      expect(await worker.producer()(key, false, signal())).toMatchObject({ outcome: 'rejected', take: 1 });
      expect(worker.writerCalls).toHaveLength(2);
    });
  });

  it('pauses when the provider’s quota is spent, sends nothing, and resumes the same job once it allows', async () => {
    let quotaSpent = true;
    const worker = setup(good, () => ({
      verdict: quotaSpent ? 'unavailable' : 'not_applicable',
      intervalRemainingPercent: null,
      weeklyRemainingPercent: null,
    }));
    const paused = await worker.producer()(key, false, signal());
    expect(paused).toMatchObject({
      outcome: 'paused',
      codes: ['quota_unavailable'],
      requestBound: REQUEST_BOUND_V3_PER_TOPIC,
    });
    expect(worker.writerCalls).toHaveLength(0);
    expect(await jobRow()).toEqual({ policy_version: SCROLL_PRODUCTION_V3_VERSION, state: 'writer' });
    quotaSpent = false;
    expect(await worker.producer()(key, false, signal(), true)).toMatchObject({ outcome: 'published', held: true });
    expect(worker.writerCalls).toHaveLength(1);
  });
});
