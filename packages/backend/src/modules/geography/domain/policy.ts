import { z } from 'zod';
/** Experimental passive-formation thresholds, not claims of knowledge or permanent product constants. */
export const GEOGRAPHY_POLICY = 'geography-passive.v1' as const;
export const FORMATION = { systemUnits: 2, planetUnits: 3, planetFacets: 2, quietAfterDays: 30 } as const;
/** One delta carries at most this many operations on the wire. */
export const MAX_PROPOSAL_OPERATIONS = 32;
const Label = z.string().min(1).max(160);
const Ref = z.string().min(1).max(240);
const Supported = { supportRefs: z.array(Ref).min(1).max(100) };
const Creation = { key: Ref, label: Label, truthStatus: z.enum(['factual', 'hypothetical']), ...Supported };
export const GeographyProposalSchema = z.strictObject({
  version: z.literal('cartographer-proposal.v1'),
  operations: z
    .array(
      z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('create_system'), ...Creation }),
        z.strictObject({ kind: z.literal('establish_star'), ...Creation }),
        z.strictObject({ kind: z.literal('form_planet'), ...Creation }),
        z.strictObject({ kind: z.literal('add_region'), ...Creation }),
        z.strictObject({ kind: z.literal('connect_route'), fromKey: Ref, toKey: Ref, ...Supported }),
        z.strictObject({ kind: z.literal('revise_label'), objectId: z.uuid(), label: Label, ...Supported }),
        z.strictObject({
          kind: z.literal('set_activity'),
          objectId: z.uuid(),
          state: z.enum(['active', 'quiet']),
          ...Supported,
        }),
        z.strictObject({
          kind: z.literal('withdraw_relation'),
          relationId: z.uuid(),
          reason: z.literal('organisation_correction'),
          ...Supported,
        }),
      ]),
    )
    .max(MAX_PROPOSAL_OPERATIONS),
});
export type GeographyProposal = z.infer<typeof GeographyProposalSchema>;
export type PlaceKind = 'system' | 'star' | 'planet' | 'region';
export interface Candidate {
  readonly key: string;
  readonly id: string;
  readonly kind: PlaceKind;
  readonly conceptId: string;
  readonly parentKey: string;
  readonly truthStatus: 'factual' | 'hypothetical';
  readonly labels: readonly string[];
}
export interface Place extends Candidate {
  readonly label: string;
  readonly objectRevision: number;
  readonly originTransitionId: string;
  readonly activity:
    | { readonly availability: 'available'; readonly state: 'active' | 'quiet' }
    | { readonly availability: 'unavailable' };
}
export interface Route {
  readonly id: string;
  readonly fromKey: string;
  readonly toKey: string;
  readonly truthStatus: 'factual' | 'hypothetical';
  readonly relationRevision: number;
  readonly originTransitionId: string;
  readonly status: 'current' | 'withdrawn';
}
export interface Support {
  readonly ref: string;
  readonly topicId: string;
  readonly facetId: string;
  readonly explanationUnitId: string;
  readonly truthStatus: 'factual';
  readonly activatedAt: string;
}
export interface Concept {
  readonly id: string;
  readonly parent: string | null;
  readonly facets: readonly string[];
}
export interface FormationFacts {
  readonly catalogue: readonly Concept[];
  readonly supports: readonly Support[];
  readonly candidates: readonly Candidate[];
  readonly objects: readonly Place[];
  readonly routes: readonly Route[];
  readonly evaluatedAt: string;
  readonly completeness: 'not_asserted';
}
export const semanticKey = (kind: PlaceKind, conceptId: string, truthStatus = 'factual') =>
  `${kind}:${conceptId}:${truthStatus}`;
export function supportsFor(f: FormationFacts, c: Candidate): readonly Support[] {
  const topic = f.catalogue.find((t) => t.id === c.conceptId);
  if (c.kind === 'system' || c.kind === 'star')
    return f.supports.filter((s) => f.catalogue.find((t) => t.id === s.topicId)?.parent === c.conceptId);
  if (c.kind === 'region')
    return f.supports.filter(
      (s) => s.facetId === c.conceptId && f.catalogue.some((t) => t.facets.includes(c.conceptId) && t.id === s.topicId),
    );
  return topic ? f.supports.filter((s) => s.topicId === topic.id && topic.facets.includes(s.facetId)) : [];
}
/** Distinct canonical explanation identity, never witness rows, variants, tags, scores or refcounts. */
export function formationEligible(f: FormationFacts, c: Candidate, subset = supportsFor(f, c)): boolean {
  if (c.truthStatus !== 'factual') return false;
  const supports = subset.filter((s) => supportsFor(f, c).some((x) => x.ref === s.ref));
  const units = new Set(supports.map((s) => s.explanationUnitId)).size;
  if (c.kind === 'system' || c.kind === 'star')
    return f.catalogue.some((t) => t.id === c.conceptId && t.parent === null) && units >= FORMATION.systemUnits;
  if (c.kind === 'planet')
    return (
      f.catalogue.some((t) => t.id === c.conceptId && t.parent !== null) &&
      units >= FORMATION.planetUnits &&
      new Set(supports.map((s) => s.facetId)).size >= FORMATION.planetFacets
    );
  return units >= 1;
}
export function activityFor(f: FormationFacts, c: Candidate): 'active' | 'quiet' | undefined {
  const latest = supportsFor(f, c)
    .map((s) => Date.parse(s.activatedAt))
    .sort((a, b) => b - a)[0];
  return latest === undefined
    ? undefined
    : Date.parse(f.evaluatedAt) - latest > FORMATION.quietAfterDays * 86400000
      ? 'quiet'
      : 'active';
}
/**
 * The first operation that makes a proposal invalid, and why. Operations depend on the ones before
 * them, so the shortest failing prefix ends at the culprit. The repair names that operation, which a
 * whole-proposal code cannot.
 */
