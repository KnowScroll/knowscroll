import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_V1_CAPABILITIES } from '@knowscroll/scroll-model';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import type { PlannedDemandInput } from '@knowscroll/backend/modules/supply';
import { expireStalePlannedDemand } from '@knowscroll/backend/modules/supply/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson } from '../support/fixtures.js';
import { plannedIntent, realSupply } from '../support/planned-demand.js';
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
    intent: plannedIntent(),
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
    expect(await record(person, demandInput(['ci.not-in-the-catalogue']))).toEqual({
      kind: 'unsupported',
      reason: 'topic_not_in_catalogue',
    });
    expect(await record(person, demandInput(['earth.tides'], { language: 'fr' }))).toEqual({
      kind: 'unsupported',
      reason: 'language_not_supported',
    });
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
    expect(await recordWith(off.record, demandInput(['space.exoplanets']))).toEqual({
      kind: 'not_commissioned',
      reason: 'create_off',
    });
    // A Reel cannot be produced at all, whatever the cap.
    expect(await recordWith(supply.record, demandInput(['space.exoplanets'], { format: 'reel' }))).toEqual({
      kind: 'not_commissioned',
      reason: 'no_production_path',
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
      open: 'deferred',
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
  /** The outcome counters as `outcome/reason` (or `outcome`) to count, summed over days. */
  const counters = async () => {
    const counted: Record<string, number> = {};
    for (const row of await database.db.selectFrom('supply.planned_demand_outcomes').selectAll().execute()) {
      const key = row.reason === '' ? row.outcome : `${row.outcome}/${row.reason}`;
      counted[key] = (counted[key] ?? 0) + Number(row.total);
    }
    return counted;
  };
  const count = (person: Awaited<ReturnType<typeof seedPerson>>, outcomes: Awaited<ReturnType<typeof record>>[]) =>
    withScope()(person.authority, (scope) => supply.count(scope, outcomes)).then((result) => {
      if (result.kind !== 'entered') throw new Error('CI scope refused');
    });
  const growth = (before: Record<string, number>, after: Record<string, number>) =>
    Object.fromEntries(
      Object.entries(after)
        .map(([key, total]) => [key, total - (before[key] ?? 0)] as const)
        .filter(([, added]) => added !== 0),
    );
  /** Moves a demand's wait back in time, as if it had been waiting that many minutes. */
  const ageRow = (id: string, minutes: number) =>
    sql`update supply.requests set created_at = now() - make_interval(mins => ${minutes}),
      updated_at = now() - make_interval(mins => ${minutes}) where id = ${id}::uuid`.execute(database.db);

  it('counts every outcome of a plan by outcome and reason, naming no person, topic or words', async () => {
    await admit('space.black-holes');
    const off = realSupply(database, content.boss, { readExploration: content.readExploration });
    const person = await seedPerson(database.db),
      other = await seedPerson(database.db);
    const before = await counters();
    const outcomes = [
      await record(person, demandInput(['ci.not-in-the-catalogue'])),
      await record(person, demandInput(['earth.seasons'], { language: 'fr' })),
      await record(person, demandInput(['earth.seasons'], { format: 'reel' })),
      await withScope()(person.authority, (scope) => off.record(scope, demandInput(['earth.seasons']))).then((r) => {
        if (r.kind !== 'entered') throw new Error('CI scope refused');
        return r.value;
      }),
      await record(person, demandInput(['space.black-holes'])),
      await record(person, demandInput(['earth.seasons'], { slot: 1 })),
      await record(other, demandInput(['earth.seasons'])),
      await record(person, demandInput(['earth.seasons'], { slot: 2 })),
    ];
    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      'unsupported',
      'unsupported',
      'not_commissioned',
      'not_commissioned',
      'ready',
      'deferred',
      'deferred',
      'already_recorded',
    ]);
    await count(person, outcomes);
    expect(growth(before, await counters())).toEqual({
      'unsupported/topic_not_in_catalogue': 1,
      'unsupported/language_not_supported': 1,
      'not_commissioned/no_production_path': 1,
      'not_commissioned/create_off': 1,
      reused: 1,
      commissioned: 1,
      joined: 1,
      'already_recorded/waiting': 1,
    });
    // The table has a day, a code, a reason and a count: nothing that could name a person, a topic or a word.
    expect(
      Object.keys((await database.db.selectFrom('supply.planned_demand_outcomes').selectAll().executeTakeFirst())!),
    ).toEqual(['day', 'outcome', 'reason', 'total']);
  });

  it('adds nothing to the counters for a plan with no missing-supply opportunity', async () => {
    const person = await seedPerson(database.db);
    const before = await counters();
    await count(person, []);
    expect(await counters()).toEqual(before);
  });

  it("adds to a day's counters one plan after another, and the database refuses a code it does not know", async () => {
    const person = await seedPerson(database.db);
    const before = await counters();
    await count(person, [{ kind: 'unsupported', reason: 'topic_not_in_catalogue' }]);
    await count(person, [{ kind: 'unsupported', reason: 'topic_not_in_catalogue' }]);
    expect(growth(before, await counters())).toEqual({ 'unsupported/topic_not_in_catalogue': 2 });
    await expect(
      database.db
        .insertInto('supply.planned_demand_outcomes')
        .values({ day: new Date(), outcome: 'not_commissioned', reason: 'a_reason_nobody_declared', total: 1 })
        .execute(),
    ).rejects.toThrow(/planned_demand_outcomes_codes/);
  });

  it("keeps what the model wanted on the person's own demand row and nowhere else", async () => {
    const intentA = plannedIntent({
      move: 'example',
      explanationUnitId: 'ci-unit-a',
      brief: 'CI-PLANNED-BRIEF-A for a',
    });
    const intentB = plannedIntent({
      move: 'limitation',
      explanationUnitId: 'ci-unit-b',
      brief: 'CI-PLANNED-BRIEF-B for b',
    });
    const a = await seedPerson(database.db),
      b = await seedPerson(database.db);
    await record(a, demandInput(['space.stars'], { intent: intentA }));
    await record(b, demandInput(['space.stars'], { intent: intentB }));
    const [rowA] = await rows(a.universeId),
      [rowB] = await rows(b.universeId);
    expect(rowA!.planned_intent).toEqual(intentA);
    expect(rowB!.planned_intent).toEqual(intentB);
    // Both waited on one shared group, and neither person's words are in it, in the canonical brief or in the command.
    expect(rowA!.work_id).toBe(rowB!.work_id);
    const group = await database.db
      .selectFrom('supply.work')
      .selectAll()
      .where('id', '=', rowA!.work_id!)
      .executeTakeFirstOrThrow();
    for (const shared of [JSON.stringify(group), JSON.stringify(rowA!.command), JSON.stringify(rowA!.brief)])
      expect(shared).not.toContain('CI-PLANNED-BRIEF');
    // A person's own ask never carries one: the database refuses it.
    await expect(
      database.db
        .insertInto('supply.requests')
        .values({
          ...rowA!,
          id: randomUUID(),
          origin: 'person',
          planner_run_id: null,
          planner_slot: null,
          state: 'requested',
        })
        .execute(),
    ).rejects.toThrow(/supply_requests_planned_intent/);
  });

  it("keeps a plan whole when the model's brief holds text the database cannot store", async () => {
    const person = await seedPerson(database.db);
    const awkward = await record(
      person,
      demandInput(['space.stars'], { intent: plannedIntent({ brief: 'CI-PLANNED-BRIEF a\u0000b \uD800 end' }) }),
    );
    expect(awkward).toMatchObject({ kind: 'deferred' });
    const [stored] = await rows(person.universeId);
    expect(stored!.planned_intent).toMatchObject({ brief: 'CI-PLANNED-BRIEF ab \uFFFD end' });

    // Control characters escape to six bytes each: the brief is cut to fit the column, and the plan still stands.
    const heavy = await seedPerson(database.db);
    const outcome = await record(
      heavy,
      demandInput(['space.stars'], { intent: plannedIntent({ brief: '\u0001'.repeat(800) }) }),
    );
    expect(outcome).toMatchObject({ kind: 'deferred' });
    const [cut] = await sql<{ chars: number; bytes: number }>`select char_length(planned_intent->>'brief') as chars,
      octet_length(planned_intent::text) as bytes from supply.requests where universe_id = ${heavy.universeId}::uuid`
      .execute(database.db)
      .then((result) => result.rows);
    expect(cut!.chars).toBeLessThan(800);
    expect(cut!.bytes).toBeLessThanOrEqual(4096);

    // An intent that fails its schema is left out; the demand is still recorded.
    const bare = await seedPerson(database.db);
    const malformed = plannedIntent({ move: 'Not A Move' });
    expect(await record(bare, demandInput(['space.stars'], { intent: malformed }))).toMatchObject({ kind: 'deferred' });
    expect((await rows(bare.universeId))[0]!.planned_intent).toBeNull();
  });

  it('closes planned demand left waiting past the limit, so it stops blocking the next plan', async () => {
    const person = await seedPerson(database.db);
    const first = await record(person, demandInput(['space.stars']));
    expect(first).toMatchObject({ kind: 'deferred' });
    const firstId = (first as { requestId: string }).requestId;
    // Past the wait limit but inside the grace: a live resolver closes it at its next look, so it is left alone.
    await ageRow(firstId, 35);
    expect(await record(person, demandInput(['space.stars'], { slot: 1 }))).toEqual({
      kind: 'already_recorded',
      requestId: firstId,
      open: 'deferred',
    });
    // Long past it, no resolver is left: the demand is closed honestly and the brief is decided afresh.
    await ageRow(firstId, 41);
    const again = await record(person, demandInput(['space.stars'], { slot: 2 }));
    expect(again).toMatchObject({ kind: 'deferred', expiredRequestId: firstId });
    const [closed, fresh] = (await rows(person.universeId)).sort((x, y) => x.planner_slot! - y.planner_slot!);
    expect(closed).toMatchObject({ id: firstId, state: 'unavailable', reason: 'could_not_prepare' });
    expect(fresh).toMatchObject({ state: 'deferred', planner_slot: 2 });
    // The expiry is counted beside the outcome of the call that found it.
    const before = await counters();
    await count(person, [again]);
    expect(growth(before, await counters())).toMatchObject({ 'expired/no_resolver': 1 });
  });

  it('does not let an older ready demand hide a waiting one from the next plan', async () => {
    const unread = await admit('earth.seasons');
    const person = await seedPerson(database.db);
    expect(await record(person, demandInput(['earth.seasons']))).toMatchObject({ kind: 'ready' });
    // The person has met it since: nothing unread is left, so the brief waits on production.
    const waiting = await record(person, demandInput(['earth.seasons'], { slot: 1, alreadyMet: [unread.unit] }));
    expect(waiting).toMatchObject({ kind: 'deferred' });
    // The ready row is older than the waiting one; the waiting one still answers.
    expect(await record(person, demandInput(['earth.seasons'], { slot: 2, alreadyMet: [unread.unit] }))).toEqual({
      kind: 'already_recorded',
      requestId: (waiting as { requestId: string }).requestId,
      open: 'deferred',
    });
  });

  describe('the operator recovery for planned demand that lost its resolver', () => {
    const resolverJobsFor = (requestId: string) =>
      database.pool
        .query("select id from pgboss.job where name='supply.resolve-request' and data->>'requestId' = $1", [requestId])
        .then((result) => result.rows.length);

    it('finds only demand long past the wait limit, sends one job each, and sends nothing twice on a day', async () => {
      const lost = await seedPerson(database.db),
        young = await seedPerson(database.db);
      const lostId = ((await record(lost, demandInput(['space.exoplanets']))) as { requestId: string }).requestId;
      const youngId = ((await record(young, demandInput(['space.exoplanets']))) as { requestId: string }).requestId;
      await ageRow(lostId, 41);
      await ageRow(youngId, 35);
      const dry = await expireStalePlannedDemand(database.db, content.boss, { dryRun: true });
      expect(dry).toMatchObject({ queued: 0, alreadyQueued: 0, more: false });
      expect(dry.stale).toBeGreaterThanOrEqual(1);
      const before = await resolverJobsFor(lostId);
      const run = await expireStalePlannedDemand(database.db, content.boss, { dryRun: false });
      expect(run.queued).toBe(dry.stale);
      expect(await resolverJobsFor(lostId)).toBe(before + 1);
      expect(await resolverJobsFor(youngId)).toBe(1);
      expect(await expireStalePlannedDemand(database.db, content.boss, { dryRun: false })).toMatchObject({
        queued: 0,
        alreadyQueued: dry.stale,
      });
    });

    it('takes at most the limit, oldest first, and says when more remain', async () => {
      const people = [await seedPerson(database.db), await seedPerson(database.db)];
      for (const [index, person] of people.entries()) {
        const id = ((await record(person, demandInput(['space.exoplanets']))) as { requestId: string }).requestId;
        await ageRow(id, 500 + index);
      }
      const run = await expireStalePlannedDemand(database.db, content.boss, { dryRun: true, limit: 1 });
      expect(run).toMatchObject({ stale: 1, more: true });
    });
  });
});
