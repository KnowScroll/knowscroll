import { describe, expect, it } from 'vitest';
import {
  EMERGING_LIMITS,
  EmergingUniverseSchema,
  GEOGRAPHY_LIMITS,
  GeographyAliasSchema,
  GeographyObjectSchema,
  GeographyRevisionsSchema,
  GeographyRouteSchema,
  GeographySnapshotSchema,
  ReadEmergingUniverseSchema,
  ReadGeographySchema,
  ReadUniverseDeltasSchema,
  UniverseDeltaSchema,
  UniverseDeltasSchema,
} from './index.js';

// Wire-only synthetic fixtures. No formation, evidence, model, scene or runtime acceptance.
const uuid = (n: number) => `0199f0a0-0000-7000-8000-${n.toString().padStart(12, '0')}`;
const universeId = uuid(1);
const transitionId = uuid(2);
const fields = {
  objectRevision: 1,
  label: '  Fixture place  ',
  truthStatus: 'factual',
  activity: { availability: 'unavailable' },
  originTransitionId: transitionId,
};
const system = { ...fields, id: uuid(3), kind: 'system', parent: { kind: 'universe', id: universeId } };
const star = { ...fields, id: uuid(4), kind: 'star', parent: { kind: 'system', id: system.id } };
const planet = { ...fields, id: uuid(5), kind: 'planet', parent: { kind: 'system', id: system.id } };
const region = { ...fields, id: uuid(6), kind: 'region', parent: { kind: 'planet', id: planet.id } };
const route = {
  id: uuid(7),
  kind: 'route',
  relationRevision: 1,
  originTransitionId: transitionId,
  status: 'current',
  fromObjectId: planet.id,
  toObjectId: region.id,
  truthStatus: 'factual',
};
const alias = { ...route, id: uuid(8), kind: 'alias', fromObjectId: uuid(9) };
const { truthStatus: _truthStatus, ...aliasFields } = alias;
const selection = { kind: 'universe' };
const geography = { revision: 1, structureRevision: 1, activityRevision: 0 };
const scope = { universeId, privacyEpoch: 1, personalWatermark: 10 };
const snapshot = {
  version: 'geography-snapshot.v1',
  ...scope,
  recordedAt: '2026-10-21T10:00:00.000Z',
  geography,
  selection,
};
const page = {
  objects: [system, star, planet, region],
  routes: [route],
  aliases: [aliasFields],
  continuation: { status: 'complete' },
};
const ready = { ...snapshot, status: 'ready', page };
const cursor = { universeId, privacyEpoch: 1, geographyRevision: 1, selection, afterObjectId: region.id };
const base = { revision: 0, structureRevision: 0, activityRevision: 0 };
const delta = {
  version: 'universe-delta.v1',
  ...scope,
  transitionId,
  recordedAt: snapshot.recordedAt,
  base,
  geography,
  operations: [
    { kind: 'create_system', object: system },
    { kind: 'establish_star', object: star },
    { kind: 'form_planet', object: planet },
    { kind: 'add_region', object: region },
    { kind: 'connect_route', route },
  ],
};
const catchup = {
  version: 'universe-deltas.v1',
  ...scope,
  status: 'available',
  afterGeographyRevision: 0,
  geography,
  deltas: [delta],
  hasMore: false,
};

