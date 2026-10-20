import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_V1_CAPABILITIES } from '@knowscroll/scroll-model';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { makeEnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, insideTransaction, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { requestHash } from '@knowscroll/backend/infrastructure/receipts';
import { readDiscoveryCandidates, readExactEncounter } from '@knowscroll/backend/modules/content/nest-providers';
import {
  REQUEST_PLANNER,
  PLANNER_MATERIAL_CHANGE,
  type PlannerMaterialChange,
  type PlannerProposal,
  type RequestPlanner,
} from '@knowscroll/backend/modules/planner';
import {
  plannerRequestProviders,
  plannerStore,
  makeRunPlanner,
  makeReadPlannerOpportunities,
  type PlannerPorts,
  type FrozenContext,
} from '@knowscroll/backend/modules/planner/nest-providers';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import { fixtureHarness, fixtureModel, attemptsOf, signal } from '../support/fixture-model.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { buildFromProviders } from '../support/providers.js';
import { scrollUseCases, starterSource } from '../support/scroll.js';
import { activatedAgo, coverage, dwell, event, openActive } from '../support/observations.js';

/** Real PostgreSQL and real harness/pg-boss adapters. Every model reply is an authored CI fixture. */
describe('Personal Planner (real PostgreSQL, authored CI model fixtures)', () => {
  let database: TestDatabase<Database>, c: Awaited<ReturnType<typeof scrollUseCases>>;
  let base: Parameters<typeof makeRunPlanner>[0], request: RequestPlanner, material: PlannerMaterialChange;
  let asset: { assetId: string; revision: number }, blocks: string[];
  const topic = `ci.planner.${randomUUID()}`;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('planner');
    c = await scrollUseCases(database, { activityMaterialChange: (s, x) => material(s, x) });
    const SCOPE = Symbol('scope'),
      ENQUEUE = Symbol('enqueue');
    const values = new Map<symbol, unknown>([
      [SCOPE, makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })],
      [ENQUEUE, makeEnqueueJob(c.boss)],
    ]);
    const providers = plannerRequestProviders({ withPersonalScope: SCOPE, enqueueJob: ENQUEUE });
    for (const provider of providers)
      values.set(provider.provide, buildFromProviders(providers, provider.provide, values));
    base = values.get(providers[0]!.provide) as PlannerPorts;
    request = values.get(REQUEST_PLANNER) as RequestPlanner;
    material = values.get(PLANNER_MATERIAL_CHANGE) as PlannerMaterialChange;
    const source = starterSource() as { assetId: string; publication: { explanationUnitId: string } };
    source.assetId = randomUUID();
    source.publication.explanationUnitId = `ci-planner-unit-${randomUUID()}`;
    const admitted = await c.importScroll(source);
    if (admitted.kind !== 'imported') throw new Error('CI fixture admission refused');
    asset = { assetId: admitted.assetId, revision: admitted.revision };
    await database.db.deleteFrom('content.encounter_topics').where('asset_id', '=', asset.assetId).execute();
    await database.db
      .insertInto('content.encounter_topics')
      .values({ asset_id: asset.assetId, asset_revision: asset.revision, topic_id: topic, role: 'primary', weight: 1 })
      .execute();
    const facts = await database.db
      .selectFrom('content.asset_revisions')
      .select('reading_facts')
      .where('asset_id', '=', asset.assetId)
      .executeTakeFirstOrThrow();
    blocks = (facts.reading_facts as { blocks: { id: string }[] }).blocks.map((b) => b.id);
  });
  afterAll(async () => {
    await c.close();
    await database.drop();
  });
  const scope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
  const job = (p: FixturePerson, runId: string) => ({
    v: 1 as const,
    universeId: p.universeId,
    privacyEpoch: 1,
    runId,
  });
  async function state(p: FixturePerson) {
    return database.db
      .selectFrom('planner.state')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .executeTakeFirstOrThrow();
  }
  async function frozen(p: FixturePerson): Promise<FrozenContext> {
    const s = await state(p);
    return (
      await database.db
        .selectFrom('planner.runs')
        .select('context')
        .where('universe_id', '=', p.universeId)
        .where('id', '=', s.active_run_id!)
        .executeTakeFirstOrThrow()
    ).context as unknown as FrozenContext;
  }
  function answer(context: FrozenContext): PlannerProposal {
    const evidence = context.facts.evidence[0];
    if (!evidence) throw new Error('CI fixture needs actual qualified evidence');
    return {
      version: 'planner-proposal.v0',
      opportunities: [
        {
          move: 'limitation',
          title: 'Authored CI next limitation',
          purpose: 'A future possibility, never evidence or proof of usefulness.',
          explanationUnitId: evidence.explanationUnitId,
          topicIds: [evidence.topicIds[0]!],
          evidenceRefs: [evidence.ref],
          eligibility: ['vertical', 'related'],
          formats: ['scroll'],
          expiresAt: new Date(Date.parse(context.evaluatedAt) + 86400000).toISOString(),
          target: { kind: 'missing_supply', brief: 'Authored CI proposal, not admitted and no production work.' },
        },
      ],
    };
  }
  function runner(
    p: FixturePerson,
    script?: (context: FrozenContext, sequence: number) => FixtureScenario | Promise<FixtureScenario>,
  ) {
    const model = fixtureModel(
      async (sequence) => {
        expect(insideTransaction()).toBe(false);
        const context = await frozen(p);
        return script ? script(context, sequence) : { kind: 'success', text: JSON.stringify(answer(context)) };
      },
      { label: 'planner-authored-ci-fixture' },
    );
    const { harness } = fixtureHarness(database.db, { model });
    let enabled = true;
    const ports: PlannerPorts = {
      ...base,
      store: plannerStore,
      readSnapshot: c.readExploration,
      readRecentTopics: c.readRecentTopics,
      readInventory: readDiscoveryCandidates,
      readExact: readExactEncounter,
      capabilities: { ...FULL_V1_CAPABILITIES, documentSchemas: ['scroll-document.v1', 'reel-document.v1'] },
      harness,
      enabled: () => enabled,
      now: () => new Date(),
      hash: (x) => requestHash('personal-planner.v0', x as Parameters<typeof requestHash>[1]),
      newId: randomUUID,
    };
    return {
      ports,
      run: makeRunPlanner(ports),
      read: makeReadPlannerOpportunities(ports),
      model,
      setEnabled: (v: boolean) => {
        enabled = v;
      },
    };
  }
  async function qualify(p: FixturePerson) {
    const exposure = await openActive(c, p, asset);
    await activatedAgo(database.db, exposure.exposureId, 3);
    await c.ingestObservations(p.authority, {
      instrumentationVersion: 1,
      events: [event(exposure, coverage(blocks, 4000)), event(exposure, dwell([0, 68000]))],
    });
    const payload = { v: 1 as const, universeId: p.universeId, privacyEpoch: 1, exposureId: exposure.exposureId };
    expect(await c.projectScrollReading(payload)).toMatchObject({ kind: 'applied', qualification: 'qualified' });
    expect(await c.projectActivity(payload)).toMatchObject({ kind: 'applied' });
    return payload;
  }
  async function read(p: FixturePerson, r: ReturnType<typeof runner>, evaluatedAt = new Date().toISOString()) {
    return scope()(p.authority, (s) => r.read(s, { evaluatedAt, limit: 3 }));
  }
  it('serialises receipts and coalesces many requests into one active run/job; disabled and insufficient runs reserve nothing', async () => {
    const p = await seedPerson(database.db),
      r = runner(p),
      commandId = randomUUID();
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => request(p.authority, { commandId })));
    expect(outcomes).toEqual(Array(6).fill(outcomes[0]));
    expect((await state(p)).desired_revision).toBe(1);
    expect(await request(p.authority, { commandId, intent: { language: 'fr', topicIds: [] } })).toEqual({
      kind: 'refused',
      reason: 'command_key_reused',
    });
    await Promise.all(Array.from({ length: 5 }, () => request(p.authority, { commandId: randomUUID() })));
    const s = await state(p);
    expect(s.desired_revision).toBe(6);
    expect(
      await database.db.selectFrom('planner.runs').select('id').where('universe_id', '=', p.universeId).execute(),
    ).toHaveLength(1);
    const jobs = await database.pool.query("select id from pgboss.job where name=$1 and data->>'universeId'=$2", [
      'planner.run',
      p.universeId,
    ]);
    expect(jobs.rows).toHaveLength(1);
    r.setEnabled(false);
    expect(await r.run(job(p, s.active_run_id!), signal())).toMatchObject({
      kind: 'entered',
      value: { kind: 'blocked_disabled' },
    });
    expect(await attemptsOf(database.db, p.universeId)).toHaveLength(0);
    expect(await request(p.authority, { commandId: randomUUID(), resumeRunId: s.active_run_id! })).toMatchObject({
      kind: 'accepted',
      runId: s.active_run_id,
    });
    r.setEnabled(true);
    expect(await r.run(job(p, s.active_run_id!), signal())).toMatchObject({
      kind: 'entered',
      value: { kind: 'insufficient' },
    });
    expect(r.model.calls).toHaveLength(0);
    expect(
      (
        await database.db
          .selectFrom('planner.runs')
          .select('context')
          .where('id', '=', s.active_run_id!)
          .executeTakeFirstOrThrow()
      ).context,
    ).toMatchObject({ intent: { availability: 'unavailable' }, selection: { completeness: 'not_asserted' } });
  });
  it('runs after actual material PC/Evidence change, ignores replay, preserves the source audit, and accepts unadmitted opportunities only', async () => {
    const p = await seedPerson(database.db),
      payload = await qualify(p),
      r = runner(p);
    const before = await state(p),
      evidence = await database.db
        .selectFrom('evidence.activity_revisions')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute();
    expect(await c.projectActivity(payload)).toMatchObject({ kind: 'skipped', reason: 'already_applied' });
    expect(await state(p)).toEqual(before);
    expect(await r.run(job(p, before.active_run_id!), signal())).toMatchObject({
      kind: 'entered',
      value: { kind: 'accepted' },
    });
    expect(r.model.calls).toHaveLength(1);
    expect(await read(p, r)).toMatchObject({
      kind: 'entered',
      value: { availability: 'available', opportunities: [{ target: { kind: 'missing_supply' } }] },
    });
    expect(
      await database.db
        .selectFrom('evidence.activity_revisions')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toEqual(evidence);
    expect(await r.run(job(p, before.active_run_id!), signal())).toMatchObject({
      kind: 'entered',
      value: { kind: 'not_active' },
    });
    expect(r.model.calls).toHaveLength(1);
    // PC-only reconciliation is material, while the already-current Evidence revision audit stays unchanged.
    const pc = personalStores.find((m) => m.module === 'personal-context')!;
    await scope()(p.authority, (s) => pc.erase(s));
    expect(await c.projectActivity(payload)).toMatchObject({ kind: 'applied' });
    expect((await state(p)).desired_revision).toBeGreaterThan(before.desired_revision);
    expect(
      await database.db
        .selectFrom('evidence.activity_revisions')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toEqual(evidence);
    expect(await read(p, r)).toMatchObject({ kind: 'entered', value: { availability: 'stale', opportunities: [] } });
  });
  it('rolls receipt/state/job back together when enqueue fails', async () => {
    const p = await seedPerson(database.db);
    const { makeRequestPlanner } = await import('@knowscroll/backend/modules/planner/nest-providers');
    const failing = makeRequestPlanner({
      ...base,
      enqueue: async (s, id) => {
        await base.enqueue(s, id);
        throw new Error('CI_ENQUEUE_FAILURE');
      },
    });
    await expect(failing(p.authority, { commandId: randomUUID() })).rejects.toThrow('CI_ENQUEUE_FAILURE');
    expect(
      await database.db.selectFrom('planner.state').selectAll().where('universe_id', '=', p.universeId).execute(),
    ).toHaveLength(0);
    expect(
      await database.db.selectFrom('planner.runs').selectAll().where('universe_id', '=', p.universeId).execute(),
    ).toHaveLength(0);
    expect(
      await database.db
        .selectFrom('receipts.personal_commands')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(0);
    expect(
      (
        await database.pool.query("select id from pgboss.job where name=$1 and data->>'universeId'=$2", [
          'planner.run',
          p.universeId,
        ])
      ).rows,
    ).toHaveLength(0);
  });
  it('rolls actual Evidence, PC, scope revision and required Planner job back together when the trigger fails', async () => {
    const p = await seedPerson(database.db),
      exposure = await openActive(c, p, asset);
    const before = await database.db
      .selectFrom('identity.universes')
      .select('revision')
      .where('id', '=', p.universeId)
      .executeTakeFirstOrThrow();
    const failing = await scrollUseCases(database, {
      activityMaterialChange: async (scoped, input) => {
        await material(scoped, input);
        throw new Error('CI_MATERIAL_FAILURE');
      },
    });
    try {
      await expect(
        failing.projectActivity({ v: 1, universeId: p.universeId, privacyEpoch: 1, exposureId: exposure.exposureId }),
      ).rejects.toThrow('CI_MATERIAL_FAILURE');
    } finally {
      await failing.close();
    }
    for (const table of [
      'planner.state',
      'planner.runs',
      'personal_context.contributions',
      'evidence.activity_revisions',
    ] as const)
      expect(
        await database.db.selectFrom(table).select('universe_id').where('universe_id', '=', p.universeId).execute(),
      ).toHaveLength(0);
    expect(
      await database.db
        .selectFrom('identity.universes')
        .select('revision')
        .where('id', '=', p.universeId)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    expect(
      (
        await database.pool.query("select id from pgboss.job where name=$1 and data->>'universeId'=$2", [
          'planner.run',
          p.universeId,
        ])
      ).rows,
    ).toHaveLength(0);
  });
  it('refuses stale concurrent revisions and concurrent deliveries, then creates exactly one successor', async () => {
    const p = await seedPerson(database.db);
    await qualify(p);
    let release!: (s: FixtureScenario) => void, started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<FixtureScenario>((resolve) => {
      release = resolve;
    });
    const r = runner(p, () => {
      started();
      return { kind: 'hold', until: held };
    });
    const s = await state(p),
      running = r.run(job(p, s.active_run_id!), signal());
    await entered;
    expect(await r.run(job(p, s.active_run_id!), signal())).toMatchObject({
      kind: 'entered',
      value: { kind: 'already_running' },
    });
    const context = await frozen(p);
    await request(p.authority, { commandId: randomUUID() });
    release({ kind: 'success', text: JSON.stringify(answer(context)) });
    expect(await running).toMatchObject({ kind: 'entered', value: { kind: 'stale' } });
    const next = await state(p);
    expect(next.active_run_id).not.toBe(s.active_run_id);
    expect(
      await database.db.selectFrom('planner.revisions').selectAll().where('universe_id', '=', p.universeId).execute(),
    ).toHaveLength(0);
    expect(
      await database.db
        .selectFrom('planner.runs')
        .select('status')
        .where('universe_id', '=', p.universeId)
        .where('status', 'in', ['queued', 'prepared', 'unknown', 'blocked'])
        .execute(),
    ).toHaveLength(1);
    expect(r.model.calls).toHaveLength(1);
  });
  it('rechecks exact inventory authority after the model finishes and rejects a withdrawn asset', async () => {
    const p = await seedPerson(database.db);
    await qualify(p);
    let release!: (s: FixtureScenario) => void, started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<FixtureScenario>((resolve) => {
      release = resolve;
    });
    const r = runner(p, () => {
      started();
      return { kind: 'hold', until: held };
    });
    const s = await state(p),
      running = r.run(job(p, s.active_run_id!), signal());
    await entered;
    const context = await frozen(p),
      target = context.facts.inventory.find((a) => a.assetId === asset.assetId)!;
    const proposed = answer(context),
      candidate = {
        ...proposed.opportunities[0]!,
        explanationUnitId: target.explanationUnitId,
        target: {
          kind: 'existing' as const,
          assetId: target.assetId,
          assetRevision: target.assetRevision,
          catalogWatermark: target.catalogWatermark,
        },
      };
    await database.db
      .updateTable('content.assets')
      .set({ status: 'withdrawn' })
      .where('id', '=', asset.assetId)
      .execute();
    try {
      release({ kind: 'success', text: JSON.stringify({ ...proposed, opportunities: [candidate] }) });
      expect(await running).toMatchObject({ kind: 'entered', value: { kind: 'rejected' } });
      expect(
        await database.db.selectFrom('planner.revisions').selectAll().where('universe_id', '=', p.universeId).execute(),
      ).toHaveLength(0);
      expect(r.model.calls).toHaveLength(1);
    } finally {
      await database.db
        .updateTable('content.assets')
        .set({ status: 'admitted' })
        .where('id', '=', asset.assetId)
        .execute();
    }
  });
  it('rolls plan acceptance and harness closure back together, then reuses the kept response after claim expiry', async () => {
    const p = await seedPerson(database.db);
    await qualify(p);
    const r = runner(p),
      s = await state(p);
    const failing = makeRunPlanner({
      ...r.ports,
      store: {
        ...plannerStore,
        accept: async (...args) => {
          await plannerStore.accept(...args);
          throw new Error('CI_APPLY_FAILURE');
        },
      },
    });
    await expect(failing(job(p, s.active_run_id!), signal())).rejects.toThrow('CI_APPLY_FAILURE');
    expect(
      await database.db.selectFrom('planner.revisions').selectAll().where('universe_id', '=', p.universeId).execute(),
    ).toHaveLength(0);
    expect((await state(p)).accepted_revision).toBe(0);
    expect(
      await database.db
        .selectFrom('reasoning.business_runs')
        .select('state')
        .where('id', '=', s.active_run_id!)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ state: 'admitted' });
    await database.db
      .updateTable('planner.runs')
      .set({ claim_until: new Date(Date.now() - 1000) })
      .where('id', '=', s.active_run_id!)
      .execute();
    expect(await r.run(job(p, s.active_run_id!), signal())).toMatchObject({
      kind: 'entered',
      value: { kind: 'accepted' },
    });
    expect(r.model.calls).toHaveLength(1);
  });
  it('bounds accepted memory to three revisions and refuses foreign/read bounds without exposing old plans', async () => {
    const p = await seedPerson(database.db);
    await qualify(p);
    const r = runner(p);
    for (let i = 0; i < 4; i++) {
      if (i > 0) await request(p.authority, { commandId: randomUUID() });
      const s = await state(p);
      expect(await r.run(job(p, s.active_run_id!), signal())).toMatchObject({
        kind: 'entered',
        value: { kind: 'accepted' },
      });
    }
    expect(await scope()(p.authority, (s) => plannerStore.revisions(s, 3))).toMatchObject({
      kind: 'entered',
      value: [{}, {}, {}],
    });
    await expect(scope()(p.authority, (s) => plannerStore.revisions(s, 4))).rejects.toThrow('PLANNER_MEMORY_BOUNDS');
    const foreign = await seedPerson(database.db);
    expect(await read(foreign, r)).toMatchObject({
      kind: 'entered',
      value: { availability: 'absent', opportunities: [] },
    });
    await expect(
      scope()(p.authority, (s) => r.read(s, { evaluatedAt: new Date().toISOString(), limit: 4 })),
    ).rejects.toThrow('PLANNER_READ_BOUNDS');
  });
  it('holds an unknown active run across new material/explicit resume without another invocation', async () => {
    const p = await seedPerson(database.db);
    await qualify(p);
    const r = runner(p, () => ({ kind: 'timeout_after_dispatch' })),
      s = await state(p);
    expect(await r.run(job(p, s.active_run_id!), signal())).toMatchObject({
      kind: 'entered',
      value: { kind: 'unknown' },
    });
    await request(p.authority, { commandId: randomUUID() });
    await request(p.authority, { commandId: randomUUID(), resumeRunId: s.active_run_id! });
    expect(await r.run(job(p, s.active_run_id!), signal())).toMatchObject({
      kind: 'entered',
      value: { kind: 'unknown' },
    });
    expect((await state(p)).active_run_id).toBe(s.active_run_id);
    expect(r.model.calls).toHaveLength(1);
    expect((await attemptsOf(database.db, p.universeId)).map((a) => a.state)).toEqual(['unknown']);
  });
  it('uses one admitted semantic repair and erases all Planner/memory/protected inputs/jobs across epochs', async () => {
    const p = await seedPerson(database.db);
    await qualify(p);
    const r = runner(p, (context, sequence) => {
        const proposal = answer(context);
        if (sequence === 1) proposal.opportunities[0]!.evidenceRefs = ['FOREIGN-PRIVATE-INSTRUCTION'];
        return { kind: 'success', text: JSON.stringify(proposal) };
      }),
      s = await state(p);
    expect(await r.run(job(p, s.active_run_id!), signal())).toMatchObject({
      kind: 'entered',
      value: { kind: 'accepted' },
    });
    expect(r.model.calls).toHaveLength(2);
    expect(r.model.calls[1]!.request.system).toContain('Copy exact evidence references');
    expect(r.model.calls[1]!.request.system).not.toContain('FOREIGN-PRIVATE-INSTRUCTION');
    expect(await read(p, r, new Date(Date.now() + 2 * 86400000).toISOString())).toMatchObject({
      kind: 'entered',
      value: { opportunities: [] },
    });
    await database.db
      .updateTable('identity.universes')
      .set({ privacy_epoch: 2 })
      .where('id', '=', p.universeId)
      .execute();
    expect(await r.run(job(p, s.active_run_id!), signal())).toMatchObject({ kind: 'refused' });
    await scope()({ ...p.authority, privacyEpoch: 2 }, (scoped) => eraseUniverse(scoped, personalStores));
    for (const table of ['planner.state', 'planner.runs', 'planner.revisions', 'reasoning.protected_requests'] as const)
      expect(
        await database.db.selectFrom(table).select('universe_id').where('universe_id', '=', p.universeId).execute(),
      ).toHaveLength(0);
    expect(
      (await database.pool.query("select id from pgboss.job where data->>'universeId'=$1", [p.universeId])).rows,
    ).toHaveLength(0);
  });
});
