import { z } from 'zod';
export const uuid = z.string().uuid();
export const exposureInput = z.object({ decisionId: uuid, assetId: uuid, clientExposureId: uuid }).strict();
export const interactionInput = z.object({ clientEventId: uuid, exposureId: uuid, assetId: uuid, kind: z.literal('keep') }).strict();
export type InteractionInput = z.infer<typeof interactionInput>;
export const historyClearInput = z.object({
 requestId: uuid,
 expectedPrivacyEpoch: z.number().int().min(0).max(2147483647),
 confirmation: z.literal('clear-scroll-history'),
}).strict();
export type HistoryClearInput = z.infer<typeof historyClearInput>;
export type HistoryClearReceipt = {receiptId:string;privacyEpoch:number;clearedAt:string};

// ADR-0028 — privacy lifecycle: pause, export and reset. Pause/resume and export share one
// unconfirmed shape (no destructive confirmation literal is needed for either); reset requires
// its own deliberate confirmation literal, matching Clear's pattern, because it is irreversible.
export const privacyLifecycleInput = z.object({
 requestId: uuid,
 expectedPrivacyEpoch: z.number().int().min(0).max(2147483647),
}).strict();
export type PrivacyLifecycleInput = z.infer<typeof privacyLifecycleInput>;
export const privacyResetInput = z.object({
 requestId: uuid,
 expectedPrivacyEpoch: z.number().int().min(0).max(2147483647),
 confirmation: z.literal('reset-personal-universe'),
}).strict();
export type PrivacyResetInput = z.infer<typeof privacyResetInput>;
// ADR-0035: deleting the account is Reset plus the account, its sessions, sign-in tokens and dated
// privacy receipts; it has its own literal because it removes more than Reset does.
export const accountDeletionInput = z.object({
 requestId: uuid,
 expectedPrivacyEpoch: z.number().int().min(0).max(2147483647),
 confirmation: z.literal('delete-my-account-and-history'),
}).strict();
export type AccountDeletionInput = z.infer<typeof accountDeletionInput>;

export type PrivacyRecordingReceipt = {
 receiptId:string; action:'pause'|'resume'; privacyEpoch:number;
 recordingPausedAt:string|null; appliedAt:string;
};
export type PrivacyExportRowCounts = {
 decisions:number; ledger:number; exposures:number; traces:number; jobs:number;
 deviceSessions:number; reasoningJobs:number; reasoningSteps:number;
 reasoningReceipts:number; reasoningAccounting:number;
 branchOpens:number; connectionFeedback:number; semanticProposals:number;
 attentionAccounts:number; hypotheses:number; encounterFeedback:number;
 askAnswers:number;
};
export type PrivacyExportDeviceSession = {
 deviceId:string; origin:string; createdAt:string; expiresAt:string; revokedAt:string|null;
};
export type PrivacyExportResult = {
 receiptId:string; privacyEpoch:number; exportedAt:string; rowCounts:PrivacyExportRowCounts;
 account:{email:string|null};
 universe:{id:string; revision:number; privacyEpoch:number; recordingPausedAt:string|null};
 accounts:{keptAssetIds:string[]; revision:number};
 decisions:unknown[]; ledger:unknown[]; exposures:unknown[]; traces:unknown[]; jobs:unknown[];
 deviceSessions:PrivacyExportDeviceSession[];
 reasoning:{jobs:unknown[]; steps:unknown[]; receipts:unknown[]; accounting:unknown[]};
 semantic:{branchOpens:unknown[]; connectionFeedback:unknown[]; proposals:unknown[]; bridges:unknown[]};
 personalModel:{attentionAccounts:unknown[]; hypotheses:unknown[]; encounterFeedback:unknown[]; atlasPlaces:unknown[]; atlasDeltas:unknown[]};
 /** #132: answer requests and their applied outcomes (ADR-0033). */
 askAnswers:unknown[];
};
export type PrivacyResetReceipt = {
 receiptId:string; epochBefore:number; epochAfter:number; sessionsRevoked:number; resetAt:string;
};
export type AccountDeletionReceipt = {
 receiptId:string; epochBefore:number; epochAfter:number; sessionsDeleted:number; deletedAt:string;
};
export type Lineage = {
  eventId?: string; causationId?: string; exposureId?: string; decisionId?: string;
  jobId?: string; stepId?: string; attemptId?: string; proposalId?: string;
  demandId?: string; generationJobId?: string; requestId?: string;
  assetId?: string; assetRevision?: number; universeId: string;
};
export type TruthState = 'documented' | 'synthesis' | 'interpretation' | 'disputed' | 'modelled' | 'counterfactual' | 'fictional';
export type ConsumptionKind = 'Reel' | 'Scroll';
export type ScrollAsset = { assetId:string; revision:number; kind:'Scroll'; title:string; summary:string; body:string; sourceTitle:string; sourceUrl:string; truthState:'documented' };

// Literal source facts only; no job or paid-task authorization.
const askUuid = uuid.transform(value => value.toLowerCase());
export const explicitAskInput = z.object({
 clientAskId: askUuid,
 exposureId: askUuid,
 expectedPrivacyEpoch: z.number().int().min(0).max(2147483647),
 question: z.string().refine(value => value.trim().length > 0 && !value.includes('\0') &&
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) &&
  new TextEncoder().encode(value).byteLength <= 4096),
}).strict();
export type ExplicitAskInput = z.infer<typeof explicitAskInput>;
export type ExplicitAskReceipt = {askId:string;eventId:string;status:'recorded_only'};

// ADR-0026 — real sign-in: one owner account, email magic link. `email`/`token` are never
// transformed here (normalization is the sign-in module's job, over the exact caller-supplied
// string) so a schema failure never itself distinguishes anything about the value's content.
export const magicLinkRequestInput = z.object({ email: z.string().min(1).max(320) }).strict();
export type MagicLinkRequestInput = z.infer<typeof magicLinkRequestInput>;
export const signInConfirmQuery = z.object({ token: z.string().min(1).max(512) }).strict();
export type SignInConfirmQuery = z.infer<typeof signInConfirmQuery>;
export type SignInConfirmReceipt = { valid: boolean };
export type MagicLinkRequestReceipt = { status: 'requested' };
export type SignInSessionReceipt = {
 sessionToken: string; sessionId: string; deviceId: string; universeId: string;
 privacyEpoch: number; expiresAt: string; accountId: string; origin: 'magic_link';
};
