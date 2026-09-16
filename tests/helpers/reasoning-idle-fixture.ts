import {createHash,randomUUID} from 'node:crypto';
import type pg from 'pg';

import {authenticateAndLock} from '../../packages/db/src/identity.ts';
import {createReasoningAdmission} from '../../packages/db/src/reasoning-admission.ts';
import {compileDirectContext,createDirectContextAuthority} from '../../packages/db/src/reasoning-context.ts';
import {cancelIdleDirectJob,expireIdleDirectJob} from '../../packages/db/src/reasoning-idle-lifecycle.ts';
import {attachPendingStep,inTransaction,seedDirectContextGraph} from './reasoning-context-fixture.ts';

export async function seedIdleGraph(pool:pg.Pool) {
 const graph=await seedDirectContextGraph(pool);
 const token=randomUUID()+randomUUID();
 await pool.query('UPDATE device_session SET token_hash=$2 WHERE id=$1',[graph.scope.sessionId,createHash('sha256').update(token).digest('hex')]);
 await inTransaction(pool,async client=>{
  const scope=await authenticateAndLock(client,token);
  await compileDirectContext(client,scope,{contextId:graph.contextId,jobId:graph.jobId,keepEventIds:graph.keepEventIds},async()=>graph.policy);
 });
 const stepId=await attachPendingStep(pool,graph);
 const authority=createDirectContextAuthority(async()=>graph.policy);
 return {...graph,token,stepId,authority,admission:createReasoningAdmission(pool,authority)};
}
export type IdleGraph=Awaited<ReturnType<typeof seedIdleGraph>>;

export function cancelGraph(pool:pg.Pool,graph:IdleGraph) {
 return inTransaction(pool,async client=>cancelIdleDirectJob(client,await authenticateAndLock(client,graph.token),{jobId:graph.jobId}));
}
export function expireGraph(pool:pg.Pool,graph:IdleGraph) {
 return inTransaction(pool,client=>expireIdleDirectJob(client,{jobId:graph.jobId,universeId:graph.scope.universeId,privacyEpoch:graph.scope.privacyEpoch}));
}
export async function reserveIdleGraph(pool:pg.Pool,graph:IdleGraph) {
 const owner='idle-fixture';
 const claim=await graph.admission.claimJob({owner,leaseMs:30_000});
 if(!claim||claim.jobId!==graph.jobId) throw new Error('Fixture did not claim its only queued Job');
 const input={universeId:graph.scope.universeId,privacyEpoch:0,jobId:graph.jobId,stepId:graph.stepId,contextId:graph.contextId,
  owner,leaseFence:claim.leaseFence,requestId:randomUUID(),requestHash:'c'.repeat(64),inputTokensUpperBound:1,maxOutputTokens:1,
  costCeilingMicroUsd:null,deadline:new Date(Date.now()+60_000).toISOString(),permitTtlMs:30_000};
 const reserved=await graph.admission.reserveAttempt(input);
 return {claim,input,reserved};
}
/** Controlled crash boundary in disposable fixtures; no withdrawal clock bypass. */
export async function makeReservedJobIdle(pool:pg.Pool,graph:IdleGraph):Promise<void> {
 await pool.query("UPDATE reasoning_job SET status='waiting',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",[graph.jobId]);
}
