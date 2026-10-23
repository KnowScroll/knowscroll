import { refKey } from './policy.js';
import type { ComposerSnapshot, Features, PlanInfluence, PlannedOpportunity } from './types.js';

/**
 * How far a plan can lift Intent (vertical) or Continuity (horizontal) for a candidate it names, at
 * full agreement. The lift is added, never scaled, and capped at 1.
 */
export const PLAN_LIFT = 0.15;
/**
 * Candidates this close to the best value of the feature count as tied with it. Only a tied
 * candidate can be lifted, so the plan decides between candidates the current intent (or the
 * admitted link) does not already separate, and can never overtake a better match
 * (blueprint §10: current intent overrides a plan immediately).
 */
export const PLAN_TIE_EPSILON = 0.01;

/** Agreement of a candidate with its best opportunity: same explanation, or only a shared topic. */
const AGREEMENT = { unit: 1, topic: 0.5 } as const;

type Candidate = ComposerSnapshot['candidates'][number];
export interface PlanCandidate {
  readonly candidate: Candidate;
  readonly base: Features;
}
export interface PlanLift {
  readonly features: Features;
  readonly influence: PlanInfluence;
}

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

/** The strongest match among the active opportunities; the higher priority wins a tie. */
function bestMatch(
  active: readonly { index: number; opportunity: PlannedOpportunity }[],
  candidate: Candidate,
): { index: number; match: PlanInfluence['match'] } | undefined {
  let best: { index: number; match: PlanInfluence['match'] } | undefined;
  for (const { index, opportunity } of active) {
    const match = matchOf(opportunity, candidate);
    if (match && (!best || AGREEMENT[match] > AGREEMENT[best.match])) best = { index, match };
  }
  return best;
}

/**
 * Lifts, for the eligible candidates only, the feature the person's plan informs.
 *
 * The base features come first, from the current intent and links alone. The plan then adds
 * `PLAN_LIFT × agreement` (capped at 1) to the candidates that tie for the best base value and match
 * an active opportunity. Nobody else changes: a candidate below the best is never lifted and none is
 * scaled down, so an old plan cannot outrank a candidate that matches the current intent better.
 * Returns an entry only for a candidate whose features changed, with the influence to record.
 */
export function planLifts(
  snapshot: ComposerSnapshot,
  eligible: readonly PlanCandidate[],
): ReadonlyMap<string, PlanLift> {
  const lifts = new Map<string, PlanLift>();
  const feature = planFeature(snapshot.mode);
  const plan = snapshot.evidence?.plan;
  const active = activeOpportunities(snapshot);
  if (!plan || !feature || active.length === 0 || eligible.length === 0) return lifts;
  const best = Math.max(...eligible.map(({ base }) => base[feature]));
  for (const { candidate, base } of eligible) {
    const before = base[feature];
    if (before < best - PLAN_TIE_EPSILON) continue;
    const match = bestMatch(active, candidate);
    if (!match) continue;
    const after = Math.min(1, before + PLAN_LIFT * AGREEMENT[match.match]);
    if (after <= before) continue;
    lifts.set(refKey(candidate.encounter), {
      features: { ...base, [feature]: after },
      influence: { planRevision: plan.revision, opportunity: match.index, match: match.match, feature, before, after },
    });
  }
  return lifts;
}
