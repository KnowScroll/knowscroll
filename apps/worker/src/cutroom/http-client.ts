/** ADR-0020: unwired, loopback-only protocol client; no funding or publication authority. */
import {createHash} from 'node:crypto';
import type {ZodType} from 'zod';
import {SubmitRequest} from '../../../../packages/contracts/src/cutroom-v1/request.ts';
import {EventsPage,RunResult,RunStatus,SubmitResponse} from '../../../../packages/contracts/src/cutroom-v1/responses.ts';
import {RunRecord} from '../../../../packages/contracts/src/cutroom-v1/record.ts';
import {ErrorResponse} from '../../../../packages/contracts/src/cutroom-v1/errors.ts';

type Stage='plan'|'stills'|'video';
export type PreparedCutroomRequest=Readonly<{requestId:string;until:Stage;body:string;bodySha256:string}>;
export type CutroomRunRef=Readonly<{requestId:string;runId:string;until:Stage}>;
type Method='GET'|'POST';
type ProtocolCode='status'|'content_type'|'body_limit'|'json'|'shape'|'identity'|'cursor'|'stage';
export type CutroomFailure=
 | {kind:'protocol_error';code:ProtocolCode;writeUncertain:boolean}
 | {kind:'transport_error';code:'aborted'|'timeout'|'network';writeUncertain:boolean}
 | {kind:'not_found'}
 | {kind:'remote_error';status:400|500;error:'invalid'|'internal';writeUncertain:boolean};
type Value<T>={kind:'ok';value:T};
type Pending={kind:'pending';value:RunStatus};
const preparedRequests=new WeakSet<object>();
const MAX_REQUEST_BYTES=256*1024;

export function prepareCutroomRequest(input:unknown):PreparedCutroomRequest {
 const parsed=SubmitRequest.safeParse(input);
 if(!parsed.success||!([undefined,'shotCount'] as unknown[]).includes(parsed.data.options.planVaryOn))throw new Error('Invalid Cutroom request');
 identity(parsed.data.requestId);
 const body=JSON.stringify(parsed.data);
 if(Buffer.byteLength(body)>MAX_REQUEST_BYTES)throw new Error('Cutroom request exceeds byte limit');
 const prepared=Object.freeze({requestId:parsed.data.requestId,until:parsed.data.options.until,body,
  bodySha256:createHash('sha256').update(body).digest('hex')});
 preparedRequests.add(prepared);return prepared;
}

function validIdentity(value:unknown):value is string {
 if(typeof value!=='string'||value.length===0||Buffer.byteLength(value)>1024)return false;
 try {encodeURIComponent(value);return true;}catch{return false;}
}
function validRunId(value:unknown):value is string {return validIdentity(value)&&value!=='.'&&value!=='..';}
function identity(value:unknown):asserts value is string {
 if(!validIdentity(value))throw new Error('Invalid Cutroom identity');
}
function reference(ref:CutroomRunRef) {
 identity(ref?.requestId);identity(ref?.runId);
 if(!validRunId(ref.runId))throw new Error('Invalid Cutroom run identity');
 if(!['plan','stills','video'].includes(ref.until))throw new Error('Invalid Cutroom stage');
 return Object.freeze({requestId:ref.requestId,runId:ref.runId,until:ref.until});
}
function protocol(code:ProtocolCode,method:Method):CutroomFailure {
 return {kind:'protocol_error',code,writeUncertain:method==='POST'};
}
function parse<T>(schema:ZodType<T>,body:unknown):T|null {
 const result=schema.safeParse(body);return result.success?result.data:null;
}
function matches(value:{runId:string;requestId?:string},ref:CutroomRunRef) {
 return value.runId===ref.runId&&(value.requestId===undefined||value.requestId===ref.requestId);
}
class BodyFailure extends Error {
 constructor(readonly code:ProtocolCode){super(code);}
}
async function readBody(response:Response,maxBytes:number):Promise<unknown> {
 if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')?.trim()??'')) {
  await response.body?.cancel();throw new BodyFailure('content_type');
 }
 const declared=response.headers.get('content-length');
 if(declared!==null&&/^\d+$/.test(declared)&&Number(declared)>maxBytes) {
  await response.body?.cancel();throw new BodyFailure('body_limit');
 }
 const reader=response.body?.getReader();
 if(!reader)throw new BodyFailure('json');
 const chunks:Uint8Array[]=[];let bytes=0;
 try {
  for(;;) {
   const next=await reader.read();if(next.done)break;
   bytes+=next.value.byteLength;
   if(bytes>maxBytes){await reader.cancel();throw new BodyFailure('body_limit');}
   chunks.push(next.value);
  }
 } finally {reader.releaseLock();}
 try {return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes)));}
 catch {throw new BodyFailure('json');}
}

