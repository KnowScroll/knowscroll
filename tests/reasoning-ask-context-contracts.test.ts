import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';

import {
 ASK_CONTEXT_VERSIONS,
 askContextPayload,
 compileDirectAskContextInput,
} from '../packages/contracts/src/reasoning-ask-context.ts';

function fixture(question='  cafe\u0301\n') {
 const universeId=randomUUID(),sessionId=randomUUID(),assetId=randomUUID(),askId=randomUUID();
 const askEventId=randomUUID(),exposureEventId=randomUUID(),exposureId=randomUUID(),decisionId=randomUUID(),jobId=randomUUID(),askClientId=randomUUID();
 const hash='a'.repeat(64),expiresAt='2026-09-17T00:00:00.000Z',scope={universeId,privacyEpoch:0};
 return {
  version:1,kind:'direct_ask_evidence_v1',contextId:randomUUID(),jobId,intentId:askId,...scope,
  sessionId,sessionExpiresAt:expiresAt,compilerVersion:ASK_CONTEXT_VERSIONS.compiler,promptVersion:ASK_CONTEXT_VERSIONS.prompt,
  sourcePolicyVersion:ASK_CONTEXT_VERSIONS.sourcePolicy,runtimePolicyVersion:'fixture-v1',runtimePolicyHash:hash,
  eventHighWater:'12',selection:'explicit_ask_id',
  fact:{askId,askEventId,askSequence:'12',askClientId,question,
   exposureEventId,exposureSequence:'10',exposureClientId:randomUUID(),exposureId,decisionId,
   decisionPolicyVersion:'editorial-unkept-v1',decisionAccountRevision:0,assetId},
  asset:{assetId,revision:1,kind:'Scroll',title:'Fixture',summary:'Synthetic',body:'Literal test evidence',
   sourceTitle:'Fixture',sourceUrl:'https://example.test/source',truthState:'documented'},
  dependencies:[
   {kind:'ask',id:askEventId,...scope,sequence:'12',hash},
   {kind:'ask_binding',id:askId,...scope,jobId,eventId:askEventId,sessionId,exposureId,clientAskId:askClientId,hash},
   {kind:'exposure_event',id:exposureEventId,...scope,sequence:'10',hash},
   {kind:'exposure',id:exposureId,...scope,assetId,hash},
   {kind:'decision_candidate',id:decisionId,...scope,assetId,hash},
   {kind:'asset',id:assetId,revision:1,hash},
   {kind:'session',id:sessionId,...scope,expiresAt},
   {kind:'runtime_policy',version:'fixture-v1',hash},
  ],
 };
}

test('Ask context contract preserves literal Unicode bytes and admits only its exact family',()=>{
 const value=fixture();
 const parsed=askContextPayload.parse(value);
 assert.equal(parsed.fact.question,value.fact.question);
 assert.equal(parsed.fact.question,'  cafe\u0301\n');
 assert.equal(parsed.kind,'direct_ask_evidence_v1');

 const wrongFamily=structuredClone(value);wrongFamily.sourcePolicyVersion='editorial-asset-pointer-v1';
 assert.equal(askContextPayload.safeParse(wrongFamily).success,false);
 const normalized=structuredClone(value);normalized.fact.question='café';
 assert.equal(askContextPayload.parse(normalized).fact.question,'café');
 assert.notEqual(askContextPayload.parse(normalized).fact.question,parsed.fact.question);
});

test('Ask context contract rejects missing, extra, foreign, and substituted authority',()=>{
 const value=fixture();
 assert.equal(askContextPayload.safeParse(value).success,true);
 for(let index=0;index<value.dependencies.length;index++) {
  const missing=structuredClone(value);missing.dependencies.splice(index,1);
  assert.equal(askContextPayload.safeParse(missing).success,false,`missing dependency ${index}`);
 }
 const duplicate=structuredClone(value);duplicate.dependencies[1]!.id=duplicate.fact.askEventId;
 assert.equal(askContextPayload.safeParse(duplicate).success,false);
 const foreign=structuredClone(value);(foreign.dependencies[3]! as Record<string,unknown>).universeId=randomUUID();
 assert.equal(askContextPayload.safeParse(foreign).success,false);
 const rebound=structuredClone(value);(rebound.dependencies[1]! as Record<string,unknown>).jobId=randomUUID();
 assert.equal(askContextPayload.safeParse(rebound).success,false);
 const sourceSwap=structuredClone(value);(sourceSwap.dependencies[5]! as Record<string,unknown>).revision=2;
 assert.equal(askContextPayload.safeParse(sourceSwap).success,false);
 const exposureAssetSwap=structuredClone(value);(exposureAssetSwap.dependencies[3]! as Record<string,unknown>).assetId=randomUUID();
 assert.equal(askContextPayload.safeParse(exposureAssetSwap).success,false);
 const badOrder=structuredClone(value);badOrder.fact.exposureSequence='12';
 assert.equal(askContextPayload.safeParse(badOrder).success,false);
 const extra=structuredClone(value);extra.dependencies.push({...extra.dependencies[0]!});
 assert.equal(askContextPayload.safeParse(extra).success,false);
});

test('Ask compiler input is exactly one Ask and cannot carry a hidden execution request',()=>{
 const input={contextId:randomUUID(),jobId:randomUUID(),askId:randomUUID()};
 assert.equal(compileDirectAskContextInput.safeParse(input).success,true);
 assert.equal(compileDirectAskContextInput.safeParse({...input,requestId:randomUUID()}).success,false);
 assert.equal(compileDirectAskContextInput.safeParse({...input,askId:'not-a-uuid'}).success,false);
});
