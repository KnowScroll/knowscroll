/** External boundary reservation; there is no fake Cutroom runtime.
 * Implement against the pinned upstream package/HTTP contract in ADR-0007. */
export interface CutroomHostAdapter {
 reconcileByRequestId(requestId:string,signal:AbortSignal):Promise<{runId:string;state:'running'|'finished'}|null>;
 importFinishedAsset(input:{requestId:string;runId:string;generationJobId:string;demandId:string;universeId:string},signal:AbortSignal):Promise<{assetId:string;revision:number}>;
}
