import { setTimeout } from 'node:timers/promises';
import { pool } from '../../../packages/db/src/index.ts';
import { projectOne } from './project.ts';
let running=true;
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>{running=false;});
const workerId=`local-${process.pid}`;
console.log(JSON.stringify({service:'worker',workerId,kind:'deterministic-projection'}));
try {while(running) {
 await pool.query('INSERT INTO worker_heartbeat(worker_id,last_seen) VALUES($1,now()) ON CONFLICT(worker_id) DO UPDATE SET last_seen=now()',[workerId]);
 try {const jobId=await projectOne();if(jobId) console.log(JSON.stringify({jobId,status:'completed'}));}
 catch {console.error(JSON.stringify({error:'projection_failed'}));}
 await setTimeout(300);
}} finally {await pool.end();}