describe('Geography declaration-only wire contracts', () => {
  it('preserves established hierarchy, opaque identity and untransformed labels', () => {
    for (const object of [system, star, planet, region]) expect(GeographyObjectSchema.parse(object)).toEqual(object);
    expect(GeographySnapshotSchema.parse(ready)).toEqual(ready);
    for (const object of [
      { ...system, id: 'fixture-system' },
      { ...planet, parent: { kind: 'star', id: star.id } },
      { ...region, parent: { kind: 'system', id: system.id } },
      { ...planet, parent: { kind: 'system', id: planet.id } },
      { ...system, objectRevision: 0 },
      { ...system, label: '\t \n' },
      { ...system, label: 'x'.repeat(161) },
      { ...system, kind: 'dust' },
      { ...system, truthStatus: 'learned' },
    ])
      expect(GeographyObjectSchema.safeParse(object).success).toBe(false);
  });

  it('retains hypothetical meaning, withdrawn relations and aliases without renderer inference', () => {
    const hypothetical = { ...region, truthStatus: 'hypothetical' };
    expect(GeographyObjectSchema.parse(hypothetical)).toEqual(hypothetical);
    for (const status of ['current', 'withdrawn']) {
      expect(GeographyRouteSchema.parse({ ...route, status })).toEqual({ ...route, status });
      expect(GeographyAliasSchema.parse({ ...aliasFields, status })).toEqual({ ...aliasFields, status });
    }
    expect(GeographyRouteSchema.safeParse({ ...route, toObjectId: route.fromObjectId }).success).toBe(false);
    expect(GeographyAliasSchema.safeParse({ ...aliasFields, toObjectId: aliasFields.fromObjectId }).success).toBe(
      false,
    );
    expect(GeographyAliasSchema.safeParse(alias).success).toBe(false);
  });

  it('keeps honest empty/loading/unavailable distinct from a ready or lagging established page', () => {
    for (const status of ['empty', 'loading']) {
      const value = { ...snapshot, status };
      expect(GeographySnapshotSchema.parse(value)).toEqual(value);
      expect(GeographySnapshotSchema.safeParse({ ...value, page }).success).toBe(false);
    }
    for (const reason of ['temporarily_unavailable', 'snapshot_expired', 'limit']) {
      const value = { ...snapshot, status: 'unavailable', reason };
      expect(GeographySnapshotSchema.parse(value)).toEqual(value);
    }
    const lagging = { ...ready, status: 'lagging', pendingPersonalWatermark: 10 };
    expect(GeographySnapshotSchema.parse(lagging)).toEqual(lagging);
    expect(GeographySnapshotSchema.safeParse({ ...lagging, pendingPersonalWatermark: 11 }).success).toBe(false);
    expect(GeographySnapshotSchema.safeParse({ ...ready, page: { ...page, objects: [] } }).success).toBe(false);
    expect(
      GeographySnapshotSchema.safeParse({ ...snapshot, status: 'unavailable', reason: 'provider_failed' }).success,
    ).toBe(false);
  });

  it('strictly excludes evidence, score, model and scene machinery at every new public boundary', () => {
    for (const extra of [
      { privateEvidence: [uuid(20)] },
      { scores: { mastery: 1 } },
      { sources: ['private'] },
      { prompt: 'internal' },
      { provider: 'internal' },
      { eligible: true },
      { generatorVersion: '1' },
      { seed: 'x' },
      { layout: { x: 1 } },
      { detailLevel: 'high' },
    ]) {
      expect(GeographyObjectSchema.safeParse({ ...planet, ...extra }).success).toBe(false);
      expect(GeographySnapshotSchema.safeParse({ ...ready, ...extra }).success).toBe(false);
      expect(UniverseDeltaSchema.safeParse({ ...delta, ...extra }).success).toBe(false);
    }
    expect(
      GeographyObjectSchema.safeParse({ ...planet, parent: { ...planet.parent, eligibility: true } }).success,
    ).toBe(false);
    expect(
      GeographyObjectSchema.safeParse({ ...planet, activity: { availability: 'unavailable', score: 0 } }).success,
    ).toBe(false);
    expect(GeographyRouteSchema.safeParse({ ...route, evidenceRefs: [] }).success).toBe(false);
  });

  it('bounds object and relation pages independently and refuses duplicate identities', () => {
    const objects = Array.from({ length: GEOGRAPHY_LIMITS.objects }, (_, i) => ({ ...planet, id: uuid(100 + i) }));
    const routes = Array.from({ length: GEOGRAPHY_LIMITS.routes }, (_, i) => ({ ...route, id: uuid(300 + i) }));
    const aliases = Array.from({ length: GEOGRAPHY_LIMITS.aliases }, (_, i) => ({ ...aliasFields, id: uuid(500 + i) }));
    const full = { ...page, objects, routes, aliases };
    expect(GeographySnapshotSchema.safeParse({ ...ready, page: full }).success).toBe(true);
    for (const key of ['objects', 'routes', 'aliases'] as const) {
      const entries = full[key];
      const overflow = { ...full, [key]: [...entries, { ...entries[0], id: uuid(999) }] };
      expect(GeographySnapshotSchema.safeParse({ ...ready, page: overflow }).success).toBe(false);
      expect(
        GeographySnapshotSchema.safeParse({ ...ready, page: { ...full, [key]: [...entries.slice(1), entries[1]] } })
          .success,
      ).toBe(false);
    }
    expect(
      GeographySnapshotSchema.safeParse({ ...ready, page: { ...page, aliases: [{ ...aliasFields, id: system.id }] } })
        .success,
    ).toBe(false);
    expect(
      GeographySnapshotSchema.safeParse({
        ...ready,
        page: { ...page, objects: [{ ...system, parent: { kind: 'universe', id: uuid(99) } }] },
      }).success,
    ).toBe(false);
    expect(
      GeographySnapshotSchema.safeParse({ ...ready, page: { ...page, routes: [{ ...route, relationRevision: 2 }] } })
        .success,
    ).toBe(false);
  });

  it('binds continuation to one scope, epoch, revision, selection and final object', () => {
    const more = { ...ready, page: { ...page, continuation: { status: 'more', cursor } } };
    expect(GeographySnapshotSchema.parse(more)).toEqual(more);
    const query = { selection, limit: 100, cursor };
    expect(ReadGeographySchema.parse(query)).toEqual(query);
    for (const change of [
      { universeId: uuid(99) },
      { privacyEpoch: 2 },
      { geographyRevision: 2 },
      { selection: { kind: 'system', systemId: system.id } },
      { afterObjectId: planet.id },
    ])
      expect(
        GeographySnapshotSchema.safeParse({
          ...more,
          page: { ...more.page, continuation: { status: 'more', cursor: { ...cursor, ...change } } },
        }).success,
      ).toBe(false);
    for (const query of [
      { selection, limit: 0 },
      { selection, limit: 101 },
      { selection, limit: 1.5 },
      { selection, limit: 1, ownerId: uuid(99) },
      { selection: { kind: 'system', systemId: system.id }, limit: 1, cursor },
      { selection, limit: 1, cursor: { ...cursor, arbitraryPatch: [] } },
    ])
      expect(ReadGeographySchema.safeParse(query).success).toBe(false);
  });

  it('declares all eight atomic applied effects and keeps original formation identity on later reads', () => {
    expect(UniverseDeltaSchema.parse(delta)).toEqual(delta);
    const update = {
      ...delta,
      transitionId: uuid(30),
      base: geography,
      geography: { revision: 2, structureRevision: 2, activityRevision: 2 },
      operations: [
        { kind: 'revise_label', objectId: planet.id, objectRevision: 2, label: 'Updated fixture' },
        {
          kind: 'set_activity',
          objectId: planet.id,
          objectRevision: 2,
          activity: { availability: 'available', state: 'quiet' },
        },
        { kind: 'withdraw_relation', relationId: route.id, relationRevision: 2 },
      ],
    };
    expect(UniverseDeltaSchema.parse(update)).toEqual(update);
    const quietPlanet = {
      ...planet,
      objectRevision: 2,
      label: 'Updated fixture',
      activity: { availability: 'available', state: 'quiet' },
    };
    expect(GeographyObjectSchema.parse(quietPlanet).originTransitionId).toBe(transitionId);
    expect(GeographyObjectSchema.parse(quietPlanet).id).toBe(planet.id);
    for (const kind of ['remove_object', 'delete_planet', 'json_patch', 'form_from_supply'])
      expect(UniverseDeltaSchema.safeParse({ ...delta, operations: [{ kind, objectId: planet.id }] }).success).toBe(
        false,
      );
    expect(
      UniverseDeltaSchema.safeParse({
        ...update,
        operations: [{ ...update.operations[0], originTransitionId: uuid(30) }],
      }).success,
    ).toBe(false);
  });

  it('refuses revision gaps, forged origins, mismatched effects and unbounded atomic batches', () => {
    for (const value of [
      { ...delta, geography: { ...geography, revision: 2 } },
      { ...delta, geography: { ...geography, structureRevision: 0 } },
      { ...delta, operations: [] },
      { ...delta, operations: Array.from({ length: 33 }, () => delta.operations[0]) },
      { ...delta, operations: [{ kind: 'form_planet', object: { ...planet, originTransitionId: uuid(99) } }] },
      { ...delta, operations: [{ kind: 'form_planet', object: { ...planet, objectRevision: 2 } }] },
      { ...delta, operations: [{ kind: 'connect_route', route: { ...route, status: 'withdrawn' } }] },
      {
        ...delta,
        operations: [
          { kind: 'set_activity', objectId: planet.id, objectRevision: 1, activity: { availability: 'unavailable' } },
        ],
      },
    ])
      expect(UniverseDeltaSchema.safeParse(value).success).toBe(false);
    expect(
      UniverseDeltaSchema.safeParse({
        ...delta,
        operations: Array.from({ length: 32 }, (_, i) => ({
          kind: 'revise_label',
          objectId: uuid(100 + i),
          objectRevision: 1,
          label: 'Updated fixture',
        })),
      }).success,
    ).toBe(true);
    for (const revisions of [
      { ...geography, revision: -1 },
      { ...geography, revision: 0.5 },
      { ...geography, activityRevision: 2 },
      { ...geography, revision: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(GeographyRevisionsSchema.safeParse(revisions).success).toBe(false);
  });

  it('requires contiguous unique scoped deltas, honest hasMore and a full snapshot on a lost history', () => {
    expect(UniverseDeltasSchema.parse(catchup)).toEqual(catchup);
    const second = {
      ...delta,
      transitionId: uuid(30),
      personalWatermark: 11,
      base: geography,
      geography: { revision: 2, structureRevision: 1, activityRevision: 2 },
      operations: [
        {
          kind: 'set_activity',
          objectId: planet.id,
          objectRevision: 2,
          activity: { availability: 'available', state: 'quiet' },
        },
      ],
    };
    const result = { ...catchup, personalWatermark: 11, geography: second.geography, deltas: [delta, second] };
    expect(UniverseDeltasSchema.parse(result)).toEqual(result);
    expect(UniverseDeltasSchema.safeParse({ ...result, deltas: [delta], hasMore: true }).success).toBe(true);
    expect(UniverseDeltasSchema.safeParse({ ...catchup, afterGeographyRevision: 1, deltas: [] }).success).toBe(true);
    for (const change of [
      { privacyEpoch: 2 },
      { universeId: uuid(99) },
      { personalWatermark: 9 },
      { afterGeographyRevision: 1 },
      { deltas: [second, delta] },
      { deltas: [] },
      { deltas: [delta, delta] },
      { hasMore: true },
      { deltas: [{ ...delta, base: { ...base, structureRevision: 1 } }] },
    ])
      expect(UniverseDeltasSchema.safeParse({ ...catchup, ...change }).success).toBe(false);
    const lost = { version: 'universe-deltas.v1', ...scope, status: 'snapshot_required', geography };
    expect(UniverseDeltasSchema.parse(lost)).toEqual(lost);
    expect(UniverseDeltasSchema.safeParse({ ...lost, deltas: [] }).success).toBe(false);
    expect(ReadUniverseDeltasSchema.parse({ afterGeographyRevision: 0, limit: 10 })).toEqual({
      afterGeographyRevision: 0,
      limit: 10,
    });
    for (const query of [
      { afterGeographyRevision: -1, limit: 10 },
      { afterGeographyRevision: 0, limit: 11 },
      { afterGeographyRevision: 0, limit: 1, create: true },
    ])
      expect(ReadUniverseDeltasSchema.safeParse(query).success).toBe(false);
  });
});

describe('emerging universe cues', () => {
  const emerging = {
    version: 'universe-emerging.v1',
    ...scope,
    recordedAt: '2026-10-21T10:00:00.000Z',
    geography,
    dust: [{ id: uuid(20) }, { id: uuid(21) }],
  };

  it('carries opaque unlabelled cues and nothing that names a topic, a count or a score', () => {
    expect(EmergingUniverseSchema.parse(emerging)).toEqual(emerging);
    expect(EmergingUniverseSchema.parse({ ...emerging, dust: [] }).dust).toEqual([]);
    for (const change of [
      { dust: [{ id: uuid(20), label: 'Machine learning' }] },
      { dust: [{ id: uuid(20), units: 2 }] },
      { dust: [{ id: uuid(20) }, { id: uuid(20) }] },
      { dust: Array.from({ length: EMERGING_LIMITS.dust + 1 }, (_, n) => ({ id: uuid(100 + n) })) },
      { dust: [{ id: 'not-a-uuid' }] },
      { geography: { revision: 1, structureRevision: 2, activityRevision: 0 } },
      { version: 'universe-emerging.v2' },
      { selection },
    ])
      expect(EmergingUniverseSchema.safeParse({ ...emerging, ...change }).success).toBe(false);
  });

  it('takes no input, so a caller cannot name an account or a topic', () => {
    expect(ReadEmergingUniverseSchema.parse({})).toEqual({});
    expect(ReadEmergingUniverseSchema.safeParse({ topicId: 'earth' }).success).toBe(false);
  });
});
