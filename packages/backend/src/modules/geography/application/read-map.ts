import {
  GeographySnapshotSchema,
  GEOGRAPHY_LIMITS,
  type GeographyAlias,
  type GeographyObject,
  type GeographyRoute,
  type GeographySnapshot,
  type ReadGeography,
} from '@knowscroll/contracts';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { Place } from '../domain/policy.js';
import { publicPlaceOf, validView } from './apply.js';
import type { GeographyPorts } from './ports.js';

type Result =
  | { readonly kind: 'read'; readonly snapshot: GeographySnapshot }
  | { readonly kind: 'refused'; readonly reason: 'selection_not_found' };
const sameSelection = (a: ReadGeography['selection'], b: ReadGeography['selection']) =>
  a.kind === b.kind && (a.kind === 'universe' || (b.kind === 'system' && a.systemId === b.systemId));

/**
 * The `geography-read.v2` read of a map at scale (D-417). It never loads the whole map and no size of map makes it
 * fail: the universe selection pages the places alone (no routes), and a system's routes and aliases come with that
 * system, each on the page that holds its `fromObjectId`. A page ends early rather than hold more than 100 routes or
 * 100 aliases; one place that alone owns more than that is `limit`. Readonly: no role wake-up, model call or write.
 */
export async function readMapAtScale(p: GeographyPorts, scope: PersonalScopeTx, q: ReadGeography): Promise<Result> {
  const { state: g, objectCount } = await p.store.head(scope);
  const universeId = scope.authority.universeId;
  const base = {
    version: 'geography-snapshot.v1' as const,
    universeId,
    privacyEpoch: scope.authority.privacyEpoch,
    personalWatermark: scope.revisionAtEntry,
    recordedAt: p.now().toISOString(),
    geography: { revision: g.revision, structureRevision: g.structureRevision, activityRevision: g.activityRevision },
    selection: q.selection,
  };
  const snapshot = (s: object): Result => ({
    kind: 'read',
    snapshot: GeographySnapshotSchema.parse({ ...base, ...s }),
  });
  const unavailable = (reason: 'limit' | 'snapshot_expired' | 'temporarily_unavailable') =>
    snapshot({ status: 'unavailable', reason });
  if (!(await p.ownerActive(scope))) return unavailable('temporarily_unavailable');
  const cursor = q.cursor;
  const cursorFence =
    cursor !== undefined &&
    (cursor.universeId !== universeId ||
      cursor.privacyEpoch !== scope.authority.privacyEpoch ||
      cursor.geographyRevision !== g.revision ||
      !sameSelection(cursor.selection, q.selection) ||
      cursor.afterObjectId !== cursor.afterObjectId.toLowerCase());

  let page: { place: Place; parentId: string }[];
  let more: boolean;
  let routes: GeographyRoute[] = [];
  const aliases: GeographyAlias[] = [];
  if (q.selection.kind === 'universe') {
    if (cursor !== undefined && (cursorFence || !(await p.store.hasObject(scope, cursor.afterObjectId))))
      return unavailable('snapshot_expired');
    const rows = await p.store.pageObjects(scope, cursor?.afterObjectId, q.limit + 1);
    more = rows.length > q.limit;
    // A system's parent is the universe; any other place with no parent is stored wrong.
    if (rows.some((r) => r.parentId === null && r.place.kind !== 'system'))
      return unavailable('temporarily_unavailable');
    page = rows.slice(0, q.limit).map((r) => ({ place: r.place, parentId: r.parentId ?? universeId }));
  } else {
    const systemId = q.selection.systemId;
    const view = await p.store.systemView(scope, [systemId]);
    if (!view.objects.some((o) => o.id === systemId && o.kind === 'system'))
      return { kind: 'refused', reason: 'selection_not_found' };
    if (!validView({ state: g, ...view }, universeId, { subset: true })) return unavailable('temporarily_unavailable');
    const objects = [...view.objects].sort((a, b) => a.id.localeCompare(b.id));
    if (cursor !== undefined && (cursorFence || !objects.some((o) => o.id === cursor.afterObjectId)))
      return unavailable('snapshot_expired');
    const idOfKey = new Map(objects.map((o) => [o.key, o.id]));
    const routesOf = new Map<string, GeographyRoute[]>(),
      aliasesOf = new Map<string, GeographyAlias[]>();
    for (const r of view.routes) {
      const from = idOfKey.get(r.fromKey)!;
      routesOf.set(from, [
        ...(routesOf.get(from) ?? []),
        {
          id: r.id,
          kind: 'route',
          fromObjectId: from,
          toObjectId: idOfKey.get(r.toKey)!,
          truthStatus: r.truthStatus,
          relationRevision: r.relationRevision,
          originTransitionId: r.originTransitionId,
          status: r.status,
        },
      ]);
    }
    for (const a of view.aliases) aliasesOf.set(a.fromObjectId, [...(aliasesOf.get(a.fromObjectId) ?? []), a]);
    const remaining = objects.filter((o) => !cursor || o.id > cursor.afterObjectId);
    page = [];
    let routeCount = 0,
      aliasCount = 0;
    for (const o of remaining) {
      if (page.length === q.limit) break;
      const ownRoutes = routesOf.get(o.id) ?? [],
        ownAliases = aliasesOf.get(o.id) ?? [];
      if (ownRoutes.length > GEOGRAPHY_LIMITS.routes || ownAliases.length > GEOGRAPHY_LIMITS.aliases)
        return unavailable('limit');
      if (
        page.length > 0 &&
        (routeCount + ownRoutes.length > GEOGRAPHY_LIMITS.routes ||
          aliasCount + ownAliases.length > GEOGRAPHY_LIMITS.aliases)
      )
        break;
      routeCount += ownRoutes.length;
      aliasCount += ownAliases.length;
      routes.push(...ownRoutes);
      aliases.push(...ownAliases);
      page.push({ place: o, parentId: o.parentKey === 'universe' ? universeId : idOfKey.get(o.parentKey)! });
    }
    more = remaining.length > page.length;
  }
  routes = routes.sort((a, b) => a.id.localeCompare(b.id));

  const active = g.activeRunId ? await p.store.header(scope, g.activeRunId) : undefined;
  const gate = await p.fenceRecording(scope, active?.recording?.source.generation);
  const pending =
    active &&
    ['queued', 'prepared'].includes(active.status) &&
    gate.kind === 'recording' &&
    (!active.recording ? gate.scope.generation === 1 : active.recording.source.generation === gate.scope.generation);
  if (objectCount === 0) return snapshot({ status: pending ? 'loading' : 'empty' });
  if (!page.length) return unavailable('snapshot_expired');
  const objects: GeographyObject[] = page.map((entry) => publicPlaceOf(entry.place, entry.parentId));
  return snapshot({
    status: pending ? 'lagging' : 'ready',
    ...(pending ? { pendingPersonalWatermark: g.materialRevision } : {}),
    page: {
      objects,
      routes,
      aliases,
      continuation: more
        ? {
            status: 'more',
            cursor: {
              universeId,
              privacyEpoch: scope.authority.privacyEpoch,
              geographyRevision: g.revision,
              selection: q.selection,
              afterObjectId: page.at(-1)!.place.id,
            },
          }
        : { status: 'complete' },
    },
  });
}
