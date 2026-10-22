import type {
  CutroomB,
  CutroomBResult,
  CutroomAuthority,
  CutroomPoolIdentity,
  CutroomAccountingTarget,
  CutroomExecutionFoundation,
  CutroomSettlement,
  CutroomSettlementPool,
  CutroomMaintenance,
  CutroomDispatchPermit,
  CutroomRemoteObservation,
} from '../../../reasoning/public.js';
import type { CommissionPorts } from './commission-ports.js';
import type { makeCommissionReview } from './commission-review.js';
import type { CommissionChainSnapshots } from './commission-chain-store-ports.js';
import type { CommissionPublication } from './commission-publication-ports.js';
import type { CutroomChainSnapshotCollector } from './commission-contracts.js';
/** Composition supplies only existing exact-operation capabilities. No HTTP or personal port. */
export interface CommissioningPorts {
  readonly enabled?: boolean;
  readonly worldId: 'dev' | 'stage';
  readonly commission: Omit<CommissionPorts, 'admitReview'>;
  readonly reasoning: CutroomB;
  readonly review: ReturnType<typeof makeCommissionReview>;
  readonly execution: CutroomExecutionFoundation;
  readonly maintenance: CutroomMaintenance;
  readonly financial: CutroomSettlement;
  readonly pool: Pick<CutroomSettlementPool, 'available'>;
  readonly snapshots: CommissionChainSnapshots;
  readonly publication: CommissionPublication;
  readonly submit: {
    submit(
      permit: CutroomDispatchPermit,
    ): Promise<
      | ({ readonly kind: 'observed'; readonly dispatchId: string } & CutroomRemoteObservation)
      | { readonly kind: 'held'; readonly code: string }
    >;
  };
  readonly collector: CutroomChainSnapshotCollector;
  /** Rechecks fixed claim operation/current root/business. Returns no bytes or mutable scope. */
  readonly readPoolWork: (input: unknown) => Promise<
    | {
        readonly target: CutroomAccountingTarget;
        readonly authority: CutroomAuthority;
        readonly identity: CutroomPoolIdentity;
        readonly claimPending: boolean;
      }
    | undefined
  >;
}
export type CommissioningDelivery =
  'disabled' | 'held' | 'post_observed' | 'post_unknown' | 'accounting_pending' | 'published' | 'accounting_confirmed';
export interface Commissioning {
  commission(command: unknown, reviewPacket: unknown): Promise<CutroomBResult>;
  pool(input: unknown): Promise<CommissioningDelivery>;
  follow(input: unknown): Promise<CommissioningDelivery>;
  accounting(input: unknown): Promise<CommissioningDelivery>;
  settle(input: unknown): Promise<CommissioningDelivery>;
  recover(input: unknown): Promise<{ readonly scanned: number; readonly woken: number }>;
}
