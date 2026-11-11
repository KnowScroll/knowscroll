/** CI-only authored protocol fixtures. Never imported by a production route or used as personal data. */
import { createAccountScope, memoryStore } from '@knowscroll/client-core';
import {
  problemDetails,
  supportsSceneLooks,
  type GeographyObject,
  type GeographyRoute,
  type RoomStation,
  type SceneClientCapabilities,
} from '@knowscroll/contracts';
import { PLANET_TYPES, type SceneChunk, type SceneDescriptor, type SceneLook } from '@knowscroll/scene-core';
export const fixtureId = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const fixtureAccount = {
  accountId: fixtureId(1),
  universeId: fixtureId(2),
  privacyEpoch: 1,
  email: 'universe@fixture.test',
};
const recordedAt = '2026-10-21T00:00:00.000Z';
/** A system of a fixture map: its places, looks, chunks and routes. */
interface FixtureSystem {
  readonly id: string;
  readonly objects: GeographyObject[];
  readonly descriptors: SceneDescriptor[];
  readonly looks: SceneLook[];
  readonly chunks: SceneChunk[];
  readonly routes: readonly GeographyRoute[];
}
/**
 * `dust` is the number of unlabelled dust cues the emerging read returns. `moreRegions` adds regions
 * to the same planet as the first one (planet 2), each on the next site of that planet's world. `extraSystems` adds that
 * many synthetic systems (a star and two planets each, one chunk each) beside the first world, for a map at scale (D-417).
 */
/** The reads of the person's own play that the Universe makes beside the map: none of them writes anything. */
export const COLLECTION_READS: readonly string[] = [
  '/v1/play/landmarks/read',
  '/v1/play/orbit/read',
  '/v1/experience/resume/read',
  '/v1/universe/places/concepts/read',
];

