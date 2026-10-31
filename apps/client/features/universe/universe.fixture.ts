/** CI-only authored protocol fixtures. Never imported by a production route or used as personal data. */
import { createAccountScope, memoryStore } from '@knowscroll/client-core';
import {
  problemDetails,
  supportsSceneLooks,
  type GeographyObject,
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
/**
 * `dust` is the number of unlabelled dust cues the emerging read returns. `moreRegions` adds regions
 * to the same planet as the first one (planet 2), each on the next site of that planet's world.
 */
/** The reads of the person's own play that the Universe makes beside the map: none of them writes anything. */
export const COLLECTION_READS: readonly string[] = [
  '/v1/play/landmarks/read',
  '/v1/play/orbit/read',
  '/v1/experience/resume/read',
];

export function sceneFixture(count = 5, dust = 0, moreRegions = 0) {
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
  const sceneRevision = count ? 7 : 0,
    personalRevision = count ? 35 : 0;
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
  return {
    descriptors,
    looks,
    chunks,
    stations,
    collection,
    reply(path: string, body: Record<string, unknown>) {
      const selection = { kind: 'universe' as const };
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
        const cursor = body.cursor as { afterObjectId?: string } | undefined;
        const remaining = objects.filter((o) => o.id > (cursor?.afterObjectId ?? '')),
          page = remaining.slice(0, 100);
        return {
          version: 'geography-snapshot.v1',
          universeId: fixtureAccount.universeId,
          privacyEpoch: 1,
          personalWatermark: 40,
          recordedAt,
          geography,
          selection,
          status: count ? 'ready' : 'empty',
          ...(count
            ? {
                page: {
                  objects: page,
                  routes,
                  aliases: [],
                  continuation:
                    remaining.length > 100
                      ? {
                          status: 'more',
                          cursor: {
                            universeId: fixtureAccount.universeId,
                            privacyEpoch: 1,
                            geographyRevision: geography.revision,
                            selection,
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
      const fields = {
        selection,
        capabilities: body.capabilities as SceneClientCapabilities,
        scope: { universeId: fixtureAccount.universeId, privacyEpoch: 1, personalWatermark: 40 },
        recordedAt,
        currentGeography: geography,
        sceneRevision,
      };
      if (path.endsWith('/manifest/read'))
        return {
          version: 'scene-manifest-read.v1',
          ...fields,
          ...(supportsSceneLooks(fields.capabilities) ? { looks } : {}),
          status: count ? 'ready' : 'empty',
          manifest: {
            schemaVersion: 'scene-manifest.v1',
            revisions,
            chunks: chunks.map((c) => ({
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
          chunk: chunks.find((c) => c.chunkId === ref.chunkId),
        };
      }
      throw new Error('unexpected_fixture_write_or_read');
    },
  };
}
export function universeHarness(count = 5, dust = 0, moreRegions = 0) {
  const world = sceneFixture(count, dust, moreRegions),
    calls: string[] = [],
    requests: { path: string; body: Record<string, unknown> }[] = [],
    store = memoryStore();
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
