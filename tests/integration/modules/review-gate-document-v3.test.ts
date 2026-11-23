import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  coverageHeadPorts,
  makeAdmissionStore,
  makeReviewGate,
} from '@knowscroll/backend/modules/content/nest-providers';
import { admitRecipeCoverage } from '../../../packages/backend/src/modules/content/application/admit-recipe-coverage.js';
import { RECIPES } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import { compileEditorialSourceV3 } from '../../../packages/backend/src/modules/content/adapters/scroll-compiler-v3.js';
import { extractResearch } from '../../../packages/backend/src/infrastructure/research/public-pages.js';
import {
  FIXTURE_SOURCE_V2,
  fixtureAuthoredV2,
  fixtureResearchPageV2,
} from '../../../packages/backend/src/modules/content/production/spike-v2/writer-v2.fixture.js';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { signal } from '../support/fixture-model.js';
import { answerWith, enableProductionScope, fixtureProduction } from '../support/generated-scroll.js';
import { compileEditorialSourceFile } from '../../../packages/backend/src/modules/content/adapters/editorial-sources.js';
import { documentV3Source, starterSource } from '../support/scroll.js';
import { markFormerV2Recipes } from '../support/scroll-v2.js';

/**
 * The release guard of the review gate for a `scroll-document.v3` revision (#761, decision G1): a held revision with no
 * active coverage head would form nothing in the Universe, so it is not released until it has one. A v1 or v2 revision
 * is released as it always was. Revisions are put in place with the admission store's own `held` flag, and the
 * coverage with the recipe rule, as an operator's flow would; the Scrolls are the hand-written fixtures and the
 * labelled CI Orrin fixture, never provider output.
 */
// Every recipe of the library is a document v3 recipe (#787, #790). This file tests the v2 path, so it makes them v2 recipes
// again, with the plan (and kit) they had, for the file's own process.
const restoreFormerV2Recipes = markFormerV2Recipes();
afterAll(restoreFormerV2Recipes);

