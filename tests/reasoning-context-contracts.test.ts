import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {directContextPayload,compileDirectContextInput} from '../packages/contracts/src/reasoning-context.ts';

function fixture() {
 const universeId=randomUUID(),sessionId=randomUUID(),assetId=randomUUID();
 const keepEventId=randomUUID(),exposureEventId=randomUUID(),exposureId=randomUUID(),decisionId=randomUUID();
 const expiresAt='2026-09-17T00:00:00.000Z',hash='a'.repeat(64),scope={universeId,privacyEpoch:0};
 return {
  version:1,kind:'direct_scroll_evidence_v1',contextId:randomUUID(),jobId:randomUUID(),intentId:randomUUID(),...scope,
  sessionId,sessionExpiresAt:expiresAt,compilerVersion:'direct-scroll-evidence-v1',promptVersion:'literal-keep-facts-v1',sourcePolicyVersion:'editorial-asset-pointer-v1',
  runtimePolicyVersion:'fixture-v1',runtimePolicyHash:hash,eventHighWater:'12',selection:'explicit_keep_ids',
  facts:[{keepEventId,keepSequence:'12',keepClientId:randomUUID(),exposureEventId,exposureSequence:'10',exposureClientId:randomUUID(),exposureId,decisionId,decisionPolicyVersion:'editorial-unkept-v1',decisionAccountRevision:0,assetId}],
  assets:[{assetId,revision:1,kind:'Scroll',title:'Fixture',summary:'Synthetic',body:'Literal test evidence',sourceTitle:'Fixture',sourceUrl:'https://example.test/source',truthState:'documented'}],
  dependencies:[
   {kind:'keep',id:keepEventId,...scope,sequence:'12',hash},
   {kind:'exposure_event',id:exposureEventId,...scope,sequence:'10',hash},
   {kind:'exposure',id:exposureId,...scope,assetId,hash},
   {kind:'decision_candidate',id:decisionId,...scope,assetId,hash},
   {kind:'asset',id:assetId,revision:1,hash},
   {kind:'session',id:sessionId,...scope,expiresAt},
   {kind:'runtime_policy',version:'fixture-v1',hash},
  ],
 };
}
test('sealed context shape rejects incomplete, duplicate and substituted dependency authority',()=>{
 const good=fixture();assert.equal(directContextPayload.safeParse(good).success,true);
 for(let i=0;i<good.dependencies.length;i++) {
  const missing=structuredClone(good);missing.dependencies.splice(i,1);
  assert.equal(directContextPayload.safeParse(missing).success,false,`missing dependency ${i}`);
 }
 const duplicate=structuredClone(good);duplicate.dependencies.push({...duplicate.dependencies[0]!});
 assert.equal(directContextPayload.safeParse(duplicate).success,false);
 const foreign=structuredClone(good);Object.assign(foreign.dependencies[0]!,{universeId:randomUUID()});
 assert.equal(directContextPayload.safeParse(foreign).success,false);
 const substituted=structuredClone(good);Object.assign(substituted.dependencies[5]!,{expiresAt:'2027-01-01T00:00:00.000Z'});
 assert.equal(directContextPayload.safeParse(substituted).success,false);
 const extra=structuredClone(good),extraId=randomUUID();
 extra.assets.push({...extra.assets[0]!,assetId:extraId});
 extra.dependencies.push({kind:'asset',id:extraId,revision:1,hash:'a'.repeat(64)});
 assert.equal(directContextPayload.safeParse(extra).success,false);
 const policy=structuredClone(good);policy.dependencies[6]!.hash='b'.repeat(64);
 assert.equal(directContextPayload.safeParse(policy).success,false);
});
test('context counter and bounds rejection does not throw or silently truncate',()=>{
 for(const value of ['not-a-counter','-1','9223372036854775808']) {
  const input=fixture();input.facts[0]!.keepSequence=value;
  assert.doesNotThrow(()=>assert.equal(directContextPayload.safeParse(input).success,false));
 }
 const future=fixture();future.eventHighWater='9';
 assert.equal(directContextPayload.safeParse(future).success,false);
 const input={contextId:randomUUID(),jobId:randomUUID(),keepEventIds:[randomUUID()]};
 assert.equal(compileDirectContextInput.safeParse({...input,sessionId:randomUUID()}).success,false);
 assert.equal(compileDirectContextInput.safeParse({...input,keepEventIds:[input.keepEventIds[0],input.keepEventIds[0]]}).success,false);
 assert.equal(compileDirectContextInput.safeParse({...input,keepEventIds:Array.from({length:17},()=>randomUUID())}).success,false);
});
