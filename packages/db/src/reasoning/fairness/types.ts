import type {
  ClaimJobInput,
  ReserveAttemptInput,
  ReservedAttempt,
} from '../admission.ts';
import type { FairnessClass } from '../fairness-policy.ts';

export type FairnessReadyInput = Omit<
  ReserveAttemptInput,
  'owner' | 'leaseFence'
> & {
  policyVersion: string;
  class: FairnessClass;
};
export type FairnessScheduleInput = ClaimJobInput & { policyVersion: string };
export type FairnessObservation = {
  kind:
    | 'admitted'
    | 'no_candidate'
    | 'ineligible'
    | 'impossible'
    | 'temporarily_blocked'
    | 'credit_wait'
    | 'capacity_exhausted'
    | 'policy_paused'
    | 'scan_exhausted';
  reason?: string;
  jobId?: string;
  universeId?: string;
  class?: FairnessClass;
  queueAgeMs?: number;
  deadlineMissed?: boolean;
};
export type FairnessScheduled = {
  kind: 'admitted';
  claim: {
    jobId: string;
    universeId: string;
    privacyEpoch: number;
    leaseFence: string;
    leaseExpiresAt: Date;
  };
  reserved: ReservedAttempt;
  charge: number;
  class: FairnessClass;
  observations: FairnessObservation[];
  probes: number;
};
export type FairnessNoWork = {
  kind: Exclude<FairnessObservation['kind'], 'admitted'>;
  observations: FairnessObservation[];
  probes: number;
};
export type ReasoningFairness = {
  installPolicy(input: unknown): Promise<{ version: string; hash: string }>;
  enqueue(input: FairnessReadyInput): Promise<void>;
  schedule(
    input: FairnessScheduleInput,
  ): Promise<FairnessScheduled | FairnessNoWork>;
};
export type State = {
  generation: string;
  class_cursor: number;
  paused: boolean;
  visit_generation: string;
  inner_generation: string;
};
export type Lane = {
  credit: string;
  remaining: string | null;
  universe_cursor: string | null;
  open_universe_id: string | null;
  universe_remaining: string;
  visit_generation: string;
  inner_generation: string;
};
export type UniverseLane = {
  universe_id: string;
  credit: string;
  candidate_cursor: string;
  ready_count: string;
};
export type Ready = FairnessReadyInput & {
  seq: string;
  charge: string;
  queueAgeMs: number;
  deadlineMissed: boolean;
};
export type Discovery = {
  state: State;
  lane: Lane;
  klass: FairnessClass;
  universe: UniverseLane | undefined;
  ready: Ready | undefined;
};
