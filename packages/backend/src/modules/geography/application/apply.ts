import { UniverseDeltaSchema, type UniverseDelta, type GeographyObject } from '@knowscroll/contracts';
import { CONCEPTS } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import {
  activityFor,
  semanticKey,
  proposalIssue,
  GEOGRAPHY_POLICY,
  type GeographyProposal,
  type Place,
  type Route,
} from '../domain/policy.js';
import type { GeographyPorts, GeographyContext, GeographyView } from './ports.js';
import { prepareGeography } from './context.js';
export function publicPlace(p: Place, universeId: string, objects: readonly Place[]): GeographyObject {
  const parentId = p.parentKey === 'universe' ? universeId : objects.find((o) => o.key === p.parentKey)?.id;
  if (!parentId) throw new Error('GEOGRAPHY_PARENT_MISSING');
  return {
    id: p.id,
    kind: p.kind,
    objectRevision: p.objectRevision,
    label: p.label,
    truthStatus: p.truthStatus,
    activity: p.activity,
    originTransitionId: p.originTransitionId,
    parent: { kind: p.kind === 'system' ? 'universe' : p.kind === 'region' ? 'planet' : 'system', id: parentId },
  } as GeographyObject;
}
/** Current authority, complete pure validation, all writes + immutable delta + required work in one root. */
export async function applyProposal(
  p: GeographyPorts,
  scope: PersonalScopeTx,
  runId: string,
  c: GeographyContext,
  proposal: GeographyProposal,
): Promise<
  | { readonly kind: 'applied' | 'replayed'; readonly delta: UniverseDelta }
  | { readonly kind: 'refused'; readonly reason: string }
