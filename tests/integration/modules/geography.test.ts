import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { makeEnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import {
  makeWithPersonalScope,
  transactionOf,
  insideTransaction,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { identityScopeOwnerProviders } from '@knowscroll/backend/modules/identity/nest-providers';
import {
  makeAdmitCoverage,
  makeCoverageAdmissionPorts,
  coverageCatalogue,
} from '@knowscroll/backend/modules/content/nest-providers';
import {
  COVERAGE_POLICY,
  CONCEPT_CATALOGUE_VERSION,
  type CoverageMapping,
  type CoverageCommand,
} from '@knowscroll/backend/modules/content';
import { READ_COVERAGE_INPUTS, READ_TRUSTED_COVERAGE } from '@knowscroll/backend/modules/personal-context';
import { personalContextProviders } from '@knowscroll/backend/modules/personal-context/nest-providers';
import {
  GEOGRAPHY_MATERIAL_CHANGE,
  REQUEST_CARTOGRAPHY,
  READ_OWN_GEOGRAPHY,
  READ_OWN_DELTAS,
  PUBLISH_GEOGRAPHY_DELTA,
  publishDeltaQueue,
  type MaterialGeographyChange,
  type RequestCartography,
  type ReadOwnGeography,
  type ReadOwnDeltas,
  type PublishGeographyDelta,
} from '@knowscroll/backend/modules/geography';
import {
  geographyProviders,
  GEOGRAPHY_PORTS,
  geographyStore,
  makeRunCartographer,
  applyProposal,
  prepareGeography,
  type GeographyPorts,
  type CartographerPorts,
  type GeographyContext,
} from '@knowscroll/backend/modules/geography/nest-providers';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import { fixtureHarness, fixtureModel, attemptsOf, signal } from '../support/fixture-model.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { scrollUseCases, starterSource } from '../support/scroll.js';
import { buildFromProviders } from '../support/providers.js';
import { activatedAgo, coverage, dwell, event, openActive } from '../support/observations.js';

/** Authored CI sources/maps/model proposals only. No source approval, provider or real formation claim. */
describe('Geography current trusted-coverage consumer (real PostgreSQL CI fixtures)', () => {
  let database: TestDatabase<Database>, c: Awaited<ReturnType<typeof scrollUseCases>>, base: GeographyPorts;
  let material: MaterialGeographyChange,
    request: RequestCartography,
    read: ReadOwnGeography,
    deltas: ReadOwnDeltas,
    publish: PublishGeographyDelta;
  const approvals = new Map<string, string>();
  const scope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
  beforeAll(async () => {
    database = await createTestDatabase<Database>('geography');
    c = await scrollUseCases(database, { activityMaterialChange: (s, x) => material(s, x) });
    const SCOPE = Symbol('scope'),
      ENQUEUE = Symbol('enqueue'),
      providers = geographyProviders({ withPersonalScope: SCOPE, enqueueJob: ENQUEUE });
    const values = new Map<symbol, unknown>([
      [SCOPE, scope()],
      [ENQUEUE, makeEnqueueJob(c.boss)],
      [READ_TRUSTED_COVERAGE, c.readTrustedCoverage],
      [READ_COVERAGE_INPUTS, buildFromProviders(personalContextProviders(), READ_COVERAGE_INPUTS, new Map())],
      ...identityScopeOwnerProviders().map((p) => [p.provide, p.useValue] as const),
    ]);
    const get = <T>(token: symbol): T => {
      const value = buildFromProviders(providers, token, values);
      values.set(token, value);
      return value as T;
    };
    base = get(GEOGRAPHY_PORTS);
    material = get(GEOGRAPHY_MATERIAL_CHANGE);
    request = get(REQUEST_CARTOGRAPHY);
    read = get(READ_OWN_GEOGRAPHY);
    deltas = get(READ_OWN_DELTAS);
    publish = get(PUBLISH_GEOGRAPHY_DELTA);
  });
  afterAll(async () => {
    await c.close();
    await database.drop();
  });
  const topic = 'earth.seasons',
    facet = 'earth.seasons.axial-tilt',
    otherFacet = 'earth.seasons.hemispheres';
  async function fixture(unit = `ci-geography-unit-${randomUUID()}`, t = topic, facets = [facet]) {
    const source = starterSource() as {
      assetId: string;
      reference: string;
      publication: { explanationUnitId: string };
      draft: { title: string };
    };
    source.assetId = randomUUID();
    source.reference = 'ci-only-synthetic-geography-map';
    source.publication.explanationUnitId = unit;
    source.draft.title = 'Authored CI Geography source';
    const imported = await c.importScroll(source);
    if (imported.kind !== 'imported') throw new Error('CI fixture import refused');
    await database.db
      .insertInto('content.encounter_topics')
      .values({ asset_id: source.assetId, asset_revision: 1, topic_id: t, role: 'primary', weight: 1 })
      .execute();
    const row = await database.db
      .selectFrom('content.asset_revisions')
      .select(['document_sha256', 'reading_facts'])
      .where('asset_id', '=', source.assetId)
      .executeTakeFirstOrThrow();
    const provenance = await database.db
      .selectFrom('content.asset_provenance')
      .select('provenance')
      .where('asset_id', '=', source.assetId)
      .executeTakeFirstOrThrow();
    const map: CoverageMapping = {
      version: COVERAGE_POLICY,
      documentSha256: row.document_sha256,
      provenanceSha256: canonicalSha256(provenance.provenance),
      explanationUnitId: unit,
      framing: 'factual',
      framingSha256: canonicalSha256({ kind: 'factual' }),
      readingFactsVersion: 2,
      readingFactsSha256: canonicalSha256(row.reading_facts),
      catalogueVersion: CONCEPT_CATALOGUE_VERSION,
      catalogueSha256: coverageCatalogue.sha256,
      bindings: facets.map((f) => ({
        topicId: t,
        facetId: f,
        meaningSha256: coverageCatalogue.meaningSha256(t, f)!,
        requiredBlockIds: f === facets[0] ? ['intro-look-up'] : ['intro-look-up', 'intro-short-version'],
      })),
    };
    const command: CoverageCommand = {
      version: 'content-coverage-command.v1',
      assetId: source.assetId,
      assetRevision: 1,
      expectedHeadRevision: 0,
      semanticReviewReference: 'ci-geography-semantic-fixture-only',
      change: { kind: 'admit', mapping: map },
    };
    approvals.set(canonicalSha256(command), command.semanticReviewReference);
    await makeAdmitCoverage(makeCoverageAdmissionPorts(database.db, (digest, ref) => approvals.get(digest) === ref))(
      command,
    );
    return {
      assetId: source.assetId,
      revision: 1,
      unit,
      map,
      command,
      blocks: (row.reading_facts as { blocks: { id: string }[] }).blocks.map((b) => b.id),
    };
  }
  async function observe(p: FixturePerson, f: Awaited<ReturnType<typeof fixture>>, omit: string[] = []) {
    const e = await openActive(c, p, f);
    await activatedAgo(database.db, e.exposureId, 20);
    await c.ingestObservations(p.authority, {
      instrumentationVersion: 1,
      events: [
        event(
          e,
          coverage(
            f.blocks.filter((id) => !omit.includes(id)),
            1000,
          ),
        ),
        event(e, dwell([0, 700000])),
      ],
    });
    expect(
      await c.projectScrollReading({ v: 1, universeId: p.universeId, privacyEpoch: 1, exposureId: e.exposureId }),
    ).toMatchObject({ kind: 'applied', qualification: 'qualified' });
    expect(
      await c.projectActivity({ v: 1, universeId: p.universeId, privacyEpoch: 1, exposureId: e.exposureId }),
    ).toMatchObject({ kind: 'applied' });
    return e;
  }
  async function coherent(p: FixturePerson) {
    const assets = [];
    for (let i = 0; i < 3; i++) {
      const f = await fixture(undefined, topic, [i === 1 ? otherFacet : facet]);
      assets.push(f);
      await observe(p, f);
    }
    return assets;
  }
  async function state(p: FixturePerson) {
    const result = await scope()(p.authority, (s) => geographyStore.state(s));
    if (result.kind !== 'entered') throw new Error('CI scope refused');
    return result.value;
  }
  async function context(p: FixturePerson, runId: string) {
    return (
      await database.db
        .selectFrom('geography.runs')
        .select('context')
        .where('universe_id', '=', p.universeId)
        .where('id', '=', runId)
        .executeTakeFirstOrThrow()
    ).context as unknown as GeographyContext;
  }
  const job = (p: FixturePerson, runId: string) => ({
    v: 1 as const,
    universeId: p.universeId,
    privacyEpoch: 1,
    runId,
  });
  const formation = (ctx: GeographyContext, t = topic) => ({
    version: 'cartographer-proposal.v1' as const,
    operations: ctx.facts.candidates
      .filter(
        (x) =>
          x.kind === 'system' ||
          x.kind === 'star' ||
          (x.kind === 'planet' && x.conceptId === t) ||
          (x.kind === 'region' && ctx.facts.supports.some((s) => s.topicId === t && s.facetId === x.conceptId)),
      )
      .filter((x) => !ctx.facts.objects.some((o) => o.key === x.key))
      .map((x) => ({
        kind: (
          { system: 'create_system', star: 'establish_star', planet: 'form_planet', region: 'add_region' } as const
        )[x.kind],
        key: x.key,
        label: x.labels[0]!,
        truthStatus: 'factual' as const,
        supportRefs: ctx.facts.supports
          .filter(
            (s) =>
              x.kind === 'system' ||
              x.kind === 'star' ||
              (x.kind === 'planet' ? s.topicId === x.conceptId : s.facetId === x.conceptId),
          )
          .map((s) => s.ref),
      })),
  });
  function runner(
    p: FixturePerson,
    script?: (ctx: GeographyContext, sequence: number) => FixtureScenario | Promise<FixtureScenario>,
    overrides: Partial<CartographerPorts> = {},
  ) {
    const model = fixtureModel(
      async (sequence) => {
        expect(insideTransaction()).toBe(false);
        const active = (await state(p)).activeRunId!;
        const ctx = await context(p, active);
        return script ? script(ctx, sequence) : { kind: 'success', text: JSON.stringify(formation(ctx)) };
      },
      { label: 'geography-authored-ci-only' },
    );
    const ports: CartographerPorts = {
      ...base,
      harness: fixtureHarness(database.db, { model }).harness,
      enabled: () => true,
      permitted: () => Promise.resolve(true),
      ...overrides,
    };
    return { model, ports, run: makeRunCartographer(ports) };
  }
  async function snapshot(
    p: FixturePerson,
    query: Parameters<ReadOwnGeography>[1] = { selection: { kind: 'universe' }, limit: 100 },
  ) {
    const r = await read(p.authority, query);
    if (r.kind !== 'read') throw new Error('CI geography read refused');
    return r.snapshot;
  }
  async function scopeApply(
    p: FixturePerson,
    runId: string,
    ctx: GeographyContext,
    proposal: ReturnType<typeof formation>,
    ports = base,
  ) {
    return scope()(p.authority, (s) => applyProposal(ports, s, runId, ctx, proposal));
  }
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
    await r.run(job(p, req.runId), signal());
    expect(r.model.calls).toHaveLength(0);
    expect(await snapshot(p)).toMatchObject({ status: 'empty', geography: { revision: 0 } });
  });
  it('shipped feature-off and absent economic permit each block real queued work without attempts; receipts coalesce/replay', async () => {
    const p = await seedPerson(database.db);
    await coherent(p);
    const c0 = { commandId: randomUUID() },
      a = await request(p.authority, c0);
    expect(await request(p.authority, c0)).toEqual(a);
    if (a.kind !== 'accepted') throw new Error('CI request refused');
    const r = runner(p, undefined, { enabled: () => false });
    await r.run(job(p, a.runId), signal());
    expect(r.model.calls).toHaveLength(0);
    expect(
      (
        await database.db
          .selectFrom('geography.runs')
          .select('outcome')
          .where('id', '=', a.runId)
          .executeTakeFirstOrThrow()
      ).outcome,
    ).toBe('disabled');
    await request(p.authority, { commandId: randomUUID(), resumeRunId: a.runId });
    await makeRunCartographer({ ...r.ports, enabled: () => true, permitted: () => Promise.resolve(false) })(
      job(p, a.runId),
      signal(),
    );
    expect(
      (
        await database.db
          .selectFrom('geography.runs')
          .select('outcome')
          .where('id', '=', a.runId)
          .executeTakeFirstOrThrow()
      ).outcome,
    ).toBe('budget_unavailable');
    expect(await attemptsOf(database.db, p.universeId)).toHaveLength(0);
    expect(await snapshot(p)).toMatchObject({ status: 'empty' });
  });
  it('repeated actual variants remain one unit; ALL-OF missing leaves cannot supply a second facet', async () => {
    const p = await seedPerson(database.db),
      unit = `ci-one-unit-${randomUUID()}`;
    for (let i = 0; i < 3; i++)
      await observe(p, await fixture(unit, topic, [facet, otherFacet]), ['intro-short-version']);
    const r = runner(p),
      s = await state(p);
    await r.run(job(p, s.activeRunId!), signal());
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
  it('three qualified units with only one actual supported facet cannot partially apply an invalid planet proposal', async () => {
    const p = await seedPerson(database.db);
    for (let i = 0; i < 3; i++) await observe(p, await fixture());
    const r = runner(p),
      s = await state(p);
    await r.run(job(p, s.activeRunId!), signal());
    expect(r.model.calls).toHaveLength(2);
    expect(await snapshot(p)).toMatchObject({ status: 'empty', geography: { revision: 0 } });
    expect(
      await database.db.selectFrom('geography.objects').select('id').where('universe_id', '=', p.universeId).execute(),
    ).toHaveLength(0);
  });
  it('three coherent qualified units plus two actual facets form stable meaning; pages/deltas and required hint job are real', async () => {
    const p = await seedPerson(database.db);
    await coherent(p);
    const s = await state(p),
      r = runner(p);
    const runningJob = job(p, s.activeRunId!);
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
    const frozen = await context(p, s.activeRunId!);
    expect(await scopeApply(p, s.activeRunId!, frozen, formation(frozen))).toMatchObject({
      kind: 'entered',
      value: { kind: 'replayed', delta: { transitionId: transition } },
    });
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
    await initial.run(job(p, first.activeRunId!), signal());
    for (let i = 0; i < 3; i++)
      await observe(
        p,
        await fixture(undefined, 'earth.tides', [i === 1 ? 'earth.tides.alignment' : 'earth.tides.forcing']),
      );
    const second = await state(p),
      tides = runner(p, (ctx) => ({ kind: 'success', text: JSON.stringify(formation(ctx, 'earth.tides')) }));
    await tides.run(job(p, second.activeRunId!), signal());
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
    await connect.run(job(p, req.runId), signal());
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
    await withdraw.run(job(p, w.runId), signal());
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
  it('indexed PC discovery overflow is unavailable, never a truncated set of formation witnesses', async () => {
    const p = await seedPerson(database.db),
      f = await fixture(),
      e = await observe(p, f);
    await scope()(p.authority, async (sc) => {
      const rows = Array.from({ length: 101 }, (_, i) => ({
        universe_id: p.universeId,
        privacy_epoch: 1,
        exposure_id: e.exposureId,
        topic_id: `ci.overflow.${i}`,
        facet_id: `ci.overflow.${i}.facet`,
        meaning_sha256: 'a'.repeat(64),
        explanation_unit_id: f.unit,
        truth_sha256: 'b'.repeat(64),
      }));
      await transactionOf(sc).insertInto('personal_context.coverage_references').values(rows).execute();
      expect(await base.readInputs(sc)).toMatchObject({
        availability: 'unavailable',
        completeness: 'not_asserted',
        probes: [],
      });
    });
    const r = runner(p),
      s = await state(p);
    await r.run(job(p, s.activeRunId!), signal());
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
    await expect(run(job(p, s.activeRunId!), signal())).rejects.toThrow('CI injected');
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
    const active = await scope()(p.authority, async (sc) => {
      const old = await geographyStore.run(sc, s.activeRunId!);
      if (!old) throw new Error('CI run absent');
      await geographyStore.writeRun(sc, { ...old, claimUntil: new Date(Date.now() - 1000).toISOString() });
    });
    expect(active.kind).toBe('entered');
    await request(p.authority, { commandId: randomUUID(), resumeRunId: s.activeRunId! });
    await run(job(p, s.activeRunId!), signal());
    expect(r.model.calls).toHaveLength(1);
    expect(await snapshot(p)).toMatchObject({ status: 'ready', geography: { revision: 1 } });
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
      running = r.run(job(p, s.activeRunId!), signal());
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
      assets = await coherent(p),
      s = await state(p);
    let locked!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => {
        locked = r;
      }),
      held = new Promise<void>((r) => {
        release = r;
      });
    const applying = scope()(p.authority, async (sc) => {
      const view = await geographyStore.view(sc),
        ctx = await prepareGeography(base, sc, view);
      if (!ctx) throw new Error('CI trusted context absent');
      const applied = await applyProposal(base, sc, s.activeRunId!, ctx, formation(ctx));
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
    await coherent(p);
    const initial = runner(p),
      s = await state(p);
    await initial.run(job(p, s.activeRunId!), signal());
    const before = await snapshot(p);
    if (before.status !== 'ready') throw new Error('CI ready expected');
    const planet = before.page.objects.find((o) => o.kind === 'planet')!;
    const quiet = runner(
      p,
      (ctx) => ({
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
      }),
      { now: () => new Date(Date.now() + 40 * 86400000) },
    );
    const q = await request(p.authority, { commandId: randomUUID() });
    if (q.kind !== 'accepted') throw new Error('CI request refused');
    await quiet.run(job(p, q.runId), signal());
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
    await rename.run(job(p, n.runId), signal());
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
    await database.db
      .deleteFrom('geography.deltas')
      .where('universe_id', '=', p.universeId)
      .where('revision', '=', 1)
      .execute();
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
    await r.run(job(p, s.activeRunId!), signal());
    await request(p.authority, { commandId: randomUUID(), resumeRunId: s.activeRunId! });
    await r.run(job(p, s.activeRunId!), signal());
    expect(r.model.calls).toHaveLength(1);
    expect((await attemptsOf(database.db, p.universeId)).map((a) => a.state)).toEqual(['unknown']);
    const suspended = await seedPerson(database.db);
    await coherent(suspended);
    const susp = runner(suspended),
      ss = await state(suspended);
    await database.db
      .updateTable('identity.accounts')
      .set({ status: 'suspended' })
      .where('id', '=', suspended.accountId)
      .execute();
    await susp.run(job(suspended, ss.activeRunId!), signal());
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
    const pendingRun = revoking.run(job(revoked, revokedState.activeRunId!), signal());
    await dispatched;
    await database.db
      .updateTable('identity.accounts')
      .set({ status: 'suspended' })
      .where('id', '=', revoked.accountId)
      .execute();
    finishDispatch({ kind: 'success', text: JSON.stringify(formation(revokedContext)) });
    await pendingRun;
    expect((await state(revoked)).revision).toBe(0);
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
      running = worker.run(job(late, ls.activeRunId!), signal());
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
