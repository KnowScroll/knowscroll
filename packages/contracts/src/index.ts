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
