import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  reasoningAttempt,reasoningContext,reasoningCounter,reasoningDispatch,reasoningPermit,
  reasoningReceipt,reasoningUsage,reasoningWake,reasoningSettlement,
} from '../packages/contracts/src/reasoning.ts';

const ids = Array.from({length:12},(_,index)=>`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`);
const at = '2026-09-16T00:00:00.000Z';
const unknownUsage = {inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null,costMicroUsd:null};
const context = {
  version:1,contextBundleId:ids[0],jobId:ids[1],universeId:ids[2],privacyEpoch:0,
  contentHash:'a'.repeat(64),policyVersion:'policy-1',sourcePolicyVersion:'source-1',reads:[],
};
const attempt = {
  version:1,attemptId:ids[3],ordinal:1,previousAttemptId:null,jobId:ids[1],stepId:ids[4],universeId:ids[2],privacyEpoch:0,
  leaseFence:'9007199254740993',contextBundleId:ids[0],requestId:ids[5],requestHash:'b'.repeat(64),
  routeId:'minimax-candidate',routeProfileVersion:'certification-1',permitId:ids[6],reservationSetId:ids[7],
  maxOutputTokens:2048,deadline:at,dispatch:{state:'reserved'},outputAuthority:'eligible',
};

test('bigint counters retain exact wire precision and reject malformed or overflowing values without throwing',()=>{
  assert.equal(reasoningCounter.parse('9007199254740993'),'9007199254740993');
  assert.equal(reasoningCounter.parse('9223372036854775807'),'9223372036854775807');
  for (const value of ['9223372036854775808','-1','01','1e3','NaN','',9007199254740992]) {
    assert.equal(reasoningCounter.safeParse(value).success,false);
  }
  assert.equal(reasoningAttempt.parse(attempt).leaseFence,'9007199254740993');
  assert.equal(reasoningAttempt.safeParse({...attempt,leaseFence:'0'}).success,false);
});

test('a context cannot mix foreign private universes or conflicting duplicate read identities',()=>{
  const read={kind:'entity',scope:{kind:'universe',universeId:ids[2]},key:ids[8],revision:'1'};
  assert.equal(reasoningContext.safeParse({...context,reads:[read]}).success,true);
  assert.equal(reasoningContext.safeParse({...context,reads:[{...read,scope:{kind:'universe',universeId:ids[9]}}]}).success,false);
  assert.equal(reasoningContext.safeParse({...context,reads:[read,{...read,revision:'2'}]}).success,false);
  assert.equal(reasoningContext.safeParse({...context,reads:[{...read,kind:'source',scope:{kind:'public'}}]}).success,true);
});

test('reservation identity, bucket identity and units cannot double count or substitute capacity',()=>{
  const reservation={reservationId:ids[8],bucketId:ids[9],attemptId:ids[3],reservationSetId:ids[7],state:'held',dimension:'remote_concurrency',unit:'slots',amount:1,windowId:null};
  const permit={version:1,permitId:ids[6],attemptId:ids[3],reservationSetId:ids[7],routeId:'route-1',routeProfileVersion:'v1',expiresAt:at,lifecycle:{state:'reserved'},reservations:[reservation]};
  assert.equal(reasoningPermit.safeParse(permit).success,true);
  for(const second of [reservation,{...reservation,reservationId:ids[10]},{...reservation,bucketId:ids[10]}]) {
    assert.equal(reasoningPermit.safeParse({...permit,reservations:[reservation,second]}).success,false);
  }
  assert.equal(reasoningPermit.safeParse({...permit,reservations:[{...reservation,unit:'tokens'}]}).success,false);
  assert.equal(reasoningPermit.safeParse({...permit,reservations:[{...reservation,amount:-1}]}).success,false);
});

test('unknown execution needs original dispatch evidence and does not acquire a success payload',()=>{
  const dispatch={state:'unknown',dispatchId:ids[10],committedAt:at,observedAt:at,reason:'lease_loss'};
  assert.equal(reasoningDispatch.safeParse(dispatch).success,true);
  const {dispatchId:omitted,...missing}=dispatch;
  assert.equal(reasoningDispatch.safeParse(missing).success,false);
  assert.equal(reasoningDispatch.safeParse({...dispatch,proposal:{learned:true}}).success,false);
  assert.equal(reasoningAttempt.safeParse({...attempt,dispatch,outputAuthority:'withdrawn'}).success,true);
  assert.equal(reasoningDispatch.safeParse({state:'not_sent',closedAt:at,reason:'expired',dispatchId:omitted}).success,false);
});

