import {
  withScopeAtCurrentEpoch,
  type PersonalScopeTx,
  type ReadPersonalRecordingNow,
  type WithDryRunPersonalScope,
  type ScopeRefusal,
} from '../../identity/public.js';
import { DISCOVERY_MAX_TOPICS } from '../../content/public.js';
import {
  shapePlannerDryRun,
  type PlannerContextCounts,
  type PlannerDryRunFacts,
  type PlannerDryRunReport,
} from '../domain/dry-run.js';
import { prepareContext, type ContextPorts } from './context.js';
import type { FrozenContext, PlannerPorts } from './ports.js';
import { plannerContextItems } from './role.js';

/**
 * Dependencies of the dry run: the ports a Planner run freezes its context with, plus where recording
 * stands and whether the role is switched on. `withPersonalScope` must be the read-only,
 * always-rolled-back scope (`makeWithDryRunPersonalScope`).
 */
export interface PlannerDryRunPorts extends ContextPorts, Pick<PlannerPorts, 'fenceRecording'> {
  readonly withPersonalScope: WithDryRunPersonalScope;
  readonly readRecordingNow: ReadPersonalRecordingNow;
  /** The `KS_PLANNER_ENABLED` switch. */
  readonly enabled: () => boolean;
}

export type PlannerDryRunResult =
  | { readonly kind: 'read'; readonly report: PlannerDryRunReport }
  | { readonly kind: 'refused'; readonly refusal: ScopeRefusal['kind'] };

/** Shell operator command (`planner dry-run --universe <uuid>`). */
export type PlannerDryRun = (universeId: string) => Promise<PlannerDryRunResult>;

/** The faults the run itself turns into a recorded end rather than a failed job. */
const KNOWN_FAULTS = ['PLANNER_PROOF_UNAVAILABLE', 'PLANNER_CONTEXT_TOO_LARGE'] as const;

/** Runs a step that may throw one of the run's recorded faults, and answers the fault's code instead of throwing. */
async function recordedFault<T>(step: () => Promise<T> | T): Promise<T | (typeof KNOWN_FAULTS)[number]> {
  try {
    return await step();
  } catch (error) {
    const fault = KNOWN_FAULTS.find((code) => error instanceof Error && error.message === code);
    if (fault === undefined) throw error;
    return fault;
  }
}

const frozenContext = (p: PlannerDryRunPorts, scope: PersonalScopeTx) =>
  recordedFault(async () => prepareContext(p, scope, await p.store.state(scope)));

const countsOf = (context: FrozenContext): PlannerContextCounts => ({
  topics: context.facts.topics.length,
  inventoryItems: context.facts.inventory.length,
  evidence: context.facts.evidence.length,
  intentTopics: context.intent.topicIds.length,
  planOpportunities: context.currentPlan.length,
  recentHasMore: context.selection.recentHasMore,
  topicsTruncated: context.selection.topicsTruncated,
});

const modelItems = (context: FrozenContext) => recordedFault(() => plannerContextItems(context).length);

async function recordingGate(
  p: PlannerDryRunPorts,
  scope: PersonalScopeTx,
): Promise<'open' | 'not_runnable' | 'recording_paused'> {
  const now = await p.readRecordingNow(scope);
  if (now.kind !== 'recording') return now.kind === 'paused' ? 'recording_paused' : 'not_runnable';
  const fenced: Awaited<ReturnType<PlannerPorts['fenceRecording']>> = await p.fenceRecording(scope, now.generation);
  return fenced.kind === 'recording' ? 'open' : 'not_runnable';
}

/**
 * What a Planner run would do for one universe now, without doing it (D-411). It enters the
 * universe's personal scope (the root lock a read takes), freezes a context exactly as the run does
 * (`prepareContext`) and checks it packages for a model, then rolls back. The scope is read-only, so
 * the run cannot write; it enqueues nothing and calls no model.
 *
 * Output: counts and codes only (`shapePlannerDryRun`). The two faults the run records as an end
 * (`PLANNER_PROOF_UNAVAILABLE`, `PLANNER_CONTEXT_TOO_LARGE`) are reported as outcomes; any other error propagates.
 * Failure and retry: safe to run at any time and as often as wanted. It waits for the root lock like a
 * read and gives up with `ScopeBusyError` at the lock timeout.
 */
export function makePlannerDryRun(p: PlannerDryRunPorts): PlannerDryRun {
  return async (universeId) => {
    const entered = await withScopeAtCurrentEpoch(
      p.withPersonalScope,
      universeId,
      'planner.dry-run',
      async (scope): Promise<PlannerDryRunFacts> => {
        const gate = await recordingGate(p, scope);
        const closed: PlannerDryRunFacts = {
          gate,
          roleEnabled: p.enabled(),
          inventoryTopicBound: DISCOVERY_MAX_TOPICS,
          context: undefined,
          fault: undefined,
          contextBytes: undefined,
          modelItems: undefined,
        };
        if (gate !== 'open') return closed;
        const context = await frozenContext(p, scope);
        if (typeof context === 'string') return { ...closed, fault: context };
        const contextBytes = new TextEncoder().encode(JSON.stringify(context)).byteLength;
        const items = await modelItems(context);
        return typeof items === 'string'
          ? { ...closed, context: countsOf(context), contextBytes, fault: items }
          : { ...closed, context: countsOf(context), contextBytes, modelItems: items };
      },
    );
    if (entered.kind === 'refused') return { kind: 'refused', refusal: entered.refusal.kind };
    return { kind: 'read', report: shapePlannerDryRun(entered.value) };
  };
}