export function proposalFault(
  proposal: GeographyProposal,
  f: FormationFacts,
): { readonly code: string; readonly operation: number } | undefined {
  const code = proposalIssue(proposal, f);
  if (code === undefined) return undefined;
  const failing = proposal.operations.findIndex((_operation, index) =>
    proposalIssue({ ...proposal, operations: proposal.operations.slice(0, index + 1) }, f),
  );
  return { code, operation: Math.max(failing, 0) };
}
/** Simulate the complete proposal before any write. Parent additions are ordered explicit operations. */
export function proposalIssue(proposal: GeographyProposal, f: FormationFacts): string | undefined {
  const objects = new Map(f.objects.map((o) => [o.key, o] as const));
  const ids = new Set(f.objects.map((o) => o.id)),
    touched = new Set<string>();
  const routes = new Map(f.routes.map((r) => [r.id, r]));
  for (const op of proposal.operations) {
    if (new Set(op.supportRefs).size !== op.supportRefs.length) return 'duplicate_support';
    const selected = op.supportRefs.map((ref) => f.supports.find((s) => s.ref === ref));
    if (selected.some((s) => !s)) return 'support_authority';
    const supports = selected.filter((s): s is Support => s !== undefined);
    if ('key' in op) {
      const c = f.candidates.find((c) => c.key === op.key);
      if (!c) return 'unknown_candidate';
      if (op.truthStatus !== 'factual' || c.truthStatus !== 'factual') return 'unsupported_truth';
      const kind = { create_system: 'system', establish_star: 'star', form_planet: 'planet', add_region: 'region' }[
        op.kind
      ];
      if (c.kind !== kind || objects.has(c.key) || ids.has(c.id) || touched.has(c.key)) return 'identity_conflict';
      if (!c.labels.includes(op.label)) return 'label_authority';
      if (!formationEligible(f, c, supports)) return 'formation_support';
      const parent = objects.get(c.parentKey);
      if (c.kind === 'system') {
        if (c.parentKey !== 'universe') return 'hierarchy';
      } else if (
        !parent ||
        parent.truthStatus !== c.truthStatus ||
        parent.kind !== (c.kind === 'region' ? 'planet' : 'system')
      )
        return 'hierarchy';
      if (c.kind === 'planet' && f.catalogue.find((t) => t.id === c.conceptId)?.parent !== parent?.conceptId)
        return 'grouping';
      if (c.kind === 'region' && !f.catalogue.find((t) => t.id === parent?.conceptId)?.facets.includes(c.conceptId))
        return 'grouping';
      objects.set(c.key, {
        ...c,
        label: op.label,
        objectRevision: 0,
        originTransitionId: 'pending',
        activity: { availability: 'unavailable' },
      });
      ids.add(c.id);
      touched.add(c.key);
    } else if (op.kind === 'connect_route') {
      const a = objects.get(op.fromKey),
        b = objects.get(op.toKey);
      if ((a && a.truthStatus !== 'factual') || (b && b.truthStatus !== 'factual')) return 'unsupported_truth';
      if (
        !a ||
        !b ||
        a.kind !== 'planet' ||
        b.kind !== 'planet' ||
        a.key === b.key ||
        a.parentKey !== b.parentKey ||
        a.truthStatus !== b.truthStatus
      )
        return 'route_authority';
      if (!supports.some((s) => s.topicId === a.conceptId) || !supports.some((s) => s.topicId === b.conceptId))
        return 'support_authority';
      const key = [a.key, b.key].sort().join('|');
      if (touched.has(key) || [...routes.values()].some((r) => [r.fromKey, r.toKey].sort().join('|') === key))
        return 'identity_conflict';
      touched.add(key);
      routes.set(key, {
        id: key,
        fromKey: a.key,
        toKey: b.key,
        truthStatus: a.truthStatus,
        relationRevision: 0,
        originTransitionId: 'pending',
        status: 'current',
      });
    } else if (op.kind === 'withdraw_relation') {
      const r = routes.get(op.relationId);
      if (!r || r.status !== 'current' || touched.has(r.id)) return 'relation_authority';
      const endpoints = [objects.get(r.fromKey), objects.get(r.toKey)];
      if (endpoints.some((o) => o && o.truthStatus !== 'factual')) return 'unsupported_truth';
      if (
        endpoints.some((o) => !o || o.truthStatus !== 'factual') ||
        !endpoints.every((o) => supports.some((s) => s.topicId === o?.conceptId))
      )
        return 'support_authority';
      touched.add(r.id);
      routes.set(r.id, { ...r, status: 'withdrawn' });
    } else {
      const o = [...objects.values()].find((o) => o.id === op.objectId);
      if (o && o.truthStatus !== 'factual') return 'unsupported_truth';
      if (!o || touched.has(o.key)) return 'identity_conflict';
      if (!supports.some((s) => supportsFor(f, o).some((x) => x.ref === s.ref))) return 'support_authority';
      if (op.kind === 'revise_label' && !o.labels.includes(op.label)) return 'label_authority';
      if (op.kind === 'revise_label' && o.label === op.label) return 'no_effect';
      if (op.kind === 'set_activity' && o.activity.availability === 'available' && o.activity.state === op.state)
        return 'no_effect';
      if (op.kind === 'set_activity' && activityFor(f, o) !== op.state) return 'activity_authority';
      touched.add(o.key);
    }
  }
  return undefined;
}
