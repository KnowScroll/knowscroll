import type { Lineage } from '../../../../packages/contracts/src/index.ts';
/** Contract reservation. No model is dispatched in the bootstrap runtime. */
export interface ReasoningProvider {
 execute(input: {lineage: Lineage & {jobId:string;stepId:string;attemptId:string}; contextHash:string; deadline:string; maxOutputTokens:number; signal:AbortSignal}): Promise<{
  proposal: unknown; providerRequestId:string; usage:{inputTokens:number|null;outputTokens:number|null;costUsd:number|null};
 }>;
}
export type ProviderReadiness = {ready:false;reason:'adapter_not_implemented'|'credentials_missing'|'live_certification_pending'} | {ready:true};
export function reasoningReadiness():ProviderReadiness {return {ready:false,reason:'adapter_not_implemented'};}
