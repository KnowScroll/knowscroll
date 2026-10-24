import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_V1_CAPABILITIES } from '@knowscroll/scroll-model';
import { makeEnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import { requestHash } from '@knowscroll/backend/infrastructure/receipts';
import {
  makeWithPersonalScope,
  fencePersonalRecording,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { FENCE_OWN_ACCOUNT, FENCE_PERSONAL_RECORDING } from '@knowscroll/backend/modules/identity';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import { readDiscoveryCandidates, readExactEncounter } from '@knowscroll/backend/modules/content/nest-providers';
import type { ComposerDecision } from '@knowscroll/backend/modules/composer';
import { PlannerJobSchema, type PlannerProposal } from '@knowscroll/backend/modules/planner';
import {
  plannerRequestProviders,
  plannerStore,
  makeRunPlanner,
  makeCheckPlannerRecordingRun,
  type PlannerPorts,
  type FrozenContext,
} from '@knowscroll/backend/modules/planner/nest-providers';
import { geographyStore, makeCheckGeographyRecordingRun } from '@knowscroll/backend/modules/geography/nest-providers';
import {
  personalRecordingReasoningHarnessFor,
  reasoningOperatorFor,
} from '@knowscroll/backend/reasoning/nest-providers';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import { attemptsOf, fixtureHarness, fixtureModel, fixtureSettings, silent, signal } from '../support/fixture-model.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import type { FixturePerson } from '../support/fixtures.js';
import { buildFromProviders } from '../support/providers.js';
import { realRecordPlannedDemand } from '../support/planned-demand.js';
import { clearRecordingPerson, recordingPerson } from '../support/recording-person.js';
import { scrollUseCases, starterSource, textCapabilities } from '../support/scroll.js';
import { activatedAgo, coverage, dwell, event, openActive } from '../support/observations.js';

const GREENHOUSE = 'earth.greenhouse-effect';
const TIDES = 'earth.tides';

/**
 * The connected loop of blueprint §3 on real PostgreSQL and pg-boss: a qualified encounter queues the
 * Planner in the same transaction, the worker accepts a plan, Composer ranks with it and supply gets
 * the missing-supply demand. Content and the model reply are authored CI fixtures; people, encounters,
 * evidence, queues, plans, demand and decisions are produced by the real use cases.
 */
describe('Planner loop: evidence, plan, Composer and supply (real PostgreSQL, authored CI fixtures)', () => {
  let database: TestDatabase<Database>, c: Awaited<ReturnType<typeof scrollUseCases>>;
  let failMaterialEnqueue = false;
  let ports: PlannerPorts;
  let plannerEnabled = true;
  // Each test sets the authored reply it expects the Planner role to receive.
  let reply: () => Promise<FixtureScenario> = () => Promise.reject(new Error('CI fixture reply not set'));
  const model = fixtureModel(() => reply(), { label: 'planner-loop-authored-ci-fixture' });
  type Asset = { assetId: string; revision: number; unit: string; blocks: string[] };
  const assets: { watched?: Asset; first?: Asset; second?: Asset; spare?: Asset } = {};

  async function admit(name: string, topics: { topicId: string; role: 'primary' | 'supporting'; weight: number }[]) {
    const source = starterSource() as {
      assetId: string;
      publication: { explanationUnitId: string };
      draft: { title: string };
    };
    source.assetId = randomUUID();
    source.publication.explanationUnitId = `ci-loop-${name}-${randomUUID()}`;
    source.draft.title = `Authored CI loop ${name}`;
    const imported = await c.importScroll(source);
    if (imported.kind !== 'imported') throw new Error('CI fixture admission refused');
    await database.db.deleteFrom('content.encounter_topics').where('asset_id', '=', imported.assetId).execute();
    await database.db
      .insertInto('content.encounter_topics')
      .values(
        topics.map((t) => ({
          asset_id: imported.assetId,
          asset_revision: imported.revision,
          topic_id: t.topicId,
          role: t.role,
          weight: t.weight,
        })),
      )
      .execute();
    const facts = await database.db
      .selectFrom('content.asset_revisions')
      .select('reading_facts')
      .where('asset_id', '=', imported.assetId)
      .executeTakeFirstOrThrow();
    const blocks = (facts.reading_facts as { blocks: { id: string }[] }).blocks.map((b) => b.id);
    return {
      assetId: imported.assetId,
      revision: imported.revision,
      unit: source.publication.explanationUnitId,
      blocks,
    };
  }

  beforeAll(async () => {
    database = await createTestDatabase<Database>('planner_loop');
    c = await scrollUseCases(database, {
      recording: true,
      wrapEnqueue: (enqueue) => async (scope, queue, payload, options) => {
        await enqueue(scope, queue, payload, options);
        if (failMaterialEnqueue && queue.name === 'planner.run') throw new Error('CI_PLANNER_ENQUEUE_FAILURE');
      },
    });
    assets.watched = await admit('watched', [
      { topicId: GREENHOUSE, role: 'primary', weight: 0.7 },
      { topicId: TIDES, role: 'supporting', weight: 0.3 },
    ]);
    assets.first = await admit('first', [{ topicId: GREENHOUSE, role: 'primary', weight: 1 }]);
    assets.second = await admit('second', [{ topicId: GREENHOUSE, role: 'primary', weight: 1 }]);
    assets.spare = await admit('spare', [{ topicId: GREENHOUSE, role: 'primary', weight: 1 }]);

    const SCOPE = Symbol('scope'),
      ENQUEUE = Symbol('enqueue');
    const own = accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 }).fenceOwnAccount;
    const values = new Map<symbol, unknown>([
      [SCOPE, makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })],
      [ENQUEUE, makeEnqueueJob(c.boss)],
      [FENCE_OWN_ACCOUNT, own],
      [FENCE_PERSONAL_RECORDING, fencePersonalRecording],
    ]);
    const requestProviders = plannerRequestProviders({ withPersonalScope: SCOPE, enqueueJob: ENQUEUE });
    for (const provider of requestProviders)
      values.set(provider.provide, buildFromProviders(requestProviders, provider.provide, values));
    const fixture = fixtureHarness(database.db, { model });
    const harness = personalRecordingReasoningHarnessFor({
      db: database.db,
      model: fixture.ports.model,
      withPersonalScope: fixture.ports.withPersonalScope,
      fenceOwn: own,
      settings: fixtureSettings,
      logEvent: silent,
      overrides: fixture.ports,
      checkPlanner: makeCheckPlannerRecordingRun({ store: plannerStore, now: () => new Date() }),
      checkGeography: makeCheckGeographyRecordingRun({ store: geographyStore, now: () => new Date() }),
    });
    ports = {
      ...(values.get(requestProviders[0]!.provide) as PlannerPorts),
      store: plannerStore,
      readSnapshot: c.readExploration,
      readRecentTopics: c.readRecentTopics,
      readInventory: readDiscoveryCandidates,
      readExact: readExactEncounter,
      capabilities: { ...FULL_V1_CAPABILITIES, documentSchemas: ['scroll-document.v1', 'reel-document.v1'] },
      harness,
      recordDemand: realRecordPlannedDemand(database, c.boss, {
        createDailyCap: 10,
        readExploration: c.readExploration,
      }),
      enabled: () => plannerEnabled,
      hash: (x) => requestHash('personal-planner.v0', x as Parameters<typeof requestHash>[1]),
      newId: randomUUID,
      now: () => new Date(),
    };
  });
  afterAll(async () => {
    await c.close();
    await database.drop();
  });

  async function qualify(p: FixturePerson, asset: Asset) {
    const exposure = await openActive(c, p, { assetId: asset.assetId, revision: asset.revision });
    await activatedAgo(database.db, exposure.exposureId, 3);
    await c.ingestObservations(p.authority, {
      instrumentationVersion: 1,
      events: [event(exposure, coverage(asset.blocks, 4000)), event(exposure, dwell([0, 68000]))],
    });
    const payload = { v: 1 as const, universeId: p.universeId, privacyEpoch: 1, exposureId: exposure.exposureId };
    expect(await c.projectScrollReading(payload)).toMatchObject({ kind: 'applied', qualification: 'qualified' });
    return payload;
  }

  const plannerState = (p: FixturePerson) =>
    database.db.selectFrom('planner.state').selectAll().where('universe_id', '=', p.universeId).executeTakeFirst();

  /** The job the run's current wake names: one per wake, whichever earlier jobs the run has had. */
  async function queuedJob(p: FixturePerson) {
    const state = await plannerState(p);
    const run = await database.db
      .selectFrom('planner.runs')
      .select('normal_wake_id')
      .where('universe_id', '=', p.universeId)
      .where('id', '=', state!.active_run_id!)
      .executeTakeFirstOrThrow();
    const queued = await database.pool.query<{ data: unknown }>(
      "select data from pgboss.job where name='planner.run' and id=$1",
      [run.normal_wake_id],
    );
    expect(queued.rows).toHaveLength(1);
    return PlannerJobSchema.parse(queued.rows[0]!.data);
  }

  /** What pg-boss records when a delivery finishes, so the run may be woken again. */
  const finishDelivery = (runId: string) =>
    database.pool.query("update pgboss.job set state='completed' where name='planner.run' and data->>'runId'=$1", [
      runId,
    ]);

  const runRow = (runId: string) =>
    database.db.selectFrom('planner.runs').selectAll().where('id', '=', runId).executeTakeFirstOrThrow();

  async function frozenContext(p: FixturePerson): Promise<FrozenContext> {
    const state = await plannerState(p);
    return (
      await database.db
        .selectFrom('planner.runs')
        .select('context')
        .where('universe_id', '=', p.universeId)
        .where('id', '=', state!.active_run_id!)
        .executeTakeFirstOrThrow()
    ).context as unknown as FrozenContext;
  }

  /** Two opportunities built from the frozen context: planned admitted content, and a topic with no content yet. */
  function proposal(context: FrozenContext, target: Asset): PlannerProposal {
    const watched = assets.watched!;
    const evidence = context.facts.evidence.find((e) => e.explanationUnitId === watched.unit);
    const inventory = context.facts.inventory.find((a) => a.explanationUnitId === target.unit);
    if (!evidence || !inventory) throw new Error('CI fixture needs the watched evidence and the planned inventory');
    const expiresAt = new Date(Date.parse(context.evaluatedAt) + 86_400_000).toISOString();
    return {
      version: 'planner-proposal.v0',
      opportunities: [
        {
          move: 'limitation',
          title: 'Authored CI planned explanation',
          purpose: 'A future possibility, never evidence.',
          topicIds: [GREENHOUSE],
          explanationUnitId: target.unit,
          evidenceRefs: [evidence.ref],
          eligibility: ['vertical'],
          formats: ['scroll'],
          expiresAt,
          target: {
            kind: 'existing',
            assetId: inventory.assetId,
            assetRevision: inventory.assetRevision,
            catalogWatermark: inventory.catalogWatermark,
          },
        },
        {
          move: 'connection',
          title: 'Authored CI tidal connection',
          purpose: 'Content that does not exist yet.',
          topicIds: [TIDES],
          explanationUnitId: watched.unit,
          evidenceRefs: [evidence.ref],
          eligibility: ['vertical', 'related'],
          formats: ['scroll'],
          expiresAt,
          target: { kind: 'missing_supply', brief: 'Authored CI brief; nothing is produced.' },
        },
      ],
    };
  }

  async function discoverDecision(p: FixturePerson): Promise<ComposerDecision> {
    const commandId = randomUUID();
    const result = await c.navigate(p.authority, {
      commandId,
      target: { kind: 'discover' },
      capabilities: textCapabilities,
    });
    if (result.kind !== 'accepted' || result.outcome.status !== 'ready') throw new Error('CI navigation not ready');
    const row = await database.db
      .selectFrom('composer.decisions')
      .select('payload')
      .where('universe_id', '=', p.universeId)
      .where('command_id', '=', commandId)
      .executeTakeFirstOrThrow();
    return row.payload as unknown as ComposerDecision;
  }

  const evidenceRows = (p: FixturePerson) =>
    database.db
      .selectFrom('evidence.activity_revisions')
      .select('id')
      .where('universe_id', '=', p.universeId)
      .execute();

  it('rolls the evidence projection back with the Planner job when the job cannot be queued', async () => {
    const p = await recordingPerson(database);
    const payload = await qualify(p, assets.watched!);
    failMaterialEnqueue = true;
    try {
      await expect(c.projectActivity(payload)).rejects.toThrow('CI_PLANNER_ENQUEUE_FAILURE');
    } finally {
      failMaterialEnqueue = false;
    }
    expect(await evidenceRows(p)).toHaveLength(0);
    expect(await plannerState(p)).toBeUndefined();
  });

  it('turns a qualified encounter into a plan that Composer ranks with and supply receives, without creating evidence', async () => {
    const p = await recordingPerson(database);
    const { first, second } = assets;
    const baseline = await discoverDecision(p);
    expect(baseline.input.evidence?.plan).toBeUndefined();
    const baselineWinner = baseline.exploration.rankedWinner!.assetId;
    // Plan the explanation the baseline ranking would not pick, so the effect is the plan's alone.
    const planned = baselineWinner === first!.assetId ? second! : first!;

    // 1. A real qualified encounter queues the Planner in the transaction that records the evidence.
    const payload = await qualify(p, assets.watched!);
    expect(await c.projectActivity(payload)).toMatchObject({ kind: 'applied' });
    const state = await plannerState(p);
    expect(state).toMatchObject({ desired_revision: 1, accepted_revision: 0 });
    const job = await queuedJob(p);
    const evidenceBefore = await evidenceRows(p);

    // 2. The worker prepares a context from that evidence, calls the role and accepts a plan.
    reply = async () => ({ kind: 'success', text: JSON.stringify(proposal(await frozenContext(p), planned)) });
    expect(await makeRunPlanner(ports)(job, signal())).toMatchObject({ kind: 'entered', value: { kind: 'accepted' } });
    expect(model.calls).toHaveLength(1);
    const revision = await database.db
      .selectFrom('planner.revisions')
      .select(['revision', 'opportunities'])
      .where('universe_id', '=', p.universeId)
      .executeTakeFirstOrThrow();
    expect((revision.opportunities as { target: { kind: string } }[]).map((o) => o.target.kind)).toEqual([
      'existing',
      'missing_supply',
    ]);
    // A plan is never evidence.
    expect(await evidenceRows(p)).toEqual(evidenceBefore);

    // 3. Supply holds the missing-supply opportunity as deferred demand on a shared group.
    const demand = await database.db
      .selectFrom('supply.requests')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .execute();
    expect(demand).toHaveLength(1);
    expect(demand[0]).toMatchObject({
      origin: 'planner',
      state: 'deferred',
      decision: 'create',
      planner_slot: 1,
      brief: { subject: { kind: 'catalogue', topicId: TIDES }, format: 'scroll', language: 'en' },
    });
    const group = await database.db
      .selectFrom('supply.work')
      .selectAll()
      .where('id', '=', demand[0]!.work_id!)
      .executeTakeFirstOrThrow();
    expect(group.active).toBe(true);
    // Create committed the group's production job with the plan; the waiter has its own resolver job.
    expect(group.production_recipe).toBe('tides');
    expect(
      (await database.pool.query("select id from pgboss.job where name='content.produce-scroll'")).rows,
    ).toHaveLength(1);
    const resolverJobs = await database.pool.query(
      "select id from pgboss.job where name='supply.resolve-request' and data->>'universeId'=$1",
      [p.universeId],
    );
    expect(resolverJobs.rows).toHaveLength(1);

    // 4. Composer reads the plan: the planned explanation now ranks first and the decision says why.
    const decision = await discoverDecision(p);
    expect(decision.input.evidence?.plan).toMatchObject({ revision: revision.revision });
    expect(decision.exploration.rankedWinner?.assetId).toBe(planned.assetId);
    const influenced = decision.evaluations.find((e) => e.assetId === planned.assetId)!;
    expect(influenced.plan).toMatchObject({ opportunity: 0, match: 'unit', feature: 'intent', before: 0.5 });
    expect(decision.evaluations.find((e) => e.assetId === assets.watched!.assetId)?.plan).toMatchObject({
      match: 'topic',
    });
    // Planned content is offered only because it was already an admitted candidate.
    expect(decision.input.candidates.map((x) => x.encounter.assetId)).toContain(planned.assetId);
    // Reading the plan wrote no evidence either.
    expect(await evidenceRows(p)).toEqual(evidenceBefore);

    // 5. A later plan revision that asks for the same missing topic adds no second waiter.
    expect(await c.projectActivity(await qualify(p, assets.first!))).toMatchObject({ kind: 'applied' });
    reply = async () => ({ kind: 'success', text: JSON.stringify(proposal(await frozenContext(p), assets.spare!)) });
    expect(await makeRunPlanner(ports)(await queuedJob(p), signal())).toMatchObject({ value: { kind: 'accepted' } });
    expect(
      await database.db
        .selectFrom('planner.revisions')
        .select('revision')
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(2);
    expect(
      (
        await database.db.selectFrom('supply.requests').select('id').where('universe_id', '=', p.universeId).execute()
      ).map((row) => row.id),
    ).toEqual(demand.map((row) => row.id));
  });

  it('requeues a run that was blocked while the Planner was off, so the next evidence yields a plan', async () => {
    const p = await recordingPerson(database);
    const callsBefore = model.calls.length;
    plannerEnabled = false;
    try {
      expect(await c.projectActivity(await qualify(p, assets.watched!))).toMatchObject({ kind: 'applied' });
      const blockedId = (await plannerState(p))!.active_run_id!;
      expect(await makeRunPlanner(ports)(await queuedJob(p), signal())).toMatchObject({
        value: { kind: 'blocked_disabled' },
      });
      expect(await runRow(blockedId)).toMatchObject({ status: 'blocked', outcome: 'blocked_disabled' });
      expect(model.calls).toHaveLength(callsBefore);
    } finally {
      plannerEnabled = true;
    }
    // New evidence while the old run is blocked: the same run goes back in the queue with a new wake.
    const blockedId = (await plannerState(p))!.active_run_id!;
    expect(await c.projectActivity(await qualify(p, assets.first!))).toMatchObject({ kind: 'applied' });
    expect((await plannerState(p))!.active_run_id).toBe(blockedId);
    expect(await runRow(blockedId)).toMatchObject({ status: 'queued' });
    reply = async () => ({ kind: 'success', text: JSON.stringify(proposal(await frozenContext(p), assets.second!)) });
    expect(await makeRunPlanner(ports)(await queuedJob(p), signal())).toMatchObject({ value: { kind: 'accepted' } });
    expect(
      await database.db
        .selectFrom('planner.revisions')
        .select('revision')
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(1);
  });

  it('retires an unknown run once its attempt is settled or old, never resends it, and then plans again', async () => {
    const p = await recordingPerson(database);
    const modelCalls = () => model.calls.length;
    reply = () => Promise.resolve({ kind: 'timeout_after_dispatch' });
    expect(await c.projectActivity(await qualify(p, assets.watched!))).toMatchObject({ kind: 'applied' });
    const unknownId = (await plannerState(p))!.active_run_id!;
    const before = modelCalls();
    expect(await makeRunPlanner(ports)(await queuedJob(p), signal())).toMatchObject({ value: { kind: 'unknown' } });
    expect(modelCalls()).toBe(before + 1);
    await finishDelivery(unknownId);

    // Evidence arrives while the attempt is unresolved and young: the run is woken and waits.
    expect(await c.projectActivity(await qualify(p, assets.first!))).toMatchObject({ kind: 'applied' });
    expect(await makeRunPlanner(ports)(await queuedJob(p), signal())).toMatchObject({
      value: { kind: 'awaiting_explicit_resume' },
    });
    expect((await plannerState(p))!.active_run_id).toBe(unknownId);
    await finishDelivery(unknownId);

    // Once the operator has written the attempt off, the next evidence retires the run and a successor plans.
    const attempt = await database.db
      .selectFrom('reasoning.external_attempts')
      .select('id')
      .where('universe_id', '=', p.universeId)
      .executeTakeFirstOrThrow();
    const operator = reasoningOperatorFor(database.db, silent);
    expect(await operator.writeOff(attempt.id, 'CI: provider never answered', 'cli:ci')).toMatchObject({
      kind: 'written_off',
    });
    expect(await c.projectActivity(await qualify(p, assets.second!))).toMatchObject({ kind: 'applied' });
    expect(await makeRunPlanner(ports)(await queuedJob(p), signal())).toMatchObject({
      value: { kind: 'unknown_settled' },
    });
    expect(await runRow(unknownId)).toMatchObject({ status: 'stale', outcome: 'unknown_settled' });
    const successorId = (await plannerState(p))!.active_run_id!;
    expect(successorId).not.toBe(unknownId);
    reply = async () => ({ kind: 'success', text: JSON.stringify(proposal(await frozenContext(p), assets.spare!)) });
    expect(await makeRunPlanner(ports)(await queuedJob(p), signal())).toMatchObject({ value: { kind: 'accepted' } });
    // The unknown attempt was never resent: one attempt for the old run, one for its successor.
    expect((await attemptsOf(database.db, p.universeId)).map((a) => a.state).sort()).toEqual([
      'succeeded',
      'written_off',
    ]);
  });

  it('retires an unresolved unknown run after two hours without resending it', async () => {
    const p = await recordingPerson(database);
    reply = () => Promise.resolve({ kind: 'timeout_after_dispatch' });
    expect(await c.projectActivity(await qualify(p, assets.watched!))).toMatchObject({ kind: 'applied' });
    const unknownId = (await plannerState(p))!.active_run_id!;
    expect(await makeRunPlanner(ports)(await queuedJob(p), signal())).toMatchObject({ value: { kind: 'unknown' } });
    await finishDelivery(unknownId);
    await database.pool.query("update planner.runs set created_at = now() - interval '3 hours' where id=$1", [
      unknownId,
    ]);
    expect(await c.projectActivity(await qualify(p, assets.first!))).toMatchObject({ kind: 'applied' });
    expect(await makeRunPlanner(ports)(await queuedJob(p), signal())).toMatchObject({
      value: { kind: 'unknown_expired' },
    });
    expect(await runRow(unknownId)).toMatchObject({ status: 'stale', outcome: 'unknown_expired' });
    expect((await plannerState(p))!.active_run_id).not.toBe(unknownId);
    // The abandoned attempt stays in the ledger as an unresolved liability.
    expect((await attemptsOf(database.db, p.universeId)).map((a) => a.state)).toEqual(['unknown']);
  });

  it('a stale delivery after a privacy Clear is refused, and Clear removes plans and planned demand', async () => {
    const p = await recordingPerson(database);
    const planned = assets.first!;
    const payload = await qualify(p, assets.watched!);
    expect(await c.projectActivity(payload)).toMatchObject({ kind: 'applied' });
    reply = async () => ({ kind: 'success', text: JSON.stringify(proposal(await frozenContext(p), planned)) });
    expect(await makeRunPlanner(ports)(await queuedJob(p), signal())).toMatchObject({
      value: { kind: 'accepted' },
    });
    // New evidence queues the next run, which a Clear then makes obsolete.
    const again = await qualify(p, assets.second!);
    expect(await c.projectActivity(again)).toMatchObject({ kind: 'applied' });
    const stale = await queuedJob(p);
    const callsBefore = model.calls.length;
    // There is a plan and planned demand to clear.
    for (const table of ['planner.revisions', 'supply.requests'] as const)
      expect(
        await database.db.selectFrom(table).select('universe_id').where('universe_id', '=', p.universeId).execute(),
      ).toHaveLength(1);

    await clearRecordingPerson(database, c.boss, p);

    for (const table of ['planner.revisions', 'planner.state', 'planner.runs', 'supply.requests'] as const)
      expect(
        await database.db.selectFrom(table).select('universe_id').where('universe_id', '=', p.universeId).execute(),
      ).toHaveLength(0);
    // The waiter's queued resolver job goes with it; the shared production job and group stay.
    expect(
      (
        await database.pool.query(
          "select id from pgboss.job where name='supply.resolve-request' and data->>'universeId'=$1",
          [p.universeId],
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (await database.pool.query("select id from pgboss.job where name='content.produce-scroll'")).rows,
    ).toHaveLength(1);
    expect(await makeRunPlanner(ports)(stale, signal())).toMatchObject({ kind: 'refused' });
    expect(model.calls).toHaveLength(callsBefore);
    expect(
      await database.db
        .selectFrom('planner.revisions')
        .select('revision')
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(0);
  });
});
