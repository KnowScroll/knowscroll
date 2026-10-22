import type {
  CutroomAccountingTarget,
  CutroomAuthority,
  CutroomScopeTx,
  CutroomSettlement,
  CutroomReviewRecheck,
  WithCutroomScope,
} from '../../../reasoning/public.js';
import type { CommissionReviewPacket } from './commission-review-ports.js';
import type { CommissionChainSnapshots } from './commission-chain-store-ports.js';

export type PublicationSnapshot = Extract<
  Awaited<ReturnType<CommissionChainSnapshots['readSnapshot']>>,
  { kind: 'snapshot' }
>;
declare const mediaProof: unique symbol;
export interface CommissionMediaProof {
  readonly [mediaProof]: true;
}
export interface CommissionVerifiedMedia {
  readonly key: string;
  readonly sha256: string;
  readonly size: number;
  readonly probe: {
    readonly v: 1;
    readonly durationMs: number;
    readonly width: number;
    readonly height: number;
    readonly fps: 24;
    readonly audioHz: 48000;
    readonly channels: 2;
    readonly faststart: true;
  };
}
export interface CommissionMedia {
  prepare(snapshot: PublicationSnapshot): Promise<CommissionMediaProof | undefined>;
  consume(proof: CommissionMediaProof, snapshot: PublicationSnapshot): CommissionVerifiedMedia | undefined;
}
export interface CommissionPublicationContext {
  readonly packet: CommissionReviewPacket;
  readonly publication?: { readonly publicationId: string; readonly snapshotSha256: string; readonly assetId: string };
}
export interface CommissionPublicationStore {
  load(scope: CutroomScopeTx, target: CutroomAccountingTarget): Promise<CommissionPublicationContext | undefined>;
  insert(
    scope: CutroomScopeTx,
    target: CutroomAccountingTarget,
    packet: CommissionReviewPacket,
    snapshot: PublicationSnapshot,
    media: CommissionVerifiedMedia,
  ): Promise<{ readonly publicationId: string; readonly assetId: string }>;
}
export interface CommissionPublicationPorts {
  readonly enabled?: boolean;
  readonly withScope: WithCutroomScope;
  readonly review: CutroomReviewRecheck;
  readonly snapshots: CommissionChainSnapshots;
  readonly media: CommissionMedia;
  readonly store: CommissionPublicationStore;
  readonly settlement: Pick<CutroomSettlement, 'createInScope'>;
}
export type CommissionPublicationResult =
  | {
      readonly kind: 'published';
      readonly publicationId: string;
      readonly assetId: string;
      readonly operationId: string;
    }
  | {
      readonly kind: 'held';
      readonly code: 'disabled' | 'identity' | 'evidence' | 'overage' | 'video' | 'review' | 'media' | 'unavailable';
    };
export interface CommissionPublication {
  publish(
    authority: CutroomAuthority,
    target: CutroomAccountingTarget,
    selector: { readonly snapshotId: string; readonly snapshotSha256: string },
  ): Promise<CommissionPublicationResult>;
}
