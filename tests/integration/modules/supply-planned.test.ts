import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_V1_CAPABILITIES } from '@knowscroll/scroll-model';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import type { PlannedDemandInput } from '@knowscroll/backend/modules/supply';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson } from '../support/fixtures.js';
import { realSupply } from '../support/planned-demand.js';
import { scrollUseCases, starterSource } from '../support/scroll.js';
import { markLibraryV1 } from '../support/scroll-v2.js';

/** Authored CI content and real PostgreSQL: the Planner's entry into Supply, which commissions production jobs but runs none. */
describe('Supply planned demand (real PostgreSQL, authored CI content)', () => {
  // Create commissions only v1 recipes (D-138): this file tests the Planner's demand on the v1 library.
  const restoreLibrary = markLibraryV1();
  afterAll(restoreLibrary);
  let database: TestDatabase<Database>, content: Awaited<ReturnType<typeof scrollUseCases>>;
  let supply: ReturnType<typeof realSupply>;
  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
  const capabilities = { ...FULL_V1_CAPABILITIES, documentSchemas: ['scroll-document.v1', 'reel-document.v1'] };
  beforeAll(async () => {
    database = await createTestDatabase<Database>('supply_planned');
    content = await scrollUseCases(database);
    supply = realSupply(database, content.boss, { createDailyCap: 10, readExploration: content.readExploration });
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

  it('commissions nothing, and stores nothing, when Create is off or has no recipe left', async () => {
    const off = realSupply(database, content.boss, { readExploration: content.readExploration });
    const person = await seedPerson(database.db);
    const recordWith = (record: typeof supply.record, input: PlannedDemandInput) =>
      withScope()(person.authority, (scope) => record(scope, input)).then((result) => {
        if (result.kind !== 'entered') throw new Error('CI scope refused');
        return result.value;
      });
    expect(await recordWith(off.record, demandInput(['space.exoplanets']))).toEqual({ kind: 'not_commissioned' });
    // A Reel cannot be produced at all, whatever the cap.
    expect(await recordWith(supply.record, demandInput(['space.exoplanets'], { format: 'reel' }))).toEqual({
      kind: 'not_commissioned',
    });
    expect(await rows(person.universeId)).toHaveLength(0);
    expect((await database.pool.query("select id from pgboss.job where name='content.produce-scroll'")).rows).toEqual(
      [],
    );
  });

  it('defers demand with no content to fit on a shared group, starts one production job, and a second person joins it', async () => {
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
    // Create committed the group's one production job with the first plan; each waiter has its own resolver job.
    const work = await database.db
      .selectFrom('supply.work')
      .select('production_recipe')
      .where('id', '=', rowA!.work_id!)
      .executeTakeFirstOrThrow();
    expect(work.production_recipe).toBe('tides');
    const produced = await database.pool.query("select id from pgboss.job where name='content.produce-scroll'");
    expect(produced.rows).toHaveLength(1);
    const resolvers = await database.pool.query(
      "select data from pgboss.job where name='supply.resolve-request' and data->>'universeId' = any($1)",
      [[first.universeId, second.universeId]],
    );
    expect(resolvers.rows).toHaveLength(2);
    // A deferred demand reads as preparing, and the person can still withdraw it.
    expect(await supply.read(first.authority, { requestId: rowA!.id })).toMatchObject({
      kind: 'ok',
      value: { status: 'preparing', phase: 'preparing' },
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
    const unread = await admit('machine-learning.transformers');
    const person = await seedPerson(database.db);
    expect(await record(person, demandInput(['machine-learning.transformers']))).toMatchObject({ kind: 'ready' });
    expect((await rows(person.universeId))[0]).toMatchObject({
      origin: 'planner',
      state: 'ready',
      decision: 'reuse',
      content: { assetId: unread.assetId },
    });
    const met = await seedPerson(database.db);
    expect(
      await record(met, demandInput(['machine-learning.transformers'], { alreadyMet: [unread.unit] })),
    ).toMatchObject({
      kind: 'deferred',
    });
    // The first catalogue topic that the brief admits names it; later topics do not matter.
    const mixed = await seedPerson(database.db);
    await record(mixed, demandInput(['ci.unknown', 'earth.tides']));
    expect((await rows(mixed.universeId))[0]!.brief).toMatchObject({ subject: { topicId: 'earth.tides' } });
  });

  it('adds nothing when an earlier plan already asked for the same brief, whichever way it was answered', async () => {
    const waiting = await seedPerson(database.db);
    const first = await record(waiting, demandInput(['earth.tides']));
    expect(first).toMatchObject({ kind: 'deferred' });
    // A later plan revision (a new run, any slot) proposes the same missing topic.
    expect(await record(waiting, demandInput(['earth.tides'], { slot: 2 }))).toEqual({
      kind: 'already_recorded',
      requestId: (first as { requestId: string }).requestId,
    });
    expect(await rows(waiting.universeId)).toHaveLength(1);
    // A different brief is a different demand; a closed one no longer counts. Its group chooses the same
    // recipe, so there is still only one production job for it.
    const productionJobs = () =>
      database.pool.query("select id from pgboss.job where name='content.produce-scroll'").then((r) => r.rows.length);
    const producedBefore = await productionJobs();
    expect(await record(waiting, demandInput(['earth.tides'], { format: 'either' }))).toMatchObject({
      kind: 'deferred',
    });
    expect(await productionJobs()).toBe(producedBefore);
    expect(await rows(waiting.universeId)).toHaveLength(2);
    const scrollRow = (await rows(waiting.universeId)).find((r) => (r.brief as { format: string }).format === 'scroll');
    await supply.cancel(waiting.authority, {
      version: 'content-request-cancel.v1',
      commandId: randomUUID(),
      requestId: scrollRow!.id,
    });
    expect(await record(waiting, demandInput(['earth.tides']))).toMatchObject({ kind: 'deferred' });
    // Reuse is deduplicated the same way while the content is still there.
    await admit('earth.greenhouse-effect');
    const reuse = await seedPerson(database.db);
    const ready = await record(reuse, demandInput(['earth.greenhouse-effect']));
    expect(ready).toMatchObject({ kind: 'ready' });
    expect(await record(reuse, demandInput(['earth.greenhouse-effect'], { slot: 1 }))).toMatchObject({
      kind: 'already_recorded',
    });
    expect(await rows(reuse.universeId)).toHaveLength(1);
  });

  it('the database refuses a second open planned waiter on the same group even if code did not check', async () => {
    const person = await seedPerson(database.db);
    await record(person, demandInput(['earth.tides']));
    const [row] = await rows(person.universeId);
    await expect(
      database.db
        .insertInto('supply.requests')
        .values({ ...row!, id: randomUUID(), planner_run_id: randomUUID(), planner_slot: 0 })
        .execute(),
    ).rejects.toThrow(/supply_requests_planner_open_work/);
  });

  it('keeps one demand per opportunity slot of a run', async () => {
    const person = await seedPerson(database.db);
    const input = demandInput(['earth.tides']);
    await record(person, input);
    await expect(record(person, { ...input, topicIds: ['machine-learning.transformers'] })).rejects.toThrow();
  });
});
