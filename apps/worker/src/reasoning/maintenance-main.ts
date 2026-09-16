import {setTimeout as sleep} from 'node:timers/promises';

import {pool} from '../../../../packages/db/src/index.ts';
import {createReasoningMaintenance} from '../../../../packages/db/src/reasoning-maintenance.ts';

const service='reasoning-maintenance';

function setting(name:string,fallback:number,min:number,max:number):number {
 const raw=process.env[name];
 if(raw===undefined) return fallback;
 if(!/^[1-9][0-9]*$/.test(raw)) throw new Error('invalid_config');
 const value=Number(raw);
 if(!Number.isSafeInteger(value)||value<min||value>max) throw new Error('invalid_config');
 return value;
}

async function main():Promise<void> {
 let intervalMs:number, maxProbes:number;
 try {
  intervalMs=setting('REASONING_MAINTENANCE_INTERVAL_MS',60_000,100,3_600_000);
  maxProbes=setting('REASONING_MAINTENANCE_MAX_PROBES',32,1,128);
 } catch {
  console.error(JSON.stringify({service,event:'error',code:'invalid_config'}));
  process.exitCode=1;
  await pool.end();
  return;
 }

 const stop=new AbortController();
 let stopping=false,failed=false,poolFailed=false,batches=0;
 const requestStop=()=>{stopping=true;stop.abort();};
 process.on('SIGINT',requestStop);
 process.on('SIGTERM',requestStop);
 pool.on('error',()=>{
  if(!poolFailed) console.error(JSON.stringify({service,event:'error',code:'pool_error'}));
  poolFailed=true;failed=true;requestStop();
 });

 console.log(JSON.stringify({service,event:'started'}));
 const maintenance=createReasoningMaintenance(pool);
 try {
  while(!stopping) {
   try {
    const result=await maintenance.runBatch({maxProbes});
    batches+=1;
    console.log(JSON.stringify({service,event:'batch',batch:batches,...result}));
   } catch {
    failed=true;
    console.error(JSON.stringify({service,event:'error',code:'unexpected_batch_error'}));
    requestStop();
    continue;
   }
   if(!stopping) {
    try {await sleep(intervalMs,undefined,{signal:stop.signal});}
    catch { /* A signal requests shutdown after the completed batch. */ }
   }
  }
 } finally {
  try {await pool.end();}
  catch {
   if(!poolFailed) console.error(JSON.stringify({service,event:'error',code:'pool_shutdown_error'}));
   failed=true;
  }
  console.log(JSON.stringify({service,event:'stopped'}));
  if(failed) process.exitCode=1;
 }
}

void main();
