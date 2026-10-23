import type {
  CreateContentRequest,
  ContentRequestReceipt,
  ContentRequestStatus,
  CancelContentRequest,
  CancelContentRequestReceipt,
} from '@knowscroll/contracts';
import type {
  PersonalAuthority,
  PersonalScopeTx,
  WithPersonalScope,
  CheckPersonalOwnerActive,
} from '../../identity/public.js';
import type {
  EncounterSnapshot,
  ReadDiscoveryCandidates,
  ReadExactEncounter,
  LockCurrentEncounters,
} from '../../content/public.js';
import type { CheckRequestSource } from '../../experience/public.js';
import type { ResolveSupplyJob } from '../events.js';

/** Only admitted public catalogue meaning or exact public explanation lineage enters shared work. */
export type CanonicalBrief = {
  readonly version: 'supply-brief.v1';
  readonly rights: 'shared_admitted';
  readonly language: string;
  readonly format: 'reel' | 'scroll' | 'either';
  readonly subject:
    | {
        readonly kind: 'catalogue';
        readonly catalogueVersion: 'content-concepts.v1';
        readonly topicId: string;
        readonly facetId?: string;
      }
    | {
        readonly kind: 'variant';
        readonly explanationUnitId: string;
        readonly source: { readonly assetId: string; readonly assetRevision: number };
      };
};
export type Source = Extract<CreateContentRequest['intent'], { kind: 'variant' }>['source'];
export type UnavailableReason = Extract<ContentRequestStatus, { status: 'unavailable' }>['reason'];
export interface Demand {
  readonly id: string;
  readonly command: CreateContentRequest;
  /** `deferred` is planned demand with no admitted content, waiting on a shared group for a production path. */
  readonly status: 'requested' | 'ready' | 'unavailable' | 'cancelled' | 'deferred';
  /** Set when the Planner asked on the person's behalf; absent means the person asked. */
  readonly planned?: { readonly runId: string; readonly slot: number };
  readonly requestRevision: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly brief?: CanonicalBrief;
  readonly workId?: string;
  readonly decision: 'reuse' | 'join' | 'create' | 'refuse';
  readonly reason?: UnavailableReason;
  readonly content?: EncounterSnapshot;
  readonly contentAvailabilityRevision?: number;
  readonly sourceAvailabilityRevision?: number;
}
export interface SupplyStore {
  read(scope: PersonalScopeTx, id: string): Promise<Demand | undefined>;
  insert(scope: PersonalScopeTx, demand: Demand): Promise<void>;
  finish(scope: PersonalScopeTx, demand: Demand): Promise<void>;
  /** Unique active canonical key; holds no personal scope identity or context. */
  joinOrCreate(
    scope: PersonalScopeTx,
    brief: CanonicalBrief,
    id: string,
  ): Promise<{ readonly id: string; readonly joined: boolean }>;
  closeWork(scope: PersonalScopeTx, id: string): Promise<void>;
}
export type Refusal =
  'scope_refused' | 'command_key_reused' | 'receipt_unavailable' | 'source_unavailable' | 'stale_source' | 'not_found';
export type Result<T> =
  { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'refused'; readonly reason: Refusal };
export type CreateRequest = (
  authority: PersonalAuthority,
  command: CreateContentRequest,
) => Promise<Result<ContentRequestReceipt>>;
export type ReadRequest = (
  authority: PersonalAuthority,
  request: { readonly requestId: string },
) => Promise<Result<ContentRequestStatus>>;
export type CancelRequest = (
  authority: PersonalAuthority,
  command: CancelContentRequest,
) => Promise<Result<CancelContentRequestReceipt>>;
export type ResolveRequest = (job: ResolveSupplyJob) => Promise<void>;

/** One missing-supply opportunity of an accepted Planner plan. */
export interface PlannedDemandInput {
  readonly plannerRunId: string;
  /** Position of the opportunity in the accepted plan, so one opportunity is one demand. */
  readonly slot: number;
  /** The opportunity's topics, most relevant first. The first code-admitted catalogue topic names the brief. */
  readonly topicIds: readonly string[];
  readonly format: 'reel' | 'scroll' | 'either';
  readonly language: string;
  readonly capabilities: CreateContentRequest['capabilities'];
  /** Explanations the person has already met. Reuse skips them: the opportunity asks for something new. */
  readonly alreadyMet: readonly string[];
}
export type PlannedDemandOutcome =
  /** Reuse: admitted content the person has not met already fits. */
  | { readonly kind: 'ready'; readonly requestId: string }
  /** Join or Create-group: waits on the shared matching group. No resolver job and no production run. */
  | { readonly kind: 'deferred'; readonly requestId: string; readonly joined: boolean }
  /** Not a code-admitted catalogue brief (topic outside the catalogue, or a language it cannot produce). */
  | { readonly kind: 'unsupported' };
/**
 * Records the Planner's missing-supply opportunity as private demand inside the caller's personal
 * scope, so it commits atomically with the accepted plan. Applies Reuse then Join/Create-group;
 * the production path that would resolve a deferred demand is a separate capability.
 */
export type RecordPlannedDemand = (scope: PersonalScopeTx, input: PlannedDemandInput) => Promise<PlannedDemandOutcome>;
export interface SupplyPorts {
  readonly withScope: WithPersonalScope;
  readonly ownerActive: CheckPersonalOwnerActive;
  readonly store: SupplyStore;
  readonly readCandidates: ReadDiscoveryCandidates;
  readonly lockCurrent: LockCurrentEncounters;
  readonly readExact: ReadExactEncounter;
  readonly checkSource: CheckRequestSource;
  readonly receipts: {
    find(
      scope: PersonalScopeTx,
      operation: string,
      commandId: string,
      command: CreateContentRequest | CancelContentRequest,
    ): Promise<
      | { readonly kind: 'new' }
      | { readonly kind: 'replay'; readonly outcome: unknown }
      | { readonly kind: 'refused'; readonly reason: 'command_key_reused' | 'receipt_unavailable' }
    >;
    insert(
      scope: PersonalScopeTx,
      operation: string,
      commandId: string,
      command: CreateContentRequest | CancelContentRequest,
    ): Promise<void>;
    complete(
      scope: PersonalScopeTx,
      commandId: string,
      receipt: ContentRequestReceipt | CancelContentRequestReceipt,
    ): Promise<void>;
  };
  readonly enqueue: (scope: PersonalScopeTx, requestId: string) => Promise<void>;
  readonly advance: (scope: PersonalScopeTx) => Promise<number>;
  readonly notify: (scope: PersonalScopeTx, revision: number, eventId: string) => Promise<void>;
  readonly newId: () => string;
  readonly now: () => Date;
}
