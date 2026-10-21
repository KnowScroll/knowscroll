import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import {
  SceneManifestReadSchema,
  SceneChunkReadSchema,
  type SceneClientCapabilities,
  type SceneManifestRead,
} from '@knowscroll/contracts';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { makeEnqueueJob, deadLetterQueueName } from '@knowscroll/backend/infrastructure/jobs';
import {
  makeWithPersonalScope,
  advanceScopeRevision,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { identityScopeOwnerProviders } from '@knowscroll/backend/modules/identity/nest-providers';
import { READ_COVERAGE_INPUTS, READ_TRUSTED_COVERAGE } from '@knowscroll/backend/modules/personal-context';
import { personalContextProviders } from '@knowscroll/backend/modules/personal-context/nest-providers';
import {
  GEOGRAPHY_APPLIED,
  READ_GEOGRAPHY_SCENE_INPUT,
  type ReadGeographySceneInput,
} from '@knowscroll/backend/modules/geography';
import {
  geographyProviders,
  geographyStore,
  GEOGRAPHY_PORTS,
  type GeographyPorts,
} from '@knowscroll/backend/modules/geography/nest-providers';
import {
  PROJECT_SCENE,
  READ_OWN_SCENE_MANIFEST,
  READ_OWN_SCENE_CHUNK,
  projectSceneQueue,
  type ProjectScene,
  type ReadOwnSceneManifest,
  type ReadOwnSceneChunk,
} from '@knowscroll/backend/modules/scenes';
import {
  sceneAppliedProviders,
  sceneProviders,
  SCENE_PORTS,
  sceneStore,
  makeProjectScene,
  type ScenePorts,
} from '@knowscroll/backend/modules/scenes/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { scrollUseCases } from '../support/scroll.js';
import { buildFromProviders } from '../support/providers.js';
const capabilities: SceneClientCapabilities = {
  version: 'scene-client.v1',
  descriptors: ['scene-descriptor.v1'],
  chunks: ['scene-chunk.v1'],
  manifests: ['scene-manifest.v1'],
  generators: ['silhouette.v1'],
  families: ['terraced.v1', 'ridged.v1', 'archipelago.v1'],
  detail: 'full',
  reducedMotion: false,
};
const query = { selection: { kind: 'universe' as const }, capabilities };
/** Authored PostgreSQL CI projection inputs only. Direct Geography rows below are NOT formation or runtime evidence. */
describe('persisted Scene projection (real PostgreSQL CI fixtures)', () => {
  let database: TestDatabase<Database>,
    c: Awaited<ReturnType<typeof scrollUseCases>>,
    geo: GeographyPorts,
    ports: ScenePorts,
    project: ProjectScene,
    read: ReadOwnSceneManifest,
    chunk: ReadOwnSceneChunk,
    input: ReadGeographySceneInput;
  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
  beforeAll(async () => {
    database = await createTestDatabase<Database>('scenes');
    c = await scrollUseCases(database);
    const SCOPE = Symbol('scope'),
      ENQUEUE = Symbol('enqueue');
    const providers = [
      ...sceneAppliedProviders({ enqueueJob: ENQUEUE }),
      ...geographyProviders({ withPersonalScope: SCOPE, enqueueJob: ENQUEUE }),
      ...sceneProviders({ withPersonalScope: SCOPE }),
    ];
    const values = new Map<symbol, unknown>([
      [SCOPE, withScope()],
      [ENQUEUE, makeEnqueueJob(c.boss)],
      [READ_TRUSTED_COVERAGE, c.readTrustedCoverage],
      [READ_COVERAGE_INPUTS, buildFromProviders(personalContextProviders(), READ_COVERAGE_INPUTS, new Map())],
      ...identityScopeOwnerProviders().map((p) => [p.provide, p.useValue] as const),
    ]);
    const get = <T>(token: symbol): T => {
      if (values.has(token)) return values.get(token) as T;
      const p = providers.find((p) => p.provide === token);
      if (!p) throw new Error('CI provider missing');
      for (const dep of p.inject) get(dep);
      const v = buildFromProviders(providers, token, values);
      values.set(token, v);
      return v as T;
    };
    geo = get(GEOGRAPHY_PORTS);
    ports = get(SCENE_PORTS);
    project = get(PROJECT_SCENE);
    read = get(READ_OWN_SCENE_MANIFEST);
    chunk = get(READ_OWN_SCENE_CHUNK);
    input = get(READ_GEOGRAPHY_SCENE_INPUT);
  });
  afterAll(async () => {
    await c.close();
    await database.drop();
  });
  async function fixture(person?: FixturePerson) {
    const p = person ?? (await seedPerson(database.db)),
      system = randomUUID(),
      star = randomUUID(),
      planet = randomUUID(),
      region = randomUUID(),
      transition = randomUUID();
    const key = (kind: string, concept: string) => `${kind}:${concept}:factual`;
    const places = [
      { id: system, kind: 'system' as const, conceptId: 'earth', parentKey: 'universe' },
      { id: star, kind: 'star' as const, conceptId: 'earth', parentKey: key('system', 'earth') },
      { id: planet, kind: 'planet' as const, conceptId: 'earth.seasons', parentKey: key('system', 'earth') },
      {
        id: region,
        kind: 'region' as const,
        conceptId: 'earth.seasons.axial-tilt',
        parentKey: key('planet', 'earth.seasons'),
      },
    ].map((o) => ({
      ...o,
      key: key(o.kind, o.conceptId),
      label:
        o.kind === 'planet'
          ? 'Seasons'
          : o.kind === 'region'
            ? 'Axial tilt'
            : o.kind === 'star'
              ? 'Earth star'
              : 'Earth',
      labels: ['Authored CI neutral label'],
      truthStatus: 'factual' as const,
      objectRevision: 1,
      originTransitionId: transition,
      activity: { availability: 'available' as const, state: 'active' as const },
    }));
    await withScope()(p.authority, async (s) => {
      for (const o of places) await geographyStore.saveObject(s, o, ['ci-private-support-never-scene']);
      const old = await geographyStore.state(s);
      await geographyStore.writeState(s, { ...old, revision: 1, structureRevision: 1 });
      const watermark = await advanceScopeRevision(s);
      await geo.applied(s, {
        transitionId: transition,
        geography: { revision: 1, structureRevision: 1, activityRevision: 0 },
        personalRevision: watermark,
      });
    });
    return { ...p, system, star, planet, region, transition, places };
  }
  async function jobs(p: FixturePerson) {
    return (
      await database.pool.query<{ data: Parameters<ProjectScene>[0]; state: string }>(
        "select data,state from pgboss.job where name=$1 and data->>'universeId'=$2 order by created_on",
        [projectSceneQueue.name, p.universeId],
      )
    ).rows;
  }
  async function snapshot(p: FixturePerson): Promise<SceneManifestRead> {
    const r = await read(p.authority, query);
    if (r.kind !== 'read') throw new Error('CI scene refused');
    expect(SceneManifestReadSchema.safeParse(r.scene).success).toBe(true);
    return r.scene;
  }
  async function root(p: FixturePerson) {
    return (
      await database.db
        .selectFrom('identity.universes')
        .select('revision')
        .where('id', '=', p.universeId)
        .executeTakeFirstOrThrow()
    ).revision;
  }
  it('empty read creates no seed, state, job or revision; capabilities and selectors are strict', async () => {
    const p = await seedPerson(database.db),
      before = await root(p);
    expect(await snapshot(p)).toMatchObject({ status: 'empty', sceneRevision: 0, manifest: { chunks: [] } });
    expect(await sceneStoreState(p)).toBeUndefined();
    expect(await jobs(p)).toHaveLength(0);
    expect(await root(p)).toBe(before);
    const unsupported = await read(p.authority, { ...query, capabilities: { ...capabilities, generators: [] } });
    expect(unsupported).toMatchObject({ kind: 'read', scene: { status: 'unsupported_version' } });
    expect(await read(p.authority, { ...query, selection: { kind: 'system', systemId: randomUUID() } })).toEqual({
      kind: 'refused',
      reason: 'selection_not_found',
    });
    await expect(
      read(p.authority, { ...query, capabilities: { ...capabilities, detail: 'invalid' } } as never),
    ).rejects.toThrow();
  });
  async function sceneStoreState(p: FixturePerson) {
    const r = await withScope()(p.authority, (s) => sceneStore.state(s));
    return r.kind === 'entered' ? r.value : undefined;
  }
  it('public Geography input uses the existing transaction and current root, omitting every private support field', async () => {
    const p = await fixture();
    const r = await withScope()(p.authority, async (s) => {
      const watermark = await advanceScopeRevision(s);
      const r = await input(s);
      expect(r.kind).toBe('read');
      if (r.kind !== 'read') throw new Error('CI input missing');
      expect(r.input.personalRevision).toBe(watermark);
      expect(r.input.personalRevision).toBeGreaterThan(s.revisionAtEntry);
      return r.input;
    });
    expect(r.kind).toBe('entered');
    if (r.kind !== 'entered') throw new Error('CI scope refused');
    expect(Object.keys(r.value).sort()).toEqual([
      'aliases',
      'geography',
      'objects',
      'personalRevision',
      'privacyEpoch',
      'routes',
      'universeId',
    ]);
    expect(JSON.stringify(r.value)).not.toMatch(/support|evidence|prompt|score|pcRevision|ci-private/);
    expect(r.value.objects.map((o) => o.meaningId)).toContain('earth.seasons');
    expect(await root(p)).toBe(2);
  });
  it('projects actual required work once, coalesces duplicates/out-of-order and keeps the input root distinct from its output advancement', async () => {
    const p = await fixture(),
      job = (await jobs(p))[0]!.data;
    expect(await snapshot(p)).toMatchObject({
      status: 'loading',
      pendingProjection: { geographyRevision: 1, personalRevision: 1 },
    });
    const before = await root(p);
    await Promise.all([project(job), project(job)]);
    const first = await snapshot(p);
    expect(first).toMatchObject({
      status: 'ready',
      sceneRevision: 1,
      scope: { personalWatermark: before + 1 },
      manifest: { revisions: { personalRevision: before, geographyRevision: 1 } },
    });
    const after = await root(p);
    await project(job);
    expect(await root(p)).toBe(after);
    await withScope()(p.authority, async (s) => {
      await advanceScopeRevision(s);
    });
    await project(job);
    expect((await snapshot(p)).status).toBe('ready');
    expect((await sceneStoreState(p))!.manifest!.revisions.sceneRevision).toBe(1);
    expect(
      (await database.pool.query('select id from reasoning.external_attempts where universe_id=$1', [p.universeId]))
        .rows,
    ).toHaveLength(0);
    expect(
      (await database.pool.query("select name from pgboss.job where data->>'universeId'=$1", [p.universeId])).rows.map(
        (r: { name: string }) => r.name,
      ),
    ).toEqual([projectSceneQueue.name]);
  });
  it('rolls back all Scene versions, descriptors and root on publication/notification failure; retry recovers', async () => {
    const p = await fixture(),
      job = (await jobs(p))[0]!.data,
      before = await root(p);
    const failing = makeProjectScene({ ...ports, notify: () => Promise.reject(new Error('CI notification failure')) });
    await expect(failing(job)).rejects.toThrow('CI notification failure');
    expect(await sceneStoreState(p)).toBeUndefined();
    expect(await root(p)).toBe(before);
    for (const table of ['objects', 'chunks', 'manifests'])
      expect(
        (await database.pool.query(`select * from scenes.${table} where universe_id=$1`, [p.universeId])).rows,
      ).toHaveLength(0);
    await project(job);
    expect((await snapshot(p)).status).toBe('ready');
  });
  it('pins appearance across a new sibling, quiet, relabel, restart and capability detail/motion; reuses unchanged chunks', async () => {
    const p = await fixture(),
      job = (await jobs(p))[0]!.data;
    await project(job);
    const first = await sceneStoreState(p);
    const stored = await withScope()(p.authority, (s) => sceneStore.objects(s));
    if (stored.kind !== 'entered') throw new Error('CI refused');
    await withScope()(p.authority, async (s) => {
      const old = await geographyStore.state(s);
      const planet = p.places.find((o) => o.id === p.planet)!;
      await geographyStore.saveObject(
        s,
        {
          ...planet,
          label: 'Seasons again',
          objectRevision: 2,
          activity: { availability: 'available', state: 'quiet' },
        },
        [],
      );
      await geographyStore.saveObject(
        s,
        {
          ...planet,
          id: randomUUID(),
          key: 'planet:earth.tides:factual',
          conceptId: 'earth.tides',
          label: 'Tides',
          originTransitionId: randomUUID(),
          objectRevision: 2,
        },
        [],
      );
      await geographyStore.writeState(s, { ...old, revision: 2, structureRevision: 2, activityRevision: 2 });
      const watermark = await advanceScopeRevision(s);
      await geo.applied(s, {
        transitionId: randomUUID(),
        geography: { revision: 2, structureRevision: 2, activityRevision: 2 },
        personalRevision: watermark,
      });
    });
    expect(await snapshot(p)).toMatchObject({
      status: 'lagging',
      sceneRevision: 1,
      pendingProjection: { geographyRevision: 2 },
    });
    // The oldest job coalesces the latest current input, with no extra model/evidence work.
    await makeProjectScene(ports)(job);
    expect(await snapshot(p)).toMatchObject({ status: 'ready', sceneRevision: 2 });
    const updated = await withScope()(p.authority, (s) => sceneStore.objects(s));
    if (updated.kind !== 'entered') throw new Error('CI refused');
    for (const old of stored.value) {
      const now = updated.value.find((o) => o.descriptor.objectId === old.descriptor.objectId)!;
      expect({
        ...now,
        descriptor: { ...now.descriptor, label: old.descriptor.label, activity: old.descriptor.activity },
      }).toEqual(old);
    }
    const low = await read(p.authority, {
      ...query,
      capabilities: { ...capabilities, detail: 'low', reducedMotion: true },
    });
    expect(low.kind === 'read' && 'manifest' in low.scene ? low.scene.manifest : undefined).toEqual(
      (await sceneStoreState(p))!.manifest,
    );
    expect(first!.worldSeed).toBe((await sceneStoreState(p))!.worldSeed);
    expect((await sceneStoreState(p))!.policyVersion).toBe('canonical-lattice.v1');
  });
  it('serves only selected exact current manifest references; foreign/old/unknown references never expose chunks', async () => {
    const p = await fixture();
    await project((await jobs(p))[0]!.data);
    const scene = await snapshot(p);
    if (!('manifest' in scene)) throw new Error('CI manifest missing');
    const ref = scene.manifest.chunks[0]!;
    const reference = {
      universeId: p.universeId,
      privacyEpoch: 1,
      manifestSceneRevision: scene.sceneRevision,
      chunkId: ref.chunkId,
      chunkSceneRevision: ref.sceneRevision,
    };
    const ready = await chunk(p.authority, { ...query, reference });
    expect(ready.kind === 'read' && SceneChunkReadSchema.safeParse(ready.scene).success).toBe(true);
    expect(ready).toMatchObject({ kind: 'read', scene: { status: 'ready' } });
    expect(
      await chunk(p.authority, {
        ...query,
        reference: { ...reference, manifestSceneRevision: scene.sceneRevision + 1 },
      }),
    ).toMatchObject({ kind: 'read', scene: { status: 'unavailable', reason: 'stale_manifest' } });
    expect(await chunk(p.authority, { ...query, reference: { ...reference, chunkId: randomUUID() } })).toMatchObject({
      kind: 'read',
      scene: { status: 'unavailable', reason: 'unknown_chunk' },
    });
    expect(await chunk(p.authority, { ...query, reference: { ...reference, universeId: randomUUID() } })).toEqual({
      kind: 'refused',
      reason: 'reference_not_found',
    });
    expect(await chunk(p.authority, { ...query, reference: { ...reference, privacyEpoch: 2 } })).toEqual({
      kind: 'refused',
      reason: 'reference_not_found',
    });
    expect(
      await chunk(p.authority, { ...query, reference, capabilities: { ...capabilities, families: [] } }),
    ).toMatchObject({ kind: 'read', scene: { status: 'unsupported_version' } });
    const selected = await read(p.authority, { ...query, selection: { kind: 'system', systemId: p.system } });
    expect(selected).toMatchObject({ kind: 'read', scene: { status: 'ready' } });
    expect(
      await chunk(p.authority, { ...query, reference, selection: { kind: 'system', systemId: randomUUID() } }),
    ).toEqual({ kind: 'refused', reason: 'selection_not_found' });
  });
  it('failed or missing jobs never claim loading/lagging; canonical label failure preserves prior immutable snapshot but refuses current readiness', async () => {
    const p = await fixture();
    await database.pool.query("update pgboss.job set state='failed' where name=$1 and data->>'universeId'=$2", [
      projectSceneQueue.name,
      p.universeId,
    ]);
    expect(await snapshot(p)).toMatchObject({ status: 'unavailable', reason: 'temporarily_unavailable' });
    await project((await jobs(p))[0]!.data);
    const old = await sceneStoreState(p);
    expect((await snapshot(p)).status).toBe('ready');
    await withScope()(p.authority, async (s) => {
      const o = p.places[2]!;
      await geographyStore.saveObject(s, { ...o, label: 'https://unsafe.example', objectRevision: 2 }, []);
      const old = await geographyStore.state(s);
      await geographyStore.writeState(s, { ...old, revision: 2, structureRevision: 2 });
      await advanceScopeRevision(s);
    });
    expect(await snapshot(p)).toMatchObject({ status: 'unavailable', reason: 'temporarily_unavailable' });
    await project((await jobs(p))[0]!.data);
    expect(await snapshot(p)).toMatchObject({ status: 'unavailable', reason: 'temporarily_unavailable' });
    expect((await sceneStoreState(p))!.manifest).toEqual(old!.manifest);
  });
  it('enforces database immutability for version rows, seed, anchor, generator and chunk allocation', async () => {
    const p = await fixture();
    await project((await jobs(p))[0]!.data);
    for (const table of ['chunks', 'manifests'])
      await expect(
        database.pool.query(`update scenes.${table} set payload=payload where universe_id=$1`, [p.universeId]),
      ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.pool.query("update scenes.state set world_seed=repeat('b',64) where universe_id=$1", [p.universeId]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.pool.query("update scenes.state set policy_version='canonical-lattice.v2' where universe_id=$1", [
        p.universeId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.pool.query(
        "update scenes.objects set payload=jsonb_set(payload,'{descriptor,anchor,x}','999') where universe_id=$1",
        [p.universeId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.pool.query(
        "update scenes.objects set payload=jsonb_set(payload,'{descriptor,generatorVersion}','\"silhouette.v2\"') where universe_id=$1",
        [p.universeId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('erases all epochs, versions, seeds and live/dead-letter jobs before Geography and fences late old-epoch work', async () => {
    const p = await fixture(),
      kept = await fixture(),
      job = (await jobs(p))[0]!.data;
    await project(job);
    await project((await jobs(kept))[0]!.data);
    await withScope()(p.authority, async (scope) => {
      const planet = p.places.find((o) => o.id === p.planet)!;
      await geographyStore.saveObject(scope, { ...planet, label: 'Seasons retained history', objectRevision: 2 }, []);
      await geographyStore.writeState(scope, {
        ...(await geographyStore.state(scope)),
        revision: 2,
        structureRevision: 2,
      });
      const personalRevision = await advanceScopeRevision(scope);
      await geo.applied(scope, {
        transitionId: randomUUID(),
        geography: { revision: 2, structureRevision: 2, activityRevision: 0 },
        personalRevision,
      });
    });
    await project(job);
    expect(
      (await database.pool.query('select scene_revision from scenes.manifests where universe_id=$1', [p.universeId]))
        .rows,
    ).toHaveLength(2);
    // Additional old-epoch copies are explicit erasure-only CI rows, never active projection authority.
    for (const [table, columns] of [
      ['objects', 'object_id,system_id,chunk_id,slot,payload'],
      ['chunks', 'chunk_id,scene_revision,system_id,payload'],
      ['manifests', 'scene_revision,payload'],
    ])
      await database.pool.query(
        `insert into scenes.${table} select universe_id,2,${columns} from scenes.${table} where universe_id=$1 and privacy_epoch=1`,
        [p.universeId],
      );
    await database.pool.query(
      'insert into scenes.state select universe_id,2,policy_version,world_seed,scene_revision,payload from scenes.state where universe_id=$1 and privacy_epoch=1',
      [p.universeId],
    );
    await c.boss.send(deadLetterQueueName(projectSceneQueue.name), job);
    expect(personalStores.findIndex((m) => m.module === 'scenes')).toBeLessThan(
      personalStores.findIndex((m) => m.module === 'geography'),
    );
    await database.db
      .updateTable('identity.universes')
      .set({ privacy_epoch: 3 })
      .where('id', '=', p.universeId)
      .execute();
    await withScope()({ ...p.authority, privacyEpoch: 3 }, (s) => eraseUniverse(s, personalStores));
    await project(job);
    for (const table of ['state', 'objects', 'chunks', 'manifests'])
      expect(
        (await database.pool.query(`select * from scenes.${table} where universe_id=$1`, [p.universeId])).rows,
      ).toHaveLength(0);
    expect(
      (await database.pool.query("select id from pgboss.job where data->>'universeId'=$1", [p.universeId])).rows,
    ).toHaveLength(0);
    expect((await snapshot(kept)).status).toBe('ready');
    expect(await read(p.authority, query)).toEqual({ kind: 'refused', reason: 'scope_refused' });
  });
  it('suspended owners cannot project or read and rolled-back required enqueue leaves no Geography or root effect', async () => {
    const p = await fixture(),
      job = (await jobs(p))[0]!.data;
    await database.db
      .updateTable('identity.accounts')
      .set({ status: 'suspended' })
      .where('id', '=', p.accountId)
      .execute();
    await project(job);
    expect(await sceneStoreState(p)).toBeUndefined();
    expect(await read(p.authority, query)).toEqual({ kind: 'refused', reason: 'scope_refused' });
    const fresh = await seedPerson(database.db),
      before = await root(fresh);
    await expect(
      withScope()(fresh.authority, async (s) => {
        await geographyStore.writeState(s, { ...(await geographyStore.state(s)), revision: 1, structureRevision: 1 });
        const personalRevision = await advanceScopeRevision(s);
        await geo.applied(s, {
          transitionId: randomUUID(),
          geography: { revision: 1, structureRevision: 1, activityRevision: 0 },
          personalRevision,
        });
        throw new Error('CI required-hook rollback');
      }),
    ).rejects.toThrow('CI required-hook rollback');
    expect(await root(fresh)).toBe(before);
    expect(await jobs(fresh)).toHaveLength(0);
    const state = await withScope()(fresh.authority, (s) => geographyStore.state(s));
    expect(state.kind === 'entered' && state.value.revision).toBe(0);
    expect(GEOGRAPHY_APPLIED).toBeTypeOf('symbol');
  });
});
