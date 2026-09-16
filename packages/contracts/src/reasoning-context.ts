import {z} from 'zod';
import {reasoningCounter} from './reasoning.ts';

/** ADR-0014 internal development contracts. Shape parsing grants no authority. */
const id=z.string().uuid();
const hash=z.string().regex(/^[0-9a-f]{64}$/);
const label=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/);
const epoch=z.number().int().min(0).max(2147483647);
const scope={universeId:id,privacyEpoch:epoch};
export const DIRECT_CONTEXT_LIMITS=Object.freeze({maxKeeps:16,maxBytes:65_536,maxDependencies:128});
export const DIRECT_CONTEXT_VERSIONS=Object.freeze({compiler:'direct-scroll-evidence-v1',prompt:'literal-keep-facts-v1',sourcePolicy:'editorial-asset-pointer-v1'});
export const contextScroll=z.object({
 assetId:id,revision:z.number().int().min(1).max(2147483647),kind:z.literal('Scroll'),
 title:z.string().max(65_536),summary:z.string().max(65_536),body:z.string().max(65_536),
 sourceTitle:z.string().max(65_536),sourceUrl:z.string().url().max(8192),
 truthState:z.enum(['documented','synthesis','interpretation','disputed','modelled','counterfactual','fictional']),
}).strict();
export const directContextDependency=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('keep'),id,...scope,sequence:reasoningCounter,hash}).strict(),
 z.object({kind:z.literal('exposure_event'),id,...scope,sequence:reasoningCounter,hash}).strict(),
 z.object({kind:z.literal('exposure'),id,...scope,assetId:id,hash}).strict(),
 z.object({kind:z.literal('decision_candidate'),id,...scope,assetId:id,hash}).strict(),
 z.object({kind:z.literal('asset'),id,revision:z.number().int().min(1).max(2147483647),hash}).strict(),
 z.object({kind:z.literal('session'),id,...scope,expiresAt:z.iso.datetime({offset:true})}).strict(),
 z.object({kind:z.literal('runtime_policy'),version:label,hash}).strict(),
]);
export type DirectContextDependency=z.infer<typeof directContextDependency>;
export function directContextDependencyKey(read:DirectContextDependency):string {
 return read.kind==='runtime_policy'?`${read.kind}:${read.version}`:
  read.kind==='decision_candidate'?`${read.kind}:${read.id}:${read.assetId}`:`${read.kind}:${read.id}`;
}
const fact=z.object({
 keepEventId:id,keepSequence:reasoningCounter,keepClientId:id,
 exposureEventId:id,exposureSequence:reasoningCounter,exposureClientId:id,
 exposureId:id,decisionId:id,decisionPolicyVersion:label,decisionAccountRevision:z.number().int().min(0).max(2147483647),assetId:id,
}).strict();
export const directContextPayload=z.object({
 version:z.literal(1),kind:z.literal('direct_scroll_evidence_v1'),
 contextId:id,jobId:id,intentId:id,...scope,
 sessionId:id,sessionExpiresAt:z.iso.datetime({offset:true}),
 compilerVersion:label,promptVersion:label,sourcePolicyVersion:label,
 runtimePolicyVersion:label,runtimePolicyHash:hash,eventHighWater:reasoningCounter,
 selection:z.literal('explicit_keep_ids'),
 facts:z.array(fact).min(1).max(DIRECT_CONTEXT_LIMITS.maxKeeps),
 assets:z.array(contextScroll).min(1).max(DIRECT_CONTEXT_LIMITS.maxKeeps),
 dependencies:z.array(directContextDependency).min(1).max(DIRECT_CONTEXT_LIMITS.maxDependencies),
}).strict().superRefine((value,ctx)=>{
 const seen=new Set<string>();
 for(const [index,read] of value.dependencies.entries()) {
  const key=directContextDependencyKey(read);
  if(seen.has(key))ctx.addIssue({code:'custom',path:['dependencies',index],message:'Duplicate dependency'});
  seen.add(key);
  if('universeId' in read&&(read.universeId!==value.universeId||read.privacyEpoch!==value.privacyEpoch))
   ctx.addIssue({code:'custom',path:['dependencies',index],message:'Foreign dependency'});
 }
 for(const name of ['facts','assets'] as const) {
  const ids=value[name].map(item=>'keepEventId' in item?item.keepEventId:item.assetId);
  if(new Set(ids).size!==ids.length)ctx.addIssue({code:'custom',path:[name],message:'Duplicate selected identity'});
 }
 if(value.facts.some(f=>!value.assets.some(a=>a.assetId===f.assetId)||(reasoningCounter.safeParse(f.keepSequence).success&&reasoningCounter.safeParse(value.eventHighWater).success&&BigInt(f.keepSequence)>BigInt(value.eventHighWater))||(reasoningCounter.safeParse(f.exposureSequence).success&&reasoningCounter.safeParse(f.keepSequence).success&&BigInt(f.exposureSequence)>BigInt(f.keepSequence))))
  ctx.addIssue({code:'custom',path:['facts'],message:'Unbound asset or invalid event ordering'});
});
export type DirectContextPayload=z.infer<typeof directContextPayload>;
export const compileDirectContextInput=z.object({contextId:id,jobId:id,keepEventIds:z.array(id).min(1).max(DIRECT_CONTEXT_LIMITS.maxKeeps)}).strict()
 .refine(value=>new Set(value.keepEventIds).size===value.keepEventIds.length,'Duplicate keep identity');
export const contextRefusal=z.enum(['missing','malformed','foreign','unsupported','obsolete_epoch','inactive_session','stale_lineage','stale_asset','changed_policy','corrupt_seal','bounds_exceeded']);
export type ContextRefusal=z.infer<typeof contextRefusal>;
export type ContextValidation={valid:true;contentHash:string;readSetHash:string}|{valid:false;reason:ContextRefusal};
