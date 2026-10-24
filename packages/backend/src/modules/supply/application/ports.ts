import type {
  CreateContentRequest,
  ContentRequestReceipt,
  ContentRequestStatus,
  ContentRequestList,
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
  ChooseScrollRecipe,
  EncounterSnapshot,
  ReadDiscoveryCandidates,
  ReadExactEncounter,
  ReadRegionEncounterCandidates,
  ReadScrollProduction,
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
  /**
   * `matching`: a free-text ask waiting for its catalogue match (no brief or group yet).
   * `requested`: waiting on a shared group. `deferred`: the same, for demand the Planner asked for.
   */
  readonly status: 'requested' | 'ready' | 'unavailable' | 'cancelled' | 'deferred' | 'matching';
  /** Set when the Planner asked on the person's behalf; absent means the person asked. */
  readonly planned?: { readonly runId: string; readonly slot: number };
  readonly requestRevision: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly brief?: CanonicalBrief;
  readonly workId?: string;
  /** `pending` until a `matching` ask has its match. */
  readonly decision: 'reuse' | 'join' | 'create' | 'refuse' | 'pending';
  readonly reason?: UnavailableReason;
  readonly content?: EncounterSnapshot;
  readonly contentAvailabilityRevision?: number;
  readonly sourceAvailabilityRevision?: number;
}
/** Who started a shared group's production: a person's own ask, or the Planner's demand. Each has its own daily cap. */
export type CommissionOrigin = 'person' | 'planner';

/** A shared matching group as a waiter needs to know it. */
export interface WorkRecord {
  readonly id: string;
  /** The library recipe whose production job this group commissioned; absent when it commissioned nothing. */
  readonly recipe?: string;
}
export interface SupplyStore {
  read(scope: PersonalScopeTx, id: string): Promise<Demand | undefined>;
  insert(scope: PersonalScopeTx, demand: Demand): Promise<void>;
  /** Ends or advances an open demand: status, revisions, outcome and, for a matched ask, its brief, group and decision. */
  finish(scope: PersonalScopeTx, demand: Demand): Promise<void>;
  /**
   * Takes the lock that serialises Create decisions, so the day's count and the group they start agree.
   * Last in the lock order: after the personal root, the owned demand and Content's locks.
   */
  lockCommissioning(scope: PersonalScopeTx): Promise<void>;
  /** The active shared group of exactly this brief, if one exists. */
  findActiveWork(scope: PersonalScopeTx, brief: CanonicalBrief): Promise<WorkRecord | undefined>;
  /**
   * Unique active canonical key; holds no personal scope identity or context. `recipe` is fixed when the
   * group is created and ignored when another group already holds the key.
   */
  joinOrCreate(
    scope: PersonalScopeTx,
    brief: CanonicalBrief,
    id: string,
    commission?: { readonly recipe: string; readonly origin: CommissionOrigin },
  ): Promise<{ readonly id: string; readonly joined: boolean }>;
  readWork(scope: PersonalScopeTx, id: string): Promise<WorkRecord | undefined>;
  /** Groups started since `since` by this origin with a production job: what a daily Create cap counts. */
  countCommissionedSince(scope: PersonalScopeTx, since: Date, origin: CommissionOrigin): Promise<number>;
  /** The person's own asks that are still open (waiting to be matched or produced), which bound their poll jobs. */
  countOpenPersonDemands(scope: PersonalScopeTx): Promise<number>;
  closeWork(scope: PersonalScopeTx, id: string): Promise<void>;
  /** The person's own asks (not the Planner's), newest first. */
  listPersonDemands(scope: PersonalScopeTx, limit: number): Promise<readonly Demand[]>;
  /** The person's open planned demand (`deferred` or `ready`) for exactly this canonical brief, if any. */
  findOpenPlanned(
    scope: PersonalScopeTx,
    brief: CanonicalBrief,
  ): Promise<{ readonly id: string; readonly state: 'deferred' | 'ready' } | undefined>;
}
export type Refusal =
  | 'scope_refused'
  | 'command_key_reused'
  | 'receipt_unavailable'
  | 'source_unavailable'
  | 'stale_source'
  | 'not_found'
  /** The person already has the most open asks they may have; no receipt is written. */
  | 'too_many_open';
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
/** The person's own recent asks with their current status; read only. */
export type ListRequests = (authority: PersonalAuthority) => Promise<Result<ContentRequestList>>;
/** The stop signal of the queue delivery; a free-text match waits on a model and must be abortable. */
export interface ResolveDelivery {
  readonly signal: AbortSignal;
}
/**
 * Advances one waiter: matches a free-text ask, waits for the production that serves it, then binds
 * the admitted content or closes the request honestly (D-037).
 */
