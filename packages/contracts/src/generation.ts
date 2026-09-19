/** ADR-0023: editorial generation briefs. Authored and reviewed outside the runtime; no model
 * writes one, and no private universe material may enter it. Parsing is not authorization: a brief
 * grants no budget, engine or dispatch. */
import {z} from 'zod';
import {ClaimRef,Criteria,NarrationSentence,StyleContract,SubmitRequest} from './cutroom-v1/request.ts';

/** One claim's evidence inside KnowScroll. The label alone crosses the wire; this never does. */
export const briefClaimSource=z.strictObject({
 claimId:z.string().min(1),
 assetId:z.string().uuid(),
 assetRevision:z.number().int().positive(),
}).readonly();

/** The stage this slice may ask for. Plan and stills stay available for cheaper rehearsals. */
export const briefStage=z.enum(['plan','stills','video']);

export const generationBrief=z.strictObject({
 version:z.literal(1),
 worldId:z.string().min(1).max(200),
 narration:z.array(NarrationSentence).min(4).max(40),
 claims:z.array(ClaimRef).min(1).max(40),
 claimSources:z.array(briefClaimSource).min(1).max(40),
 criteria:Criteria,
 style:StyleContract,
 /** Only the variation the current engine accepts; omitted means the engine's own default. */
 planVaryOn:z.literal('shotCount').optional(),
}).superRefine((brief,ctx)=>{
 const listed=brief.claims.map(claim=>claim.id);
 const sourced=brief.claimSources.map(source=>source.claimId);
 for(const id of listed)if(!sourced.includes(id))ctx.addIssue({code:'custom',path:['claimSources'],
  message:`claim "${id}" has no source; a generated encounter keeps its evidence lineage`});
 for(const id of sourced)if(!listed.includes(id))ctx.addIssue({code:'custom',path:['claimSources'],
  message:`source names claim "${id}", which is not in the claim list`});
 if(new Set(sourced).size!==sourced.length)ctx.addIssue({code:'custom',path:['claimSources'],
  message:'each claim is sourced once'});
 const assets=new Set(brief.claimSources.map(source=>`${source.assetId}@${source.assetRevision}`));
 if(assets.size!==1)ctx.addIssue({code:'custom',path:['claimSources'],
  message:'this slice sources one Scroll revision per brief'});
});
export type GenerationBrief=z.infer<typeof generationBrief>;

/** The exact source revision a brief rests on, for the row that stores it. */
export function briefSource(brief:GenerationBrief):{assetId:string;assetRevision:number} {
 const first=brief.claimSources[0];
 if(first===undefined)throw new Error('A generation brief has at least one claim source');
 return {assetId:first.assetId,assetRevision:first.assetRevision};
}

/**
 * Deterministic compilation to the pinned wire request. Sources, claim text and truth state stay
 * in KnowScroll (reel-contract "what must not be sent"); only labels and criteria cross. The
 * caller supplies the request identity and its authorized ceiling; this function invents neither.
 */
export function compileSubmitRequest(input:{brief:GenerationBrief;requestId:string;until:z.infer<typeof briefStage>;budgetCents:number}):unknown {
 const {brief,requestId,until,budgetCents}=input;
 const request={
  contractVersion:1,
  requestId,
  worldId:brief.worldId,
  narration:brief.narration,
  claims:brief.claims,
  criteria:brief.criteria,
  style:brief.style,
  options:brief.planVaryOn===undefined
   ?{until,budgetCents}
   :{until,budgetCents,planVaryOn:brief.planVaryOn},
 };
 const parsed=SubmitRequest.safeParse(request);
 if(!parsed.success)throw new Error(`Brief does not compile to a valid Cutroom request: ${parsed.error.issues.map(issue=>`${issue.path.join('.')||'(body)'}: ${issue.message}`).join('; ')}`);
 return request;
}
