import { GeographyObjectSchema, GeographyRouteSchema } from '@knowscroll/contracts';
import { publicPlace, validView } from './apply.js';
import type { GeographyPorts, ReadGeographySceneInput } from './ports.js';
/** Uses the caller's locked scope, including the current root watermark after any prior writes. */
export function makeReadGeographySceneInput(p: GeographyPorts): ReadGeographySceneInput {
  return async (scope) => {
    if (!(await p.ownerActive(scope))) return { kind: 'refused' };
    const view = await p.store.view(scope);
    const { revision, structureRevision, activityRevision } = view.state;
    const geography = { revision, structureRevision, activityRevision },
      personalRevision = await p.rootRevision(scope);
    if (view.objects.length > 1000 || view.routes.length + view.aliases.length > 1000)
      return { kind: 'unavailable', reason: 'limit', geography, personalRevision };
    if (!validView(view, scope.authority.universeId))
      return { kind: 'unavailable', reason: 'temporarily_unavailable', geography, personalRevision };
    return {
      kind: 'read',
      input: {
        universeId: scope.authority.universeId,
        privacyEpoch: scope.authority.privacyEpoch,
        personalRevision,
        geography,
        objects: view.objects.map((o) => ({
          ...GeographyObjectSchema.parse(publicPlace(o, scope.authority.universeId, view.objects)),
          meaningId: o.conceptId,
        })),
        routes: view.routes.map((r) =>
          GeographyRouteSchema.parse({
            id: r.id,
            kind: 'route',
            fromObjectId: view.objects.find((o) => o.key === r.fromKey)!.id,
            toObjectId: view.objects.find((o) => o.key === r.toKey)!.id,
            truthStatus: r.truthStatus,
            relationRevision: r.relationRevision,
            originTransitionId: r.originTransitionId,
            status: r.status,
          }),
        ),
        aliases: view.aliases.map((a) => ({ ...a })),
      },
    };
  };
}