export function sceneFixture(count = 5, dust = 0, moreRegions = 0, extraSystems = 0) {
  const geography = { revision: count ? 3 : 0, structureRevision: count ? 3 : 0, activityRevision: 0 };
  const objects: GeographyObject[] = Array.from({ length: count }, (_, n) => {
    const kind =
      n === 0 ? ('system' as const) : n === 1 ? ('star' as const) : n === 4 ? ('region' as const) : ('planet' as const);
    const fields = {
      id: fixtureId(10 + n),
      objectRevision: 1,
      label: `CI ${kind} ${n}`,
      truthStatus: 'factual' as const,
      activity: { availability: 'available' as const, state: 'active' as const },
      originTransitionId: fixtureId(9000),
    };
    if (kind === 'system') return { ...fields, kind, parent: { kind: 'universe', id: fixtureAccount.universeId } };
    if (kind === 'region') return { ...fields, kind, parent: { kind: 'planet', id: fixtureId(12) } };
    return { ...fields, kind, parent: { kind: 'system', id: fixtureId(10) } };
  });
  if (count > 4)
    for (let more = 0; more < moreRegions; more++)
      objects.push({
        id: fixtureId(100 + more),
        objectRevision: 1,
        label: `CI region ${count + more}`,
        truthStatus: 'factual',
        activity: { availability: 'available', state: 'active' },
        originTransitionId: fixtureId(9000),
        kind: 'region',
        parent: { kind: 'planet', id: fixtureId(12) },
      });
  const descriptors: SceneDescriptor[] = objects.map((o, n) => ({
    schemaVersion: 'scene-descriptor.v1',
    generatorVersion: 'silhouette.v1',
    objectId: o.id,
    parentId: o.parent.id,
    kind: o.kind,
    originTransitionId: o.originTransitionId,
    label: o.label,
    truthStatus: o.truthStatus,
    activity: o.activity,
    family: n % 3 === 0 ? 'ridged.v1' : n % 3 === 1 ? 'terraced.v1' : 'archipelago.v1',
    seed: n % 2 ? 'a'.repeat(32) : 'b'.repeat(32),
    palette: n % 2 ? 'ochre' : 'sage',
    material: 'solid',
    atmosphere: { density: 0.1 },
    detail: { roughness: 0.2 },
    anchor: {
      x: n < 5 ? n * 300 : (n % 32) * 300,
      y: n < 5 ? 0 : Math.floor(n / 32) * 300,
      layer: n === 0 ? 0 : n === 1 ? 1 : o.kind === 'region' ? 3 : 2,
    },
    target: { kind: o.kind, objectId: o.id },
  }));
  /** Authored looks, served on the manifest to a client that asks for them (D-102): one type per planet. */
  const looks: SceneLook[] = descriptors.flatMap((d, n): SceneLook[] => {
    const base = { schemaVersion: 'scene-look.v1', generatorVersion: 'worldmap.v1', objectId: d.objectId } as const;
    if (d.kind === 'system') return [{ ...base, kind: 'system', haze: 'teal' }];
    if (d.kind === 'region')
      return [{ ...base, kind: 'region', site: descriptors.slice(0, n).filter((o) => o.kind === 'region').length }];
    if (d.kind === 'star') return [];
    return [
      {
        ...base,
        kind: 'planet',
        type: PLANET_TYPES[n % PLANET_TYPES.length]!,
        rings: n % 2 === 0,
        moon: n % 3 === 0,
        hueShift: 0,
        variant: 0,
        siteCount: 7,
      },
    ];
  });
  const routes =
    count >= 4
      ? [
          {
            id: fixtureId(8000),
            kind: 'route' as const,
            relationRevision: 2,
            originTransitionId: fixtureId(9000),
            status: 'current' as const,
            fromObjectId: fixtureId(12),
            toObjectId: fixtureId(13),
            truthStatus: 'factual' as const,
          },
        ]
      : [];
  let sceneRevision = count ? 7 : 0;
  const personalRevision = count ? 35 : 0;
  const revisions = {
    geographyRevision: geography.revision,
    structureRevision: geography.structureRevision,
    activityRevision: 0,
    sceneRevision,
    personalRevision,
  };
  const chunks: SceneChunk[] = [];
  for (let at = 0; at < count; at += 100)
    chunks.push({
      schemaVersion: 'scene-chunk.v1',
      chunkId: fixtureId(10000 + at),
      revisions,
      objects: descriptors.slice(at, at + 100),
      routes:
        at === 0
          ? routes.map(({ id, fromObjectId, toObjectId, originTransitionId, truthStatus }) => ({
              id,
              fromObjectId,
              toObjectId,
              originTransitionId,
              truthStatus,
            }))
          : [],
    });
  const looksOfDescriptors = (list: readonly SceneDescriptor[]): SceneLook[] =>
    list.flatMap((d, n): SceneLook[] => {
      const base = { schemaVersion: 'scene-look.v1', generatorVersion: 'worldmap.v1', objectId: d.objectId } as const;
      if (d.kind === 'system') return [{ ...base, kind: 'system', haze: 'teal' }];
      if (d.kind === 'planet')
        return [
          {
            ...base,
            kind: 'planet',
            type: PLANET_TYPES[n % PLANET_TYPES.length]!,
            rings: false,
            moon: false,
            hueShift: 0,
            variant: n,
            siteCount: 7,
          },
        ];
      return [];
    });
  /** The map's systems as the sky and the per-system reads see them: the first world's, then the synthetic extras. */
  const systems: FixtureSystem[] = [];
  if (count)
    systems.push({
      id: fixtureId(10),
      objects,
      descriptors,
      looks,
      chunks,
      routes,
    });
  for (let n = 0; n < extraSystems; n++) {
    const base = 20_000 + n * 10;
    const own: GeographyObject[] = [
      {
        id: fixtureId(base),
        objectRevision: 1,
        label: `CI system ${n + 2}`,
        truthStatus: 'factual',
        activity: { availability: 'available', state: 'active' },
        originTransitionId: fixtureId(9000),
        kind: 'system',
        parent: { kind: 'universe', id: fixtureAccount.universeId },
      },
      ...([1, 2, 3] as const).map((offset): GeographyObject => ({
        id: fixtureId(base + offset),
        objectRevision: 1,
        label: `CI ${offset === 1 ? 'star' : 'planet'} ${n + 2}.${offset}`,
        truthStatus: 'factual',
        activity: { availability: 'available', state: 'active' },
        originTransitionId: fixtureId(9000),
        kind: offset === 1 ? 'star' : 'planet',
        parent: { kind: 'system', id: fixtureId(base) },
      })),
    ];
    const own_descriptors: SceneDescriptor[] = own.map((o) => ({
      schemaVersion: 'scene-descriptor.v1',
      generatorVersion: 'silhouette.v1',
      objectId: o.id,
      parentId: o.parent.id,
      kind: o.kind,
      originTransitionId: o.originTransitionId,
      label: o.label,
      truthStatus: o.truthStatus,
      activity: o.activity,
      family: 'terraced.v1',
      seed: n % 2 ? 'a'.repeat(32) : 'b'.repeat(32),
      palette: 'sage',
      material: 'solid',
      atmosphere: { density: 0.1 },
      detail: { roughness: 0.2 },
      anchor: { x: ((n + 1) % 50) * 900, y: Math.floor((n + 1) / 50) * 900, layer: o.kind === 'system' ? 0 : 2 },
      target: { kind: o.kind, objectId: o.id },
    }));
    systems.push({
      id: fixtureId(base),
      objects: own,
      descriptors: own_descriptors,
      looks: looksOfDescriptors(own_descriptors),
      chunks: [
        {
          schemaVersion: 'scene-chunk.v1',
          chunkId: fixtureId(30_000 + n),
          revisions,
          objects: own_descriptors,
          routes: [],
        },
      ],
      routes: [],
    });
  }
  const bySystem = (systemId: string) => systems.find((system) => system.id === systemId);
  /** What a read of a selection covers: one system, or the whole map. */
  const covered = (selection: { kind: 'universe' } | { kind: 'system'; systemId: string }) => {
    const own = selection.kind === 'system' ? [bySystem(selection.systemId)] : systems;
    const found = own.flatMap((system) => (system ? [system] : []));
    return {
      known: selection.kind === 'universe' || found.length === 1,
      objects: found.flatMap((system) => system.objects).sort((a, b) => (a.id < b.id ? -1 : 1)),
      routes: found.flatMap((system) => system.routes),
      looks: found.flatMap((system) => system.looks),
      chunks: found.flatMap((system) => system.chunks),
    };
  };
  /** The room stations this map's reads answer with; a test pushes some to see them drawn. */
  const stations: RoomStation[] = [];
  const stationsOf = () => stations;
  /**
   * What the person's play reads answer with: nothing earned, no Orbit days and nothing to resume, until a test
   * sets some. `planets` names the topic of each planet, as Geography does.
   */
  const collection: {
    landmarks: Record<string, unknown>[];
    orbit: { days: number; goal: 3; weekStart: string; closed: boolean };
    resume: { assetId: string; title: string; part: number; total: number } | null;
    planets: { id: string; topicId: string }[];
  } = {
    landmarks: [],
    orbit: { days: 0, goal: 3, weekStart: '2026-11-02', closed: false },
    resume: null,
    planets: [],
  };
  /**
   * What a system's Reels and Scrolls read answers with (#697): none until a test adds some. `systemFinds.away` makes the
   * read say the system is not on the map.
   */
  const systemFinds: {
    finds: { assetId: string; assetRevision: number; kind: 'reel' | 'scroll'; title: string }[];
    away: boolean;
  } = { finds: [], away: false };
  return {
    /** The map changed: the scene moves on one revision, in every system and every chunk, and a refresh reads it all again. */
    bump() {
      sceneRevision += 1;
      revisions.sceneRevision = sceneRevision;
    },
    descriptors,
    looks,
    chunks,
    stations,
    collection,
    systemFinds,
    reply(path: string, body: Record<string, unknown>) {
      const selection = { kind: 'universe' as const };
      if (path === '/v1/universe/system/finds/read')
        return {
          version: 'universe-system-finds.v1',
          readId: body.readId,
          universeId: fixtureAccount.universeId,
          privacyEpoch: 1,
          personalWatermark: 40,
          systemId: body.systemId,
          ...(systemFinds.away
            ? { status: 'unavailable', reason: 'not_on_map' }
            : { status: 'ready', finds: systemFinds.finds }),
        };
      if (path === '/v1/play/landmarks/read') return { landmarks: collection.landmarks };
      if (path === '/v1/play/orbit/read') return { orbit: collection.orbit };
      if (path === '/v1/experience/resume/read') return { resume: collection.resume };
      if (path === '/v1/universe/places/concepts/read')
        return {
          version: 'universe-place-concepts.v1',
          universeId: fixtureAccount.universeId,
          privacyEpoch: 1,
          personalWatermark: 40,
          geography,
          planets: collection.planets,
        };
      // The room stations of the map: a read of its own, answered with none unless a test names some.
      if (path === '/v1/rooms/stations')
        return {
          version: 'rooms.v1',
          readId: body.readId,
          scope: { accountId: fixtureAccount.accountId, privacyEpoch: 1 },
          status: 'ready',
          stations: stationsOf(),
        };
      if (path.endsWith('/geography/read')) {
        const asked = (body.selection ?? { kind: 'universe' }) as
          { kind: 'universe' } | { kind: 'system'; systemId: string };
        const own = covered(asked);
        const cursor = body.cursor as { afterObjectId?: string } | undefined;
        // `geography-read.v2` (D-417): the universe selection carries places only, a system's routes come with it.
        const v2 = body.version === 'geography-read.v2';
        const remaining = own.objects.filter((o) => o.id > (cursor?.afterObjectId ?? '')),
          page = remaining.slice(0, 100);
        const routesHere = v2 && asked.kind === 'universe' ? [] : own.routes;
        return {
          version: 'geography-snapshot.v1',
          universeId: fixtureAccount.universeId,
          privacyEpoch: 1,
          personalWatermark: 40,
          recordedAt,
          geography,
          selection: asked,
          status: count ? 'ready' : 'empty',
          ...(count
            ? {
                page: {
                  objects: page,
                  routes: routesHere,
                  aliases: [],
                  continuation:
                    remaining.length > 100
                      ? {
                          status: 'more',
                          cursor: {
                            universeId: fixtureAccount.universeId,
                            privacyEpoch: 1,
                            geographyRevision: geography.revision,
                            selection: asked,
                            afterObjectId: page.at(-1)!.id,
                          },
                        }
                      : { status: 'complete' },
                },
              }
            : {}),
        };
      }
      if (path.endsWith('/emerging/read'))
        return {
          version: 'universe-emerging.v1',
          universeId: fixtureAccount.universeId,
          privacyEpoch: 1,
          personalWatermark: 40,
          recordedAt,
          geography,
          dust: Array.from({ length: dust }, (_, n) => ({
            id: `0199a000-0000-5000-8000-${(n + 1).toString(16).padStart(12, '0')}`,
          })),
        };
      if (path.endsWith('/geography/deltas/read'))
        return {
          version: 'universe-deltas.v1',
          universeId: fixtureAccount.universeId,
          privacyEpoch: 1,
          personalWatermark: 40,
          status: 'available',
          afterGeographyRevision: geography.revision,
          geography,
          deltas: [],
          hasMore: false,
        };
      const asked = (body.selection ?? selection) as { kind: 'universe' } | { kind: 'system'; systemId: string };
      const own = covered(asked);
      const fields = {
        selection: asked,
        capabilities: body.capabilities as SceneClientCapabilities,
        scope: { universeId: fixtureAccount.universeId, privacyEpoch: 1, personalWatermark: 40 },
        recordedAt,
        currentGeography: geography,
        sceneRevision,
      };
      // The sky (D-417): every system, a page at a time, each with its haze and planet count.
      if (path.endsWith('/scenes/sky/read')) {
        const { selection: _unused, ...skyFields } = fields;
        const since = body.sinceSceneRevision as number | undefined;
        const after = (body.cursor as { afterSystemId?: string } | undefined)?.afterSystemId ?? '';
        const limit = (body.limit as number | undefined) ?? 200;
        const listed = [...systems]
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .filter((system) => system.id > after && (since === undefined || sceneRevision > since));
        const page = listed.slice(0, limit);
        const base = {
          version: 'scene-sky-read.v1',
          ...skyFields,
          ...(since === undefined ? {} : { sinceSceneRevision: since }),
        };
        if (!count) return { ...base, status: 'empty' };
        return {
          ...base,
          status: 'ready',
          revisions,
          systems: page.map((system) => ({
            descriptor: system.descriptors.find((d) => d.kind === 'system')!,
            haze: 'teal',
            planetCount: system.descriptors.filter((d) => d.kind === 'planet').length,
            sceneRevision,
          })),
          continuation:
            listed.length > page.length
              ? { status: 'more', cursor: { sceneRevision, afterSystemId: page.at(-1)!.id } }
              : { status: 'complete' },
        };
      }
      if (path.endsWith('/manifest/read'))
        return {
          version: 'scene-manifest-read.v1',
          ...fields,
          ...(supportsSceneLooks(fields.capabilities) ? { looks: own.looks } : {}),
          status: count ? 'ready' : 'empty',
          manifest: {
            schemaVersion: 'scene-manifest.v1',
            revisions,
            chunks: own.chunks.map((c) => ({
              chunkId: c.chunkId,
              sceneRevision,
              objectIds: c.objects.map((o) => o.objectId),
            })),
          },
        };
      if (path.endsWith('/chunks/read')) {
        const ref = body.reference as { chunkId: string };
        return {
          version: 'scene-chunk-read.v1',
          ...fields,
          reference: body.reference,
          status: 'ready',
          chunk: own.chunks.find((c) => c.chunkId === ref.chunkId),
        };
      }
      throw new Error('unexpected_fixture_write_or_read');
    },
  };
}
export function universeHarness(count = 5, dust = 0, moreRegions = 0, extraSystems = 0) {
  const world = sceneFixture(count, dust, moreRegions, extraSystems),
    calls: string[] = [],
    requests: { path: string; body: Record<string, unknown> }[] = [],
    store = memoryStore();
  /** The answers the account gives to "may I play the first open?", one per ask; once they run out, it was seen. */
  const firstOpenAnswers: boolean[] = [];
  let gate: Promise<void> | undefined,
    network = false,
    authority = false;
  const scope = createAccountScope({
    account: fixtureAccount,
    baseUrl: 'https://universe.fixture.test',
    store,
    authorization: () => undefined,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      calls.push(path);
      if (path === '/v1/account/universe/first-open')
        return new Response(JSON.stringify({ claimed: firstOpenAnswers.shift() ?? false }), {
          headers: { 'content-type': 'application/json' },
        });
      const body = (await request.json()) as Record<string, unknown>;
      requests.push({ path, body });
      const reply = world.reply(path, body); // freeze before the deliberately abort-ignoring gate
      await gate;
      if (network) throw new TypeError('fixture_offline');
      if (authority)
        return new Response(JSON.stringify(problemDetails('NOT_FOUND')), {
          status: 404,
          headers: { 'content-type': 'application/problem+json' },
        });
      return new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } });
    },
  });
  return {
    scope,
    calls,
    requests,
    store,
    world,
    /** Queues the account's answers to the first-open claim: true the first time it is asked, for one device. */
    firstOpen: (...answers: boolean[]) => void firstOpenAnswers.push(...answers),
    gate: (value: Promise<void> | undefined) => {
      gate = value;
    },
    network: (value: boolean) => {
      network = value;
    },
    authority: (value: boolean) => {
      authority = value;
    },
  };
}