export function createCutroomHttpClient(options:{origin:string;timeoutMs?:number;maxResponseBytes?:number}) {
 if(!/^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d+\/?$/.test(options.origin))throw new Error('Cutroom requires an explicit loopback HTTP origin');
 const url=new URL(options.origin);if(url.port==='0')throw new Error('Invalid Cutroom port');
 const origin=url.origin;
 const timeoutMs=options.timeoutMs??5000,maxResponseBytes=options.maxResponseBytes??1024*1024;
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw new Error('Invalid Cutroom timeout');
 if(!Number.isSafeInteger(maxResponseBytes)||maxResponseBytes<1||maxResponseBytes>4*1024*1024)throw new Error('Invalid Cutroom response bound');

 async function exchange<T>(method:Method,path:string,errorStatuses:readonly number[],decode:(status:number,body:unknown)=>T|CutroomFailure,signal?:AbortSignal,body?:string):Promise<T|CutroomFailure> {
  if(signal?.aborted)return {kind:'transport_error',code:'aborted',writeUncertain:false};
  const controller=new AbortController();let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
  try {
   const response=await fetch(origin+path,{method,redirect:'error',signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal,
    headers:body===undefined?{accept:'application/json'}:{accept:'application/json','content-type':'application/json'},body});
   const value=await readBody(response,maxResponseBytes);
   if(errorStatuses.includes(response.status)) {
    const error=parse(ErrorResponse,value),expected={400:'invalid',404:'not-found',500:'internal'}[response.status];
    if(!error||error.error!==expected)return protocol('shape',method);
    if(response.status===404)return {kind:'not_found'};
    return {kind:'remote_error',status:response.status as 400|500,error:error.error as 'invalid'|'internal',writeUncertain:method==='POST'};
   }
   return decode(response.status,value);
  } catch(error) {
   if(error instanceof BodyFailure)return protocol(error.code,method);
   return {kind:'transport_error',code:signal?.aborted?'aborted':timedOut?'timeout':'network',writeUncertain:method==='POST'};
  } finally {clearTimeout(timer);}
 }
 function statusResponse(method:Method,status:number,body:unknown,ref:CutroomRunRef):Value<RunStatus>|CutroomFailure {
  if(status!==200)return protocol('status',method);
  const value=parse(RunStatus,body);if(!value)return protocol('shape',method);
  return matches(value,ref)?{kind:'ok',value}:protocol('identity',method);
 }
 return Object.freeze({
  submit(prepared:PreparedCutroomRequest,signal?:AbortSignal) {
   if(!preparedRequests.has(prepared))throw new Error('Cutroom request must be prepared before submission');
   type Result={kind:'accepted';value:Extract<SubmitResponse,{outcome:'accepted'}>;ref:CutroomRunRef}
    |{kind:'refused';value:Extract<SubmitResponse,{outcome:'refused'}>};
   return exchange<Result>('POST','/v1/runs',[500],(status,body)=>{
    if(![202,409,422].includes(status))return protocol('status','POST');
    const value=parse(SubmitResponse,body);if(!value)return protocol('shape','POST');
    if(value.requestId!==undefined&&value.requestId!==prepared.requestId)return protocol('identity','POST');
    if(status===202&&value.outcome==='accepted'&&!validRunId(value.runId))return protocol('identity','POST');
    if(status===202&&value.outcome==='accepted')return {kind:'accepted',value,ref:Object.freeze({requestId:value.requestId,runId:value.runId,until:prepared.until})};
    if(value.outcome==='refused'&&((status===409&&value.reason==='conflict')||(status===422&&value.reason!=='conflict')))return {kind:'refused',value};
    return protocol('status','POST');
   },signal,prepared.body);
  },
  lookup(requestId:string,signal?:AbortSignal) {
   identity(requestId);
   return exchange<Value<RunStatus>>('GET','/v1/runs?requestId='+encodeURIComponent(requestId),[400,404,500],(status,body)=>{
    if(status!==200)return protocol('status','GET');
    const value=parse(RunStatus,body);if(!value)return protocol('shape','GET');
    return value.requestId===requestId&&validRunId(value.runId)?{kind:'ok',value}:protocol('identity','GET');
   },signal);
  },
  status(ref:CutroomRunRef,signal?:AbortSignal) {
   ref=reference(ref);return exchange<Value<RunStatus>>('GET','/v1/runs/'+encodeURIComponent(ref.runId),[404,500],(status,body)=>statusResponse('GET',status,body,ref),signal);
  },
  cancel(ref:CutroomRunRef,signal?:AbortSignal) {
   ref=reference(ref);return exchange<Value<RunStatus>>('POST','/v1/runs/'+encodeURIComponent(ref.runId)+'/cancel',[404,500],(status,body)=>statusResponse('POST',status,body,ref),signal);
  },
  events(ref:CutroomRunRef,since:number,signal?:AbortSignal) {
   ref=reference(ref);if(!Number.isSafeInteger(since)||since<0)throw new Error('Invalid Cutroom cursor');
   return exchange<Value<EventsPage>>('GET','/v1/runs/'+encodeURIComponent(ref.runId)+'/events?since='+since,[400,404,500],(status,body)=>{
    if(status!==200)return protocol('status','GET');
    const value=parse(EventsPage,body);if(!value)return protocol('shape','GET');
    if(value.runId!==ref.runId||value.events.some(event=>event.runId!==ref.runId))return protocol('identity','GET');
    let cursor=since;
    for(const [index,event] of value.events.entries()) {
     if(event.seq<=cursor||(event.type==='run.finished'&&index!==value.events.length-1))return protocol('cursor','GET');
     cursor=event.seq;
    }
    return value.nextSince===cursor?{kind:'ok',value}:protocol('cursor','GET');
   },signal);
  },
  result(ref:CutroomRunRef,signal?:AbortSignal) {
   ref=reference(ref);
   return exchange<Value<RunResult>|Pending>('GET','/v1/runs/'+encodeURIComponent(ref.runId)+'/result',[404,500],(status,body)=>{
    if(status===409){const value=parse(RunStatus,body);return !value?protocol('shape','GET'):matches(value,ref)?{kind:'pending',value}:protocol('identity','GET');}
    if(status!==200)return protocol('status','GET');
    const value=parse(RunResult,body);if(!value)return protocol('shape','GET');
    if(!matches(value,ref))return protocol('identity','GET');
    if(value.status==='completed'&&value.until!==ref.until)return protocol('stage','GET');
    return {kind:'ok',value};
   },signal);
  },
  record(ref:CutroomRunRef,signal?:AbortSignal) {
   ref=reference(ref);
   return exchange<Value<RunRecord>|Pending>('GET','/v1/runs/'+encodeURIComponent(ref.runId)+'/record',[404,500],(status,body)=>{
    if(status===409){const value=parse(RunStatus,body);return !value?protocol('shape','GET'):matches(value,ref)?{kind:'pending',value}:protocol('identity','GET');}
    if(status!==200)return protocol('status','GET');
    const value=parse(RunRecord,body);if(!value)return protocol('shape','GET');
    return value.runId===ref.runId?{kind:'ok',value}:protocol('identity','GET');
   },signal);
  },
 });
}
