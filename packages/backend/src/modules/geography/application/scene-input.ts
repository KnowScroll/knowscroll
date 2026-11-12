import { GeographyObjectSchema, GeographyRouteSchema, type GeographyRoute } from '@knowscroll/contracts';
import { publicPlace, validView } from './apply.js';
import { pinCatalogue } from './catalogue.js';
import type {
  GeographyPorts,
  GeographySceneInput,
  ReadGeographyChangedSystems,
  ReadGeographySceneInput,
} from './ports.js';
import type { Place, Route } from '../domain/policy.js';

function publicRoutes(routes: readonly Route[], objects: readonly Place[]): GeographyRoute[] {
  const idOfKey = new Map(objects.map((o) => [o.key, o.id]));
  return routes.map((r) =>
    GeographyRouteSchema.parse({
      id: r.id,
      kind: 'route',
      fromObjectId: idOfKey.get(r.fromKey)!,
      toObjectId: idOfKey.get(r.toKey)!,
      truthStatus: r.truthStatus,
      relationRevision: r.relationRevision,
      originTransitionId: r.originTransitionId,
      status: r.status,
    }),
  );
}
function publicObjects(objects: readonly Place[], universeId: string): GeographySceneInput['objects'] {
  return objects.map((o) => ({
    ...GeographyObjectSchema.parse(publicPlace(o, universeId, objects)),
    meaningId: o.conceptId,
  }));
}

/**
 * Uses the caller's locked scope, including the current root watermark after any prior writes. With no selection it
 * reads the whole map (the readers that hold it all: a visit, the rooms, a client that predates the sky); `head` and
 * `systems` read none of it or only the systems asked for, however large the map is (D-417).
 */
export function makeReadGeographySceneInput(p: GeographyPorts): ReadGeographySceneInput {
  return async (scope, selection) => {
    if (!(await p.ownerActive(scope))) return { kind: 'refused' };
    const universeId = scope.authority.universeId;
    if (selection !== undefined) {
      const { state, objectCount } = await p.store.head(scope);
      const { revision, structureRevision, activityRevision } = state;
      const geography = { revision, structureRevision, activityRevision },
        personalRevision = await p.rootRevision(scope);
      const base = {
        universeId,
        privacyEpoch: scope.authority.privacyEpoch,
        personalRevision,
        geography,
        objectCount,
      };
      if (selection.kind === 'head') return { kind: 'read', input: { ...base, objects: [], routes: [], aliases: [] } };
      const view = await p.store.systemView(scope, selection.systemIds);
      if (!validView({ state, ...view }, universeId, pinCatalogue(await p.catalogue.current()), { subset: true }))
        return { kind: 'unavailable', reason: 'temporarily_unavailable', geography, personalRevision };
      return {
        kind: 'read',
        input: {
          ...base,
          objects: publicObjects(view.objects, universeId),
          routes: publicRoutes(view.routes, view.objects),
          aliases: [],
        },
      };
    }
    const view = await p.store.view(scope);
    const { revision, structureRevision, activityRevision } = view.state;
    const geography = { revision, structureRevision, activityRevision },
      personalRevision = await p.rootRevision(scope);
    if (view.objects.length > 1000 || view.routes.length + view.aliases.length > 1000)
      return { kind: 'unavailable', reason: 'limit', geography, personalRevision };
    if (!validView(view, universeId, pinCatalogue(await p.catalogue.current())))
      return { kind: 'unavailable', reason: 'temporarily_unavailable', geography, personalRevision };
    return {
      kind: 'read',
      input: {
        universeId,
        privacyEpoch: scope.authority.privacyEpoch,
        personalRevision,
        geography,
        objectCount: view.objects.length,
        objects: publicObjects(view.objects, universeId),
        routes: publicRoutes(view.routes, view.objects),
        aliases: view.aliases.map((a) => ({ ...a })),
      },
    };
  };
}

/** The systems whose places changed after a revision (D-417): from the places' own stamps, one bounded query. */
export function makeReadGeographyChangedSystems(p: Pick<GeographyPorts, 'store'>): ReadGeographyChangedSystems {
  return (scope, query) => p.store.changedSystems(scope, query.since, query.after, query.limit);
}
