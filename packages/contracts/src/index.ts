import { z } from 'zod';
export const uuid = z.string().uuid();
export const exposureInput = z.object({ decisionId: uuid, assetId: uuid, clientExposureId: uuid }).strict();
export const interactionInput = z.object({ clientEventId: uuid, exposureId: uuid, assetId: uuid, kind: z.literal('keep') }).strict();
export type InteractionInput = z.infer<typeof interactionInput>;
export type Lineage = {
  eventId?: string; causationId?: string; exposureId?: string; decisionId?: string;
  jobId?: string; stepId?: string; attemptId?: string; proposalId?: string;
  demandId?: string; generationJobId?: string; requestId?: string;
  assetId?: string; assetRevision?: number; universeId: string;
};
export type TruthState = 'documented' | 'synthesis' | 'interpretation' | 'disputed' | 'modelled' | 'counterfactual' | 'fictional';
export type ConsumptionKind = 'Reel' | 'Scroll';
export type ScrollAsset = { assetId:string; revision:number; kind:'Scroll'; title:string; summary:string; body:string; sourceTitle:string; sourceUrl:string; truthState:'documented' };
