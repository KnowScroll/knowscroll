import type { ComposerSnapshot, Features, PlanInfluence, PlannedOpportunity } from './types.js';

/**
 * Share of Intent (vertical) or Continuity (horizontal) that the person's plan can fill when the
 * plan has an opportunity for the move. The rest stays with the existing meaning of the feature,
 * so a candidate that matches the current intent always beats one that does not (blueprint §10:
 * current intent overrides a plan immediately).
 */
export const PLAN_SHARE = 0.25;

/** Agreement of a candidate with its best opportunity: same explanation, or only a shared topic. */
const AGREEMENT = { unit: 1, topic: 0.5 } as const;

type Candidate = ComposerSnapshot['candidates'][number];

/** Vertical moves read opportunities suited to a new subject; horizontal moves read those suited to the thread. */
function planFeature(mode: ComposerSnapshot['mode']): PlanInfluence['feature'] | undefined {
  return mode === 'vertical' ? 'intent' : mode === 'horizontal' ? 'continuity' : undefined;
}

/** Opportunities that are unexpired at evaluation time and suit this move, in plan priority order. */
function activeOpportunities(
  snapshot: ComposerSnapshot,
): readonly { index: number; opportunity: PlannedOpportunity }[] {
  const plan = snapshot.evidence?.plan;
  const thread = snapshot.mode === 'vertical' ? 'vertical' : 'related';
  if (!plan || !planFeature(snapshot.mode)) return [];
  return plan.opportunities
    .map((opportunity, index) => ({ index, opportunity }))
    .filter(
      ({ opportunity }) =>
        Date.parse(opportunity.expiresAt) > Date.parse(snapshot.evaluatedAt) &&
        opportunity.eligibility.includes(thread),
    );
}

function matchOf(opportunity: PlannedOpportunity, candidate: Candidate): PlanInfluence['match'] | undefined {
  const encounter = candidate.encounter;
  if (!opportunity.formats.includes(encounter.kind)) return undefined;
  if (opportunity.target === 'existing' && opportunity.explanationUnitId === encounter.explanationUnitId) return 'unit';
  const topics = encounter.topics.filter((t) => t.role !== 'incidental').map((t) => t.topicId);
  return opportunity.topicIds.some((topicId) => topics.includes(topicId)) ? 'topic' : undefined;
}

/**
 * Blends the person's plan into Intent or Continuity for one candidate.
 *
 * With no active opportunity for this move the features are returned untouched. Otherwise the
 * feature becomes `(1 - PLAN_SHARE) * base + PLAN_SHARE * agreement`, which stays within [0, 1]
 * and lets the plan decide only between candidates the intent does not already separate.
 * The influence is returned only for a candidate that an opportunity actually matched.
 */
export function applyPlan(
  snapshot: ComposerSnapshot,
  candidate: Candidate,
  base: Features,
): { readonly features: Features; readonly influence?: PlanInfluence } {
  const active = activeOpportunities(snapshot);
  const feature = planFeature(snapshot.mode);
  const plan = snapshot.evidence?.plan;
  if (!plan || !feature || active.length === 0) return { features: base };
  let best: { index: number; match: PlanInfluence['match'] } | undefined;
  for (const { index, opportunity } of active) {
    const match = matchOf(opportunity, candidate);
    if (match && (!best || AGREEMENT[match] > AGREEMENT[best.match])) best = { index, match };
  }
  const before = base[feature];
  const after = (1 - PLAN_SHARE) * before + PLAN_SHARE * (best ? AGREEMENT[best.match] : 0);
  const features = { ...base, [feature]: after };
  return best
    ? {
        features,
        influence: { planRevision: plan.revision, opportunity: best.index, match: best.match, feature, before, after },
      }
    : { features };
}