export type ResolveRequest = (job: ResolveSupplyJob, delivery?: ResolveDelivery) => Promise<void>;

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
  /** The person already has open planned demand for this brief (an earlier plan asked); nothing is added. */
  | { readonly kind: 'already_recorded'; readonly requestId: string }
  /** Join or Create: waits on the shared group, and a resolver job binds it when its production ends. */
  | { readonly kind: 'deferred'; readonly requestId: string; readonly joined: boolean }
  /** Nothing can produce it now: the day's Create cap is reached, Create is off, or no recipe is left. Nothing is stored. */
  | { readonly kind: 'not_commissioned' }
  /** Not a code-admitted catalogue brief (topic outside the catalogue, or a language it cannot produce). */
  | { readonly kind: 'unsupported' };
/**
 * Records the Planner's missing-supply opportunity as private demand inside the caller's personal
 * scope, so it commits atomically with the accepted plan. Applies Reuse, then Join or Create: a
 * Create commits the shared production job with the plan.
 */
export type RecordPlannedDemand = (scope: PersonalScopeTx, input: PlannedDemandInput) => Promise<PlannedDemandOutcome>;
export interface SupplyPorts {
  readonly withScope: WithPersonalScope;
  readonly ownerActive: CheckPersonalOwnerActive;
  readonly store: SupplyStore;
  readonly readCandidates: ReadDiscoveryCandidates;
  /**
   * Scrolls whose admitted coverage binds an exact topic and facet. A catalogue facet is established
   * by coverage, never by the discovery projection's own facet labels, which do not carry catalogue
   * facet IDs.
   */
  readonly readFacetCandidates: ReadRegionEncounterCandidates;
  /** Quartermaster's Create: which library recipe a catalogue brief commissions, decided by code. */
  readonly chooseRecipe: ChooseScrollRecipe;
  /** Where one recipe's production stands, for a waiter deciding whether to keep waiting. */
  readonly readProduction: ReadScrollProduction;
  /** Sends the production job of one take of a recipe in the caller's transaction (idempotent per recipe, version and take). */
  readonly enqueueProduction: (scope: PersonalScopeTx, recipe: string, take: number) => Promise<void>;
  /** Shared Scroll productions Create may start per UTC day, by who asks; 0 turns Create off for that origin. */
  readonly createDailyCaps: Readonly<Record<CommissionOrigin, number>>;
  /**
   * Which of these explanations the person has already met, re-derived inside the scope. Planned demand
   * asks for something new, so it never binds to one of them.
   */
  readonly readMetUnits: (
    scope: PersonalScopeTx,
    query: { readonly topicIds: readonly string[]; readonly units: readonly string[] },
  ) => Promise<ReadonlySet<string>>;
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
  /**
   * Sends a resolver job for one waiter in the caller's transaction. A later poll names its slot, and a
   * repeat of the same request and slot is a no-op.
   */
  readonly enqueue: (
    scope: PersonalScopeTx,
    requestId: string,
    options?: { readonly startAfter: Date; readonly slot: number },
  ) => Promise<void>;
  readonly advance: (scope: PersonalScopeTx) => Promise<number>;
  readonly notify: (scope: PersonalScopeTx, revision: number, eventId: string) => Promise<void>;
  readonly newId: () => string;
  readonly now: () => Date;
}
