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
  readonly status: 'requested' | 'ready' | 'unavailable' | 'cancelled';
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
