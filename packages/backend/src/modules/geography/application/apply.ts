import { UniverseDeltaSchema, type UniverseDelta, type GeographyObject } from '@knowscroll/contracts';
import type { PersonalScopeTx, RecordingScopeTx } from '../../identity/public.js';
import type { Catalogue } from '../domain/catalogue.js';
import { requiredChanges } from '../domain/formation.js';
import { derivedRouteId } from '../domain/ids.js';
import {
  activityFor,
  semanticKey,
  proposalIssue,
  GEOGRAPHY_POLICY,
  type FormationFacts,
  type GeographyProposal,
  type Place,
  type Route,
} from '../domain/policy.js';
import { placeSchedules } from '../domain/quiet.js';
import { PRODUCT_CATALOGUE } from './catalogue.js';
import type { EvaluationScope, GeographyPorts, GeographyContext, GeographyView } from './ports.js';
import { evaluationOf, prepareGeography } from './context.js';
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
/**
 * What an evaluation leaves behind once its facts are committed: each place's last support and next look, and the
 * dirty rows it covered (D-416). Dirty rows are deleted only up to the revision the evaluation read, and only when the
 * rules require nothing more of these facts, so a topic with more due than one delta holds (or evidence that arrived
 * during the run) stays dirty and gets its own paced run. `more` says another run is wanted.
 *
 * Runs in the caller's transaction, after the writes it commits. `clearDirty: false` is the quiet settle, which applies
 * activity only and must leave a due creation to the run that owns it.
 */
export async function commitEvaluation(
  p: Pick<GeographyPorts, 'store' | 'clearDirty'>,
  scope: PersonalScopeTx,
  facts: FormationFacts,
  evaluated: EvaluationScope,
  options: { readonly clearDirty: boolean },
): Promise<{ readonly more: boolean }> {
  await p.store.saveSchedule(scope, placeSchedules(facts));
  if (!options.clearDirty) return { more: false };
  const leftover = requiredChanges(facts).operations.length > 0;
  if (!leftover) await p.clearDirty(scope, { topicIds: evaluated.topics, throughRevision: evaluated.dirtyThrough });
  return { more: leftover || evaluated.hasMore };
}

/**
 * Current authority, complete pure validation, all writes + immutable delta + required work in one root.
 * `runId` names the Cartographer run that made the delta; the quiet sweep has no run and passes none.
 * The apply re-reads exactly the topics the context evaluated (D-416) and writes the schedule of every place among
 * them in the same transaction, so a place's last support and next look never lag the delta that changed it.
 */
export async function applyProposal(
  p: GeographyPorts,
  cap: RecordingScopeTx,
  runId: string | undefined,
  c: GeographyContext,
  proposal: GeographyProposal,
  closeLedger: () => Promise<void>,
  options: { readonly clearDirty?: boolean } = {},
): Promise<
  | { readonly kind: 'applied' | 'replayed'; readonly delta: UniverseDelta; readonly more: boolean }
  | { readonly kind: 'refused'; readonly reason: string; readonly more?: boolean }
