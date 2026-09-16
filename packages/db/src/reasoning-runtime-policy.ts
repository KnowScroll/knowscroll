import {createHash} from 'node:crypto';
import type pg from 'pg';
import {z} from 'zod';

const id=z.string().uuid(),label=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/);
const count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const reasoningDimension=z.enum(['global_budget','owner_budget','provider_account','route_quota','request_rate','input_rate','output_rate','combined_rate','remote_concurrency','job_budget']);
export const settlementBasis=z.enum(['input_tokens','output_tokens','total_tokens','cost_micro_usd','requests','remote_slots']);
export const settlementHandling=z.enum(['budget','rate','remote']);
const binding=z.object({
 bucketId:id,dimension:reasoningDimension,unit:z.enum(['tokens','requests','slots','micro_usd']),windowId:label.nullable(),
 scope:z.enum(['shared','owner','job']),scopeId:id.nullable(),basis:settlementBasis,handling:settlementHandling,
}).strict();
export const resolvedReasoningPolicy=z.object({
 version:z.literal(1),routeId:label,routeProfileVersion:label,policyVersion:label,
 maxInputTokens:count.min(1),maxOutputTokens:count.min(1),priceBasis:label.nullable(),
 requiredDimensions:z.array(reasoningDimension).min(6).max(10),buckets:z.array(binding).min(6).max(64),
}).strict();
export type ResolvedReasoningPolicy=z.infer<typeof resolvedReasoningPolicy>;
export type ReasoningBinding=z.infer<typeof binding>;
export type ReasoningScope={universeId:string;privacyEpoch:number;jobId:string};
export type ReasoningContextCheck=ReasoningScope & {stepId:string;contextId:string;policyVersion:string};
/** Trusted server configuration only. Implementations do short local/SQL work, never network I/O. */
export interface ReasoningAuthority {
 resolvePolicy(client:pg.PoolClient,scope:ReasoningScope):Promise<unknown>;
 /** lock runs before shared resources; recheck acquires no new dependency locks. */
 validateContext(client:pg.PoolClient,scope:ReasoningContextCheck,phase:'lock'|'recheck'):Promise<boolean>;
}
export class ReasoningDenied extends Error {
 constructor(readonly code:string) {super(`Reasoning operation denied: ${code}`);this.name='ReasoningDenied';}
}
const required=['global_budget','owner_budget','job_budget','provider_account','route_quota','remote_concurrency'] as const;
/** Scope identifiers are checked but omitted from the retained binding fingerprint. */
export function validateReasoningPolicy(input:unknown,scope:ReasoningScope):{policy:ResolvedReasoningPolicy;bindingHash:string} {
 const result=resolvedReasoningPolicy.safeParse(input);
 if(!result.success) throw new ReasoningDenied('invalid_policy');
 const policy=result.data;
 const dims=new Set(policy.requiredDimensions),seen=new Set<string>();
 if(dims.size!==policy.requiredDimensions.length||required.some(d=>!dims.has(d))) throw new ReasoningDenied('incomplete_policy');
 for(const b of policy.buckets) {
  if(seen.has(b.bucketId)||!dims.has(b.dimension)) throw new ReasoningDenied('invalid_bucket_binding');
  seen.add(b.bucketId);
  const expectedScope=b.dimension==='owner_budget'?'owner':b.dimension==='job_budget'?'job':'shared';
  if(b.scope!==expectedScope||b.scopeId!==(expectedScope==='owner'?scope.universeId:expectedScope==='job'?scope.jobId:null)) throw new ReasoningDenied('foreign_bucket_binding');
  const rate=b.dimension.endsWith('_rate');
  if(b.handling!==(b.dimension==='remote_concurrency'?'remote':rate?'rate':'budget')|| (rate&&b.windowId===null)) throw new ReasoningDenied('invalid_bucket_semantics');
  const expectedBasis=b.dimension==='remote_concurrency'?'remote_slots':b.dimension==='request_rate'?'requests':b.dimension==='input_rate'?'input_tokens':b.dimension==='output_rate'?'output_tokens':b.dimension==='combined_rate'?'total_tokens':null;
  if(expectedBasis&&b.basis!==expectedBasis) throw new ReasoningDenied('invalid_usage_basis');
  const unit=b.basis==='remote_slots'?'slots':b.basis==='requests'?'requests':b.basis==='cost_micro_usd'?'micro_usd':'tokens';
  if(b.unit!==unit||(b.basis==='remote_slots'&&b.dimension!=='remote_concurrency')||(b.unit==='micro_usd'&&!policy.priceBasis)) throw new ReasoningDenied('invalid_bucket_unit');
 }
 if([...dims].some(d=>!policy.buckets.some(b=>b.dimension===d))) throw new ReasoningDenied('missing_bucket');
 const canonical={...policy,requiredDimensions:[...dims].sort(),buckets:policy.buckets.map(({scopeId,...rest})=>rest).sort((a,b)=>a.bucketId.localeCompare(b.bucketId))};
 return {policy,bindingHash:createHash('sha256').update(JSON.stringify(canonical)).digest('hex')};
}
export function reservationAmount(binding:ReasoningBinding,inputTokens:number,maxOutputTokens:number,costCeilingMicroUsd:number|null):number {
 const value=binding.basis==='input_tokens'?inputTokens:binding.basis==='output_tokens'?maxOutputTokens:
  binding.basis==='total_tokens'?inputTokens+maxOutputTokens:binding.basis==='cost_micro_usd'?costCeilingMicroUsd:1;
 if(value===null||!Number.isSafeInteger(value)||value<=0) throw new ReasoningDenied('invalid_reservation_estimate');
 return value;
}
