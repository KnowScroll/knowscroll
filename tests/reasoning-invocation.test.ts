import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {invokeReasoningOnce,type DispatchAuthorization,type CommittedDispatch,type UnknownInvocation} from '../apps/worker/src/reasoning/invoke.ts';
function fixture(){
 const body=Buffer.from('{"synthetic":true}');
 const authorization:DispatchAuthorization={universeId:randomUUID(),privacyEpoch:0,jobId:randomUUID(),stepId:randomUUID(),attemptId:randomUUID(),owner:'worker',leaseFence:'1',requestId:randomUUID(),requestHash:createHash('sha256').update(body).digest('hex'),inputTokensUpperBound:100,maxOutputTokens:10,dispatchId:randomUUID()};
 const grant:CommittedDispatch={...authorization,routeId:'fixture',routeProfileVersion:'v1',deadline:new Date(Date.now()+10000).toISOString()};
 const events:string[]=[],unknowns:UnknownInvocation[]=[],receipts:unknown[]=[];
 const admission={authorizeDispatch:async()=>{events.push('committed');return grant;},markAttemptUnknown:async(input:UnknownInvocation)=>{unknowns.push(input);return {outcome:'unknown'};}};
 const reconciliation={recordAndSettleReceipt:async(input:unknown)=>{events.push('receipt');receipts.push(input);}};
 const metadata={remoteDisposition:'terminal',outcome:'success',httpStatus:200,usage:{inputTokens:2,outputTokens:3,cacheReadTokens:null,cacheWriteTokens:null,costMicroUsd:null}};
 const transport={invoke:async()=>{events.push('transport');return metadata;}};
 return {body,authorization,grant,events,unknowns,receipts,admission,reconciliation,metadata,transport,signal:new AbortController().signal};
}
test('worker invokes once after committed authorization and binds only minimal observation',async()=>{
 const f=fixture();const result=await invokeReasoningOnce(f);
 assert.equal(result.kind,'recorded');assert.deepEqual(f.events,['committed','transport','receipt']);
 const receipt=f.receipts[0] as Record<string,unknown>;
 assert.equal(receipt.attemptId,f.authorization.attemptId);assert.equal(receipt.requestId,f.authorization.requestId);assert.equal(receipt.dispatchId,f.authorization.dispatchId);
 assert.equal(receipt.evidenceKind,'original_transport');assert.equal('body' in receipt,false);
});
test('lost authorization acknowledgement, wrong bytes and pre-abort make zero transport calls',async()=>{
 const lost=fixture();lost.admission.authorizeDispatch=async()=>{lost.events.push('commit_ack_lost');throw new Error('synthetic lost acknowledgement');};
 await assert.rejects(invokeReasoningOnce(lost),/lost acknowledgement/);assert.deepEqual(lost.events,['commit_ack_lost']);
 const wrong=fixture();await assert.rejects(invokeReasoningOnce({...wrong,body:Buffer.from('other')}),/does not match/);assert.deepEqual(wrong.events,[]);
 const understated=fixture();understated.authorization.inputTokensUpperBound=1;await assert.rejects(invokeReasoningOnce(understated),/exceeds its input/);assert.deepEqual(understated.events,[]);
 const aborted=fixture(),controller=new AbortController();controller.abort();assert.deepEqual(await invokeReasoningOnce({...aborted,signal:controller.signal}),{kind:'not_invoked'});assert.deepEqual(aborted.events,[]);
});
test('transport failure and invalid metadata preserve possible-send uncertainty without retry',async()=>{
 const failed=fixture();failed.transport.invoke=async()=>{failed.events.push('transport');throw new Error('fixture raw error never exposed');};
 assert.deepEqual(await invokeReasoningOnce(failed),{kind:'unknown',accountingUpdated:true});assert.deepEqual(failed.events,['committed','transport']);assert.equal(failed.unknowns[0]?.reason,'transport_loss');
 const invalid=fixture();const result=await invokeReasoningOnce({...invalid,transport:{invoke:async()=>({...invalid.metadata,rawResponse:'fixture private text'})}});
 assert.equal(result.kind,'unknown');assert.equal(invalid.receipts.length,0);
});
test('post-commit abort and expired grant issue no transport, while late metadata still settles',async()=>{
 const aborted=fixture(),controller=new AbortController();aborted.admission.authorizeDispatch=async()=>{controller.abort();return aborted.grant;};
 assert.equal((await invokeReasoningOnce({...aborted,signal:controller.signal})).kind,'unknown');assert.equal(aborted.unknowns[0]?.reason,'local_cancel');assert.equal(aborted.events.includes('transport'),false);
 const expired=fixture();expired.grant.deadline=new Date(Date.now()-100).toISOString();assert.equal((await invokeReasoningOnce(expired)).kind,'unknown');assert.equal(expired.events.includes('transport'),false);
 const late=fixture(),cancel=new AbortController();late.transport.invoke=async()=>{cancel.abort();return late.metadata;};
 assert.equal((await invokeReasoningOnce({...late,signal:cancel.signal})).kind,'recorded');assert.equal(late.unknowns[0]?.reason,'local_cancel');assert.equal(late.receipts.length,1);
});
