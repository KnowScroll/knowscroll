import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_V1_CAPABILITIES } from '@knowscroll/scroll-model';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import type { PlannedDemandInput } from '@knowscroll/backend/modules/supply';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson } from '../support/fixtures.js';
import { realSupply } from '../support/planned-demand.js';
import { scrollUseCases, starterSource } from '../support/scroll.js';

/** Authored CI content and real PostgreSQL: the Planner's entry into Supply, without a provider or a production run. */
describe('Supply planned demand (real PostgreSQL, authored CI content)', () => {
  let database: TestDatabase<Database>, content: Awaited<ReturnType<typeof scrollUseCases>>;
  let supply: ReturnType<typeof realSupply>;
  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
  const capabilities = { ...FULL_V1_CAPABILITIES, documentSchemas: ['scroll-document.v1', 'reel-document.v1'] };
  beforeAll(async () => {
    database = await createTestDatabase<Database>('supply_planned');
    content = await scrollUseCases(database);
    supply = realSupply(database, content.boss);
  });
  afterAll(async () => {
    await content.close();
    await database.drop();
  });

  async function admit(topicId: string) {
    const source = starterSource() as { assetId: string; publication: { explanationUnitId: string } };
    source.assetId = randomUUID();
    source.publication.explanationUnitId = `ci-planned-${randomUUID()}`;
    const imported = await content.importScroll(source);
    if (imported.kind !== 'imported') throw new Error('CI fixture admission refused');
    await database.db
      .insertInto('content.encounter_topics')
      .values({
        asset_id: imported.assetId,
        asset_revision: imported.revision,
        topic_id: topicId,
        role: 'primary',
        weight: 1,
      })
      .execute();
    return { assetId: imported.assetId, unit: source.publication.explanationUnitId };
  }
  const demandInput = (topicIds: string[], overrides: Partial<PlannedDemandInput> = {}): PlannedDemandInput => ({
    plannerRunId: randomUUID(),
    slot: 0,
    topicIds,
    format: 'scroll',
    language: 'en',
    capabilities,
    alreadyMet: [],
    ...overrides,
  });
  const record = (person: Awaited<ReturnType<typeof seedPerson>>, input: PlannedDemandInput) =>
    withScope()(person.authority, (scope) => supply.record(scope, input)).then((result) => {
      if (result.kind !== 'entered') throw new Error('CI scope refused');
      return result.value;
    });
  const rows = (universeId: string) =>
    database.db.selectFrom('supply.requests').selectAll().where('universe_id', '=', universeId).execute();

  it('records nothing for a topic the catalogue does not admit', async () => {
    const person = await seedPerson(database.db);
    expect(await record(person, demandInput(['ci.not-in-the-catalogue']))).toEqual({ kind: 'unsupported' });
    expect(await record(person, demandInput(['earth.tides'], { language: 'fr' }))).toEqual({ kind: 'unsupported' });
    expect(await rows(person.universeId)).toHaveLength(0);
  });

  it('defers demand with no content to fit on a shared group that a second person joins, with no job and no production', async () => {
    const first = await seedPerson(database.db),
      second = await seedPerson(database.db);
    const a = await record(first, demandInput(['earth.tides']));
    const b = await record(second, demandInput(['earth.tides']));
    expect(a).toMatchObject({ kind: 'deferred', joined: false });
    expect(b).toMatchObject({ kind: 'deferred', joined: true });
    const [rowA] = await rows(first.universeId),
      [rowB] = await rows(second.universeId);
    expect(rowA).toMatchObject({ origin: 'planner', state: 'deferred', decision: 'create', planner_slot: 0 });
    expect(rowB).toMatchObject({ origin: 'planner', state: 'deferred', decision: 'join' });
    expect(rowA!.work_id).toBe(rowB!.work_id);
    const jobs = await database.pool.query("select id from pgboss.job where name='supply.resolve-request'");
    expect(jobs.rows).toHaveLength(0);
    // A deferred demand reads as preparing, and the person can still withdraw it.
    expect(await supply.read(first.authority, { requestId: rowA!.id })).toMatchObject({
      kind: 'ok',
      value: { status: 'preparing', phase: 'requested' },
    });
    expect(
      await supply.cancel(first.authority, {
        version: 'content-request-cancel.v1',
        commandId: randomUUID(),
        requestId: rowA!.id,
      }),
    ).toMatchObject({ kind: 'ok', value: { outcome: 'cancelled' } });
    expect((await rows(first.universeId))[0]).toMatchObject({ state: 'cancelled' });
  });

  it('reuses admitted content the person has not met, and defers when they have met all of it', async () => {
    const unread = await admit('earth.seasons');
    const person = await seedPerson(database.db);
    expect(await record(person, demandInput(['earth.seasons']))).toMatchObject({ kind: 'ready' });
    expect((await rows(person.universeId))[0]).toMatchObject({
      origin: 'planner',
      state: 'ready',
      decision: 'reuse',
      content: { assetId: unread.assetId },
    });
    const met = await seedPerson(database.db);
    expect(await record(met, demandInput(['earth.seasons'], { alreadyMet: [unread.unit] }))).toMatchObject({
      kind: 'deferred',
    });
    // The first catalogue topic that the brief admits names it; later topics do not matter.
    const mixed = await seedPerson(database.db);
    await record(mixed, demandInput(['ci.unknown', 'earth.tides']));
    expect((await rows(mixed.universeId))[0]!.brief).toMatchObject({ subject: { topicId: 'earth.tides' } });
  });

  it('keeps one demand per opportunity slot', async () => {
    const person = await seedPerson(database.db);
    const input = demandInput(['earth.tides']);
    await record(person, input);
    await expect(record(person, input)).rejects.toThrow();
  });
});
