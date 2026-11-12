import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import {
  SceneChunkSchema,
  SceneDescriptorSchema,
  SceneManifestSchema,
  type ReadGeography,
  type SceneClientCapabilities,
  type SceneSkySystem,
} from '@knowscroll/contracts';
import { CATALOGUE, planSnapshot } from '@knowscroll/backend/modules/content';
import { makeEnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import {
  makeWithPersonalScope,
  advanceScopeRevision,
  fencePersonalRecording,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import {
  accountAccessUseCases,
  identityScopeOwnerProviders,
} from '@knowscroll/backend/modules/identity/nest-providers';
import {
  FENCE_OWN_ACCOUNT,
  FENCE_PERSONAL_RECORDING,
  type PersonalScopeTx,
} from '@knowscroll/backend/modules/identity';
import {
  CLEAR_COVERAGE_DIRTY,
  MARK_COVERAGE_DIRTY,
  READ_COVERAGE_DIRTY,
  READ_COVERAGE_INPUTS,
  READ_TRUSTED_COVERAGE,
} from '@knowscroll/backend/modules/personal-context';
import { personalContextProviders } from '@knowscroll/backend/modules/personal-context/nest-providers';
import { READ_OWN_GEOGRAPHY, type ReadOwnGeography } from '@knowscroll/backend/modules/geography';
import {
  geographyProviders,
  geographyStore,
  GEOGRAPHY_PORTS,
  type GeographyPorts,
} from '@knowscroll/backend/modules/geography/nest-providers';
import {
  PROJECT_SCENE,
  READ_OWN_SCENE_MANIFEST,
  READ_OWN_SCENE_SKY,
  projectSceneQueue,
  type ProjectScene,
  type ReadOwnSceneManifest,
  type ReadOwnSceneSky,
} from '@knowscroll/backend/modules/scenes';
import {
  sceneAppliedProviders,
  sceneProviders,
  SCENE_PORTS,
  sceneStore,
  makeReadSceneChunk,
  makeReadSceneManifest,
  makeReadSceneSky,
  type ScenePorts,
} from '@knowscroll/backend/modules/scenes/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { scrollUseCases } from '../support/scroll.js';
import { buildFromProviders } from '../support/providers.js';
import { catalogueOf } from '../support/catalogue.js';

const base: SceneClientCapabilities = {
  version: 'scene-client.v1',
  descriptors: ['scene-descriptor.v1'],
  chunks: ['scene-chunk.v1'],
  manifests: ['scene-manifest.v1'],
  generators: ['silhouette.v1'],
  families: ['terraced.v1', 'ridged.v1', 'archipelago.v1'],
  detail: 'full',
  reducedMotion: false,
};
/** A client that declared the sky (D-417) and the looks it needs; the other is a client that predates both. */
const skyClient: SceneClientCapabilities = {
  ...base,
  generators: ['silhouette.v1', 'worldmap.v1'],
  looks: ['scene-look.v1'],
  sky: ['scene-sky.v1'],
};
const oldClient = base;

/** Ids in creation order, so id order is arrival order, as UUIDv7 ids are. */
const nid = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const planetConcepts = ['earth.seasons', 'earth.tides', 'earth.greenhouse-effect', 'earth.seasons'];
const facetsOf = (planetConcept: string) =>
  planSnapshot()
    .all()
    .find((c) => c.id === planetConcept)!
    .facets.map((f) => f.id);
const transition = nid(0xfffff);

interface Synthetic {
  id: string;
  kind: 'system' | 'star' | 'planet' | 'region';
  conceptId: string;
  parentKey: string;
  key: string;
  label: string;
  labels: string[];
  truthStatus: 'factual';
  objectRevision: number;
  originTransitionId: string;
  activity: { availability: 'available'; state: 'active' };
}
function place(
  n: number,
  kind: Synthetic['kind'],
  conceptId: string,
  parentKey: string,
  revision: number,
  label = `Synthetic place ${n}`,
): Synthetic {
  return {
    id: nid(n),
    kind,
    conceptId,
    parentKey,
    // Synthetic scale fixtures reuse one catalogue concept for many places, so the key is unique by number; it is not
    // the key the catalogue derives, which a subset read does not require (D-417).
    key: `${kind}:${conceptId}:factual:${n}`,
    label,
    labels: ['Authored CI neutral label'],
    truthStatus: 'factual',
    objectRevision: revision,
    originTransitionId: transition,
    activity: { availability: 'available', state: 'active' },
  };
}
/** One system: its star, `planets` planets and two regions on each. Returns the places in creation order. */
function system(start: number, planets: number, revision: number) {
  const systemPlace = place(start, 'system', 'earth', 'universe', revision);
  const places = [systemPlace, place(start + 1, 'star', 'earth', systemPlace.key, revision)];
  let n = start + 2;
  const planetPlaces: Synthetic[] = [];
  for (let i = 0; i < planets; i++) {
    const concept = planetConcepts[i % planetConcepts.length]!;
    const planet = place(n++, 'planet', concept, systemPlace.key, revision);
    planetPlaces.push(planet);
    places.push(planet);
    if (planets <= 6)
      for (const facet of facetsOf(concept).slice(0, 2)) places.push(place(n++, 'region', facet, planet.key, revision));
  }
  return { systemPlace, planetPlaces, places, next: n };
}

describe('a map at scale (real PostgreSQL CI fixtures, synthetic places)', () => {
  let database: TestDatabase<Database>,
    c: Awaited<ReturnType<typeof scrollUseCases>>,
    geo: GeographyPorts,
    ports: ScenePorts,
    project: ProjectScene,
    geographyRead: ReadOwnGeography,
    skyRead: ReadOwnSceneSky,
    manifestRead: ReadOwnSceneManifest;
  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 20_000 });
  const report: string[] = [];
  const say = (line: string) => report.push(line);
  async function recording(scope: PersonalScopeTx) {
    const own = await accountAccessUseCases({ db: database.db, lockTimeoutMs: 20_000 }).fenceOwnAccount(scope);
    if (own.kind !== 'active') throw new Error('CI Scene owning account unavailable');
    const gate = await fencePersonalRecording(scope, 1);
    if (gate.kind !== 'recording') throw new Error('CI Scene original recording generation unavailable');
    return gate.scope;
  }
  beforeAll(async () => {
    database = await createTestDatabase<Database>('scenes_scale');
    c = await scrollUseCases(database);
    const SCOPE = Symbol('scope'),
      ENQUEUE = Symbol('enqueue'),
      LOG = Symbol('log');
    const providers = [
      ...sceneAppliedProviders({ enqueueJob: ENQUEUE }),
      ...geographyProviders({ withPersonalScope: SCOPE, enqueueJob: ENQUEUE }),
      ...sceneProviders({ withPersonalScope: SCOPE, logEvent: LOG }),
    ];
    const values = new Map<symbol, unknown>([
      [CATALOGUE, catalogueOf(database.db)],
      [SCOPE, withScope()],
      [LOG, () => undefined],
      [ENQUEUE, makeEnqueueJob(c.boss)],
      [FENCE_OWN_ACCOUNT, accountAccessUseCases({ db: database.db, lockTimeoutMs: 20_000 }).fenceOwnAccount],
      [FENCE_PERSONAL_RECORDING, fencePersonalRecording],
      [READ_TRUSTED_COVERAGE, c.readTrustedCoverage],
      [READ_COVERAGE_INPUTS, buildFromProviders(personalContextProviders(), READ_COVERAGE_INPUTS, new Map())],
      [CLEAR_COVERAGE_DIRTY, buildFromProviders(personalContextProviders(), CLEAR_COVERAGE_DIRTY, new Map())],
      [MARK_COVERAGE_DIRTY, buildFromProviders(personalContextProviders(), MARK_COVERAGE_DIRTY, new Map())],
      [READ_COVERAGE_DIRTY, buildFromProviders(personalContextProviders(), READ_COVERAGE_DIRTY, new Map())],
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
    geographyRead = get(READ_OWN_GEOGRAPHY);
    skyRead = get(READ_OWN_SCENE_SKY);
    manifestRead = get(READ_OWN_SCENE_MANIFEST);
  }, 120_000);
  afterAll(async () => {
    // Measurements for the slice report; stdout is the one place a CI log keeps them.
    for (const line of report) process.stdout.write(`[scale] ${line}\n`);
    await c.close();
    await database.drop();
  });

  /** Writes places and routes to Geography as one commit, applies it and returns the projection job it enqueued. */
  async function commit(
    p: FixturePerson,
    places: readonly Synthetic[],
    routes: readonly { id: string; from: Synthetic; to: Synthetic }[] = [],
    changed: readonly Synthetic[] = [],
  ) {
    await withScope()(p.authority, async (s) => {
      const cap = await recording(s);
      const old = await geographyStore.state(s);
      const revision = old.revision + 1;
      for (const o of [...places, ...changed])
        await geographyStore.saveObject(s, { ...o, objectRevision: revision }, []);
      for (const r of routes)
        await geographyStore.saveRoute(
          s,
          {
            id: r.id,
            fromKey: r.from.key,
            toKey: r.to.key,
            truthStatus: 'factual',
            relationRevision: revision,
            originTransitionId: transition,
            status: 'current',
          },
          [],
        );
      await geographyStore.writeState(s, { ...old, revision, structureRevision: revision });
      const watermark = await advanceScopeRevision(s);
      await geo.applied(cap, {
        recordingGeneration: 1,
        transitionId: randomUUID(),
        geography: { revision, structureRevision: revision, activityRevision: old.activityRevision },
        personalRevision: watermark,
      });
    });
    const rows = await database.pool.query<{ data: Parameters<ProjectScene>[0] }>(
      "select data from pgboss.job where name=$1 and data->>'universeId'=$2 order by created_on desc limit 1",
      [projectSceneQueue.name, p.universeId],
    );
    return rows.rows[0]!.data;
  }
  async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
    const started = performance.now();
    const value = await work();
    return { value, ms: performance.now() - started };
  }
  const count = async (sql: string, args: unknown[]) =>
    Number((await database.pool.query<{ n: string }>(sql, args)).rows[0]!.n);
  /** Counts what each storage call returns, for the reads under test. */
  function counting() {
    const rows: Record<string, number> = {};
    const wrap = <K extends keyof ScenePorts['store']>(name: K) =>
      ((...args: unknown[]) =>
        (sceneStore[name] as (...a: unknown[]) => Promise<unknown>)(...args).then((result) => {
          rows[name] = (rows[name] ?? 0) + (Array.isArray(result) ? result.length : result === undefined ? 0 : 1);
          return result;
        })) as ScenePorts['store'][K];
    const store: ScenePorts['store'] = {
      ...sceneStore,
      sky: wrap('sky'),
      chunkHeads: wrap('chunkHeads'),
      chunk: wrap('chunk'),
      looksOf: wrap('looksOf'),
      systems: wrap('systems'),
      objectsOfSystems: wrap('objectsOfSystems'),
    };
    const p: ScenePorts = { ...ports, store };
    return { rows, sky: makeReadSceneSky(p), manifest: makeReadSceneManifest(p), chunk: makeReadSceneChunk(p) };
  }
  async function readSky(p: FixturePerson, caps = skyClient, read = skyRead) {
    const systems: SceneSkySystem[] = [];
    const pages: { ms: number; size: number }[] = [];
    let cursor: { sceneRevision: number; afterSystemId: string } | undefined;
    for (;;) {
      const { value, ms } = await timed(() =>
        read(p.authority, { capabilities: caps, limit: 200, ...(cursor ? { cursor } : {}) }),
      );
      if (value.kind !== 'read' || !('systems' in value.scene))
        throw new Error(`CI sky refused: ${JSON.stringify(value)}`);
      systems.push(...value.scene.systems);
      pages.push({ ms, size: value.scene.systems.length });
      if (value.scene.continuation.status === 'complete') return { systems, pages };
      cursor = value.scene.continuation.cursor;
    }
  }
  const projected = async (p: FixturePerson) => {
    const state = await withScope()(p.authority, (s) => sceneStore.state(s));
    return state.kind === 'entered' ? state.value : undefined;
  };

  // One world for the read, bound and delta tests: 500 ordinary systems and one with 18 fully connected planets.
  let world: {
    person: FixturePerson;
    systems: Synthetic[];
    big: ReturnType<typeof system>;
    places: number;
    next: number;
  };
  let projectionMs = 0;
  beforeAll(async () => {
    const person = await seedPerson(database.db);
    const places: Synthetic[] = [];
    const systems: Synthetic[] = [];
    let next = 1;
    for (let i = 0; i < 500; i++) {
      const made = system(next, 3, 1);
      systems.push(made.systemPlace);
      places.push(...made.places);
      next = made.next;
    }
    const big = system(next, 18, 1);
    places.push(...big.places);
    next = big.next;
    const routes: { id: string; from: Synthetic; to: Synthetic }[] = [];
    let route = 0x800000;
    for (const [i, from] of big.planetPlaces.entries())
      for (const to of big.planetPlaces.slice(i + 1)) routes.push({ id: nid(route++), from, to });
    for (const s of systems.slice(0, 40)) {
      const planets = places.filter((x) => x.kind === 'planet' && x.parentKey === s.key);
      routes.push({ id: nid(route++), from: planets[0]!, to: planets[1]! });
    }
    const job = await commit(person, places, routes);
    const { ms } = await timed(() => project(job));
    projectionMs = ms;
    world = { person, systems, big, places: places.length, next };
  }, 300_000);

  it('projects thousands of places a few systems at a time, and a map at scale reads the sky and one system within bounds', async () => {
    const p = world.person;
    say(`projection of ${world.places} places in ${world.systems.length + 1} systems: ${projectionMs.toFixed(0)} ms`);
    expect(await count('select count(*) as n from scenes.objects where universe_id=$1', [p.universeId])).toBe(
      world.places,
    );
    expect(await count('select count(*) as n from scenes.systems where universe_id=$1', [p.universeId])).toBe(501);
    expect(projectionMs).toBeLessThan(60_000);
    // The state no longer carries the map: its payload stays small however many places there are.
    const stateBytes = await count('select octet_length(payload::text) as n from scenes.state where universe_id=$1', [
      p.universeId,
    ]);
    say(`scenes.state payload: ${stateBytes} bytes for ${world.places} places`);
    expect(stateBytes).toBeLessThan(1000);
    expect(await count('select count(*) as n from scenes.manifests where universe_id=$1', [p.universeId])).toBe(0);

    // The sky, all of it, a page at a time.
    const sky = await readSky(p);
    expect(sky.systems).toHaveLength(501);
    expect(sky.pages.map((page) => page.size)).toEqual([200, 200, 101]);
    expect(new Set(sky.systems.map((s) => s.descriptor.objectId)).size).toBe(501);
    expect(sky.systems.every((s) => s.descriptor.kind === 'system' && s.haze !== undefined)).toBe(true);
    expect(sky.systems.map((s) => s.descriptor.objectId)).toEqual(
      [...sky.systems.map((s) => s.descriptor.objectId)].sort(),
    );
    expect(sky.systems.filter((s) => s.planetCount === 3)).toHaveLength(500);
    expect(sky.systems.find((s) => s.planetCount === 18)).toBeDefined();
    // New systems sit on the coarse grid, 900 anchor units apart.
    const anchors = new Set(sky.systems.map((s) => `${s.descriptor.anchor.x},${s.descriptor.anchor.y}`));
    expect(anchors.size).toBe(501);
    const worst = Math.max(
      ...sky.systems.flatMap((s) => [Math.abs(s.descriptor.anchor.x), Math.abs(s.descriptor.anchor.y)]),
    );
    say(
      `sky: ${sky.pages.length} pages [${sky.pages.map((page) => page.ms.toFixed(0)).join(', ')}] ms for 501 systems; widest anchor ${worst}`,
    );
    // Measured alone these are 0.2 to 0.4 s a page; the bound leaves room for a CI runner shared with other suites.
    for (const page of sky.pages) expect(page.ms).toBeLessThan(3000);

    // What the sky read asked storage for: one page of rows, no chunk, no place from Geography.
    const spy = counting();
    const once = await readSky(p, skyClient, spy.sky);
    expect(once.systems).toHaveLength(501);
    expect(spy.rows['sky']).toBe(501 + 2);
    expect(spy.rows['chunk'] ?? 0).toBe(0);
    expect(spy.rows['chunkHeads'] ?? 0).toBe(0);

    // One system: its places from Geography, its manifest, its chunks. A system of 3 planets and 2 regions each.
    const target = sky.systems[250]!;
    const systemId = target.descriptor.objectId;
    const measured = await timed(async () => {
      const geography = await geographyRead(p.authority, {
        selection: { kind: 'system', systemId },
        limit: 100,
        version: 'geography-read.v2',
      });
      const manifest = await spy.manifest(p.authority, {
        selection: { kind: 'system', systemId },
        capabilities: skyClient,
      });
      if (manifest.kind !== 'read' || !('manifest' in manifest.scene)) throw new Error('CI manifest refused');
      const chunks = [];
      for (const ref of manifest.scene.manifest.chunks)
        chunks.push(
          await spy.chunk(p.authority, {
            selection: { kind: 'system', systemId },
            capabilities: skyClient,
            reference: {
              universeId: p.universeId,
              privacyEpoch: 1,
              manifestSceneRevision: manifest.scene.sceneRevision,
              chunkId: ref.chunkId,
              chunkSceneRevision: ref.sceneRevision,
            },
          }),
        );
      return { geography, manifest, chunks };
    });
    say(
      `one system (geography + manifest + chunks): ${measured.ms.toFixed(0)} ms; storage rows read ${JSON.stringify(spy.rows)}`,
    );
    expect(measured.ms).toBeLessThan(2000);
    if (measured.value.geography.kind !== 'read' || !('page' in measured.value.geography.snapshot))
      throw new Error('CI geography');
    // 1 system + 1 star + 3 planets + 6 regions.
    expect(measured.value.geography.snapshot.page.objects).toHaveLength(11);
    if (measured.value.manifest.kind !== 'read' || !('manifest' in measured.value.manifest.scene))
      throw new Error('CI manifest');
    expect(measured.value.manifest.scene.manifest.chunks.length).toBeLessThanOrEqual(2);
    expect(measured.value.manifest.scene.looks).toHaveLength(1 + 3 + 6);
    expect(measured.value.chunks.every((r) => r.kind === 'read' && r.scene.status === 'ready')).toBe(true);
    // Nothing but this system's rows: the objects of its chunks are exactly its places.
    const ids = measured.value.chunks.flatMap((r) =>
      r.kind === 'read' && r.scene.status === 'ready' ? r.scene.chunk.objects.map((o) => o.objectId) : [],
    );
    expect(ids).toHaveLength(11);
    expect(spy.rows['chunk']).toBe(measured.value.manifest.scene.manifest.chunks.length);
    expect(spy.rows['chunkHeads']).toBeLessThanOrEqual(2);
  }, 120_000);

  it('gives the whole map only to a client that can hold it, and says so to one that cannot', async () => {
    const p = world.person;
    for (const caps of [oldClient, skyClient]) {
      const whole = await manifestRead(p.authority, { selection: { kind: 'universe' }, capabilities: caps });
      expect(whole).toMatchObject({ kind: 'read', scene: { status: 'unavailable', reason: 'limit' } });
    }
    // A client that predates the sky still reads one system, as a system selection always allowed.
    const systemId = world.systems[3]!.id;
    expect(
      await manifestRead(p.authority, { selection: { kind: 'system', systemId }, capabilities: oldClient }),
    ).toMatchObject({ kind: 'read', scene: { status: 'ready' } });
    // And the sky is not served to a client that did not declare it.
    expect(await skyRead(p.authority, { capabilities: oldClient, limit: 10 })).toMatchObject({
      kind: 'read',
      scene: { status: 'unsupported_version' },
    });
    // The older whole-map Geography read refuses with `limit`, as it always did past 1000 places.
    expect(await geographyRead(p.authority, { selection: { kind: 'universe' }, limit: 100 })).toMatchObject({
      kind: 'read',
      snapshot: { status: 'unavailable', reason: 'limit' },
    });
  });

  it('reads more than 100 routes without failing: the universe read lists places only, a system its routes page by page', async () => {
    const p = world.person;
    // Universe selection, every page: places only, never a route, never `limit`.
    const objects: string[] = [];
    let pages = 0;
    const started = performance.now();
    let cursor: ReadGeography['cursor'];
    for (;;) {
      const r = await geographyRead(p.authority, {
        selection: { kind: 'universe' },
        limit: 100,
        version: 'geography-read.v2',
        ...(cursor ? { cursor } : {}),
      });
      if (r.kind !== 'read' || !('page' in r.snapshot))
        throw new Error(`CI universe page refused: ${JSON.stringify(r)}`);
      pages++;
      expect(r.snapshot.page.routes).toEqual([]);
      expect(r.snapshot.page.aliases).toEqual([]);
      objects.push(...r.snapshot.page.objects.map((o) => o.id));
      if (r.snapshot.page.continuation.status === 'complete') break;
      cursor = r.snapshot.page.continuation.cursor;
    }
    say(
      `geography universe read v2: ${pages} pages, ${objects.length} places, ${(performance.now() - started).toFixed(0)} ms`,
    );
    expect(objects).toHaveLength(world.places);
    expect(new Set(objects).size).toBe(world.places);
    expect(objects).toEqual([...objects].sort());

    // The system with 153 routes among 18 planets: pages end early to keep each within 100 routes, every route once.
    const systemId = world.big.systemPlace.id;
    const routeIds: string[] = [];
    const bigObjects: string[] = [];
    let systemCursor: ReadGeography['cursor'];
    let systemPages = 0;
    for (;;) {
      const r = await geographyRead(p.authority, {
        selection: { kind: 'system', systemId },
        limit: 100,
        version: 'geography-read.v2',
        ...(systemCursor ? { cursor: systemCursor } : {}),
      });
      if (r.kind !== 'read' || !('page' in r.snapshot)) throw new Error(`CI system page refused: ${JSON.stringify(r)}`);
      systemPages++;
      expect(r.snapshot.page.routes.length).toBeLessThanOrEqual(100);
      // A route sits on the page that holds its `fromObjectId`.
      const here = new Set(r.snapshot.page.objects.map((o) => o.id));
      expect(r.snapshot.page.routes.every((route) => here.has(route.fromObjectId))).toBe(true);
      routeIds.push(...r.snapshot.page.routes.map((route) => route.id));
      bigObjects.push(...r.snapshot.page.objects.map((o) => o.id));
      if (r.snapshot.page.continuation.status === 'complete') break;
      systemCursor = r.snapshot.page.continuation.cursor;
    }
    say(`geography system read v2 of a system with 153 routes: ${systemPages} pages`);
    expect(routeIds).toHaveLength(153);
    expect(new Set(routeIds).size).toBe(153);
    expect(systemPages).toBeGreaterThanOrEqual(2);
    expect(bigObjects).toHaveLength(2 + 18);
    // A system this large is a Scene system too: its manifest reads, and its sky entry counts its planets.
    expect(
      await manifestRead(p.authority, { selection: { kind: 'system', systemId }, capabilities: skyClient }),
    ).toMatchObject({
      kind: 'read',
      scene: { status: 'ready' },
    });
    // Without the version the read is the whole-map read it was: refused with `limit`, not mixed up with the new one.
    expect(await geographyRead(p.authority, { selection: { kind: 'system', systemId }, limit: 100 })).toMatchObject({
      kind: 'read',
      snapshot: { status: 'unavailable', reason: 'limit' },
    });
    // A system that is not the person's own is not found.
    expect(
      await geographyRead(p.authority, {
        selection: { kind: 'system', systemId: randomUUID() },
        limit: 10,
        version: 'geography-read.v2',
      }),
    ).toEqual({ kind: 'refused', reason: 'selection_not_found' });
  }, 120_000);

  it('re-projects only the system a delta touches, never moves a place already drawn, and lays new places out as v2', async () => {
    const p = world.person;
    const snapshot = async () => ({
      chunks: await count('select count(*) as n from scenes.chunks where universe_id=$1', [p.universeId]),
      systems: new Map(
        (
          await database.pool.query<{
            system_id: string;
            scene_revision: number;
            planet_count: number;
            cell: number | null;
          }>('select system_id,scene_revision,planet_count,cell from scenes.systems where universe_id=$1', [
            p.universeId,
          ])
        ).rows.map((row) => [row.system_id, row]),
      ),
      objects: (
        await database.pool.query<{
          object_id: string;
          slot: number | null;
          layout: string;
          chunk_id: string;
          payload: unknown;
        }>(
          'select object_id,slot,layout,chunk_id,payload from scenes.objects where universe_id=$1 order by object_id',
          [p.universeId],
        )
      ).rows,
      state: await projected(p),
    });
    const before = await snapshot();
    const revision = before.state!.projected!.sceneRevision;

    // 1. One place is relabelled: one chunk version, one system revision, one revision of the scene.
    const system0 = world.systems[10]!;
    const planet = (
      await database.pool.query<{ payload: Synthetic }>(
        "select payload from geography.objects where universe_id=$1 and payload->>'parentKey'=$2 and payload->>'kind'='planet' order by id limit 1",
        [p.universeId, system0.key],
      )
    ).rows[0]!.payload;
    const job = await commit(p, [], [], [{ ...planet, label: 'Renamed by a delta' }]);
    const relabel = await timed(() => project(job));
    const afterLabel = await snapshot();
    say(`delta of one relabelled place re-projected in ${relabel.ms.toFixed(0)} ms (map of ${world.places} places)`);
    expect(afterLabel.chunks - before.chunks).toBe(1);
    const moved = [...afterLabel.systems.values()].filter(
      (row) => before.systems.get(row.system_id)!.scene_revision !== row.scene_revision,
    );
    expect(moved.map((row) => row.system_id)).toEqual([system0.id]);
    expect(moved[0]!.scene_revision).toBe(revision + 1);
    expect(afterLabel.state!.projected!.sceneRevision).toBe(revision + 1);
    expect(afterLabel.objects).toHaveLength(before.objects.length);
    const relabelled = afterLabel.objects.filter((row, i) => JSON.stringify(row) !== JSON.stringify(before.objects[i]));
    expect(relabelled.map((row) => row.object_id)).toEqual([planet.id]);
    expect(relabelled[0]!.slot).toBe(before.objects.find((row) => row.object_id === planet.id)!.slot);
    // The refresh a client holding the sky at the old revision asks for is exactly that one system.
    const refresh = await skyRead(p.authority, { capabilities: skyClient, limit: 200, sinceSceneRevision: revision });
    if (refresh.kind !== 'read' || !('systems' in refresh.scene)) throw new Error('CI refresh');
    expect(refresh.scene.systems.map((s) => s.descriptor.objectId)).toEqual([system0.id]);
    expect(refresh.scene.systems[0]!.sceneRevision).toBe(revision + 1);

    // 2. A new planet arrives in a system with three planets: the next ordinal, around the star, in the same system.
    const system1 = world.systems[400]!;
    const arrived = place(world.next, 'planet', 'earth.tides', system1.key, 0);
    const arrivedRegion = place(world.next + 1, 'region', 'earth.tides.coasts', arrived.key, 0);
    const job2 = await commit(p, [arrived, arrivedRegion]);
    const arrival = await timed(() => project(job2));
    const afterArrival = await snapshot();
    say(`delta of one new planet and region re-projected in ${arrival.ms.toFixed(0)} ms`);
    expect(afterArrival.chunks - afterLabel.chunks).toBe(1);
    expect(afterArrival.systems.get(system1.id)).toMatchObject({ planet_count: 4, scene_revision: revision + 2 });
    expect(
      [...afterArrival.systems.values()].filter(
        (row) => afterLabel.systems.get(row.system_id)!.scene_revision !== row.scene_revision,
      ),
    ).toHaveLength(1);
    // (e) Nothing that was stored moved: every earlier object row is byte for byte the same, slots and anchors included.
    for (const row of afterLabel.objects)
      expect(afterArrival.objects.find((o) => o.object_id === row.object_id)).toEqual(row);
    const added = afterArrival.objects.find((o) => o.object_id === arrived.id)!;
    expect(added).toMatchObject({ slot: 3, layout: 'canonical-lattice.v2' });
    // The star is the object created right after its system (id + 1) and shares the system's anchor.
    const starAnchor = (
      afterArrival.objects.find((o) => o.object_id === nid(parseInt(system1.id.slice(-12), 16) + 1))!.payload as {
        descriptor: { anchor: { x: number; y: number } };
      }
    ).descriptor.anchor;
    const addedAnchor = (added.payload as { descriptor: { anchor: { x: number; y: number } } }).descriptor.anchor;
    // Ordinal 3 is the fourth lattice point from the star: one cell away, on the innermost orbit.
    expect(Math.hypot(addedAnchor.x - starAnchor.x, addedAnchor.y - starAnchor.y)).toBe(300);

    // 3. A new system takes the next free coarse cell and moves nothing.
    const fresh = system(world.next + 2, 2, 0);
    const job3 = await commit(p, fresh.places);
    await project(job3);
    const afterSystem = await snapshot();
    for (const row of afterArrival.objects)
      expect(afterSystem.objects.find((o) => o.object_id === row.object_id)).toEqual(row);
    expect(afterSystem.systems.get(fresh.systemPlace.id)!.cell).toBe(501);
    expect(afterSystem.state!.layout).toEqual({ legacyReach: 0, nextCell: 502 });
    // The delta job again, or any older one, changes nothing: the stamps are already represented.
    const rows = await count('select count(*) as n from scenes.chunks where universe_id=$1', [p.universeId]);
    await project(job);
    await project(job3);
    expect(await count('select count(*) as n from scenes.chunks where universe_id=$1', [p.universeId])).toBe(rows);
    // Every chunk any of this wrote parses, and a manifest of one system is exactly its newest chunks.
    const read = await manifestRead(p.authority, {
      selection: { kind: 'system', systemId: system1.id },
      capabilities: skyClient,
    });
    if (read.kind !== 'read' || !('manifest' in read.scene)) throw new Error('CI system manifest');
    expect(SceneManifestSchema.safeParse(read.scene.manifest).success).toBe(true);
    for (const ref of read.scene.manifest.chunks) {
      const stored = await database.pool.query<{ payload: unknown }>(
        'select payload from scenes.chunks where universe_id=$1 and chunk_id=$2 and scene_revision=$3',
        [p.universeId, ref.chunkId, ref.sceneRevision],
      );
      expect(SceneChunkSchema.safeParse(stored.rows[0]!.payload).success).toBe(true);
    }
  }, 120_000);

  it('leaves nothing behind when a projection is refused part-way, and says the scene is unavailable', async () => {
    const p = await seedPerson(database.db);
    const good = system(1, 2, 1);
    await project(await commit(p, good.places));
    const before = await count('select count(*) as n from scenes.objects where universe_id=$1', [p.universeId]);
    const chunksBefore = await count('select count(*) as n from scenes.chunks where universe_id=$1', [p.universeId]);
    // One good new system and one the catalogue does not hold: the whole step is refused and rolled back.
    const fine = system(100, 2, 0);
    const bad = [
      place(200, 'system', 'astronomy', 'universe', 0),
      place(201, 'star', 'astronomy', place(200, 'system', 'astronomy', 'universe', 0).key, 0),
    ];
    await project(await commit(p, [...fine.places, ...bad]));
    expect(await count('select count(*) as n from scenes.objects where universe_id=$1', [p.universeId])).toBe(before);
    expect(await count('select count(*) as n from scenes.chunks where universe_id=$1', [p.universeId])).toBe(
      chunksBefore,
    );
    expect(await count('select count(*) as n from scenes.systems where universe_id=$1', [p.universeId])).toBe(1);
    expect(await skyRead(p.authority, { capabilities: skyClient, limit: 10 })).toMatchObject({
      kind: 'read',
      scene: { status: 'unavailable', reason: 'temporarily_unavailable' },
    });
    // The next cell was not spent by the refused step.
    expect((await projected(p))!.layout.nextCell).toBe(1);
  }, 120_000);

  it('adopts a world an older projector left, moving nothing, and still serves it whole to a client that predates the sky', async () => {
    const p = await seedPerson(database.db);
    const made = system(1, 1, 1);
    const [sys, star, planetPlace, region] = made.places as [Synthetic, Synthetic, Synthetic, Synthetic];
    await commit(p, made.places.slice(0, 4));
    // The rows the previous release projected: lattice slots, whole-map manifest in the state, route membership list.
    const lattice = [
      { x: -150, y: -150 },
      { x: 150, y: -150 },
      { x: 150, y: 150 },
      { x: 450, y: 150 },
    ];
    const descriptors = [sys, star, planetPlace, region].map((o, n) =>
      SceneDescriptorSchema.parse({
        schemaVersion: 'scene-descriptor.v1',
        generatorVersion: 'silhouette.v1',
        objectId: o.id,
        parentId: o.kind === 'system' ? p.universeId : o.kind === 'region' ? planetPlace.id : sys.id,
        kind: o.kind,
        originTransitionId: o.originTransitionId,
        label: o.label,
        truthStatus: 'factual',
        activity: o.activity,
        family: 'terraced.v1',
        seed: String(n + 1).repeat(32),
        palette: 'ochre',
        material: 'solid',
        atmosphere: { density: 0.15 },
        detail: { roughness: 0.4 },
        anchor: { ...lattice[n]!, layer: n },
        target: { kind: o.kind, objectId: o.id },
      }),
    );
    const chunkId = randomUUID();
    const revisions = {
      geographyRevision: 1,
      structureRevision: 1,
      activityRevision: 0,
      sceneRevision: 3,
      personalRevision: 1,
    };
    const chunk = SceneChunkSchema.parse({
      schemaVersion: 'scene-chunk.v1',
      chunkId,
      revisions,
      objects: [...descriptors].sort((a, b) => a.objectId.localeCompare(b.objectId)),
      routes: [],
    });
    const manifest = SceneManifestSchema.parse({
      schemaVersion: 'scene-manifest.v1',
      revisions,
      chunks: [{ chunkId, sceneRevision: 3, objectIds: chunk.objects.map((o) => o.objectId) }],
    });
    for (const [n, d] of descriptors.entries())
      await database.pool.query(
        'insert into scenes.objects(universe_id,privacy_epoch,object_id,system_id,chunk_id,slot,payload) values($1,1,$2,$3,$4,$5,$6)',
        [
          p.universeId,
          d.objectId,
          sys.id,
          chunkId,
          n,
          JSON.stringify({ descriptor: d, systemId: sys.id, chunkId, slot: n }),
        ],
      );
    await database.pool.query(
      'insert into scenes.chunks(universe_id,privacy_epoch,chunk_id,scene_revision,system_id,payload) values($1,1,$2,3,$3,$4)',
      [p.universeId, chunkId, sys.id, JSON.stringify(chunk)],
    );
    await database.pool.query(
      "insert into scenes.state(universe_id,privacy_epoch,policy_version,world_seed,scene_revision,payload) values($1,1,'canonical-lattice.v1',$2,3,$3)",
      [
        p.universeId,
        'c'.repeat(64),
        JSON.stringify({ policyVersion: 'canonical-lattice.v1', routeChunks: [], manifest }),
      ],
    );
    interface Row {
      object_id: string;
      system_id: string;
      chunk_id: string;
      slot: number | null;
      layout: string;
      payload: { descriptor: { anchor: { x: number; y: number } } };
    }
    const rows = async (): Promise<Row[]> =>
      (
        await database.pool.query<Row>(
          'select object_id,system_id,chunk_id,slot,layout,payload from scenes.objects where universe_id=$1 order by object_id',
          [p.universeId],
        )
      ).rows;
    const chunksBefore = (await database.pool.query('select * from scenes.chunks where universe_id=$1', [p.universeId]))
      .rows;
    const objectsBefore = await rows();

    // Before adoption a legacy-shaped world is not served; after it, it is.
    expect(await skyRead(p.authority, { capabilities: skyClient, limit: 10 })).toMatchObject({
      kind: 'read',
      scene: { status: 'unavailable', reason: 'temporarily_unavailable' },
    });
    const adopted = await database.pool.query<{ adopted: boolean }>(
      'select scenes.adopt_legacy_layout($1,1) as adopted',
      [p.universeId],
    );
    expect(adopted.rows[0]!.adopted).toBe(true);
    expect(
      (
        await database.pool.query<{ adopted: boolean }>('select scenes.adopt_legacy_layout($1,1) as adopted', [
          p.universeId,
        ])
      ).rows[0]!.adopted,
    ).toBe(false);
    expect(await rows()).toEqual(objectsBefore);
    expect(
      (await database.pool.query('select * from scenes.chunks where universe_id=$1', [p.universeId])).rows,
    ).toEqual(chunksBefore);
    expect(objectsBefore.every((row) => row.layout === 'canonical-lattice.v1')).toBe(true);
    expect(
      (
        await database.pool.query(
          'select system_id,cell,planet_count,object_count,scene_revision from scenes.systems where universe_id=$1',
          [p.universeId],
        )
      ).rows,
    ).toEqual([{ system_id: sys.id, cell: null, planet_count: 1, object_count: 4, scene_revision: 3 }]);
    const state = (
      await database.pool.query<{
        payload: unknown;
        scene_revision: number;
        policy_version: string;
        world_seed: string;
      }>('select payload,scene_revision,policy_version,world_seed from scenes.state where universe_id=$1', [
        p.universeId,
      ])
    ).rows[0]!;
    expect(state.payload).toEqual({ projected: revisions, layout: { legacyReach: 450, nextCell: 0 } });
    expect(state).toMatchObject({
      scene_revision: 3,
      policy_version: 'canonical-lattice.v1',
      world_seed: 'c'.repeat(64),
    });

    // The client that predates the sky is served the same manifest it always was: chunk list, revisions, object ids.
    const whole = await manifestRead(p.authority, { selection: { kind: 'universe' }, capabilities: oldClient });
    if (whole.kind !== 'read' || !('manifest' in whole.scene)) throw new Error('CI whole manifest');
    expect(whole.scene).toMatchObject({ status: 'ready', sceneRevision: 3 });
    expect(JSON.stringify(whole.scene.manifest)).toBe(JSON.stringify(manifest));
    const skyed = await readSky(p);
    expect(skyed.systems).toHaveLength(1);
    expect(skyed.systems[0]).toMatchObject({ planetCount: 1, sceneRevision: 3, descriptor: { objectId: sys.id } });
    expect(skyed.systems[0]!.haze).toBeUndefined();

    // A new planet and a new system after the adoption: v2, and nothing already drawn moves.
    const arrival = place(10, 'planet', 'earth.tides', sys.key, 0);
    const another = system(20, 1, 0);
    await project(await commit(p, [arrival, ...another.places]));
    for (const row of objectsBefore) expect((await rows()).find((o) => o.object_id === row.object_id)).toEqual(row);
    const added = (await rows()).find((o) => o.object_id === arrival.id)!;
    expect(added).toMatchObject({ layout: 'canonical-lattice.v2', slot: 0 });
    // Around the older star (150, -150), one cell away, and not on the older planet's place (0, 300 from the star).
    const offset = { x: added.payload.descriptor.anchor.x - 150, y: added.payload.descriptor.anchor.y + 150 };
    expect(Math.hypot(offset.x, offset.y)).toBe(300);
    expect(offset).not.toEqual({ x: 0, y: 300 });
    // The new system is past everything the older layout drew.
    const newSystem = skyedAnchor(await readSky(p), another.systemPlace.id);
    expect(Math.max(Math.abs(newSystem.x), Math.abs(newSystem.y))).toBeGreaterThanOrEqual(450 + 900);
    expect((await projected(p))!.policyVersion).toBe('canonical-lattice.v1');
    // The whole map is still served to an old client while it fits, and the chunks a manifest names read back.
    const again = await manifestRead(p.authority, { selection: { kind: 'universe' }, capabilities: oldClient });
    expect(again).toMatchObject({ kind: 'read', scene: { status: 'ready' } });
  }, 120_000);

  /** A descriptor as the earlier release stored it, for the worlds these tests seed by hand. */
  function descriptorOf(
    id: string,
    kind: Synthetic['kind'],
    parentId: string,
    anchor: { x: number; y: number; layer: number },
    n: number,
    label = `Seeded ${kind} ${n}`,
  ) {
    return SceneDescriptorSchema.parse({
      schemaVersion: 'scene-descriptor.v1',
      generatorVersion: 'silhouette.v1',
      objectId: id,
      parentId,
      kind,
      originTransitionId: transition,
      label,
      truthStatus: 'factual',
      activity: { availability: 'available', state: 'active' },
      family: 'terraced.v1',
      seed: String((n % 9) + 1).repeat(32),
      palette: 'ochre',
      material: 'solid',
      atmosphere: { density: 0.15 },
      detail: { roughness: 0.4 },
      anchor,
      target: { kind, objectId: id },
    });
  }
  const seedObject = async (
    p: FixturePerson,
    d: ReturnType<typeof descriptorOf>,
    systemId: string,
    chunkId: string,
    layout: 'canonical-lattice.v1' | 'canonical-lattice.v2',
    slot: number | null,
  ) =>
    database.pool.query(
      'insert into scenes.objects(universe_id,privacy_epoch,object_id,system_id,chunk_id,slot,layout,payload) values($1,1,$2,$3,$4,$5,$6,$7)',
      [
        p.universeId,
        d.objectId,
        systemId,
        chunkId,
        slot,
        layout,
        JSON.stringify({ descriptor: d, systemId, chunkId, slot }),
      ],
    );
  const legacyPayload = (revisions: object) =>
    JSON.stringify({
      policyVersion: 'canonical-lattice.v1',
      routeChunks: [],
      manifest: { schemaVersion: 'scene-manifest.v1', revisions, chunks: [] },
    });
  const systemRows = async (p: FixturePerson) =>
    (
      await database.pool.query<{
        system_id: string;
        cell: number | null;
        planet_count: number;
        object_count: number;
        scene_revision: number;
      }>(
        'select system_id,cell,planet_count,object_count,scene_revision from scenes.systems where universe_id=$1 order by system_id',
        [p.universeId],
      )
    ).rows;
  const stateRow = async (p: FixturePerson) =>
    (
      await database.pool.query(
        'select policy_version,world_seed,scene_revision,payload from scenes.state where universe_id=$1',
        [p.universeId],
      )
    ).rows[0] as { scene_revision: number; payload: unknown };
  const adopt = async (p: FixturePerson) =>
    (
      await database.pool.query<{ adopted: boolean }>('select scenes.adopt_legacy_layout($1,1) as adopted', [
        p.universeId,
      ])
    ).rows[0]!.adopted;

  it('adopts again an old-shape state of a world that already has v2 systems: counts refreshed, next cell past the highest, nothing moved', async () => {
    const p = await seedPerson(database.db);
    // A v1 system (star, one planet) whose sky row is behind its objects, and a v2 system on cell 7 with one more object
    // than its row counts; their ids sort in this order.
    const v1 = [nid(1), nid(2), nid(3)];
    const v2 = [nid(10), nid(11), nid(12)];
    const chunkV1 = randomUUID(),
      chunkV2 = randomUUID();
    await seedObject(
      p,
      descriptorOf(v1[0]!, 'system', p.universeId, { x: -150, y: -150, layer: 0 }, 1),
      v1[0]!,
      chunkV1,
      'canonical-lattice.v1',
      0,
    );
    await seedObject(
      p,
      descriptorOf(v1[1]!, 'star', v1[0]!, { x: 150, y: -150, layer: 1 }, 2),
      v1[0]!,
      chunkV1,
      'canonical-lattice.v1',
      1,
    );
    await seedObject(
      p,
      descriptorOf(v1[2]!, 'planet', v1[0]!, { x: 150, y: 150, layer: 2 }, 3),
      v1[0]!,
      chunkV1,
      'canonical-lattice.v1',
      2,
    );
    // The v2 system is far past the v1 square: its anchors must not count as the older layout's reach.
    await seedObject(
      p,
      descriptorOf(v2[0]!, 'system', p.universeId, { x: 9900, y: 900, layer: 0 }, 10),
      v2[0]!,
      chunkV2,
      'canonical-lattice.v2',
      null,
    );
    await seedObject(
      p,
      descriptorOf(v2[1]!, 'star', v2[0]!, { x: 9900, y: 900, layer: 1 }, 11),
      v2[0]!,
      chunkV2,
      'canonical-lattice.v2',
      null,
    );
    await seedObject(
      p,
      descriptorOf(v2[2]!, 'planet', v2[0]!, { x: 10200, y: 900, layer: 2 }, 12),
      v2[0]!,
      chunkV2,
      'canonical-lattice.v2',
      0,
    );
    const revisions = {
      geographyRevision: 4,
      structureRevision: 4,
      activityRevision: 0,
      sceneRevision: 6,
      personalRevision: 2,
    };
    await database.pool.query(
      'insert into scenes.systems(universe_id,privacy_epoch,system_id,cell,planet_count,object_count,scene_revision) values($1,1,$2,null,0,1,2),($1,1,$3,7,0,1,5)',
      [p.universeId, v1[0], v2[0]],
    );
    await database.pool.query(
      "insert into scenes.state(universe_id,privacy_epoch,policy_version,world_seed,scene_revision,payload) values($1,1,'canonical-lattice.v1',$2,6,$3)",
      [p.universeId, 'd'.repeat(64), legacyPayload(revisions)],
    );
    const objectsBefore = (
      await database.pool.query('select * from scenes.objects where universe_id=$1 order by object_id', [p.universeId])
    ).rows;

    expect(await adopt(p)).toBe(true);
    // The counts follow the stored objects; the cell and the scene revision of a row that exists stay as they were.
    expect(await systemRows(p)).toEqual([
      { system_id: v1[0], cell: null, planet_count: 1, object_count: 3, scene_revision: 2 },
      { system_id: v2[0], cell: 7, planet_count: 1, object_count: 3, scene_revision: 5 },
    ]);
    // The next cell is past the highest one taken, and the reach is the v1 objects' alone.
    expect((await stateRow(p)).payload).toEqual({ projected: revisions, layout: { legacyReach: 150, nextCell: 8 } });
    expect(
      (
        await database.pool.query('select * from scenes.objects where universe_id=$1 order by object_id', [
          p.universeId,
        ])
      ).rows,
    ).toEqual(objectsBefore);
    // A second call finds the new shape and changes nothing.
    const state = await stateRow(p);
    const rows = await systemRows(p);
    expect(await adopt(p)).toBe(false);
    expect(await stateRow(p)).toEqual(state);
    expect(await systemRows(p)).toEqual(rows);
  });

  it('adopts a world an old projector created after the migration at its next projection, and refuses an old projector in an adopted world', async () => {
    const p = await seedPerson(database.db);
    const made = system(1, 1, 1);
    const [sys, star, planetPlace, region] = made.places.slice(0, 4) as [Synthetic, Synthetic, Synthetic, Synthetic];
    await commit(p, [sys, star, planetPlace, region]);
    // The old projector's write for a universe with no state row: a legacy-shaped state, a lattice slot for each object.
    const chunkId = randomUUID();
    const anchors = [
      { x: -150, y: -150 },
      { x: 150, y: -150 },
      { x: 150, y: 150 },
      { x: 450, y: 150 },
    ];
    const seeded = [sys, star, planetPlace, region].map((o, n) =>
      descriptorOf(
        o.id,
        o.kind,
        o.kind === 'system' ? p.universeId : o.kind === 'region' ? planetPlace.id : sys.id,
        { ...anchors[n]!, layer: n },
        n,
        o.label,
      ),
    );
    for (const [n, d] of seeded.entries()) await seedObject(p, d, sys.id, chunkId, 'canonical-lattice.v1', n);
    await database.pool.query(
      'insert into scenes.chunks(universe_id,privacy_epoch,chunk_id,scene_revision,system_id,payload) values($1,1,$2,3,$3,$4)',
      [
        p.universeId,
        chunkId,
        sys.id,
        JSON.stringify({
          schemaVersion: 'scene-chunk.v1',
          chunkId,
          revisions: {
            geographyRevision: 1,
            structureRevision: 1,
            activityRevision: 0,
            sceneRevision: 3,
            personalRevision: 1,
          },
          objects: [...seeded].sort((a, b) => a.objectId.localeCompare(b.objectId)),
          routes: [],
        }),
      ],
    );
    const revisions = {
      geographyRevision: 1,
      structureRevision: 1,
      activityRevision: 0,
      sceneRevision: 3,
      personalRevision: 1,
    };
    await database.pool.query(
      "insert into scenes.state(universe_id,privacy_epoch,policy_version,world_seed,scene_revision,payload) values($1,1,'canonical-lattice.v1',$2,3,$3)",
      [p.universeId, 'e'.repeat(64), legacyPayload(revisions)],
    );
    const before = (
      await database.pool.query(
        'select object_id,slot,layout,payload from scenes.objects where universe_id=$1 order by object_id',
        [p.universeId],
      )
    ).rows;
    expect((await projected(p))!.legacy).toBe(true);

    // The next projection adopts it first, then projects what changed; the scene revision only goes forward.
    const arrival = place(10, 'planet', 'earth.tides', sys.key, 0);
    await project(await commit(p, [arrival]));
    const state = await projected(p);
    expect(state!.legacy).toBeUndefined();
    expect(state!.projected).toMatchObject({ geographyRevision: 2, sceneRevision: 4 });
    expect(state!.layout).toEqual({ legacyReach: 450, nextCell: 0 });
    expect((await stateRow(p)).scene_revision).toBe(4);
    expect(await systemRows(p)).toEqual([
      { system_id: sys.id, cell: null, planet_count: 2, object_count: 5, scene_revision: 4 },
    ]);
    const after = (
      await database.pool.query(
        'select object_id,slot,layout,payload from scenes.objects where universe_id=$1 order by object_id',
        [p.universeId],
      )
    ).rows;
    for (const row of before)
      expect(
        after.find((o: { object_id: string }) => o.object_id === (row as { object_id: string }).object_id),
      ).toEqual(row);
    expect(after.find((o: { object_id: string }) => o.object_id === arrival.id)).toMatchObject({
      layout: 'canonical-lattice.v2',
      slot: 0,
    });

    // An old projector writing the whole-map state into this adopted world has a scene revision that went back: the
    // state guard refuses it, so its job fails and dead-letters. It is not adopted again.
    await expect(
      database.pool.query(
        "insert into scenes.state(universe_id,privacy_epoch,policy_version,world_seed,scene_revision,payload) values($1,1,'canonical-lattice.v1',$2,1,$3) on conflict(universe_id,privacy_epoch) do update set scene_revision=excluded.scene_revision,payload=excluded.payload",
        [p.universeId, 'e'.repeat(64), legacyPayload({ ...revisions, sceneRevision: 1 })],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect((await stateRow(p)).scene_revision).toBe(4);
  }, 120_000);
});
function skyedAnchor(sky: { systems: SceneSkySystem[] }, systemId: string) {
  return sky.systems.find((s) => s.descriptor.objectId === systemId)!.descriptor.anchor;
}