> {
  await p.store.root(cap);
  const scope = cap.personal;
  if (
    !(await p.ownerActive(scope)) ||
    c.universeId !== scope.authority.universeId ||
    c.privacyEpoch !== scope.authority.privacyEpoch
  )
    return { kind: 'refused', reason: 'scope_authority' };
  const hash = p.hash({ policy: GEOGRAPHY_POLICY, context: c, proposal }),
    prior = await p.store.findDelta(scope, c.transitionId);
  if (prior) {
    return prior.hash === hash
      ? { kind: 'replayed', delta: prior.delta, more: false }
      : { kind: 'refused', reason: 'transition_key_reused' };
  }
  const state = await p.store.state(scope);
  if (state.revision !== c.base.revision) return { kind: 'refused', reason: 'revision_changed' };
  const evaluated = evaluationOf(c);
  const prepared = await prepareGeography(p, cap, { kind: 'evaluated', evaluated });
  if (prepared.kind !== 'prepared' || !(await p.ownerActive(scope)))
    return { kind: 'refused', reason: 'source_changed' };
  const fresh = prepared.context;
  const view: GeographyView = { state, objects: fresh.facts.objects, routes: fresh.facts.routes, aliases: [] };
  if (!validView(view, c.universeId, p.catalogue)) return { kind: 'refused', reason: 'stored_structure' };
  // New reading since the context was frozen does not void a proposal: it applies when every
  // operation still holds on today's authority. Support that was withdrawn, corrected or retracted
  // makes it fail here as `source_changed`.
  const issue = proposalIssue(proposal, fresh.facts);
  if (issue) return { kind: 'refused', reason: fresh.factsSha256 === c.factsSha256 ? issue : 'source_changed' };
  // A place is created only from a candidate the frozen context named. A concept that reading
  // reached after the freeze is not one a proposal can use.
  if (proposal.operations.some((op) => 'key' in op && !c.facts.candidates.some((slot) => slot.key === op.key)))
    return { kind: 'refused', reason: 'source_changed' };
  if (!proposal.operations.length) {
    const settled = await commitEvaluation(p, scope, fresh.facts, evaluated, {
      clearDirty: options.clearDirty !== false,
    });
    return { kind: 'refused', reason: 'no_changes', more: settled.more };
  }
  const revision = state.revision + 1,
    objects = [...view.objects],
    routes = [...view.routes],
    operations: UniverseDelta['operations'] = [];
  const secret = (await p.store.placeSecret(scope, true))!;
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
      const a = objects.find((x) => x.key === op.fromKey)!,
        b = objects.find((x) => x.key === op.toKey)!;
      const route: Route = {
        id: derivedRouteId(p.mac, secret, op.fromKey, op.toKey),
        fromKey: a.key,
        toKey: b.key,
        truthStatus: a.truthStatus,
        relationRevision: revision,
        originTransitionId: c.transitionId,
        status: 'current',
      };
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
  const added = { objects: objects.length - view.objects.length, relations: routes.length - view.routes.length };
  if (prepared.structure.objects + added.objects > 1000 || prepared.structure.relations + added.relations > 1000)
    return { kind: 'refused', reason: 'limit' };
  await closeLedger();
  const personalWatermark = await p.advance(scope);
  const geography = {
    revision,
    structureRevision: operations.some((x) => x.kind !== 'set_activity') ? revision : state.structureRevision,
    activityRevision: operations.some((x) => x.kind === 'set_activity') ? revision : state.activityRevision,
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
  await p.store.writeState(scope, { ...state, ...geography });
  const settled = await commitEvaluation(p, scope, { ...fresh.facts, objects, routes }, evaluated, {
    clearDirty: options.clearDirty !== false,
  });
  await p.enqueueDelta(scope, delta);
  await p.applied(cap, {
    recordingGeneration: cap.generation,
    transitionId: delta.transitionId,
    geography,
    personalRevision: personalWatermark,
    committedCreations: {
      recordedAt: delta.recordedAt,
      targets: delta.operations.flatMap((operation) => {
        if (
          operation.kind !== 'create_system' &&
          operation.kind !== 'establish_star' &&
          operation.kind !== 'form_planet' &&
          operation.kind !== 'add_region'
        )
          return [];
        const object = operation.object;
        return [
          {
            operation: operation.kind,
            objectId: object.id,
            parentId: object.parent.id,
            kind: object.kind,
            objectRevision: object.objectRevision,
            label: object.label,
            truthStatus: object.truthStatus,
          },
        ];
      }),
    },
  });
  return { kind: 'applied', delta, more: settled.more };
}
/** Validate retained hierarchy and relations before any public read. Aliases have no creation operation. */
export function validView(view: GeographyView, universeId: string, catalogue: Catalogue = PRODUCT_CATALOGUE): boolean {
  const ids = new Map(view.objects.map((o) => [o.id, o])),
    keys = new Map(view.objects.map((o) => [o.key, o]));
  if (ids.size !== view.objects.length || keys.size !== view.objects.length) return false;
  for (const o of view.objects) {
    if (o.objectRevision > view.state.revision || o.key !== semanticKey(o.kind, o.conceptId, o.truthStatus))
      return false;
    const topic = catalogue.topic(o.conceptId);
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
      if (o.kind === 'region' && !catalogue.topic(parent.conceptId)?.facets.some((f) => f.id === o.conceptId))
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
