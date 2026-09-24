import { setTimeout } from 'node:timers/promises';
import { pool } from '../../../packages/db/src/index.ts';
import { projectOne } from './project.ts';
import { answerTransportsFromEnvironment } from './reasoning/answer-loop.ts';
import { runAnswerPass } from './reasoning/answer-worker.ts';
let running=true;
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>{running=false;});
const workerId=`local-${process.pid}`;
// #132: answers run only when this process was configured with a transport (ADR-0033 §2).
const answerTransports=answerTransportsFromEnvironment(process.env);
// Lease on an admitted answer; bounded by admission's own 1..60,000 ms limit.
const answerLeaseMs=Math.min(60_000,Math.max(1_000,Number(process.env.KS_ANSWER_LEASE_MS ?? 60_000)||60_000));
const stop=new AbortController();
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>stop.abort());
console.log(JSON.stringify({service:'worker',workerId,kind:'deterministic-projection',answers:answerTransports?Object.keys(answerTransports):[]}));
try {while(running) {
 await pool.query('INSERT INTO worker_heartbeat(worker_id,last_seen) VALUES($1,now()) ON CONFLICT(worker_id) DO UPDATE SET last_seen=now()',[workerId]);
 try {const result=await projectOne();if(result) console.log(JSON.stringify(result));}
 catch {console.error(JSON.stringify({error:'projection_failed'}));}
 if(answerTransports) {
  // Minimal log: ids and outcome kinds only, never a question, reply or key.
  try {const pass=await runAnswerPass({pool,owner:workerId,leaseMs:answerLeaseMs,transports:answerTransports,signal:stop.signal});
   if(pass.kind==='done') console.log(JSON.stringify({answer:pass.askId,invocation:pass.invocation,outcome:pass.outcome.kind,status:'status' in pass.outcome?pass.outcome.status:pass.outcome.reason}));}
  catch {console.error(JSON.stringify({error:'answer_pass_failed'}));}
 }
 await setTimeout(300);
}} finally {await pool.end();}
