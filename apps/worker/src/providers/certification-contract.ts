/** ADR-0011: development certification only; not a production reasoning permit. */
export type Json = null | boolean | number | string | Json[] | {[key:string]:Json};
export type NativeMessage = {role:'user'|'assistant';content:string|{[key:string]:Json}[]};
export type NativeTool = {name:string;description:string;input_schema:{[key:string]:Json}};
export type DispatchMetadata = {requestHash:string;inputBytes:number;maxOutputTokens:number};
export type CertificationRequest = {
 messages:NativeMessage[];tools?:NativeTool[];thinking:'disabled'|'adaptive';
 maxOutputTokens:number;deadline:string;signal:AbortSignal;
 beforeDispatch:(metadata:DispatchMetadata)=>Promise<void>;
};
export type CertificationObservation = {
 outcome:'completed'|'http_error'|'invalid_response'|'aborted'|'timeout'|'transport_error'|'not_dispatched';
 dispatched:boolean;httpStatus:number|null;requestHash:string|null;providerRequestId:string|null;
 usage:{inputTokens:number|null;outputTokens:number|null;cacheReadTokens:number|null;cacheWriteTokens:number|null;costUsd:null};
 /** Protected in-process continuation. Never include these in public receipts/logs. */
 nativeContent:{[key:string]:Json}[];text:string;stopReason:string|null;
};
export type MiniMaxCertificationOptions = {
 apiKey:string;
 /** Fixed official HTTPS URL in live runner; loopback override only for transport tests. */
 baseURL?:string;fetch?:typeof fetch;
};
export type MiniMaxCertificationAdapter = {invoke:(request:CertificationRequest)=>Promise<CertificationObservation>};
export const CERTIFICATION_LIMITS = Object.freeze({maxRequests:4,maxReservedTokens:100_000,maxInputBytes:16_384,maxOutputTokens:4096,requestTimeoutMs:60_000,runTimeoutMs:300_000});
