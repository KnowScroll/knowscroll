import {
  ReadGeographySchema,
  GeographySnapshotSchema,
  ReadUniverseDeltasSchema,
  UniverseDeltasSchema,
  type GeographySnapshot,
  type GeographyRoute,
} from '@knowscroll/contracts';
import type { GeographyPorts, ReadOwnGeography, ReadOwnDeltas } from './ports.js';
import { publicPlace, validView } from './apply.js';
const sameSelection = (
  a: Parameters<ReadOwnGeography>[1]['selection'],
  b: Parameters<ReadOwnGeography>[1]['selection'],
) => a.kind === b.kind && (a.kind === 'universe' || (b.kind === 'system' && a.systemId === b.systemId));
/** Resource reads are readonly: no role wake-up, model call, invented scene state or personal write. */
export function makeReadGeography(p: GeographyPorts): ReadOwnGeography {
  return async (authority, input) => {
    const q = ReadGeographySchema.parse(input);
    const result = await p.withScope(authority, async (scope) => {
      const view = await p.store.view(scope),
        g = view.state;
      const base = {
        version: 'geography-snapshot.v1' as const,
        universeId: scope.authority.universeId,
        privacyEpoch: scope.authority.privacyEpoch,
        personalWatermark: scope.revisionAtEntry,
        recordedAt: p.now().toISOString(),
        geography: {
          revision: g.revision,
          structureRevision: g.structureRevision,
          activityRevision: g.activityRevision,
        },
        selection: q.selection,
      };
      const unavailable = (reason: 'limit' | 'snapshot_expired' | 'temporarily_unavailable') =>
        ({
          kind: 'read',
          snapshot: GeographySnapshotSchema.parse({ ...base, status: 'unavailable', reason }),
        }) as const;
      if (view.objects.length > 1000 || view.routes.length + view.aliases.length > 1000) return unavailable('limit');
      if (!validView(view, scope.authority.universeId) || !(await p.ownerActive(scope)))
        return unavailable('temporarily_unavailable');
      const systemId = q.selection.kind === 'system' ? q.selection.systemId : undefined;
      const selectedSystem =
        q.selection.kind === 'system' ? view.objects.find((o) => o.id === systemId && o.kind === 'system') : undefined;
      if (q.selection.kind === 'system' && !selectedSystem)
        return { kind: 'refused', reason: 'selection_not_found' } as const;
      const objects = view.objects
        .filter(
          (o) =>
            !selectedSystem ||
            o.id === selectedSystem.id ||
            o.parentKey === selectedSystem.key ||
            view.objects.some((parent) => parent.key === o.parentKey && parent.parentKey === selectedSystem.key),
        )
        .sort((a, b) => a.id.localeCompare(b.id));
      const ids = new Set(objects.map((o) => o.id)),
        keys = new Set(objects.map((o) => o.key));
      if (
        q.cursor &&
        (q.cursor.universeId !== scope.authority.universeId ||
          q.cursor.privacyEpoch !== scope.authority.privacyEpoch ||
          q.cursor.geographyRevision !== g.revision ||
          !sameSelection(q.cursor.selection, q.selection) ||
          q.cursor.afterObjectId !== q.cursor.afterObjectId.toLowerCase() ||
          !ids.has(q.cursor.afterObjectId))
      )
        return unavailable('snapshot_expired');
      const routes = view.routes.filter((r) => keys.has(r.fromKey) && keys.has(r.toKey)),
        aliases = view.aliases.filter((a) => ids.has(a.fromObjectId) && ids.has(a.toObjectId));
      if (routes.length > 100 || aliases.length > 100) return unavailable('limit');
      const active = g.activeRunId ? await p.store.run(scope, g.activeRunId) : undefined;
      const pending = active && ['queued', 'prepared'].includes(active.status);
      if (!objects.length)
        return {
          kind: 'read',
          snapshot: GeographySnapshotSchema.parse({ ...base, status: pending ? 'loading' : 'empty' }),
        } as const;
      const remaining = objects.filter((o) => !q.cursor || o.id > q.cursor.afterObjectId),
        page = remaining.slice(0, q.limit);
      if (!page.length) return unavailable('snapshot_expired');
      const publicRoutes: GeographyRoute[] = routes.map((r) => ({
        id: r.id,
        kind: 'route',
        relationRevision: r.relationRevision,
        originTransitionId: r.originTransitionId,
        status: r.status,
        truthStatus: r.truthStatus,
        fromObjectId: view.objects.find((o) => o.key === r.fromKey)!.id,
        toObjectId: view.objects.find((o) => o.key === r.toKey)!.id,
      }));
      const snapshot: GeographySnapshot = GeographySnapshotSchema.parse({
        ...base,
        status: pending ? 'lagging' : 'ready',
        ...(pending ? { pendingPersonalWatermark: g.materialRevision } : {}),
        page: {
          objects: page.map((o) => publicPlace(o, scope.authority.universeId, view.objects)),
          routes: publicRoutes,
          aliases,
          continuation:
            remaining.length > page.length
              ? {
                  status: 'more',
                  cursor: {
                    universeId: scope.authority.universeId,
                    privacyEpoch: scope.authority.privacyEpoch,
                    geographyRevision: g.revision,
                    selection: q.selection,
                    afterObjectId: page.at(-1)!.id,
                  },
                }
              : { status: 'complete' },
        },
      });
      return { kind: 'read', snapshot } as const;
    });
    return result.kind === 'entered' ? result.value : { kind: 'refused', reason: 'scope_refused' };
  };
}
export function makeReadDeltas(p: GeographyPorts): ReadOwnDeltas {
  return async (authority, input) => {
    const q = ReadUniverseDeltasSchema.parse(input);
    const result = await p.withScope(authority, async (scope) => {
      const g = await p.store.state(scope);
      const base = {
        version: 'universe-deltas.v1' as const,
        universeId: scope.authority.universeId,
        privacyEpoch: scope.authority.privacyEpoch,
        personalWatermark: scope.revisionAtEntry,
        geography: {
          revision: g.revision,
          structureRevision: g.structureRevision,
          activityRevision: g.activityRevision,
        },
      };
      const fallback = () =>
        ({ kind: 'read', deltas: UniverseDeltasSchema.parse({ ...base, status: 'snapshot_required' }) }) as const;
      if (!(await p.ownerActive(scope)) || q.afterGeographyRevision > g.revision) return fallback();
      const deltas = await p.store.deltas(scope, q.afterGeographyRevision, q.limit);
      let expected = q.afterGeographyRevision;
      for (const delta of deltas) {
        if (delta.base.revision !== expected) return fallback();
        expected = delta.geography.revision;
      }
      if (expected < g.revision && !deltas.length) return fallback();
      const parsed = UniverseDeltasSchema.safeParse({
        ...base,
        status: 'available',
        afterGeographyRevision: q.afterGeographyRevision,
        deltas,
        hasMore: expected < g.revision,
      });
      return parsed.success ? ({ kind: 'read', deltas: parsed.data } as const) : fallback();
    });
    return result.kind === 'entered' ? result.value : { kind: 'refused', reason: 'scope_refused' };
  };
}
