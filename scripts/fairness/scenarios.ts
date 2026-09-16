import {CLASSES,createSnapshot,enqueue,scheduleTick,settle,snapshotHash,type Candidate,type FairnessClass,type FairnessPolicy} from './model.ts';

export const fixturePolicy=(overrides:Partial<FairnessPolicy>={}):FairnessPolicy=>({
 version:'fairness-v1',quantum:100,maxNormalizedRequest:100,scale:100,maxReadySetSize:64,maxScanPerTick:32,maxAdmissionsPerTick:16,
 normalized:[{key:'tokens',kind:'tokens',basis:100},{key:'requests',kind:'requests',basis:100}],
 physical:[{key:'budget',kind:'budget',capacity:10_000},{key:'rate',kind:'rate',capacity:10_000},{key:'remote',kind:'remote',capacity:4}],
 weights:{interactive:5,active_continuity:6,accumulated_interpretation:4,background_inquiry:3,housekeeping:2},...overrides,
});
export const candidate=(id:string,universeId:string,klass:FairnessClass='interactive',tokens=50):Candidate=>({
 attemptId:`attempt-${id}`,reservationId:`reservation-${id}`,universeId,class:klass,enqueue:Number(id.replace(/\D/g,''))||1,basisVersion:'basis-v1',demand:{tokens,requests:1,budget:tokens,rate:tokens,remote:1},
});
export function runScenario(policy:FairnessPolicy,work:Candidate[],ticks=16) {
 let snapshot=createSnapshot(policy);for(const item of work) snapshot=enqueue(policy,snapshot,item);
 const decisions=[] as ReturnType<typeof scheduleTick>['decisions'];for(let i=0;i<ticks&&snapshot.ready.length;i++){const result=scheduleTick(policy,snapshot);snapshot=result.snapshot;decisions.push(...result.decisions);}
 return {snapshot,decisions,hash:snapshotHash(snapshot)};
}
export function replayScenario(policy:FairnessPolicy,work:Candidate[],ticks=16) { return runScenario(policy,work,ticks); }
export const allClasses=CLASSES;
export function settleActual(policy:FairnessPolicy,snapshot:ReturnType<typeof createSnapshot>,attemptId:string,tokens:number) { return settle(policy,snapshot,attemptId,{receiptId:`receipt-${attemptId}`,actual:{tokens,requests:1,budget:tokens,rate:tokens,remote:1},terminal:true}); }
