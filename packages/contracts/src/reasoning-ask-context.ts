import {z} from 'zod';
import {explicitAskInput} from './index.ts';
import {reasoningCounter} from './reasoning.ts';
import {contextScroll} from './reasoning-context.ts';

const id=z.string().uuid();
const hash=z.string().regex(/^[0-9a-f]{64}$/);
const label=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/);
const scope={universeId:id,privacyEpoch:z.number().int().min(0).max(2147483647)};
export const ASK_CONTEXT_VERSIONS=Object.freeze({compiler:'direct-ask-evidence-v1',prompt:'literal-ask-facts-v1',sourcePolicy:'ask-editorial-asset-pointer-v1'});
export const ASK_CONTEXT_LIMITS=Object.freeze({maxBytes:65_536,maxDependencies:8});
export const askContextDependency=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('ask'),id,...scope,sequence:reasoningCounter,hash}).strict(),
 z.object({kind:z.literal('ask_binding'),id,...scope,jobId:id,eventId:id,sessionId:id,exposureId:id,clientAskId:id,hash}).strict(),
 z.object({kind:z.literal('exposure_event'),id,...scope,sequence:reasoningCounter,hash}).strict(),
 z.object({kind:z.literal('exposure'),id,...scope,assetId:id,hash}).strict(),
 z.object({kind:z.literal('decision_candidate'),id,...scope,assetId:id,hash}).strict(),
 z.object({kind:z.literal('asset'),id,revision:z.number().int().min(1).max(2147483647),hash}).strict(),
 z.object({kind:z.literal('session'),id,...scope,expiresAt:z.iso.datetime({offset:true})}).strict(),
 z.object({kind:z.literal('runtime_policy'),version:label,hash}).strict(),
]);
export type AskContextDependency=z.infer<typeof askContextDependency>;
export function askContextDependencyKey(read:AskContextDependency):string {
 return read.kind==='runtime_policy'?`${read.kind}:${read.version}`:
  read.kind==='decision_candidate'?`${read.kind}:${read.id}:${read.assetId}`:`${read.kind}:${read.id}`;
}
export const askContextPayload=z.object({
 version:z.literal(1),kind:z.literal('direct_ask_evidence_v1'),contextId:id,jobId:id,intentId:id,...scope,
 sessionId:id,sessionExpiresAt:z.iso.datetime({offset:true}),
 compilerVersion:z.literal(ASK_CONTEXT_VERSIONS.compiler),promptVersion:z.literal(ASK_CONTEXT_VERSIONS.prompt),sourcePolicyVersion:z.literal(ASK_CONTEXT_VERSIONS.sourcePolicy),
 runtimePolicyVersion:label,runtimePolicyHash:hash,eventHighWater:reasoningCounter,
 selection:z.literal('explicit_ask_id'),
 fact:z.object({askId:id,askEventId:id,askSequence:reasoningCounter,askClientId:id,question:explicitAskInput.shape.question,
  exposureEventId:id,exposureSequence:reasoningCounter,exposureClientId:id,exposureId:id,
  decisionId:id,decisionPolicyVersion:label,decisionAccountRevision:z.number().int().min(0).max(2147483647),assetId:id}).strict(),
 asset:contextScroll,
 dependencies:z.array(askContextDependency).length(ASK_CONTEXT_LIMITS.maxDependencies),
}).strict().superRefine((v,ctx)=>{
 const f=v.fact;
 const expected=new Set([`ask:${f.askEventId}`,`ask_binding:${f.askId}`,`exposure_event:${f.exposureEventId}`,`exposure:${f.exposureId}`,
  `decision_candidate:${f.decisionId}:${f.assetId}`,`asset:${f.assetId}`,`session:${v.sessionId}`,`runtime_policy:${v.runtimePolicyVersion}`]);
 const seen=new Set<string>();
 for(const [i,r] of v.dependencies.entries()){
  const key=askContextDependencyKey(r);
  if(seen.has(key)||!expected.has(key))ctx.addIssue({code:'custom',path:['dependencies',i],message:'Duplicate or extra dependency'});
  seen.add(key);
  if('universeId' in r&&(r.universeId!==v.universeId||r.privacyEpoch!==v.privacyEpoch))ctx.addIssue({code:'custom',path:['dependencies',i],message:'Foreign dependency'});
  const bound=r.kind==='ask'?r.sequence===f.askSequence:
   r.kind==='ask_binding'?r.jobId===v.jobId&&r.eventId===f.askEventId&&r.sessionId===v.sessionId&&r.exposureId===f.exposureId&&r.clientAskId===f.askClientId:
   r.kind==='exposure_event'?r.sequence===f.exposureSequence:
   r.kind==='session'?r.expiresAt===v.sessionExpiresAt:
   r.kind==='runtime_policy'?r.hash===v.runtimePolicyHash:
   r.kind==='asset'?r.revision===v.asset.revision:
   r.kind==='exposure'||r.kind==='decision_candidate'?r.assetId===f.assetId:true;
  if(!bound)ctx.addIssue({code:'custom',path:['dependencies',i],message:'Dependency does not match selection'});
 }
 if(seen.size!==expected.size||[...expected].some(k=>!seen.has(k)))ctx.addIssue({code:'custom',path:['dependencies'],message:'Incomplete dependency set'});
 if(v.intentId!==f.askId||v.asset.assetId!==f.assetId)ctx.addIssue({code:'custom',path:['fact'],message:'Unbound Ask or asset'});
 if([f.askSequence,f.exposureSequence,v.eventHighWater].every(x=>reasoningCounter.safeParse(x).success)&&
  (BigInt(f.exposureSequence)>=BigInt(f.askSequence)||BigInt(f.askSequence)>BigInt(v.eventHighWater)))ctx.addIssue({code:'custom',path:['fact'],message:'Invalid event ordering'});
});
export type AskContextPayload=z.infer<typeof askContextPayload>;
export const compileDirectAskContextInput=z.object({contextId:id,jobId:id,askId:id}).strict();
