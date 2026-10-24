import { projectSceneQueue } from '@knowscroll/backend/modules/scenes';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { fencePersonalRecording, transactionOf } from '@knowscroll/backend/infrastructure/postgres';
import { publishDeltaQueue, type PublishGeographyDelta } from '@knowscroll/backend/modules/geography';
import {
  geographyStore,
  makeRunCartographer,
  applyProposal,
  makeCheckGeographyRecordingRun,
  type GeographyContext,
} from '@knowscroll/backend/modules/geography/nest-providers';
import { plannerStore, makeCheckPlannerRecordingRun } from '@knowscroll/backend/modules/planner/nest-providers';
import { personalRecordingReasoningHarnessFor } from '@knowscroll/backend/reasoning/nest-providers';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import {
  fixtureHarness,
  fixtureSettings,
  silent,
  attemptsOf,
  receiptClassesOf,
  signal,
} from '../support/fixture-model.js';
import { seedPerson } from '../support/fixtures.js';
import { geographyWorld, topic, facet, otherFacet, type GeographyWorld } from '../support/geography-world.js';

/** Authored CI sources/maps/model proposals only. No source approval, provider or real formation claim. */
describe('Geography current trusted-coverage consumer (real PostgreSQL CI fixtures)', () => {
  let world: GeographyWorld;
  let database: GeographyWorld['database'], base: GeographyWorld['base'];
  let request: GeographyWorld['request'], read: GeographyWorld['read'], deltas: GeographyWorld['deltas'];
  let publish: GeographyWorld['publish'], scope: GeographyWorld['scope'];
  let fixture: GeographyWorld['fixture'], observe: GeographyWorld['observe'], coherent: GeographyWorld['coherent'];
  let state: GeographyWorld['state'], context: GeographyWorld['context'], job: GeographyWorld['job'];
  let formation: GeographyWorld['formation'], runner: GeographyWorld['runner'], snapshot: GeographyWorld['snapshot'];
  let scopeApply: GeographyWorld['scopeApply'], manualApply: GeographyWorld['manualApply'];
  beforeAll(async () => {
    world = await geographyWorld('geography');
    ({ database, base, request, read, deltas, publish, scope } = world);
    ({ fixture, observe, coherent, state, context, job, formation, runner, snapshot } = world);
    ({ scopeApply, manualApply } = world);
  });
  afterAll(() => world.close());
  async function kindsOf(person: Parameters<typeof snapshot>[0]) {
    const result = await snapshot(person);
    return 'page' in result ? result.page.objects.map((object) => object.kind).sort() : [];
  }
  it('a refusal before admission settles the claim by the rules when no attempt is retained, and keeps it when one is', async () => {
    for (const retained of [false, true]) {
      const a = await seedPerson(database.db);
      await coherent(a);
      const before = await state(a),
        runId = before.activeRunId!;
      if (retained)
        await database.db
          .insertInto('reasoning.business_runs')
          .values({
            universe_id: a.universeId,
            id: runId,
            privacy_epoch: 1,
            owner_module: 'geography',
            purpose: 'personal-cartographer',
          })
          .execute();
      const fixture = fixtureHarness(database.db, { model: undefined });
      const actual = personalRecordingReasoningHarnessFor({
        db: database.db,
        model: undefined,
        withPersonalScope: fixture.ports.withPersonalScope,
        fenceOwn: base.fenceOwn,
        settings: fixtureSettings,
        logEvent: silent,
        overrides: fixture.ports,
        checkPlanner: makeCheckPlannerRecordingRun({ store: plannerStore, now: base.now }),
        checkGeography: makeCheckGeographyRecordingRun({ store: geographyStore, now: base.now }),
      });
      const forbidden = () => {
        throw new Error('CI unadmitted run has no ledger run to apply under or close');
      };
      await makeRunCartographer({
        ...base,
        enabled: () => true,
        harness: { ...actual, withPersonalApply: forbidden, closePersonalRun: forbidden },
      })(await job(a, runId), signal());
      const h = await database.db
        .selectFrom('geography.runs')
        .selectAll()
        .where('universe_id', '=', a.universeId)
        .where('id', '=', runId)
        .executeTakeFirstOrThrow();
      expect(h.normal_wake_id).toBeNull();
      expect(await attemptsOf(database.db, a.universeId)).toEqual([]);
      const deltas = await database.db
        .selectFrom('geography.deltas')
        .select('transition_id')
        .where('universe_id', '=', a.universeId)
        .execute();
      if (retained) {
        // A retained attempt cannot be proved away: the claim stays until it expires.
        expect(h.status).toBe('prepared');
        expect(h.outcome).toBeNull();
        expect(h.claim_id).not.toBeNull();
        expect(h.claim_wake_claim_id).toBe(h.claim_id);
        expect(await state(a)).toEqual(before);
        expect(deltas).toEqual([]);
      } else {
        // The provider is missing, so no model ran; the rules still formed the places.
        expect(h).toMatchObject({
          status: 'accepted',
          outcome: 'applied_by_rules',
          claim_id: null,
          claim_until: null,
          claim_wake_claim_id: null,
        });
        expect(await kindsOf(a)).toEqual(['planet', 'region', 'region', 'star', 'system']);
        expect(deltas).toHaveLength(1);
        expect((await state(a)).activeRunId).toBeUndefined();
      }
      expect(
        await database.db
          .selectFrom('reasoning.business_runs')
          .select('id')
          .where('universe_id', '=', a.universeId)
          .execute(),
      ).toHaveLength(retained ? 1 : 0);
    }
  });
  it('unviewed assets and readonly map visits create no work, coverage, model call or objects', async () => {
    const p = await seedPerson(database.db);
    await fixture();
    await fixture();
    await fixture();
    for (let i = 0; i < 3; i++)
      expect(await snapshot(p)).toMatchObject({ status: 'empty', geography: { revision: 0 } });
    expect(
      (await database.pool.query("select id from pgboss.job where data->>'universeId'=$1", [p.universeId])).rows,
    ).toHaveLength(0);
    const req = await request(p.authority, { commandId: randomUUID() });
    if (req.kind !== 'accepted') throw new Error('CI request refused');
    const r = runner(p);
    await r.run(await job(p, req.runId), signal());
    expect(r.model.calls).toHaveLength(0);
    expect(await snapshot(p)).toMatchObject({ status: 'empty', geography: { revision: 0 } });
  });
  it('a switched-off role releases real queued work without attempts, receipts coalesce/replay, and asking again runs a new run once', async () => {
    const p = await seedPerson(database.db);
    await coherent(p);
    const c0 = { commandId: randomUUID() },
      a = await request(p.authority, c0);
    expect(await request(p.authority, c0)).toEqual(a);
    if (a.kind !== 'accepted') throw new Error('CI request refused');
    const r = runner(p, undefined, { enabled: () => false });
    await r.run(await job(p, a.runId), signal());
    expect(r.model.calls).toHaveLength(0);
    expect(
      await database.db
        .selectFrom('geography.runs')
        .select(['status', 'outcome'])
        .where('id', '=', a.runId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'insufficient', outcome: 'disabled' });
    expect((await state(p)).activeRunId).toBeUndefined();
    expect(await attemptsOf(database.db, p.universeId)).toHaveLength(0);
    expect(await snapshot(p)).toMatchObject({ status: 'empty' });
    // Switching the role on and asking again starts a new run, which runs once.
    const again = await request(p.authority, { commandId: randomUUID() });
    if (again.kind !== 'accepted') throw new Error('CI request refused');
    expect(again.runId).not.toBe(a.runId);
    await makeRunCartographer({ ...r.ports, enabled: () => true })(await job(p, again.runId), signal());
    expect(r.model.calls).toHaveLength(1);
    expect(await snapshot(p)).toMatchObject({ status: 'ready', geography: { revision: 1 } });
  });
  it('repeated actual variants remain one unit; ALL-OF missing leaves cannot supply a second facet', async () => {
    const p = await seedPerson(database.db),
      unit = `ci-one-unit-${randomUUID()}`;
    for (let i = 0; i < 3; i++)
      await observe(p, await fixture(unit, topic, [facet, otherFacet]), ['intro-short-version']);
    const r = runner(p),
      s = await state(p);
    await r.run(await job(p, s.activeRunId!), signal());
    // One unit earns nothing, so reading alone asks no model. An explicit request still does, and
    // the proposal it gets back (a planet from one unit) is refused.
    expect(r.model.calls).toHaveLength(0);
    const asked = await request(p.authority, { commandId: randomUUID() });
    if (asked.kind !== 'accepted') throw new Error('CI request refused');
    await r.run(await job(p, asked.runId), signal());
    expect(r.model.calls).toHaveLength(2);
    expect(await snapshot(p)).toMatchObject({ status: 'empty', geography: { revision: 0 } });
    expect(
      await database.db
        .selectFrom('geography.deltas')
        .select('revision')
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(0);
  });
  it('three qualified units with one actual facet: the invalid planet proposal is refused and the rules form only the system and star', async () => {
    const p = await seedPerson(database.db);
    for (let i = 0; i < 3; i++) await observe(p, await fixture());
    const r = runner(p),
      s = await state(p);
    await r.run(await job(p, s.activeRunId!), signal());
    expect(r.model.calls).toHaveLength(2);
    const result = await snapshot(p);
    if (result.status !== 'ready') throw new Error('CI ready expected');
    expect(result.page.objects.map((o) => o.kind).sort()).toEqual(['star', 'system']);
    expect(
      (
        await database.db
          .selectFrom('geography.runs')
          .select('outcome')
          .where('id', '=', s.activeRunId!)
          .executeTakeFirstOrThrow()
      ).outcome,
    ).toBe('applied_by_rules');
  });
  it('three coherent qualified units plus two actual facets form stable meaning; pages/deltas and required hint job are real', async () => {
    const p = await seedPerson(database.db);
    await coherent(p);
    const s = await state(p),
      r = runner(p);
    const runningJob = await job(p, s.activeRunId!);
    await Promise.all([r.run(runningJob, signal()), r.run(runningJob, signal())]);
    expect(r.model.calls).toHaveLength(1);
    const first = await snapshot(p);
    expect(first).toMatchObject({
      status: 'ready',
      geography: { revision: 1, structureRevision: 1, activityRevision: 0 },
    });
    if (first.status !== 'ready') throw new Error('CI ready expected');
    expect(first.page.objects.map((o) => o.kind).sort()).toEqual(['planet', 'region', 'region', 'star', 'system']);
    const transition = first.page.objects[0]!.originTransitionId;
    await expect(
      database.db
        .updateTable('geography.deltas')
        .set({ input_sha256: 'b'.repeat(64) })
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });

    const work = (
      await database.pool.query<{ data: Parameters<PublishGeographyDelta>[0] }>(
        "select data from pgboss.job where name=$1 and data->>'universeId'=$2",
        [publishDeltaQueue.name, p.universeId],
      )
    ).rows;
    expect(work).toEqual([
      { data: { v: 1, universeId: p.universeId, privacyEpoch: 1, transitionId: transition, geographyRevision: 1 } },
    ]);
    await publish(work[0]!.data);
    await publish(work[0]!.data);
    expect((await state(p)).publishedRevision).toBe(1);
    const page = await snapshot(p, { selection: { kind: 'universe' }, limit: 2 });
    if (page.status !== 'ready' || page.page.continuation.status !== 'more')
      throw new Error('CI continuation expected');
    const next = await snapshot(p, {
      selection: { kind: 'universe' },
      limit: 2,
      cursor: page.page.continuation.cursor,
    });
    expect(next.status).toBe('ready');
    if (next.status === 'ready')
      expect(next.page.objects.every((o) => !page.page.objects.some((x) => x.id === o.id))).toBe(true);
    expect(
      await snapshot(p, {
        selection: { kind: 'universe' },
        limit: 2,
        cursor: { ...page.page.continuation.cursor, privacyEpoch: 2 },
      }),
    ).toMatchObject({ status: 'unavailable', reason: 'snapshot_expired' });
    const other = await seedPerson(database.db);
    expect(
      await read(other.authority, {
        selection: { kind: 'system', systemId: first.page.objects.find((o) => o.kind === 'system')!.id },
        limit: 10,
      }),
    ).toEqual({ kind: 'refused', reason: 'selection_not_found' });
    expect(await deltas(p.authority, { afterGeographyRevision: 0, limit: 10 })).toMatchObject({
      kind: 'read',
      deltas: { status: 'available', hasMore: false, deltas: [{ transitionId: transition }] },
    });
    const sceneJobs = await database.pool.query<{ data: unknown }>(
      "select data from pgboss.job where name=$1 and data->>'universeId'=$2",
      [projectSceneQueue.name, p.universeId],
    );
    expect(sceneJobs.rows).toHaveLength(1);
    expect(sceneJobs.rows[0]!.data).toMatchObject({
      v: 1,
      universeId: p.universeId,
      privacyEpoch: 1,
      transitionId: transition,
      geography: first.geography,
    });
    const frozen = await context(p, s.activeRunId!);
    expect(await scopeApply(p, s.activeRunId!, frozen, formation(frozen))).toMatchObject({
      kind: 'entered',
      value: { kind: 'replayed', delta: { transitionId: transition } },
    });
    expect(
      (
        await database.pool.query("select id from pgboss.job where name=$1 and data->>'universeId'=$2", [
          projectSceneQueue.name,
          p.universeId,
        ])
      ).rows,
    ).toHaveLength(1);
    expect(await scopeApply(p, s.activeRunId!, frozen, { ...formation(frozen), operations: [] })).toMatchObject({
      kind: 'entered',
      value: { kind: 'refused', reason: 'transition_key_reused' },
    });
    expect(
      (
        await database.pool.query<{ data: Parameters<PublishGeographyDelta>[0] }>(
          "select data from pgboss.job where name=$1 and data->>'universeId'=$2",
          [publishDeltaQueue.name, p.universeId],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it('routes connect only actual coherent planets; withdrawal retains endpoints/origin, aliases cannot cross truth', async () => {
    const p = await seedPerson(database.db);
    await coherent(p);
    const initial = runner(p),
      first = await state(p);
    await initial.run(await job(p, first.activeRunId!), signal());
    for (let i = 0; i < 3; i++)
      await observe(
        p,
        await fixture(undefined, 'earth.tides', [i === 1 ? 'earth.tides.alignment' : 'earth.tides.forcing']),
      );
    const second = await state(p),
      tides = runner(p, (ctx) => ({ kind: 'success', text: JSON.stringify(formation(ctx, 'earth.tides')) }));
    await tides.run(await job(p, second.activeRunId!), signal());
    const connect = runner(p, (ctx) => {
      const planets = ctx.facts.objects.filter((o) => o.kind === 'planet');
      return {
        kind: 'success',
        text: JSON.stringify({
          version: 'cartographer-proposal.v1',
          operations: [
            {
              kind: 'connect_route',
              fromKey: planets[0]!.key,
              toKey: planets[1]!.key,
              supportRefs: ctx.facts.supports.map((s) => s.ref),
            },
          ],
        }),
      };
    });
    const req = await request(p.authority, { commandId: randomUUID() });
    if (req.kind !== 'accepted') throw new Error('CI request refused');
    await connect.run(await job(p, req.runId), signal());
    const connected = await snapshot(p);
    if (connected.status !== 'ready') throw new Error('CI ready expected');
    expect(connected.page.routes).toHaveLength(1);
    const route = connected.page.routes[0]!;
    const withdraw = runner(p, (ctx) => ({
      kind: 'success',
      text: JSON.stringify({
        version: 'cartographer-proposal.v1',
        operations: [
          {
            kind: 'withdraw_relation',
            relationId: route.id,
            reason: 'organisation_correction',
            supportRefs: ctx.facts.supports.map((s) => s.ref),
          },
        ],
      }),
    }));
    const w = await request(p.authority, { commandId: randomUUID() });
    if (w.kind !== 'accepted') throw new Error('CI request refused');
    await withdraw.run(await job(p, w.runId), signal());
    const withdrawn = await snapshot(p);
    if (withdrawn.status !== 'ready') throw new Error('CI ready expected');
    expect(withdrawn.page.routes[0]).toMatchObject({
      id: route.id,
      originTransitionId: route.originTransitionId,
      fromObjectId: route.fromObjectId,
      toObjectId: route.toObjectId,
      status: 'withdrawn',
    });
    const page = await snapshot(p, { selection: { kind: 'universe' }, limit: 1 });
    if (page.status !== 'ready') throw new Error('CI page expected');
    expect(page.page.routes).toHaveLength(1);
    // Explicit corrupt alias fixture, not an application write path: cross-truth alias must fail closed.
    const planet = withdrawn.page.objects.find((o) => o.kind === 'planet')!,
      aliasId = randomUUID();
    const existing = await scope()(p.authority, (s) => geographyStore.view(s));
    if (existing.kind !== 'entered') throw new Error('CI scope refused');
    const sourceObject = existing.value.objects.find((o) => o.id === planet.id)!,
      originalSystem = existing.value.objects.find((o) => o.key === sourceObject.parentKey)!;
    const hypotheticalSystem = {
      ...originalSystem,
      id: randomUUID(),
      key: originalSystem.key.replace(':factual', ':hypothetical'),
      truthStatus: 'hypothetical' as const,
    };
    const hypothetical = {
      ...sourceObject,
      id: randomUUID(),
      key: sourceObject.key.replace(':factual', ':hypothetical'),
      parentKey: hypotheticalSystem.key,
      truthStatus: 'hypothetical' as const,
    };
    await database.db
      .insertInto('geography.objects')
      .values(
        [hypotheticalSystem, hypothetical].map((o) => ({
          universe_id: p.universeId,
          privacy_epoch: 1,
          id: o.id,
          semantic_key: o.key,
          payload: JSON.stringify(o),
          support_refs: JSON.stringify([]),
        })),
      )
      .execute();
    expect(await snapshot(p)).toMatchObject({ status: 'ready' });
    await database.db
      .insertInto('geography.relations')
      .values({
        universe_id: p.universeId,
        privacy_epoch: 1,
        id: aliasId,
        semantic_key: 'ci-forbidden-alias',
        kind: 'alias',
        payload: {
          kind: 'alias',
          id: aliasId,
          relationRevision: 4,
          originTransitionId: route.originTransitionId,
          status: 'current',
          fromObjectId: hypothetical.id,
          toObjectId: planet.id,
        },
        support_refs: JSON.stringify([]),
      })
      .execute();
    expect(await snapshot(p)).toMatchObject({ status: 'unavailable', reason: 'temporarily_unavailable' });
  });
  it('raw discovery overflow is unavailable, never a truncated set of formation witnesses', async () => {
    const p = await seedPerson(database.db),
      f = await fixture(),
      e = await observe(p, f);
    await scope()(p.authority, async (sc) => {
      // Deliberately invalid RAW discovery overflow, never a claim of semantic support.
      // Copy the actual modern complete source binding so every real composite FK remains valid.
      const source = await transactionOf(sc)
        .selectFrom('personal_context.recording_coverage_references')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .where('exposure_id', '=', e.exposureId)
        .executeTakeFirstOrThrow();
      const rows = Array.from({ length: 1001 }, (_, i) => ({
        ...source,
        topic_id: `ci.overflow.${i}`,
        facet_id: `ci.overflow.${i}.facet`,
      }));
      await transactionOf(sc).insertInto('personal_context.recording_coverage_references').values(rows).execute();
      expect(await base.readInputs(sc)).toMatchObject({
        availability: 'unavailable',
        completeness: 'not_asserted',
        probes: [],
      });
    });
    const r = runner(p),
      s = await state(p);
    await r.run(await job(p, s.activeRunId!), signal());
    expect(r.model.calls).toHaveLength(0);
    expect(await snapshot(p)).toMatchObject({ status: 'empty' });
  });
  it('hint-enqueue failure rolls back objects/delta/root revision; kept real harness answer applies once without resend', async () => {
    const p = await seedPerson(database.db);
    await coherent(p);
    const s = await state(p),
      r = runner(p);
    let fail = true;
    const run = makeRunCartographer({
      ...r.ports,
      enqueueDelta: async (sc, d) => {
        await base.enqueueDelta(sc, d);
        if (fail) throw new Error('CI injected after real delta job');
      },
    });
    const before = await database.db
      .selectFrom('identity.universes')
      .select('revision')
      .where('id', '=', p.universeId)
      .executeTakeFirstOrThrow();
    await expect(run(await job(p, s.activeRunId!), signal())).rejects.toThrow('CI injected');
    expect((await state(p)).revision).toBe(0);
    expect(
      await database.db.selectFrom('geography.objects').select('id').where('universe_id', '=', p.universeId).execute(),
    ).toHaveLength(0);
    expect(
      await database.db
        .selectFrom('geography.deltas')
        .select('revision')
        .where('universe_id', '=', p.universeId)
        .execute(),
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
          publishDeltaQueue.name,
          p.universeId,
        ])
      ).rows,
    ).toHaveLength(0);
    fail = false;
    expect(await request(p.authority, { commandId: randomUUID(), resumeRunId: s.activeRunId! })).toMatchObject({
      kind: 'refused',
      reason: 'run_not_resumable',
    });
    // Recovery is claim-fenced. Explicit resume requires claim expiry, never a second remote run.
    const frozen = await database.db
      .selectFrom('geography.runs')
      .select(['context', 'recording_context_sha256', 'recording_model_context_sha256'])
      .where('universe_id', '=', p.universeId)
      .where('id', '=', s.activeRunId!)
      .executeTakeFirstOrThrow();
    expect(frozen.context).not.toBeNull();
    expect(frozen.recording_context_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(frozen.recording_model_context_sha256).toMatch(/^[a-f0-9]{64}$/);
    const active = await scope()(p.authority, async (sc) => {
      if ((await base.fenceOwn(sc)).kind !== 'active') throw new Error('CI own');
      if ((await fencePersonalRecording(sc, 1)).kind !== 'recording') throw new Error('CI original generation');
      const old = await geographyStore.header(sc, s.activeRunId!);
      if (!old) throw new Error('CI run absent');
      await geographyStore.writeRun(sc, { ...old, claimUntil: new Date(Date.now() - 1000).toISOString() });
    });
    expect(active.kind).toBe('entered');
    expect(
      await database.db
        .selectFrom('geography.runs')
        .select(['context', 'recording_context_sha256', 'recording_model_context_sha256'])
        .where('universe_id', '=', p.universeId)
        .where('id', '=', s.activeRunId!)
        .executeTakeFirstOrThrow(),
    ).toEqual(frozen);
    await request(p.authority, { commandId: randomUUID(), resumeRunId: s.activeRunId! });
    await run(await job(p, s.activeRunId!), signal());
    expect(r.model.calls).toHaveLength(1);
    expect(await snapshot(p)).toMatchObject({ status: 'ready', geography: { revision: 1 } });
  });
  it('required Scene hook failure rolls back the actual Geography apply, root, delta and both required jobs', async () => {
    const p = await seedPerson(database.db);
    await coherent(p);
    const before = await database.db
      .selectFrom('identity.universes')
      .select('revision')
      .where('id', '=', p.universeId)
      .executeTakeFirstOrThrow();
    await expect(
      manualApply(p, (cap, ctx, runId, close) =>
        applyProposal(
          {
            ...base,
            applied: async (scope, input) => {
              await base.applied(scope, input);
              throw new Error('CI required Scene enqueue failure');
            },
          },
          cap,
          runId,
          ctx,
          formation(ctx),
          close,
        ),
      ),
    ).rejects.toThrow('CI required Scene enqueue failure');
    expect((await state(p)).revision).toBe(0);
    for (const table of ['geography.objects', 'geography.deltas'] as const)
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
        await database.pool.query("select name from pgboss.job where name=any($1) and data->>'universeId'=$2", [
          [projectSceneQueue.name, publishDeltaQueue.name],
          p.universeId,
        ])
      ).rows,
    ).toHaveLength(0);
  });
  it('Content withdrawal without a new observation invalidates an in-flight proposal; no stale delta applies', async () => {
    const p = await seedPerson(database.db),
      assets = await coherent(p);
    let entered!: () => void, release!: (v: FixtureScenario) => void;
    const ready = new Promise<void>((r) => {
        entered = r;
      }),
      held = new Promise<FixtureScenario>((r) => {
        release = r;
      });
    let frozen!: GeographyContext;
    const r = runner(p, (ctx) => {
        frozen = ctx;
        entered();
        return { kind: 'hold', until: held };
      }),
      s = await state(p),
      running = r.run(await job(p, s.activeRunId!), signal());
    await ready;
    await database.db
      .updateTable('content.assets')
      .set({ status: 'withdrawn' })
      .where('id', '=', assets[0]!.assetId)
      .execute();
    release({ kind: 'success', text: JSON.stringify(formation(frozen)) });
    await running;
    expect(r.model.calls).toHaveLength(1);
    expect(await snapshot(p)).toMatchObject({ status: 'empty', geography: { revision: 0 } });
    expect(
      (
        await database.db
          .selectFrom('geography.runs')
          .select('outcome')
          .where('id', '=', s.activeRunId!)
          .executeTakeFirstOrThrow()
      ).outcome,
    ).toBe('source_changed');
  });
  it('trusted authority SHARE locks fence withdrawal through the complete atomic apply transaction', async () => {
    const p = await seedPerson(database.db),
      assets = await coherent(p);
    let locked!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => {
        locked = r;
      }),
      held = new Promise<void>((r) => {
        release = r;
      });
    const applying = manualApply(p, async (cap, ctx, runId, close) => {
      const applied = await applyProposal(base, cap, runId, ctx, formation(ctx), close);
      locked();
      await held;
      return applied;
    });
    await ready;
    const withdrawal = database.db
      .updateTable('content.assets')
      .set({ status: 'withdrawn' })
      .where('id', '=', assets[0]!.assetId)
      .execute();
    try {
      await expect
        .poll(async () => {
          const rows = await sql<{
            n: number;
          }>`select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`.execute(
            database.db,
          );
          return rows.rows[0]?.n ?? 0;
        })
        .toBeGreaterThan(0);
    } finally {
      release();
    }
    expect(await applying).toMatchObject({ kind: 'entered', value: { kind: 'applied' } });
    await withdrawal;
    expect(await snapshot(p)).toMatchObject({ status: 'lagging', geography: { revision: 1 } });
  });
  it('quiet activity and label updates retain IDs/origins/structure; cursor expiry and catch-up gaps are explicit', async () => {
    const p = await seedPerson(database.db);
    const recent = await coherent(p);
    const initial = runner(p),
      s = await state(p);
    await initial.run(await job(p, s.activeRunId!), signal());
    const before = await snapshot(p);
    if (before.status !== 'ready') throw new Error('CI ready expected');
    const planet = before.page.objects.find((o) => o.kind === 'planet')!;
    // Authored elapsed-reading fixtures, not future role/lease/queue clocks. Replace current
    // authority with actually projected aged witnesses; prior recent certificates cannot win.
    for (let i = 0; i < recent.length; i++) {
      const old = recent[i]!;
      const aged = await fixture(
        old.unit,
        topic,
        old.map.bindings.map((b) => b.facetId),
      );
      await observe(p, aged, [], 40 * 24 * 60);
      await database.db
        .updateTable('content.assets')
        .set({ status: 'withdrawn' })
        .where('id', '=', old.assetId)
        .execute();
    }
    const quiet = runner(p, (ctx) => ({
      kind: 'success',
      text: JSON.stringify({
        version: 'cartographer-proposal.v1',
        operations: [
          {
            kind: 'set_activity',
            objectId: planet.id,
            state: 'quiet',
            supportRefs: ctx.facts.supports.map((s) => s.ref),
          },
        ],
      }),
    }));
    const q = await request(p.authority, { commandId: randomUUID() });
    if (q.kind !== 'accepted') throw new Error('CI request refused');
    await quiet.run(await job(p, q.runId), signal());
    const after = await snapshot(p);
    expect(after).toMatchObject({
      status: 'ready',
      geography: { revision: 2, structureRevision: 1, activityRevision: 2 },
    });
    if (after.status === 'ready')
      expect(after.page.objects.find((o) => o.id === planet.id)).toMatchObject({
        originTransitionId: planet.originTransitionId,
        activity: { availability: 'available', state: 'quiet' },
      });
    const rename = runner(p, (ctx) => ({
      kind: 'success',
      text: JSON.stringify({
        version: 'cartographer-proposal.v1',
        operations: [
          {
            kind: 'revise_label',
            objectId: planet.id,
            label: ctx.facts.objects.find((o) => o.id === planet.id)!.labels[1],
            supportRefs: ctx.facts.supports.map((s) => s.ref),
          },
        ],
      }),
    }));
    const n = await request(p.authority, { commandId: randomUUID() });
    if (n.kind !== 'accepted') throw new Error('CI request refused');
    await rename.run(await job(p, n.runId), signal());
    const final = await snapshot(p);
    expect(final).toMatchObject({
      status: 'ready',
      geography: { revision: 3, structureRevision: 3, activityRevision: 2 },
    });
    if (final.status === 'ready')
      expect(final.page.objects.find((o) => o.id === planet.id)).toMatchObject({
        originTransitionId: planet.originTransitionId,
      });
    expect(await deltas(p.authority, { afterGeographyRevision: 0, limit: 1 })).toMatchObject({
      kind: 'read',
      deltas: { status: 'available', hasMore: true, deltas: [{ base: { revision: 0 }, geography: { revision: 1 } }] },
    });
    // Authored snapshot-gap fixture ONLY: no production Geography retention pruner exists.
    // Normal full/Clear already erase Scenes before Geography. Preserve the restrictive FK
    // here by removing this exact delivery fact and exact delta together under the own root.
    await scope()(p.authority, async (sc) => {
      const tx = transactionOf(sc);
      const gap = await tx
        .selectFrom('geography.deltas')
        .select('transition_id')
        .where('universe_id', '=', p.universeId)
        .where('privacy_epoch', '=', 1)
        .where('revision', '=', 1)
        .executeTakeFirstOrThrow();
      await tx
        .deleteFrom('scenes.formation_presentations')
        .where('universe_id', '=', p.universeId)
        .where('privacy_epoch', '=', 1)
        .where('transition_id', '=', gap.transition_id)
        .execute();
      await tx
        .deleteFrom('geography.deltas')
        .where('universe_id', '=', p.universeId)
        .where('privacy_epoch', '=', 1)
        .where('revision', '=', 1)
        .execute();
    });
    expect(await deltas(p.authority, { afterGeographyRevision: 0, limit: 10 })).toMatchObject({
      kind: 'read',
      deltas: { status: 'snapshot_required' },
    });
  });
  it('unknown attempts never resend, account suspension gates workers, and reset fences late completion then erases all stores', async () => {
    const p = await seedPerson(database.db);
    await coherent(p);
    const r = runner(p, () => ({ kind: 'timeout_after_dispatch' })),
      s = await state(p);
    await r.run(await job(p, s.activeRunId!), signal());
    await request(p.authority, { commandId: randomUUID(), resumeRunId: s.activeRunId! });
    await r.run(await job(p, s.activeRunId!), signal());
    expect(r.model.calls).toHaveLength(1);
    expect((await attemptsOf(database.db, p.universeId)).map((a) => a.state)).toEqual(['unknown']);
    // The Cartographer runs because the person read, so its attempt counts against the background share.
    expect(await receiptClassesOf(database.db, p.universeId)).toEqual([
      { role_id: 'geography.cartographer', background: true },
    ]);
    const suspended = await seedPerson(database.db);
    await coherent(suspended);
    const susp = runner(suspended),
      ss = await state(suspended);
    await database.db
      .updateTable('identity.accounts')
      .set({ status: 'suspended' })
      .where('id', '=', suspended.accountId)
      .execute();
    await susp.run(await job(suspended, ss.activeRunId!), signal());
    expect(susp.model.calls).toHaveLength(0);
    // Account revocation while the model is outside the transaction also fences completion.
    const revoked = await seedPerson(database.db);
    await coherent(revoked);
    let onDispatch!: () => void, finishDispatch!: (v: FixtureScenario) => void;
    const dispatched = new Promise<void>((resolve) => {
      onDispatch = resolve;
    });
    const pendingAnswer = new Promise<FixtureScenario>((resolve) => {
      finishDispatch = resolve;
    });
    let revokedContext!: GeographyContext;
    const revoking = runner(revoked, (ctx) => {
      revokedContext = ctx;
      onDispatch();
      return { kind: 'hold', until: pendingAnswer };
    });
    const revokedState = await state(revoked);
    const pendingRun = revoking.run(await job(revoked, revokedState.activeRunId!), signal());
    await dispatched;
    await database.db
      .updateTable('identity.accounts')
      .set({ status: 'suspended' })
      .where('id', '=', revoked.accountId)
      .execute();
    finishDispatch({ kind: 'success', text: JSON.stringify(formation(revokedContext)) });
    await pendingRun;
    // Raw fixture inspection must not impersonate the now-suspended account actor.
    expect(
      await database.db
        .selectFrom('geography.state')
        .select('revision')
        .where('universe_id', '=', revoked.universeId)
        .where('privacy_epoch', '=', 1)
        .executeTakeFirstOrThrow(),
    ).toEqual({ revision: 0 });
    expect(
      await database.db
        .selectFrom('geography.deltas')
        .select('revision')
        .where('universe_id', '=', revoked.universeId)
        .execute(),
    ).toEqual([]);
    expect(await request(revoked.authority, { commandId: randomUUID() })).toEqual({
      kind: 'refused',
      reason: 'scope_refused',
    });
    const late = await seedPerson(database.db);
    await coherent(late);
    let entered!: () => void, release!: (v: FixtureScenario) => void;
    const ready = new Promise<void>((r) => {
        entered = r;
      }),
      held = new Promise<FixtureScenario>((r) => {
        release = r;
      });
    let frozen!: GeographyContext;
    const worker = runner(late, (ctx) => {
        frozen = ctx;
        entered();
        return { kind: 'hold', until: held };
      }),
      ls = await state(late),
      running = worker.run(await job(late, ls.activeRunId!), signal());
    await ready;
    await database.db
      .updateTable('identity.universes')
      .set({ privacy_epoch: 2 })
      .where('id', '=', late.universeId)
      .execute();
    release({ kind: 'success', text: JSON.stringify(formation(frozen)) });
    await running;
    expect(await read(late.authority, { selection: { kind: 'universe' }, limit: 100 })).toEqual({
      kind: 'refused',
      reason: 'scope_refused',
    });
    const fresh = { ...late.authority, privacyEpoch: 2 };
    await scope()(fresh, (sc) => eraseUniverse(sc, personalStores));
    for (const table of [
      'geography.objects',
      'geography.relations',
      'geography.state',
      'geography.runs',
      'geography.deltas',
      'reasoning.protected_requests',
    ] as const)
      expect(
        await database.db.selectFrom(table).select('universe_id').where('universe_id', '=', late.universeId).execute(),
      ).toHaveLength(0);
    expect(
      (await database.pool.query("select id from pgboss.job where data->>'universeId'=$1", [late.universeId])).rows,
    ).toHaveLength(0);
  });
});
