import type { CommissionReceiveBinding, CommissionReceivePayload } from './commission-receive-contracts.js';
import type { CommissionVerifiedMedia } from './commission-publication-ports.js';
declare const receiveScope: unique symbol;
export interface ReceiveScopeTx {
  readonly [receiveScope]: true;
  readonly authority: { readonly worldId: 'dev' | 'stage'; readonly generation: number };
  readonly mode: 'admit' | 'recover';
  readonly enabled: boolean;
}
export type WithReceiveScope = <T>(
  authority: ReceiveScopeTx['authority'],
  mode: ReceiveScopeTx['mode'],
  work: (scope: ReceiveScopeTx) => Promise<T>,
) => Promise<
  | { readonly kind: 'entered'; readonly value: T }
  | { readonly kind: 'refused'; readonly code: 'disabled' | 'generation' }
>;
export interface ReceiveEnvelope {
  readonly payloadUtf8: string;
  readonly payloadSha256: string;
}
export interface ReceiveReceipt {
  readonly receiptId: string;
  readonly handoffId: string;
  readonly assetId: string;
  readonly assetRevision: number;
  readonly receiptSha256: string;
}
export interface ReceiveRecord extends ReceiveEnvelope {
  readonly payload: CommissionReceivePayload;
  readonly state: 'pending' | 'admitted' | 'expired';
  readonly leaseId?: string;
  readonly receipt?: ReceiveReceipt;
}
declare const mediaProof: unique symbol;
export interface ReceiveMediaProof {
  readonly [mediaProof]: true;
}
export interface ReceiveMedia {
  prepare(payload: CommissionReceivePayload, binding: CommissionReceiveBinding): Promise<ReceiveMediaProof | undefined>;
  consume(
    proof: ReceiveMediaProof,
    payload: CommissionReceivePayload,
    binding: CommissionReceiveBinding,
  ): CommissionVerifiedMedia | undefined;
}
export interface ReceiveStore {
  stage(
    scope: ReceiveScopeTx,
    envelope: ReceiveEnvelope,
    payload: CommissionReceivePayload,
    binding: CommissionReceiveBinding,
  ): Promise<ReceiveRecord | undefined>;
  load(scope: ReceiveScopeTx, handoffId: string, lease: boolean): Promise<ReceiveRecord | undefined>;
  admit(
    scope: ReceiveScopeTx,
    record: ReceiveRecord,
    binding: CommissionReceiveBinding,
    media: CommissionVerifiedMedia,
  ): Promise<ReceiveReceipt | undefined>;
  end(scope: ReceiveScopeTx, handoffId: string, leaseId: string): Promise<void>;
  recover(input: unknown): Promise<{ readonly scanned: number; readonly woken: number }>;
}
export interface CommissionReceivePorts {
  readonly enabled?: boolean;
  /** Only disposable fixture composition may admit documents explicitly labelled fixture. */
  readonly fixture?: boolean;
  readonly authority: ReceiveScopeTx['authority'];
  readonly now: () => number;
  readonly withScope: WithReceiveScope;
  readonly store: ReceiveStore;
  /** Trusted composition re-reads its Root-file registry; caller/queue data cannot mint it. */
  readonly readBinding: (handoffId: string, payloadSha256: string) => Promise<CommissionReceiveBinding | undefined>;
  readonly media: ReceiveMedia;
}
export type ReceiveResult =
  { readonly kind: 'admitted'; readonly receipt: ReceiveReceipt } | { readonly kind: 'pending' | 'held' | 'disabled' };
export interface CommissionReceive {
  stage(envelope: unknown): Promise<ReceiveResult>;
  receive(input: unknown): Promise<ReceiveResult>;
  recover(input: unknown): Promise<{ readonly scanned: number; readonly woken: number }>;
}
/** Source snapshot joins Content with the narrow immutable confirmed Reasoning receipt. */
export interface CommissionReceiveOrigin {
  read(publicationId: string, targetWorld: 'dev' | 'stage'): Promise<CommissionReceivePayload | undefined>;
}
