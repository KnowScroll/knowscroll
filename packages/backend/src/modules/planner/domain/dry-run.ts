/**
 * What one Planner run would do for one universe if it ran now (D-411).
 *
 * - `not_runnable`: the universe or its account is not active, or a Clear runs. No run would record anything.
 * - `recording_paused`: recording is paused, so a run is retired and records nothing new.
 * - `disabled`: `KS_PLANNER_ENABLED` is off. The run is stored `blocked/blocked_disabled`.
 * - `proof_unavailable`: the evidence proof cannot be read. The run is stored `blocked/proof_unavailable`.
 * - `context_bounds`: the context is over the model's bounds. The run settles `insufficient/context_bounds`.
 * - `insufficient_evidence`: no qualified evidence. The run settles `insufficient/insufficient_evidence` with no model call.
 * - `calls_model`: the run asks the model for a plan.
 */
export type PlannerDryRunOutcome =
  | 'not_runnable'
  | 'recording_paused'
  | 'disabled'
  | 'proof_unavailable'
  | 'context_bounds'
  | 'insufficient_evidence'
  | 'calls_model';

/** What the run's row would hold afterwards. */
export interface PlannerWouldRecord {
  readonly status: 'blocked' | 'insufficient';
  readonly outcome: string;
}

/** What a frozen context holds, as counts. The context itself carries titles, summaries and ids; the report never sees them. */
export interface PlannerContextCounts {
  readonly topics: number;
  readonly inventoryItems: number;
  readonly evidence: number;
  readonly intentTopics: number;
  readonly planOpportunities: number;
  readonly recentHasMore: boolean;
  readonly topicsTruncated: boolean;
}

/** The facts the report is made from. */
export interface PlannerDryRunFacts {
  readonly gate: 'open' | 'not_runnable' | 'recording_paused';
  readonly roleEnabled: boolean;
  /** The most topics the inventory read is given (Content's discovery bound). */
  readonly inventoryTopicBound: number;
  readonly context: PlannerContextCounts | undefined;
  /** Why no context was frozen: the coded fault `prepareContext` or the model packaging threw. */
  readonly fault: 'PLANNER_PROOF_UNAVAILABLE' | 'PLANNER_CONTEXT_TOO_LARGE' | undefined;
  /** The size of the frozen context's JSON, the 500,000-byte bound's measure. */
  readonly contextBytes: number | undefined;
  /** How many items the model framing holds, when it fits. */
  readonly modelItems: number | undefined;
}

export interface PlannerDryRunReport {
  readonly outcome: PlannerDryRunOutcome;
  readonly wouldRecord: PlannerWouldRecord | null;
  readonly wouldCallModel: boolean;
  readonly roleEnabled: boolean;
  /** The topics in the frozen context (at most 100). */
  readonly topics: number | null;
  /** The most topics the inventory read is given (Content's discovery bound). */
  readonly inventoryTopicBound: number;
  /** Admitted items the inventory read returned (at most 100). */
  readonly inventoryItems: number | null;
  readonly evidence: number | null;
  readonly intentTopics: number | null;
  readonly planOpportunities: number | null;
  readonly recentHasMore: boolean | null;
  readonly topicsTruncated: boolean | null;
  readonly contextBytes: number | null;
  readonly modelItems: number | null;
}

function decide(facts: PlannerDryRunFacts): Pick<PlannerDryRunReport, 'outcome' | 'wouldRecord' | 'wouldCallModel'> {
  const none = (outcome: PlannerDryRunOutcome) => ({ outcome, wouldRecord: null, wouldCallModel: false });
  if (facts.gate === 'not_runnable') return none('not_runnable');
  if (facts.gate === 'recording_paused') return none('recording_paused');
  if (!facts.roleEnabled)
    return {
      outcome: 'disabled',
      wouldRecord: { status: 'blocked', outcome: 'blocked_disabled' },
      wouldCallModel: false,
    };
  if (facts.fault === 'PLANNER_PROOF_UNAVAILABLE')
    return {
      outcome: 'proof_unavailable',
      wouldRecord: { status: 'blocked', outcome: 'proof_unavailable' },
      wouldCallModel: false,
    };
  if (facts.fault === 'PLANNER_CONTEXT_TOO_LARGE')
    return {
      outcome: 'context_bounds',
      wouldRecord: { status: 'insufficient', outcome: 'context_bounds' },
      wouldCallModel: false,
    };
  if (facts.context !== undefined && facts.context.evidence === 0)
    return {
      outcome: 'insufficient_evidence',
      wouldRecord: { status: 'insufficient', outcome: 'insufficient_evidence' },
      wouldCallModel: false,
    };
  return { outcome: 'calls_model', wouldRecord: null, wouldCallModel: true };
}

/**
 * Shapes the dry run's facts into the report an operator may paste into a public issue: counts and
 * codes, never a topic, title, summary, unit or evidence reference. Pure. The outcome follows what
 * `makeRunPlanner` does with a run, in the same order.
 */
export function shapePlannerDryRun(facts: PlannerDryRunFacts): PlannerDryRunReport {
  const { context } = facts;
  return {
    ...decide(facts),
    roleEnabled: facts.roleEnabled,
    topics: context?.topics ?? null,
    inventoryTopicBound: facts.inventoryTopicBound,
    inventoryItems: context?.inventoryItems ?? null,
    evidence: context?.evidence ?? null,
    intentTopics: context?.intentTopics ?? null,
    planOpportunities: context?.planOpportunities ?? null,
    recentHasMore: context?.recentHasMore ?? null,
    topicsTruncated: context?.topicsTruncated ?? null,
    contextBytes: facts.contextBytes ?? null,
    modelItems: facts.modelItems ?? null,
  };
}
