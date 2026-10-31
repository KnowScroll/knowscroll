import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { admitLibraryContinuityUseCase } from '@knowscroll/backend/modules/content/nest-providers';
import type { NavigationOutcome } from '@knowscroll/contracts';
import { RECIPES, type RecipeKey } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { scrollUseCases, starterSource, textCapabilities } from '../support/scroll.js';

/**
 * "Resume Part 2 of 3" on the Universe (v3 S-4, D-215): the next Part of a series the person has
 * started and not yet opened, read from their own openings only. Labelled CI fixtures on real
 * PostgreSQL: the Scrolls are the starter document under the recipes' identities, and the Seasons
 * series is admitted by the real `admit-continuity`. Nothing here is generated content.
 */
type Cases = Awaited<ReturnType<typeof scrollUseCases>>;
type Ready = Extract<NavigationOutcome, { status: 'ready' }>;

function ready(result: Awaited<ReturnType<Cases['navigate']>>): Ready {
  expect(result).toMatchObject({ kind: 'accepted', outcome: { status: 'ready' } });
  if (result.kind !== 'accepted' || result.outcome.status !== 'ready') throw new Error('CI fixture expected ready');
  return result.outcome;
}

describe('Resume on the Universe (real PostgreSQL, labelled CI fixtures)', () => {
  let database: TestDatabase<Database>;
  let cases: Cases;
  const parts: Record<'one' | 'two' | 'three', { assetId: string; assetRevision: number }> = {} as never;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('universe_resume');
    cases = await scrollUseCases(database);
    const publish = async (key: RecipeKey) => {
      const source = starterSource() as { assetId: string; publication: { explanationUnitId: string } };
      source.assetId = RECIPES[key].assetId;
      source.publication.explanationUnitId = `ci-resume-${key}`;
      const imported = await cases.importScroll(source);
      if (imported.kind !== 'imported') throw new Error(`fixture admission refused for ${key}`);
      await database.db
        .insertInto('content.encounter_topics')
        .values({
          asset_id: imported.assetId,
          asset_revision: 1,
          topic_id: 'earth.seasons',
          role: 'primary',
          weight: 1,
        })
        .execute();
      return { assetId: imported.assetId, assetRevision: imported.revision };
    };
    parts.one = await publish('seasons');
    parts.two = await publish('seasons-hemispheres');
    parts.three = await publish('seasons-elsewhere');
    await publish('seasons-limits');
    expect(await admitLibraryContinuityUseCase(database.db)({ dryRun: false })).toMatchObject({
      seriesRevisionsAdmitted: 1,
    });
  });
  afterAll(async () => {
    await cases.close();
    await database.drop();
  });

  /** Opens the exact Scroll as the person's own reading, and activates it: they have been on it. */
  async function readPart(person: FixturePerson, target: { assetId: string; assetRevision: number }) {
    const open = ready(
      await cases.navigate(person.authority, {
        commandId: randomUUID(),
        target: { kind: 'return', ...target },
        capabilities: textCapabilities,
      }),
    );
    const activated = await cases.activateOffer(person.authority, {
      commandId: randomUUID(),
      target: {
        kind: 'offer',
        sessionId: open.sessionId,
        offerId: open.offer.offerId,
        expectedIntentRevision: open.intentRevision,
      },
    });
    expect(activated.kind).toBe('accepted');
  }
  const resumeOf = async (person: FixturePerson) => {
    const result = await cases.readResume(person.authority);
    if (result.kind !== 'read') throw new Error('CI expected a read');
    return result.resume;
  };

  it('offers nothing to a person who has opened nothing', async () => {
    expect(await resumeOf(await seedPerson(database.db))).toBeNull();
  });

  it('offers the next Part of the series after Part 1, counted from the admitted series, then Part 3, then nothing', async () => {
    const person = await seedPerson(database.db);
    await readPart(person, parts.one);
    expect(await resumeOf(person)).toEqual({
      assetId: parts.two.assetId,
      title: expect.any(String) as string,
      part: 2,
      total: 3,
    });
    await readPart(person, parts.two);
    expect(await resumeOf(person)).toMatchObject({ assetId: parts.three.assetId, part: 3, total: 3 });
    // The last Part has no next one, and a Part the person has opened is not offered again.
    await readPart(person, parts.three);
    expect(await resumeOf(person)).toBeNull();
  });

  it("is the person's own reading only: another person reading on never moves it or makes one", async () => {
    const mine = await seedPerson(database.db);
    const other = await seedPerson(database.db);
    await readPart(mine, parts.one);
    expect(await resumeOf(other)).toBeNull();
    // Someone else reaching Part 3 changes nothing about where I would pick up.
    await readPart(other, parts.one);
    await readPart(other, parts.two);
    await readPart(other, parts.three);
    expect(await resumeOf(mine)).toMatchObject({ assetId: parts.two.assetId, part: 2 });
    expect(await resumeOf(other)).toBeNull();
  });

  it('looks only at the own openings of the caller: nine later openings by someone else do not crowd it out', async () => {
    const mine = await seedPerson(database.db);
    const crowd = await seedPerson(database.db);
    await readPart(mine, parts.one);
    // The query takes the newest eight openings; nine newer ones in another universe must not take their place.
    for (let opening = 0; opening < 9; opening++) await readPart(crowd, parts.one);
    expect(await resumeOf(mine)).toMatchObject({ assetId: parts.two.assetId, part: 2, total: 3 });
  });

  it('does not offer a Part after a long absence, and a Scroll the person opened only once is not "resumed" beyond the window', async () => {
    const person = await seedPerson(database.db);
    await readPart(person, parts.one);
    expect(await resumeOf(person)).not.toBeNull();
    await sql`update experience.exposures set activated_at = now() - interval '40 days'
      where universe_id = ${person.universeId}::uuid`.execute(database.db);
    expect(await resumeOf(person)).toBeNull();
  });

  it('is a read: it writes no exposure, receipt or revision', async () => {
    const person = await seedPerson(database.db);
    await readPart(person, parts.one);
    const count = async () =>
      (
        await sql<{ exposures: number; receipts: number; revision: number }>`
          select (select count(*) from experience.exposures where universe_id = ${person.universeId}::uuid)::int as exposures,
                 (select count(*) from receipts.personal_commands where universe_id = ${person.universeId}::uuid)::int as receipts,
                 (select revision from identity.universes where id = ${person.universeId}::uuid)::int as revision`.execute(
          database.db,
        )
      ).rows[0];
    const before = await count();
    await resumeOf(person);
    await resumeOf(person);
    expect(await count()).toEqual(before);
  });
});