test('late usage is representable after private context erasure without carrying private payload fields',()=>{
  const receipt={version:1,receiptId:ids[11],attemptId:ids[3],dispatchId:ids[10],requestId:ids[5],
    routeId:'minimax-candidate',routeProfileVersion:'certification-1',evidenceKind:'original_transport',observedAt:at,remoteDisposition:'terminal',outcome:'success',httpStatus:200,usage:unknownUsage};
  assert.deepEqual(reasoningReceipt.parse(receipt).usage,unknownUsage);
  for(const [key,value] of Object.entries({contextHash:'a'.repeat(64),universeId:ids[2],prompt:'private',nativeContent:[],providerRequestId:'vendor-id',error:'secret'})) {
    assert.equal(reasoningReceipt.safeParse({...receipt,[key]:value}).success,false,key);
  }
  assert.equal(reasoningReceipt.safeParse({...receipt,usage:{...unknownUsage,inputTokens:3,outputTokens:2}}).success,true);
});

test('unknown usage stays null while invalid counters never become free usage',()=>{
  assert.deepEqual(reasoningUsage.parse(unknownUsage),unknownUsage);
  for(const value of [-1,NaN,Infinity,0.5,Number.MAX_SAFE_INTEGER+1,'0']) {
    assert.equal(reasoningUsage.safeParse({...unknownUsage,inputTokens:value}).success,false);
  }
  assert.equal(reasoningUsage.parse({...unknownUsage,inputTokens:0}).inputTokens,0);
});

test('direct intent identity cannot be silently replaced with a coalesced watermark',()=>{
  assert.equal(reasoningWake.safeParse({kind:'direct',intentId:ids[0]}).success,true);
  assert.equal(reasoningWake.safeParse({kind:'dirty',scopeKey:'universe-reasoning',throughSequence:'12'}).success,true);
  assert.equal(reasoningWake.safeParse({kind:'direct',intentId:ids[0],throughSequence:'12'}).success,false);
  assert.equal(reasoningWake.safeParse({kind:'dirty',scopeKey:'universe-reasoning',throughSequence:'12',intentId:ids[0]}).success,false);
});


test('attempt retry lineage and withdrawn output cannot contradict their lifecycle',()=>{
  assert.equal(reasoningAttempt.safeParse({...attempt,ordinal:2}).success,false);
  assert.equal(reasoningAttempt.safeParse({...attempt,ordinal:2,previousAttemptId:ids[10]}).success,true);
  assert.equal(reasoningAttempt.safeParse({...attempt,ordinal:2,previousAttemptId:attempt.attemptId}).success,false);
  const cancelled={...attempt,dispatch:{state:'unknown',dispatchId:ids[10],committedAt:at,observedAt:at,reason:'local_cancel'}};
  assert.equal(reasoningAttempt.safeParse(cancelled).success,false);
  assert.equal(reasoningAttempt.safeParse({...cancelled,outputAuthority:'withdrawn'}).success,true);
});

test('settlement revision links and unique bucket adjustments make double-charge ambiguity explicit',()=>{
  const settlement={version:1,settlementId:ids[11],attemptId:ids[3],receiptId:ids[10],receiptFingerprint:'c'.repeat(64),
    basis:'measured',revision:1,supersedesSettlementId:null,usage:unknownUsage,liability:'held',remoteConcurrency:'held',
    adjustments:[{bucketId:ids[9],unit:'tokens',delta:12}]};
  assert.equal(reasoningSettlement.safeParse(settlement).success,true);
  assert.equal(reasoningSettlement.safeParse({...settlement,revision:2}).success,false);
  assert.equal(reasoningSettlement.safeParse({...settlement,revision:2,supersedesSettlementId:ids[8]}).success,true);
  assert.equal(reasoningSettlement.safeParse({...settlement,adjustments:[...settlement.adjustments,...settlement.adjustments]}).success,false);
});
