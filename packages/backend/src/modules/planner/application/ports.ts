import type { PersonalAuthority, PersonalScopeTx, ScopeOutcome, WithPersonalScope } from '../../identity/public.js';
import type { ReadDiscoveryCandidates, ReadExactEncounter } from '../../content/public.js';
import type {
  ReadExplorationSnapshot,
  ReadRecentContextTopics,
  ExplorationSnapshot,
} from '../../personal-context/public.js';
import type { ReasoningHarness } from '../../../reasoning/public.js';
import type { Opportunity, PlannerIntent, ValidationFacts } from '../domain/proposal.js';

export interface PlannerState {
  readonly desiredRevision: number;
  readonly materialRevision: number;
  readonly activeRunId?: string;
  readonly acceptedRevision: number;
  readonly intent?: PlannerIntent;
}
export interface FrozenContext {
  readonly version: 'planner-context.v0';
  readonly evaluatedAt: string;
  readonly desiredRevision: number;
  readonly contextRevision: number;
  readonly scopeRevision: number;
  readonly intent: {
    readonly availability: 'explicit' | 'unavailable';
    readonly language: string;
    readonly topicIds: readonly string[];
  };
  readonly selection: {
    readonly policy: 'plan_inventory_recent_union.v0';
    readonly recentHasMore: boolean;
    readonly topicsTruncated: boolean;
    readonly inventoryBound: 100;
    readonly completeness: 'not_asserted';
  };
  readonly snapshot: ExplorationSnapshot;
  readonly facts: ValidationFacts;
  readonly currentPlan: readonly Opportunity[];
  readonly memory: readonly {
    readonly revision: number;
    readonly contextRevision: number;
    readonly opportunities: readonly Opportunity[];
  }[];
}
export interface PlannerRun {
  readonly claimId?: string;
  readonly claimUntil?: string;
  readonly id: string;
  readonly revision: number;
  readonly status: 'queued' | 'prepared' | 'unknown' | 'blocked' | 'accepted' | 'stale' | 'rejected' | 'insufficient';
  readonly context?: FrozenContext;
  readonly outcome?: string;
}
export interface PlannerRevision {
  readonly runId: string;
  readonly revision: number;
  readonly contextRevision: number;
  readonly opportunities: readonly Opportunity[];
}
export interface PlannerStore {
  readonly state: (scope: PersonalScopeTx) => Promise<PlannerState>;
  readonly writeState: (scope: PersonalScopeTx, state: PlannerState) => Promise<void>;
  readonly run: (scope: PersonalScopeTx, id: string) => Promise<PlannerRun | undefined>;
  readonly writeRun: (scope: PersonalScopeTx, run: PlannerRun) => Promise<void>;
  readonly revisions: (scope: PersonalScopeTx, limit: number) => Promise<readonly PlannerRevision[]>;
  readonly accept: (
    scope: PersonalScopeTx,
    run: PlannerRun,
    opportunities: readonly Opportunity[],
    attemptId: string,
  ) => Promise<void>;
}
export interface PlannerPorts {
  readonly withPersonalScope: WithPersonalScope;
  readonly store: PlannerStore;
  readonly readSnapshot: ReadExplorationSnapshot;
  readonly readRecentTopics: ReadRecentContextTopics;
  readonly readInventory: ReadDiscoveryCandidates;
  readonly readExact: ReadExactEncounter;
  readonly capabilities: unknown;
  readonly harness: ReasoningHarness;
  /** Deployment config gate; does not replace provider allowance, harness budgets or quota. */
  readonly enabled: () => boolean;
  readonly enqueue: (scope: PersonalScopeTx, runId: string) => Promise<void>;
  readonly hash: (value: unknown) => string;
  readonly newId: () => string;
  readonly now: () => Date;
  readonly receipts: {
    readonly find: (
      scope: PersonalScopeTx,
      commandId: string,
      hash: string,
    ) => Promise<
      { readonly kind: 'new' | 'refused' } | { readonly kind: 'replay'; readonly outcome: RequestPlannerOutcome }
    >;
    readonly insert: (scope: PersonalScopeTx, commandId: string, hash: string) => Promise<void>;
    readonly complete: (scope: PersonalScopeTx, commandId: string, outcome: RequestPlannerOutcome) => Promise<void>;
  };
}
export type PlannerReadPorts = Pick<
  PlannerPorts,
  'store' | 'readSnapshot' | 'readExact' | 'capabilities' | 'hash' | 'now'
>;
export type RequestPlannerOutcome =
  | { readonly kind: 'accepted'; readonly revision: number; readonly runId: string }
  | { readonly kind: 'refused'; readonly reason: 'command_key_reused' | 'scope_refused' | 'run_not_resumable' };
export type RequestPlanner = (
  authority: PersonalAuthority,
  command: { readonly commandId: string; readonly intent?: PlannerIntent; readonly resumeRunId?: string },
) => Promise<RequestPlannerOutcome>;
/** Producer-owned same-transaction callback; sourceRevision is the committed-next scope revision. */
export type PlannerMaterialChange = (
  scope: PersonalScopeTx,
  input: { readonly sourceRevision: number },
) => Promise<void>;
export type ReadPlannerOpportunities = (
  scope: PersonalScopeTx,
  query: { readonly evaluatedAt: string; readonly limit: number },
) => Promise<{
  readonly revision: number;
  readonly contextRevision: number;
  readonly opportunities: readonly Opportunity[];
  readonly availability: 'available' | 'absent' | 'stale';
}>;
export type RunPlanner = (
  payload: { readonly v: 1; readonly universeId: string; readonly privacyEpoch: number; readonly runId: string },
  signal: AbortSignal,
) => Promise<ScopeOutcome<{ readonly kind: string }>>;
