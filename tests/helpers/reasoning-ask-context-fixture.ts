import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {recordExplicitAsk} from '../../packages/db/src/explicit-ask.ts';
import {compileDirectAskContext,validateDirectAskContext} from '../../packages/db/src/reasoning-ask-context.ts';
import {attachPendingStep,inTransaction,seedDirectContextGraph,withReasoningContextSchema} from './reasoning-context-fixture.ts';
export {attachPendingStep,inTransaction,withReasoningContextSchema};
export type AskContextGraph=Awaited<ReturnType<typeof seedAskContextGraph>>;
export async function seedAskContextGraph(pool:pg.Pool,options:{question?:string}={}) {
  const graph=await seedDirectContextGraph(pool);
  const question=options.question??'  Why e\u0301 differs from é?\r\n世界 🌌  ';
  const clientAskId=randomUUID();
  const receipt=await inTransaction(pool,async client=>{
    await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[graph.scope.universeId]);
    await client.query('SELECT id FROM device_session WHERE id=$1 FOR UPDATE',[graph.scope.sessionId]);
    return recordExplicitAsk(client,graph.scope,{clientAskId,exposureId:graph.exposureId,expectedPrivacyEpoch:0,question});
  });
  await pool.query('UPDATE reasoning_job SET intent_id=$1 WHERE id=$2',[receipt.askId,graph.jobId]);
  return {...graph,askId:receipt.askId,askEventId:receipt.eventId,clientAskId,question};
}
export function resolverFor(graph:AskContextGraph) { return async ()=>graph.policy; }
export async function compileAsk(pool:pg.Pool,graph:AskContextGraph,contextId=graph.contextId) {
  return inTransaction(pool,client=>compileDirectAskContext(client,graph.scope,{contextId,jobId:graph.jobId,askId:graph.askId},resolverFor(graph)));
}
export async function validateAsk(pool:pg.Pool,graph:AskContextGraph,stepId:string,phase:'lock'|'recheck'='lock') {
  return inTransaction(pool,async client=>{
    await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[graph.scope.universeId]);
    await client.query('SELECT id FROM device_session WHERE id=$1 FOR UPDATE',[graph.scope.sessionId]);
    await client.query('SELECT id FROM reasoning_job WHERE id=$1 FOR UPDATE',[graph.jobId]);
    await client.query('SELECT id FROM reasoning_step WHERE id=$1 FOR UPDATE',[stepId]);
    return validateDirectAskContext(client,{universeId:graph.scope.universeId,privacyEpoch:graph.scope.privacyEpoch,jobId:graph.jobId,stepId,contextId:graph.contextId,policyVersion:graph.policy.policyVersion},resolverFor(graph),phase);
  });
}
