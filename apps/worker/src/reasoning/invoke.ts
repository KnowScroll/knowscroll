import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {reasoningUsage} from '../../../../packages/contracts/src/reasoning.ts';

export type DispatchAuthorization={
 universeId:string;privacyEpoch:number;jobId:string;stepId:string;attemptId:string;owner:string;leaseFence:string;
 requestId:string;requestHash:string;inputTokensUpperBound:number;maxOutputTokens:number;dispatchId:string;
};
export type CommittedDispatch={
 attemptId:string;requestId:string;dispatchId:string;requestHash:string;inputTokensUpperBound:number;maxOutputTokens:number;
 routeId:string;routeProfileVersion:string;deadline:string;
};
export type UnknownInvocation=Pick<DispatchAuthorization,'universeId'|'privacyEpoch'|'jobId'|'stepId'|'attemptId'|'owner'|'leaseFence'> & {
 reason:'transport_loss'|'deadline'|'local_cancel';
};
export interface InvocationAdmission {
 authorizeDispatch(input:DispatchAuthorization):Promise<CommittedDispatch>;
 markAttemptUnknown(input:UnknownInvocation):Promise<unknown>;
}
export interface InvocationReconciliation {
 recordAndSettleReceipt(input:unknown,origin:'worker'):Promise<unknown>;
}
const observation=z.object({
 remoteDisposition:z.enum(['terminal','unconfirmed']),outcome:z.enum(['success','refusal','error','unclassified']),
 httpStatus:z.number().int().min(100).max(599).nullable(),usage:reasoningUsage,
}).strict();
/** An internal adapter seam. No implementation or ordinary worker wiring invokes a provider. */
export interface SingleInvocationTransport {
 invoke(input:{body:Uint8Array;maxOutputTokens:number;signal:AbortSignal}):Promise<unknown>;
}
export type InvocationResult={kind:'not_invoked'}|{kind:'unknown';accountingUpdated:boolean}|{kind:'recorded';receiptId:string};

/** One fresh authorization, at most one transport call, minimal receipt only. Never retry this invocation. */
export async function invokeReasoningOnce(input:{
 admission:InvocationAdmission;reconciliation:InvocationReconciliation;authorization:DispatchAuthorization;
 body:Uint8Array;transport:SingleInvocationTransport;signal:AbortSignal;
}):Promise<InvocationResult> {
 const {admission,reconciliation,authorization,transport,signal}=input;
 // Copy before awaiting: caller mutation must not change the bytes after their hash was checked.
 const body=Uint8Array.from(input.body);
 const requestHash=createHash('sha256').update(body).digest('hex');
 if(requestHash!==authorization.requestHash) throw new Error('Serialized reasoning request does not match its reservation');
 if(!Number.isSafeInteger(authorization.inputTokensUpperBound)||authorization.inputTokensUpperBound<body.byteLength) throw new Error('Serialized reasoning request exceeds its input reservation');
 if(signal.aborted) return {kind:'not_invoked'};
 // A rejected/lost COMMIT acknowledgement never reaches transport, even if the intent exists in SQL.
 const grant=await admission.authorizeDispatch({...authorization,requestHash});
 if(grant.requestHash!==requestHash||grant.attemptId!==authorization.attemptId||grant.dispatchId!==authorization.dispatchId||
    grant.requestId!==authorization.requestId||grant.inputTokensUpperBound!==authorization.inputTokensUpperBound||grant.maxOutputTokens!==authorization.maxOutputTokens) throw new Error('Dispatch grant binding mismatch');
 const deadline=Date.parse(grant.deadline);
 const markUnknown=async(reason:UnknownInvocation['reason']):Promise<boolean>=>{
  try {const result=await admission.markAttemptUnknown({...authorization,reason});return !!result&&typeof result==='object'&&'outcome' in result&&result.outcome==='unknown';}
  catch {return false;} // Retained intent remains possibly sent; no local failure grants replay authority.
 };
 if(!Number.isFinite(deadline)||deadline<=Date.now()||signal.aborted) {
  return {kind:'unknown',accountingUpdated:await markUnknown(signal.aborted?'local_cancel':'deadline')};
 }
 const controller=new AbortController();
 const abort=()=>controller.abort();
 signal.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(abort,Math.min(deadline-Date.now(),2147483647));
 let raw:unknown;
 try {raw=await transport.invoke({body,maxOutputTokens:grant.maxOutputTokens,signal:controller.signal});}
 catch {
  return {kind:'unknown',accountingUpdated:await markUnknown(signal.aborted?'local_cancel':Date.now()>=deadline?'deadline':'transport_loss')};
 } finally {clearTimeout(timer);signal.removeEventListener('abort',abort);}
 if(signal.aborted||Date.now()>=deadline) await markUnknown(signal.aborted?'local_cancel':'deadline');
 const parsed=observation.safeParse(raw);
 if(!parsed.success) return {kind:'unknown',accountingUpdated:await markUnknown('transport_loss')};
 const receiptId=randomUUID();
 await reconciliation.recordAndSettleReceipt({version:1,receiptId,attemptId:grant.attemptId,requestId:grant.requestId,
  dispatchId:grant.dispatchId,routeId:grant.routeId,routeProfileVersion:grant.routeProfileVersion,
  evidenceKind:'original_transport',observedAt:new Date().toISOString(),...parsed.data},'worker');
 return {kind:'recorded',receiptId};
}
