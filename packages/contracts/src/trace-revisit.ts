import {z} from 'zod';

const uuid=z.string().uuid().transform(value=>value.toLowerCase());
export const traceRevisitEventId=uuid;
export const traceRevisitScroll=z.object({
 assetId:uuid,revision:z.number().int().positive(),kind:z.literal('Scroll'),
 title:z.string(),summary:z.string(),body:z.string(),sourceTitle:z.string(),
 sourceUrl:z.string().url(),truthState:z.literal('documented'),
}).strict();
// Stored decision candidates include recommendation metadata (currently reason).
// Validate and project only the nine display fields; metadata never enters the
// strict read response or the current-asset equality comparison.
export const traceRevisitCandidate=traceRevisitScroll.passthrough().transform(value=>({
 assetId:value.assetId,revision:value.revision,kind:value.kind,title:value.title,
 summary:value.summary,body:value.body,sourceTitle:value.sourceTitle,
 sourceUrl:value.sourceUrl,truthState:value.truthState,
}));
export const traceRevisitReceipt=z.object({
 mode:z.literal('kept_revisit'),traceEventId:uuid,universeId:uuid,
 privacyEpoch:z.number().int().min(0).max(2147483647),exposureId:uuid,
 keptAt:z.string().datetime({offset:true}),scroll:traceRevisitScroll,
}).strict();
export type TraceRevisit=z.infer<typeof traceRevisitReceipt>;
