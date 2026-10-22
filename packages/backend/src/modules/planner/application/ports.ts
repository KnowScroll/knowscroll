import type {
  PersonalAuthority,
  PersonalScopeTx,
  RecordingScopeTx,
  FenceOwnAccount,
  FencePersonalRecording,
  WithPersonalScope,
} from '../../identity/public.js';
import type { ReadDiscoveryCandidates, ReadExactEncounter } from '../../content/public.js';
import type {
  ReadExplorationSnapshot,
  ReadRecentContextTopics,
  ExplorationSnapshot,
} from '../../personal-context/public.js';
import type { RecordingReasoningHarness } from '../../../reasoning/public.js';
import type { PlannerJob } from '../events.js';
import type { Opportunity, PlannerIntent, ValidationFacts } from '../domain/proposal.js';

export type PlannerSource = { readonly generation: number } & (
  | { readonly kind: 'material'; readonly sourceRevision: number }
  | { readonly kind: 'command'; readonly commandId: string }
  | { readonly kind: 'legacy1' }
);
export interface PlannerState {
  readonly desiredSource?: PlannerSource;
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
  readonly recording?: { readonly accountId: string; readonly source: PlannerSource };
  readonly contextSha256?: string;
  readonly modelContextSha256?: string;
  readonly normalWakeId?: string;
  readonly claimWakeClaimId?: string;
  readonly claimId?: string;
  readonly claimUntil?: string;
  readonly id: string;
  readonly revision: number;
  readonly status: 'queued' | 'prepared' | 'unknown' | 'blocked' | 'accepted' | 'stale' | 'rejected' | 'insufficient';
  readonly context?: FrozenContext;
  readonly outcome?: string;
}
export type PlannerRunHeader = Omit<PlannerRun, 'context'> & { readonly hasContext: boolean };
export interface PlannerAccountingHeader {
  readonly id: string;
  readonly status: PlannerRun['status'];
  readonly accountId?: string;
  readonly generation?: number;
}
export interface PlannerRevision {
  readonly runId: string;
  readonly revision: number;
  readonly contextRevision: number;
  readonly opportunities: readonly Opportunity[];
}
export interface PlannerStore {
  readonly accountingHeader: (scope: PersonalScopeTx, id: string) => Promise<PlannerAccountingHeader | undefined>;
  readonly retire: (scope: PersonalScopeTx, id: string) => Promise<boolean>;
  readonly state: (scope: PersonalScopeTx) => Promise<PlannerState>;
  readonly writeState: (scope: PersonalScopeTx, state: PlannerState) => Promise<void>;
  readonly account: (scope: PersonalScopeTx) => Promise<string | undefined>;
  readonly stateHeader: (scope: PersonalScopeTx) => Promise<Omit<PlannerState, 'intent'>>;
  readonly header: (scope: PersonalScopeTx, id: string) => Promise<PlannerRunHeader | undefined>;
  readonly context: (scope: PersonalScopeTx, id: string) => Promise<FrozenContext | undefined>;
  readonly root: (scope: RecordingScopeTx) => Promise<{ readonly accountId: string; readonly revision: number }>;
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
  readonly fenceOwn: FenceOwnAccount;
  readonly fenceRecording: FencePersonalRecording;
  readonly store: PlannerStore;
  readonly readSnapshot: ReadExplorationSnapshot;
  readonly readRecentTopics: ReadRecentContextTopics;
  readonly readInventory: ReadDiscoveryCandidates;
  readonly readExact: ReadExactEncounter;
  readonly capabilities: unknown;
  readonly harness: RecordingReasoningHarness;
  /** Deployment config gate; does not replace provider allowance, harness budgets or quota. */
  readonly enabled: () => boolean;
  readonly enqueue: (
    scope: RecordingScopeTx,
    runId: string,
    delayed?: { readonly startAfter: Date; readonly expectedClaimId: string },
  ) => Promise<void>;
  readonly hash: (value: unknown) => string;
  readonly canonicalHash: (value: unknown) => string;
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
  | {
      readonly kind: 'refused';
      readonly reason: 'command_key_reused' | 'scope_refused' | 'run_not_resumable' | 'recording_required';
    };
export type RequestPlanner = (
  authority: PersonalAuthority,
  command: {
    readonly commandId: string;
    readonly intent?: PlannerIntent;
    readonly resumeRunId?: string;
    readonly recordingGeneration?: number;
  },
) => Promise<RequestPlannerOutcome>;
/** Producer-owned same-transaction callback; sourceRevision is the committed-next scope revision. */
export type PlannerMaterialChange = (
  scope: RecordingScopeTx,
  input: { readonly sourceRevision: number; readonly recordingGeneration: number },
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
  payload: PlannerJob,
  signal: AbortSignal,
) => Promise<
  | { readonly kind: 'entered'; readonly value: { readonly kind: string } }
  | { readonly kind: 'refused'; readonly refusal: { readonly kind: string } }
>;
