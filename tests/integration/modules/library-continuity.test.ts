import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { admitLibraryContinuityUseCase } from '@knowscroll/backend/modules/content/nest-providers';
import { RECIPES, type RecipeKey } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import { type NavigationOutcome } from '@knowscroll/contracts';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson } from '../support/fixtures.js';
import { scrollUseCases, starterSource, textCapabilities } from '../support/scroll.js';

type Cases = Awaited<ReturnType<typeof scrollUseCases>>;

/** Stands in for the Scroll the generator would publish for this recipe: the recipe's own asset ID. */
async function publishRecipe(cases: Cases, key: RecipeKey) {
  const source = starterSource() as { assetId: string; publication: { explanationUnitId: string } };
  source.assetId = RECIPES[key].assetId;
  source.publication.explanationUnitId = `ci-library-continuity-${key}`;
  const imported = await cases.importScroll(source);
  if (imported.kind !== 'imported') throw new Error(`fixture admission refused for ${key}`);
  return { assetId: imported.assetId, assetRevision: imported.revision };
}

function ready(result: Awaited<ReturnType<Cases['navigate']>>): Extract<NavigationOutcome, { status: 'ready' }> {
  if (result.kind !== 'accepted' || result.outcome.status !== 'ready') throw new Error('expected a ready outcome');
  return result.outcome;
}

describe('content admit-continuity over the library plan (real PostgreSQL, CI fixtures)', () => {
  let database: TestDatabase<Database>;
  let cases: Cases;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('library_continuity');
    cases = await scrollUseCases(database);
  });
  afterAll(async () => {
    await cases.close();
    await database.drop();
  });

  const admit = (dryRun: boolean) => admitLibraryContinuityUseCase(database.db)({ dryRun });
  const rowCounts = async () => ({
    units: (await database.db.selectFrom('content.series_units').select('part').execute()).length,
    links: (await database.db.selectFrom('content.continuity_links').select('id').execute()).length,
  });

  it('admits what is published, skips what is not, is idempotent, and navigation then offers the moves', async () => {
    const seasons = await publishRecipe(cases, 'seasons');
    const hemispheres = await publishRecipe(cases, 'seasons-hemispheres');
    await publishRecipe(cases, 'greenhouse');

    // seasons-elsewhere (Part 3) and greenhouse-limits are not published yet.
    const dry = await admit(true);
    expect(dry).toMatchObject({ dryRun: true, seriesRevisionsAdmitted: 0, linksAdmitted: 0 });
    expect(dry.seriesSkipped.find((entry) => entry.seriesId === 'library.earth.seasons')).toEqual({
      seriesId: 'library.earth.seasons',
      unpublished: ['seasons-elsewhere'],
    });
    expect(await rowCounts()).toEqual({ units: 0, links: 0 });

    const elsewhere = await publishRecipe(cases, 'seasons-elsewhere');
    const dryAfter = await admit(true);
    expect(dryAfter).toMatchObject({ seriesRevisionsAdmitted: 1, linksAdmitted: 4 });
    expect(await rowCounts()).toEqual({ units: 0, links: 0 });

    const first = await admit(false);
    expect(first).toMatchObject({ dryRun: false, seriesRevisionsAdmitted: 1, linksAdmitted: 4 });
    expect(first.relatedSkipped.find((entry) => entry.from === 'greenhouse')).toEqual({
      from: 'greenhouse',
      to: 'greenhouse-limits',
      unpublished: ['greenhouse-limits'],
    });
    expect(await rowCounts()).toEqual({ units: 3, links: 4 });

    const second = await admit(false);
    expect(second).toMatchObject({ seriesRevisionsAdmitted: 0, linksAdmitted: 0, linksUnchanged: 4 });
    expect(await rowCounts()).toEqual({ units: 3, links: 4 });

    // A recipe published later is picked up by the next run, and only what is new is written.
    await publishRecipe(cases, 'greenhouse-limits');
    expect(await admit(false)).toMatchObject({ seriesRevisionsAdmitted: 0, linksAdmitted: 1 });
    expect(await rowCounts()).toEqual({ units: 3, links: 5 });

    // Navigation offers the Part and Related moves from the exposure of the middle Part.
    const person = await seedPerson(database.db);
    const opened = ready(
      await cases.navigate(person.authority, {
        commandId: randomUUID(),
        target: { kind: 'return', ...hemispheres },
        capabilities: textCapabilities,
      }),
    );
    const activated = await cases.activateOffer(person.authority, {
      commandId: randomUUID(),
      target: {
        kind: 'offer',
        sessionId: opened.sessionId,
        offerId: opened.offer.offerId,
        expectedIntentRevision: opened.intentRevision,
      },
    });
    if (activated.kind !== 'accepted') throw new Error('expected activation');
    const read = await cases.readContext(person.authority, activated.outcome.exposureId);
    if (read.kind !== 'read') throw new Error('expected a context');
    const { series, continuations } = read.context;
    // The total is counted from the admitted series units (D-072), here the three Seasons parts.
    expect(series).toMatchObject({ seriesId: 'library.earth.seasons', part: 2, total: 3 });
    expect(continuations.seriesPrevious).toMatchObject({
      status: 'ready',
      target: seasons,
      relation: { kind: 'series_step', part: 1 },
    });
    expect(continuations.seriesNext).toMatchObject({
      status: 'ready',
      target: elsewhere,
      relation: { kind: 'series_step', part: 3 },
    });
    // seasons-hemispheres declares no related move, and the response carries no count but the series total.
    expect(continuations.related).toMatchObject({ status: 'unavailable' });
    expect(JSON.stringify(read.context)).not.toMatch(/"(count|partCount)/u);
  });

  it('replaces a link when a Scroll is republished, keeping the old rows as history', async () => {
    const before = await rowCounts();
    const source = starterSource() as {
      assetId: string;
      publication: { explanationUnitId: string };
      draft: { title: string };
    };
    source.assetId = RECIPES['seasons-hemispheres'].assetId;
    source.publication.explanationUnitId = 'ci-library-continuity-seasons-hemispheres';
    source.draft.title = 'CI fixture corrected hemispheres';
    expect(await cases.importScroll(source)).toMatchObject({ kind: 'imported', revision: 2 });

    const summary = await admit(false);
    expect(summary).toMatchObject({ seriesRevisionsAdmitted: 1, linksAdmitted: 4 });
    const after = await rowCounts();
    expect(after).toEqual({ units: before.units + 3, links: before.links + 4 });
    // Two links moved to the new revision (the first part's next, the last part's previous); the old
    // revision's own links stay active for the old revision.
    const retired = await database.db
      .selectFrom('content.continuity_links')
      .select('id')
      .where('active', '=', false)
      .execute();
    expect(retired).toHaveLength(2);
    expect(await admit(false)).toMatchObject({ seriesRevisionsAdmitted: 0, linksAdmitted: 0 });
  });
});