describe('The review gate releases a document v3 revision only with its coverage (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  const gate = () => makeReviewGate(database.db);
  const operator = 'cli:ci-reviewer';
  beforeAll(async () => {
    database = await createTestDatabase<Database>('review_gate_v3');
    await enableProductionScope(database.db);
  });
  afterAll(async () => {
    await database.drop();
  });

  /** Stores a hand-written document v3 as a revision held for review, with no topic and no coverage. */
  async function holdV3(name: 'fence' | 'seasons' | 'broad-street') {
    const source = documentV3Source(name);
    const assetId = randomUUID();
    const compiled = compileEditorialSourceV3({ ...source, assetId }, 1);
    if (compiled.kind !== 'compiled') throw new Error(`fixture ${name} did not compile`);
    const store = makeAdmissionStore(database.db);
    await store.inAdmission((tx) =>
      store.storeRevision(tx, {
        assetId,
        revision: 1,
        provenanceKind: 'authored_editorial',
        compiled,
        createsAsset: true,
        held: true,
      }),
    );
    return { assetId, source, compiled };
  }

  /** Admits the beat coverage of a held revision by the recipe the source names, as the import does for a served one. */
  async function admitCoverage(held: Awaited<ReturnType<typeof holdV3>>) {
    const recipe = RECIPES[held.source['recipe'] as keyof typeof RECIPES];
    const store = makeAdmissionStore(database.db);
    return store.inAdmission((tx) =>
      admitRecipeCoverage(coverageHeadPorts, tx, recipe, { assetId: held.assetId, assetRevision: 1 }),
    );
  }

  const assetOf = (assetId: string) =>
    database.db
      .selectFrom('content.assets')
      .select(['status', 'revision', 'availability_revision'])
      .where('id', '=', assetId)
      .executeTakeFirstOrThrow();
  const reviewOf = (assetId: string) =>
    database.db
      .selectFrom('content.revision_reviews')
      .select(['state', 'decided_by'])
      .where('asset_id', '=', assetId)
      .where('revision', '=', 1)
      .executeTakeFirstOrThrow();
  const headsOf = async (assetId: string) =>
    (
      await database.db
        .selectFrom('content.coverage_heads')
        .select('revision')
        .where('asset_id', '=', assetId)
        .execute()
    ).length;

  it('refuses a held document v3 revision that has no coverage head, and changes nothing', async () => {
    const held = await holdV3('fence');
    expect(await headsOf(held.assetId)).toBe(0);
    const before = await assetOf(held.assetId);
    expect(before).toMatchObject({ status: 'held', revision: 1 });

    expect(await gate().release({ assetId: held.assetId, revision: 1, decidedBy: operator })).toEqual({
      kind: 'refused',
      reason: 'coverage_missing',
    });
    expect(await assetOf(held.assetId)).toEqual(before);
    expect(await reviewOf(held.assetId)).toEqual({ state: 'held', decided_by: null });
  });

  it('releases it once an active coverage head exists, and a repeat changes nothing', async () => {
    const held = await holdV3('broad-street');
    expect(await gate().release({ assetId: held.assetId, revision: 1, decidedBy: operator })).toMatchObject({
      kind: 'refused',
      reason: 'coverage_missing',
    });

    expect(await admitCoverage(held)).toMatchObject({ kind: 'admitted', change: 'appended' });
    expect(await headsOf(held.assetId)).toBe(1);

    expect(await gate().release({ assetId: held.assetId, revision: 1, decidedBy: operator })).toEqual({
      kind: 'released',
      assetId: held.assetId,
      revision: 1,
      replacedRevision: null,
    });
    expect(await assetOf(held.assetId)).toMatchObject({ status: 'admitted', revision: 1 });
    expect(await reviewOf(held.assetId)).toEqual({ state: 'released', decided_by: operator });
    const after = await assetOf(held.assetId);
    expect(await gate().release({ assetId: held.assetId, revision: 1, decidedBy: 'cli:someone-else' })).toMatchObject({
      kind: 'already_released',
    });
    expect(await assetOf(held.assetId)).toEqual(after);
  });

  it('does not ask for coverage of a v1 revision: one held with no head releases as before', async () => {
    // A v1 Scroll is stored through the same flag; it never had beat coverage and must not need any.
    const assetId = randomUUID();
    const compiled = compileEditorialSourceFile({ ...starterSource(), assetId }, 1);
    if (compiled.kind !== 'compiled') throw new Error('the starter did not compile');
    const store = makeAdmissionStore(database.db);
    await store.inAdmission((tx) =>
      store.storeRevision(tx, {
        assetId,
        revision: 1,
        provenanceKind: 'authored_editorial',
        compiled,
        createsAsset: true,
        held: true,
      }),
    );
    expect(compiled.documentVersion).toBe('scroll-document.v1');
    expect(await headsOf(assetId)).toBe(0);
    expect(await gate().release({ assetId, revision: 1, decidedBy: operator })).toMatchObject({ kind: 'released' });
  });

  it('releases a held v2 revision exactly as before', async () => {
    const key = 'seasons-hemispheres';
    const assetId = TOPICS[key].assetId;
    const orrinPageFor = (url: string) =>
      url === fixtureResearchPageV2.url
        ? fixtureResearchPageV2
        : extractResearch(
            `<html><title>CI fixture</title><main>${[...FIXTURE_SOURCE_V2, `This invented fixture page for ${url} adds nothing further about Orrin.`].map((text) => `<p>${text}</p>`).join('')}</main></html>`,
            url,
            '2026-10-20T00:00:00.000Z',
          );
    const run = fixtureProduction(database.db, () => answerWith(fixtureAuthoredV2()), orrinPageFor);
    expect(await run.produce(key, false, signal())).toMatchObject({ outcome: 'published', held: true, assetId });
    expect(await headsOf(assetId)).toBe(1);
    expect(await gate().release({ assetId, revision: 1, decidedBy: operator })).toEqual({
      kind: 'released',
      assetId,
      revision: 1,
      replacedRevision: null,
    });
    expect(await assetOf(assetId)).toMatchObject({ status: 'admitted', revision: 1 });
  });
});
