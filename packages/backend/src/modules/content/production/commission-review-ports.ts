import type { CutroomCommissionScript } from './commission-contracts.js';
import type { CutroomReviewBinding, CutroomScopeTx, CutroomPreparationScopeTx } from '../../../reasoning/public.js';
export interface ReelTemplateDescriptor {
  readonly narrationClaimCounts: readonly number[];
  readonly claimRoles: readonly ('main' | 'supporting')[];
  readonly mustShowTypes: readonly ('presence' | 'event')[];
  readonly mustNotShowTypes: readonly ('presence' | 'event')[];
  readonly depictionPolicyVersion: string;
  readonly styleId: string;
  readonly styleVersion: number;
  readonly planVaryOn: 'shotCount' | 'order' | 'canonicalSubject' | 'angle' | null;
}
export interface ReelArgumentDescriptor {
  readonly worldId: string;
  readonly sources: readonly string[];
  readonly narrationText: readonly string[];
}
export interface ReelCorpusRecord {
  readonly sourceNamespace: string;
  readonly generatedReelId: string;
  readonly sourceSnapshotRevision: string;
  readonly originalTemplateSha256: string | null;
  readonly originalArgumentSha256: string | null;
  readonly briefSha256: string;
  readonly descriptorSourceRef: string;
  readonly algorithmEvidenceRef: string;
  readonly template: ReelTemplateDescriptor;
  readonly argument: ReelArgumentDescriptor;
  readonly bridgeSha256: string;
}
/** Trusted complete metadata inventory, never request data. All statuses/versions/scopes must be represented. */
export interface ReelCorpusManifest {
  readonly version: 'reel-corpus-completeness.v1';
  readonly snapshotId: string;
  readonly sourceScopesAndRevisions: readonly string[];
  readonly totalCount: number;
  readonly allPagesDigest: string;
  readonly descriptorMappingDigest: string;
  readonly requiredProjectionIds: readonly ['legacy-template-v1', 'legacy-argument-v1', 'narration-bridge-v1'];
  readonly trustedReviewCommandSha256: string;
}
export interface CommissionReviewDraft {
  readonly version: 'cutroom-review.v1';
  readonly businessRunId: string;
  readonly worldId: 'dev' | 'stage';
  readonly generation: number;
  readonly take: number;
  readonly ceilingCents: number;
  readonly grantRef: 'knowscroll-v2-d018';
  readonly grantCeilingCents: 200;
  readonly rightsReviewRef: string;
  readonly framingReviewRef: string;
  readonly targetReviewRef: string;
  readonly script: CutroomCommissionScript;
  readonly scriptSha256: string;
  readonly evidenceSha256: string;
  readonly requestId: string;
  readonly requestSha256: string;
  readonly byteLength: number;
  readonly template: ReelTemplateDescriptor;
  readonly templateSha256: string;
  readonly bridge: { readonly narrationText: readonly string[] };
  readonly bridgeSha256: string;
}
export interface CommissionReviewPacket extends CommissionReviewDraft {
  readonly corpusSnapshotSha256: string;
  readonly corpusGate: 'clear';
  readonly reviewSha256: string;
}
export type CommissionReviewPreparation =
  | { readonly kind: 'prepared'; readonly packet: CommissionReviewPacket }
  | {
      readonly kind: 'refused';
      readonly code: 'invalid' | 'identity' | 'corpus_unavailable' | 'repetition' | 'stale_snapshot';
    };
/** Explicit human evidence matched by trusted composition; parsed refs/PR/Git identity cannot mint this registry. */
export interface CommissionHumanApproval {
  readonly businessRunId: string;
  readonly worldId: 'dev' | 'stage';
  readonly generation: number;
  readonly reviewSha256: string;
  readonly scriptSha256: string;
  readonly evidenceSha256: string;
  readonly requestSha256: string;
  readonly ceilingCents: number;
  readonly humanEvidenceRef: string;
}
export type CommissionReviewVerdict =
  | { readonly kind: 'reviewed'; readonly binding: CutroomReviewBinding }
  | {
      readonly kind: 'refused';
      readonly code:
        'invalid' | 'identity' | 'corpus_unavailable' | 'repetition' | 'approval' | 'revoked' | 'stale_snapshot';
    };
export interface CommissionReviewStore {
  prepare(
    scope: CutroomScopeTx,
    input: unknown,
    manifests: readonly ReelCorpusManifest[],
  ): Promise<CommissionReviewPreparation>;
  gate(
    scope: CutroomScopeTx,
    packet: CommissionReviewPacket,
    manifests: readonly ReelCorpusManifest[],
    humanEvidenceRef: string,
  ): Promise<CommissionReviewVerdict>;
  recheck(
    scope: CutroomScopeTx,
    businessRunId: string,
    approvals: readonly CommissionHumanApproval[],
    manifests: readonly ReelCorpusManifest[],
  ): Promise<CutroomReviewBinding | undefined>;
}

/** Separate read-only store: no gate/admit/recheck, business mutation or approval capability. */
export interface CommissionPreparationStore {
  prepareReadOnly(
    scope: CutroomPreparationScopeTx,
    input: unknown,
    manifests: readonly ReelCorpusManifest[],
  ): Promise<CommissionReviewPreparation>;
}
