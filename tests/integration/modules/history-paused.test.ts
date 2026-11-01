import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportCurrentPerson } from '@knowscroll/backend/erasure-registry';
import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { dataExportFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { hasActivatedExposure, readVisitedAssets } from '@knowscroll/backend/modules/experience/nest-providers';
import type { NavigationOutcome } from '@knowscroll/contracts';
import { openToEveryone } from '../support/audience.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import type { FixturePerson } from '../support/fixtures.js';
import { recordingPerson, setRecording } from '../support/recording-person.js';
import { scrollUseCases, starterSource, textCapabilities } from '../support/scroll.js';

/**
 * What a person opens while recording is paused stays out of their History (D-284), on real PostgreSQL. The exposure is
 * still written, because it serves the item the person has open; the export's encounter list and the reads that say what
 * a person has opened leave it out, and a resume brings the list back to growing. Evidence label: CI fixture accounts and
 * authored fixtures, real database.
 */
type Cases = Awaited<ReturnType<typeof scrollUseCases>>;
type Ready = Extract<NavigationOutcome, { status: 'ready' }>;

describe('History while recording is paused (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let boss: ReturnType<typeof createBoss>;
  let cases: Cases;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('history_paused');
    boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
    await boss.start();
    cases = await scrollUseCases(database, { recording: true });
  });
  afterAll(async () => {
    await cases.close();
    await boss.stop({ graceful: false });
    await database.drop();
  });

  async function importScroll(): Promise<{ assetId: string }> {
    const source = starterSource() as { assetId: string; publication: { explanationUnitId: string } };
    source.assetId = randomUUID();
    source.publication.explanationUnitId = `history-paused-${randomUUID()}`;
    const imported = await cases.importScroll(source);
    if (imported.kind !== 'imported') throw new Error('fixture admission refused');
    return { assetId: imported.assetId };
  }

  function ready(result: Awaited<ReturnType<Cases['navigate']>>): Ready {
    if (result.kind !== 'accepted' || result.outcome.status !== 'ready') throw new Error('fixture expected ready');
    return result.outcome;
  }

  /** The way Explore opens an item: a Composer session, then an offer's activation, at the generation the device holds. */
  async function exploreOpen(person: FixturePerson, recordingGeneration: number) {
    const offered = ready(
      await cases.navigate(person.authority, {
        commandId: randomUUID(),
        target: { kind: 'discover' },
        capabilities: textCapabilities,
        recordingGeneration,
      }),
    );
    const activated = await cases.activateOffer(person.authority, {
      commandId: randomUUID(),
      target: {
        kind: 'offer',
        sessionId: offered.sessionId,
        offerId: offered.offer.offerId,
        expectedIntentRevision: offered.intentRevision,
      },
      recordingGeneration,
    });
    if (activated.kind !== 'accepted') throw new Error('activation refused');
    return { assetId: offered.offer.assetId, exposureId: activated.outcome.exposureId };
  }

  /** The way an address opens an item (`/scroll/<id>`): a direct open, then a direct activation. */
  async function directOpen(
    person: FixturePerson,
    recordingGeneration: number,
    beforeActivation?: () => Promise<void>,
  ) {
    const { assetId } = await importScroll();
    const opened = await cases.openExposure(person.authority, {
      commandId: randomUUID(),
      target: { kind: 'scroll', assetId },
      origin: { kind: 'direct' },
      capabilities: textCapabilities,
    });
    if (opened.kind !== 'opened') throw new Error('open refused');
    await beforeActivation?.();
    const activated = await cases.activateExposure(person.authority, {
      commandId: randomUUID(),
      exposureId: opened.outcome.exposureId,
      recordingGeneration,
    });
    if (activated.kind !== 'activated') throw new Error('activation refused');
    return { assetId, exposureId: opened.outcome.exposureId };
  }

  /** The "encounters" list of a real export file, as the person would download it. */
  async function encountersInExport(person: FixturePerson) {
    const use = dataExportFor(database.db, boss, {
      gather: (scope, who) => exportCurrentPerson(scope, who, openToEveryone),
      lockTimeoutMs: 5_000,
    });
    const exportId = randomUUID();
    const accepted = await use.request(person.authority, { exportId });
    if (accepted.kind !== 'accepted') throw new Error('export refused');
    expect(await use.build({ v: 1, exportId })).toBe('built');
    const link = await use.mintLink(person.authority, { exportId });
    if (link.kind !== 'link') throw new Error('no link');
    const file = await use.consume(link.token);
    if (file.kind !== 'file') throw new Error('no file');
    const parsed = JSON.parse(new TextDecoder().decode(file.bytes)) as {
      sections: { experience?: { encounters: { items: { title: string; openedAt: string }[] } } };
    };
    return parsed.sections.experience?.encounters.items ?? [];
  }

  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
  async function visited(person: FixturePerson, assetIds: readonly string[]) {
    const read = await withScope()(person.authority, (scope) => readVisitedAssets(scope, assetIds));
    if (read.kind !== 'entered') throw new Error('scope refused');
    return read.value;
  }
  async function servesItem(person: FixturePerson, assetId: string) {
    const read = await withScope()(person.authority, (scope) => hasActivatedExposure(scope, assetId, 1));
    if (read.kind !== 'entered') throw new Error('scope refused');
    return read.value;
  }
  const exposuresOf = (person: FixturePerson) =>
    database.db
      .selectFrom('experience.exposures')
      .select(['asset_id', 'made_while_paused', 'activated_at'])
      .where('universe_id', '=', person.universeId)
      .execute();

  it('adds nothing to the export while paused, and one entry for the next item after a resume', async () => {
    const person = await recordingPerson(database);
    for (let index = 0; index < 5; index++) await importScroll();

    const first = await exploreOpen(person, 1);
    const before = await encountersInExport(person);
    expect(before).toHaveLength(1);

    await setRecording(database, person, 1, false);
    const whilePaused = [
      await exploreOpen(person, 2),
      await exploreOpen(person, 2),
      await exploreOpen(person, 2),
      await directOpen(person, 2),
    ];

    // The items opened while paused are real and activated, so they still serve what the person has open.
    const rows = await exposuresOf(person);
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.activated_at !== null)).toBe(true);
    expect(rows.filter((row) => row.made_while_paused).map((row) => row.asset_id)).toEqual(
      expect.arrayContaining(whilePaused.map((item) => item.assetId)),
    );
    expect(rows.filter((row) => !row.made_while_paused).map((row) => row.asset_id)).toEqual([first.assetId]);
    for (const item of whilePaused) expect(await servesItem(person, item.assetId)).toBe(true);

    // The history is exactly as it was, in the export and in the reads that say what a person has opened.
    expect(await encountersInExport(person)).toEqual(before);
    expect([...(await visited(person, [first.assetId, ...whilePaused.map((item) => item.assetId)]))]).toEqual([
      first.assetId,
    ]);

    await setRecording(database, person, 2, true);
    const resumed = await exploreOpen(person, 3);
    const after = await encountersInExport(person);
    expect(after).toHaveLength(2);
    expect((await visited(person, [resumed.assetId])).has(resumed.assetId)).toBe(true);
    expect((await exposuresOf(person)).filter((row) => row.made_while_paused)).toHaveLength(4);
  });

  it('marks a direct open that is activated while paused, and keeps the mark after a resume', async () => {
    const person = await recordingPerson(database);
    const pauseBetween = () => setRecording(database, person, 1, false);
    const item = await directOpen(person, 2, pauseBetween);
    await setRecording(database, person, 2, true);

    expect((await exposuresOf(person)).find((row) => row.asset_id === item.assetId)).toMatchObject({
      made_while_paused: true,
    });
    expect(await encountersInExport(person)).toEqual([]);
    expect((await visited(person, [item.assetId])).size).toBe(0);
    expect(await servesItem(person, item.assetId)).toBe(true);
  });

  it('keeps an item opened while recording was on in History through a pause and a resume', async () => {
    const person = await recordingPerson(database);
    await importScroll();
    const opened = await exploreOpen(person, 1);
    await setRecording(database, person, 1, false);
    await setRecording(database, person, 2, true);

    expect((await exposuresOf(person)).find((row) => row.asset_id === opened.assetId)).toMatchObject({
      made_while_paused: false,
    });
    expect(await encountersInExport(person)).toHaveLength(1);
  });
});
