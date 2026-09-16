import {z} from 'zod';

const uuid=z.string().uuid().transform(value=>value.toLowerCase());
export const traceRevisitEventId=uuid;
export const traceRevisitScroll=z.object({
 assetId:uuid,revision:z.number().int().positive(),kind:z.literal('Scroll'),
 title:z.string(),summary:z.string(),body:z.string(),sourceTitle:z.string(),
 sourceUrl:z.string().url(),truthState:z.literal('documented'),
}).strict();
export const traceRevisitReceipt=z.object({
 mode:z.literal('kept_revisit'),traceEventId:uuid,universeId:uuid,
 privacyEpoch:z.number().int().min(0).max(2147483647),exposureId:uuid,
 keptAt:z.string().datetime({offset:true}),scroll:traceRevisitScroll,
}).strict();
export type TraceRevisit=z.infer<typeof traceRevisitReceipt>;
