/** CI-only authored protocol fixtures. Never imported by a production route or used as personal data. */
import { createAccountScope, memoryStore } from '@knowscroll/client-core';
import { problemDetails, type GeographyObject, type SceneClientCapabilities } from '@knowscroll/contracts';
import { type SceneChunk, type SceneDescriptor } from '@knowscroll/scene-core';
export const fixtureId = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const fixtureAccount = {
  accountId: fixtureId(1),
  universeId: fixtureId(2),
  privacyEpoch: 1,
  email: 'universe@fixture.test',
};
const recordedAt = '2026-10-21T00:00:00.000Z';
/** `dust` is the number of unlabelled dust cues the emerging read returns. */
export function sceneFixture(count = 5, dust = 0) {
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
      layer: n === 0 ? 0 : n === 1 ? 1 : n === 4 ? 3 : 2,
    },
    target: { kind: o.kind, objectId: o.id },
  }));
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
  return {
    descriptors,
    chunks,
    reply(path: string, body: Record<string, unknown>) {
      const selection = { kind: 'universe' as const };
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
export function universeHarness(count = 5, dust = 0) {
  const world = sceneFixture(count, dust),
    calls: string[] = [],
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
