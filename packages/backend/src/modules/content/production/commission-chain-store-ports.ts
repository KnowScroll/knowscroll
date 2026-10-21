import type {
  CutroomAccountingScopeTx,
  CutroomAccountingTarget,
  WithCutroomAccountingScope,
  CutroomExecutionFoundation,
  CutroomExecutionBinding,
} from '../../../reasoning/public.js';
import type { CutroomCollectedChain, CutroomChainInput, CutroomChainReport } from './commission-contracts.js';
export type ChainDocumentKind = 'opening' | 'result' | 'record' | 'closing';
export interface ChainDocument {
  readonly runOrdinal: number;
  readonly kind: ChainDocumentKind;
  readonly bodyUtf8: string;
  readonly byteLength: number;
  readonly sha256: string;
}
export interface ChainSnapshotHeader {
  readonly version: 'cutroom-chain-snapshot.v1';
  readonly expected: CutroomChainInput['expected'];
  readonly execution: CutroomExecutionBinding;
  readonly collection: Omit<CutroomCollectedChain, 'version' | 'input'>;
  readonly runs: readonly {
    readonly runId: string;
    readonly openedAtMs: number;
    readonly resultAtMs: number;
    readonly recordAtMs: number;
    readonly closedAtMs: number;
  }[];
  readonly documents: readonly Omit<ChainDocument, 'bodyUtf8'>[];
  readonly summary: {
    readonly chainSha256: string;
    readonly attemptSha256: string;
    readonly actualCents: number;
    readonly overCeiling: boolean;
    readonly videoKind: 'candidate' | 'unavailable';
    readonly videoCode: 'not_video' | 'record' | 'gates' | null;
  };
}
export interface SealedChainSnapshot {
  readonly header: ChainSnapshotHeader;
  readonly headerUtf8: string;
  readonly snapshotSha256: string;
  readonly documents: readonly ChainDocument[];
}
export interface StoredChainSnapshot {
  readonly snapshotId: string;
  readonly observationId: string;
  readonly ordinal: number;
  readonly headerUtf8: string;
  readonly snapshotSha256: string;
  readonly documentCount: number;
  readonly totalDocumentBytes: number;
  readonly validationTimeMs: string;
  readonly actualCents: string;
  readonly overCeiling: boolean;
  readonly videoKind: string;
  readonly documents: readonly ChainDocument[];
}
export type ChainSnapshotSelector =
  { readonly snapshotId: string; readonly snapshotSha256: string } | { readonly observationId: string };
export type ChainStoreRefusal = 'disabled' | 'invalid' | 'identity' | 'capacity' | 'corrupt' | 'unavailable';
export type ChainStoreResult =
  | {
      readonly kind: 'recorded' | 'replayed';
      readonly snapshotId: string;
      readonly observationId: string;
      readonly snapshotSha256: string;
    }
  | { readonly kind: 'refused'; readonly code: ChainStoreRefusal };
export interface CommissionChainStore {
  inspect(
    scope: CutroomAccountingScopeTx,
    snapshot: SealedChainSnapshot,
  ): Promise<
    | { readonly kind: 'available'; readonly ordinal: number }
    | { readonly kind: 'replayed'; readonly snapshotId: string; readonly observationId: string }
    | { readonly kind: 'refused'; readonly code: 'identity' | 'capacity' | 'corrupt' }
  >;
  insert(
    scope: CutroomAccountingScopeTx,
    snapshot: SealedChainSnapshot,
    ordinal: number,
    observationId: string,
  ): Promise<string>;
  read(scope: CutroomAccountingScopeTx, selector: ChainSnapshotSelector): Promise<StoredChainSnapshot | undefined>;
}
export interface CommissionChainStorePorts {
  readonly enabled?: boolean;
  readonly withAccountingScope: WithCutroomAccountingScope;
  readonly execution: Pick<
    CutroomExecutionFoundation,
    'readAccountingBinding' | 'recordObservationInScope' | 'matchesAccountingObservation'
  >;
  readonly store: CommissionChainStore;
}
export interface CommissionChainSnapshots {
  recordCollectedChain(target: CutroomAccountingTarget, collected: unknown): Promise<ChainStoreResult>;
  readSnapshot(
    target: CutroomAccountingTarget,
    selector: ChainSnapshotSelector,
  ): Promise<
    | {
        readonly kind: 'snapshot';
        readonly snapshotId: string;
        readonly observationId: string;
        readonly snapshotSha256: string;
        readonly header: ChainSnapshotHeader;
        readonly documents: readonly ChainDocument[];
        readonly report: Extract<CutroomChainReport, { kind: 'complete' }>;
      }
    | { readonly kind: 'refused'; readonly code: ChainStoreRefusal }
  >;
}