> {
  if (
    !(await p.ownerActive(scope)) ||
    c.universeId !== scope.authority.universeId ||
    c.privacyEpoch !== scope.authority.privacyEpoch
  )
    return { kind: 'refused', reason: 'scope_authority' };
  const hash = p.hash({ policy: GEOGRAPHY_POLICY, context: c, proposal }),
    prior = await p.store.findDelta(scope, c.transitionId);
  if (prior)
    return prior.hash === hash
      ? { kind: 'replayed', delta: prior.delta }
      : { kind: 'refused', reason: 'transition_key_reused' };
  const view = await p.store.view(scope);
  if (!validView(view, c.universeId)) return { kind: 'refused', reason: 'stored_structure' };
  if (view.state.revision !== c.base.revision || view.state.desiredRevision !== c.desiredRevision)
    return { kind: 'refused', reason: 'revision_changed' };
  const fresh = await prepareGeography(p, scope, view, c);
  if (
    !fresh ||
    fresh.pcRevision !== c.pcRevision ||
    fresh.factsSha256 !== c.factsSha256 ||
    !(await p.ownerActive(scope))
  )
    return { kind: 'refused', reason: 'source_changed' };
  const issue = proposalIssue(proposal, fresh.facts);
  if (issue) return { kind: 'refused', reason: issue };
  if (!proposal.operations.length) return { kind: 'refused', reason: 'no_changes' };
  const revision = view.state.revision + 1,
    objects = [...view.objects],
    routes = [...view.routes],
    operations: UniverseDelta['operations'] = [];
  const supportWrites: { object?: Place; route?: Route; refs: readonly string[] }[] = [];
  for (const op of proposal.operations) {
    if ('key' in op) {
      const candidate = fresh.facts.candidates.find((x) => x.key === op.key)!;
      const state = activityFor(fresh.facts, candidate);
      const object: Place = {
        ...candidate,
        label: op.label,
        objectRevision: revision,
        originTransitionId: c.transitionId,
        activity: state ? { availability: 'available', state } : { availability: 'unavailable' },
      };
      objects.push(object);
      supportWrites.push({ object, refs: op.supportRefs });
      operations.push({
        kind: op.kind,
        object: publicPlace(object, c.universeId, objects),
      } as UniverseDelta['operations'][number]);
    } else if (op.kind === 'connect_route') {
      const key = [op.fromKey, op.toKey].sort().join('|'),
        a = objects.find((x) => x.key === op.fromKey)!,
        b = objects.find((x) => x.key === op.toKey)!;
      const route: Route = {
        id: c.routeIds[key]!,
        fromKey: a.key,
        toKey: b.key,
        truthStatus: a.truthStatus,
        relationRevision: revision,
        originTransitionId: c.transitionId,
        status: 'current',
      };
      if (!route.id) return { kind: 'refused', reason: 'route_identity' };
      routes.push(route);
      supportWrites.push({ route, refs: op.supportRefs });
      operations.push({
        kind: 'connect_route',
        route: {
          id: route.id,
          kind: 'route',
          fromObjectId: a.id,
          toObjectId: b.id,
          truthStatus: route.truthStatus,
          relationRevision: revision,
          originTransitionId: c.transitionId,
          status: 'current',
        },
      });
    } else if (op.kind === 'withdraw_relation') {
      const old = routes.find((x) => x.id === op.relationId)!,
        route = { ...old, status: 'withdrawn' as const, relationRevision: revision };
      routes[routes.indexOf(old)] = route;
      supportWrites.push({ route, refs: op.supportRefs });
      operations.push({ kind: 'withdraw_relation', relationId: route.id, relationRevision: revision });
    } else {
      const old = objects.find((x) => x.id === op.objectId)!,
        object: Place = {
          ...old,
          objectRevision: revision,
          ...(op.kind === 'revise_label'
            ? { label: op.label }
            : { activity: { availability: 'available' as const, state: op.state } }),
        };
      objects[objects.indexOf(old)] = object;
      supportWrites.push({ object, refs: op.supportRefs });
      operations.push(
        op.kind === 'revise_label'
          ? { kind: 'revise_label', objectId: object.id, objectRevision: revision, label: object.label }
          : { kind: 'set_activity', objectId: object.id, objectRevision: revision, activity: object.activity },
      );
    }
  }
  if (objects.length > 1000 || routes.length + view.aliases.length > 1000) return { kind: 'refused', reason: 'limit' };
  const personalWatermark = await p.advance(scope);
  const geography = {
    revision,
    structureRevision: operations.some((x) => x.kind !== 'set_activity') ? revision : view.state.structureRevision,
    activityRevision: operations.some((x) => x.kind === 'set_activity') ? revision : view.state.activityRevision,
  };
  const delta = UniverseDeltaSchema.parse({
    version: 'universe-delta.v1',
    universeId: c.universeId,
    privacyEpoch: c.privacyEpoch,
    personalWatermark,
    transitionId: c.transitionId,
    recordedAt: p.now().toISOString(),
    base: c.base,
    geography,
    operations,
  });
  for (const write of supportWrites) {
    if (write.object) await p.store.saveObject(scope, write.object, write.refs);
    if (write.route) await p.store.saveRoute(scope, write.route, write.refs);
  }
  await p.store.writeDelta(scope, runId, hash, delta);
  await p.store.writeState(scope, { ...view.state, ...geography });
  await p.enqueueDelta(scope, delta);
  await p.applied(scope, { transitionId: delta.transitionId, geography, personalRevision: personalWatermark });
  return { kind: 'applied', delta };
}
/** Validate retained hierarchy and relations before any public read. Aliases have no creation operation. */
export function validView(view: GeographyView, universeId: string): boolean {
  const ids = new Map(view.objects.map((o) => [o.id, o])),
    keys = new Map(view.objects.map((o) => [o.key, o]));
  if (ids.size !== view.objects.length || keys.size !== view.objects.length) return false;
  for (const o of view.objects) {
    if (o.objectRevision > view.state.revision || o.key !== semanticKey(o.kind, o.conceptId, o.truthStatus))
      return false;
    const topic = CONCEPTS.find((t) => t.id === o.conceptId);
    if (o.kind === 'system' && (!topic || topic.parent !== null)) return false;
    if (o.kind === 'star' && (!topic || topic.parent !== null)) return false;
    if (o.kind === 'planet' && (!topic || topic.parent === null)) return false;
    if (o.kind === 'system') {
      if (o.parentKey !== 'universe') return false;
    } else {
      const parent = keys.get(o.parentKey);
      if (
        !parent ||
        parent.truthStatus !== o.truthStatus ||
        parent.kind !== (o.kind === 'region' ? 'planet' : 'system')
      )
        return false;
      if (o.kind === 'star' && parent.conceptId !== o.conceptId) return false;
      if (o.kind === 'planet' && topic?.parent !== parent.conceptId) return false;
      if (
        o.kind === 'region' &&
        !CONCEPTS.some((t) => t.id === parent.conceptId && t.facets.some((f) => f.id === o.conceptId))
      )
        return false;
    }
    publicPlace(o, universeId, view.objects);
  }
  const relations = new Set<string>();
  for (const r of view.routes) {
    const a = keys.get(r.fromKey),
      b = keys.get(r.toKey);
    if (
      !a ||
      !b ||
      a.id === b.id ||
      a.kind !== 'planet' ||
      b.kind !== 'planet' ||
      a.parentKey !== b.parentKey ||
      a.truthStatus !== r.truthStatus ||
      b.truthStatus !== r.truthStatus ||
      r.relationRevision > view.state.revision ||
      ids.has(r.id) ||
      relations.has(r.id)
    )
      return false;
    relations.add(r.id);
  }
  const currentAliases = view.aliases.filter((a) => a.status === 'current');
  if (new Set(currentAliases.map((a) => a.fromObjectId)).size !== currentAliases.length) return false;
  const aliases = new Map(currentAliases.map((a) => [a.fromObjectId, a]));
  for (const a of view.aliases) {
    const from = ids.get(a.fromObjectId),
      to = ids.get(a.toObjectId);
    if (
      !from ||
      !to ||
      from.kind !== to.kind ||
      from.truthStatus !== to.truthStatus ||
      a.relationRevision > view.state.revision ||
      ids.has(a.id) ||
      relations.has(a.id)
    )
      return false;
    relations.add(a.id);
    const chain = new Set<string>([a.fromObjectId]);
    let target = a.toObjectId;
    while (aliases.get(target)?.status === 'current') {
      if (chain.has(target)) return false;
      chain.add(target);
      target = aliases.get(target)!.toObjectId;
    }
  }
  return true;
}
