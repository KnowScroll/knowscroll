import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {validateReasoningPolicy,reservationAmount,type ResolvedReasoningPolicy,ReasoningDenied} from '../packages/db/src/reasoning-runtime-policy.ts';
const scope={universeId:randomUUID(),jobId:randomUUID(),privacyEpoch:0};
function policy():ResolvedReasoningPolicy {
 const dimensions=['global_budget','owner_budget','job_budget','provider_account','route_quota','remote_concurrency','input_rate'] as const;
 return {version:1,routeId:'route',routeProfileVersion:'profile-v1',policyVersion:'policy-v1',maxInputTokens:1000,maxOutputTokens:1000,priceBasis:null,
 requiredDimensions:[...dimensions],buckets:dimensions.map(d=>({bucketId:randomUUID(),dimension:d,
  unit:d==='remote_concurrency'?'slots':'tokens',windowId:d==='input_rate'?'minute-1':null,
  scope:d==='owner_budget'?'owner':d==='job_budget'?'job':'shared',scopeId:d==='owner_budget'?scope.universeId:d==='job_budget'?scope.jobId:null,
  basis:d==='remote_concurrency'?'remote_slots':d==='input_rate'?'input_tokens':'total_tokens',handling:d==='remote_concurrency'?'remote':d==='input_rate'?'rate':'budget'}))};
}
test('runtime policy binding is stable under ordering and changes with accounting interpretation',()=>{
 const p=policy(),first=validateReasoningPolicy(p,scope);
 assert.equal(first.bindingHash,validateReasoningPolicy({...p,buckets:[...p.buckets].reverse(),requiredDimensions:[...p.requiredDimensions].reverse()},scope).bindingHash);
 assert.notEqual(first.bindingHash,validateReasoningPolicy({...p,policyVersion:'policy-v2'},scope).bindingHash);
 assert.notEqual(first.bindingHash,validateReasoningPolicy({...p,buckets:p.buckets.map((b,i)=>i===0?{...b,basis:'input_tokens'}:b)},scope).bindingHash);
});
test('runtime policy refuses missing, duplicate, foreign and mismatched accounting bindings',()=>{
 const cases:Array<(p:ResolvedReasoningPolicy)=>unknown>=[
  p=>({...p,requiredDimensions:p.requiredDimensions.filter(d=>d!=='owner_budget')}),
  p=>({...p,buckets:p.buckets.filter(b=>b.dimension!=='provider_account')}),
  p=>({...p,buckets:[...p.buckets,p.buckets[0]]}),
  p=>({...p,buckets:p.buckets.map(b=>b.scope==='owner'?{...b,scopeId:randomUUID()}:b)}),
  p=>({...p,buckets:p.buckets.map(b=>b.scope==='job'?{...b,scopeId:randomUUID()}:b)}),
  p=>({...p,buckets:p.buckets.map(b=>b.dimension==='input_rate'?{...b,windowId:null}:b)}),
  p=>({...p,buckets:p.buckets.map(b=>b.dimension==='input_rate'?{...b,handling:'budget'}:b)}),
  p=>({...p,buckets:p.buckets.map(b=>b.dimension==='remote_concurrency'?{...b,unit:'tokens'}:b)}),
  p=>({...p,buckets:p.buckets.map(b=>b.dimension==='global_budget'?{...b,basis:'cost_micro_usd',unit:'micro_usd'}:b)}),
  p=>({...p,secret:'not-accepted'}),
 ];
 for(const change of cases) assert.throws(()=>validateReasoningPolicy(change(policy()),scope),ReasoningDenied);
});
test('reservation estimates preserve units and fail closed on absent cost or integer overflow',()=>{
 const p=policy(),token=p.buckets[0]!,remote=p.buckets.find(b=>b.dimension==='remote_concurrency')!;
 assert.equal(reservationAmount(token,100,200,null),300);
 assert.equal(reservationAmount(remote,100,200,null),1);
 const cost={...token,unit:'micro_usd' as const,basis:'cost_micro_usd' as const};
 assert.throws(()=>reservationAmount(cost,100,200,null),ReasoningDenied);
 assert.equal(reservationAmount(cost,100,200,777),777);
 assert.throws(()=>reservationAmount(token,Number.MAX_SAFE_INTEGER,1,null),ReasoningDenied);
});
