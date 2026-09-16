import type pg from 'pg';

import {purgeClosedReasoningAccounting} from './reasoning-storage.js';

const DEFAULT_MAX_PROBES=32;
const MAX_PROBES=128;
const GRAPH_LIMITS=Object.freeze({steps:128,attempts:128,contexts:128,reads:16_384});

type Lane='job'|'accounting';
type Candidate={id:string;universeId:string};
type Cursors={job:string|null;accounting:string|null;next:Lane};

export type ReasoningMaintenanceBatch={probes:number;retiredJobs:number;purgedAccounting:number;skipped:number};
export type ReasoningMaintenance={runBatch(input?:{maxProbes?:number}):Promise<ReasoningMaintenanceBatch>};

function maxProbes(input:{maxProbes?:number}|undefined):number {
 const value=input?.maxProbes??DEFAULT_MAX_PROBES;
 if(!Number.isInteger(value)||value<1||value>MAX_PROBES) throw new Error('Reasoning maintenance maxProbes must be 1 through 128');
 return value;
}

function isExpectedContention(error:unknown):boolean {
 const code=typeof error==='object'&&error!==null&&'code' in error ? (error as {code?:unknown}).code : undefined;
 return code==='55P03'||code==='57014'||code==='40P01'||code==='40001';
}

async function transaction<T>(pool:pg.Pool,body:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
 const client=await pool.connect();
 try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='500ms'");
  await client.query("SET LOCAL statement_timeout='2000ms'");
  const result=await body(client);
  await client.query('COMMIT');
  return result;
 } catch(error) {
  try {await client.query('ROLLBACK');} catch {}
  throw error;
 } finally {client.release();}
}

async function discover(pool:pg.PoolClient,lane:Lane,cursor:string|null):Promise<Candidate|undefined> {
 const table=lane==='job'?'reasoning_job':'reasoning_accounting';
 const idColumn=lane==='job'?'id':'attempt_id';
 const base=lane==='job'
  ? "withdrawn_at IS NOT NULL"
  : "all_duties_closed_at IS NOT NULL";
 const after=cursor===null?undefined:(await pool.query<{id:string;universe_id:string}>(
  `SELECT ${idColumn} AS id,universe_id FROM ${table} WHERE ${base} AND ${idColumn}>$1 ORDER BY ${idColumn} LIMIT 1`,[cursor],
 )).rows[0];
 const row=after??(await pool.query<{id:string;universe_id:string}>(
  `SELECT ${idColumn} AS id,universe_id FROM ${table} WHERE ${base} ORDER BY ${idColumn} LIMIT 1`,
 )).rows[0];
 return row?{id:String(row.id),universeId:String(row.universe_id)}:undefined;
}

async function lockUniverse(client:pg.PoolClient,universeId:string):Promise<boolean> {
 return (await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE SKIP LOCKED',[universeId])).rowCount===1;
}

async function eligibleWithdrawnJob(client:pg.PoolClient,candidate:Candidate):Promise<boolean> {
 const job=(await client.query<{id:string}>(
  `SELECT id FROM reasoning_job
   WHERE id=$1 AND universe_id=$2 AND withdrawn_at<=clock_timestamp()-interval '168 hours'
    AND status IN ('cancelled','expired') AND lease_owner IS NULL AND lease_expires_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM reasoning_fairness_ready WHERE job_id=reasoning_job.id)
    AND NOT EXISTS(SELECT 1 FROM reasoning_step WHERE job_id=reasoning_job.id
      AND status NOT IN ('succeeded','failed','cancelled','superseded'))
    AND NOT EXISTS(
      SELECT 1 FROM reasoning_attempt a LEFT JOIN reasoning_accounting ac ON ac.attempt_id=a.id
      WHERE a.job_id=reasoning_job.id AND (a.active OR ac.attempt_id IS NULL
        OR ac.output_authority<>'withdrawn' OR ac.state NOT IN ('not_sent','unknown','responded'))
    ) FOR UPDATE`,[candidate.id,candidate.universeId],
 )).rows[0];
 if(!job) return false;
 const counts=(await client.query<{steps:string;attempts:string;contexts:string;reads:string}>(
  `SELECT
    (SELECT count(*) FROM reasoning_step WHERE job_id=$1)::text AS steps,
    (SELECT count(*) FROM reasoning_attempt WHERE job_id=$1)::text AS attempts,
    (SELECT count(*) FROM reasoning_context WHERE job_id=$1)::text AS contexts,
    ((SELECT count(*) FROM reasoning_context_read r JOIN reasoning_context c ON c.id=r.context_id WHERE c.job_id=$1)
      +(SELECT count(*) FROM reasoning_context_dependency d JOIN reasoning_context c ON c.id=d.context_id WHERE c.job_id=$1))::text AS reads`,[candidate.id],
 )).rows[0];
 if(!counts) return false;
 if(Number(counts.steps)>GRAPH_LIMITS.steps||Number(counts.attempts)>GRAPH_LIMITS.attempts||
    Number(counts.contexts)>GRAPH_LIMITS.contexts||Number(counts.reads)>GRAPH_LIMITS.reads) return false;

 // Stable private-row locks follow the already-held universe and Job locks.
 await client.query('SELECT id FROM reasoning_step WHERE job_id=$1 ORDER BY id FOR UPDATE',[candidate.id]);
 await client.query(`SELECT a.id FROM reasoning_attempt a JOIN reasoning_accounting ac ON ac.attempt_id=a.id
   WHERE a.job_id=$1 ORDER BY a.id FOR UPDATE OF a,ac`,[candidate.id]);
 await client.query('SELECT id FROM reasoning_context WHERE job_id=$1 ORDER BY id FOR UPDATE',[candidate.id]);
 // A read after all waits prevents a stale candidate from becoming an erase.
 return (await client.query(
  `SELECT 1 FROM reasoning_job
   WHERE id=$1 AND universe_id=$2 AND withdrawn_at<=clock_timestamp()-interval '168 hours'
    AND status IN ('cancelled','expired') AND lease_owner IS NULL AND lease_expires_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM reasoning_fairness_ready WHERE job_id=reasoning_job.id)
    AND NOT EXISTS(SELECT 1 FROM reasoning_step WHERE job_id=reasoning_job.id
      AND status NOT IN ('succeeded','failed','cancelled','superseded'))
    AND NOT EXISTS(
      SELECT 1 FROM reasoning_attempt a LEFT JOIN reasoning_accounting ac ON ac.attempt_id=a.id
      WHERE a.job_id=reasoning_job.id AND (a.active OR ac.attempt_id IS NULL
        OR ac.output_authority<>'withdrawn' OR ac.state NOT IN ('not_sent','unknown','responded'))
    )`,[candidate.id,candidate.universeId],
 )).rowCount===1;
}

async function retireJob(client:pg.PoolClient,candidate:Candidate):Promise<boolean> {
 if(!await lockUniverse(client,candidate.universeId)) return false;
 if(!await eligibleWithdrawnJob(client,candidate)) return false;
 await client.query('SET CONSTRAINTS ALL DEFERRED');
 const attempts=await client.query('DELETE FROM reasoning_attempt WHERE job_id=$1',[candidate.id]);
 await client.query('DELETE FROM reasoning_step WHERE job_id=$1',[candidate.id]);
 await client.query('DELETE FROM reasoning_context WHERE job_id=$1',[candidate.id]);
 const job=await client.query(`DELETE FROM reasoning_job WHERE id=$1 AND universe_id=$2
   AND NOT EXISTS(SELECT 1 FROM reasoning_attempt WHERE job_id=$1)`,[candidate.id,candidate.universeId]);
 if(job.rowCount!==1) throw new Error('Reasoning retirement lost its locked Job');
 // The retained accounting identity is deliberately untouched; `attempts` is
 // consumed only to make the private delete order explicit to readers.
 void attempts;
 return true;
}

async function eligibleAccounting(client:pg.PoolClient,candidate:Candidate):Promise<boolean> {
 const row=(await client.query<{attempt_id:string}>(
  `SELECT attempt_id FROM reasoning_accounting
   WHERE attempt_id=$1 AND universe_id=$2
    AND all_duties_closed_at<clock_timestamp()-interval '30 days'
    AND liability_state='settled' AND remote_state='released'
    AND NOT reconciliation_hold AND NOT idempotency_hold
    AND NOT EXISTS(SELECT 1 FROM reasoning_attempt WHERE id=reasoning_accounting.attempt_id)
   FOR UPDATE`,[candidate.id,candidate.universeId],
 )).rows[0];
 if(!row) return false;
 // The existing helper is intentionally retained. It orders by attempt id, so
 // only invoke it when this probe owns the currently earliest eligible identity.
 return (await client.query(
  `SELECT 1 WHERE NOT EXISTS(
    SELECT 1 FROM reasoning_accounting a
     WHERE a.universe_id=$1 AND a.attempt_id<$2::uuid
      AND a.all_duties_closed_at<clock_timestamp()-interval '30 days'
      AND a.liability_state='settled' AND a.remote_state='released'
      AND NOT a.reconciliation_hold AND NOT a.idempotency_hold
      AND NOT EXISTS(SELECT 1 FROM reasoning_attempt p WHERE p.id=a.attempt_id)
  )`,[candidate.universeId,candidate.id],
 )).rowCount===1;
}

async function purgeAccounting(client:pg.PoolClient,candidate:Candidate):Promise<number> {
 if(!await lockUniverse(client,candidate.universeId)) return 0;
 if(!await eligibleAccounting(client,candidate)) return 0;
 return purgeClosedReasoningAccounting(client,candidate.universeId,1);
}

export function createReasoningMaintenance(pool:pg.Pool):ReasoningMaintenance {
 const cursors:Cursors={job:null,accounting:null,next:'job'};
 return {
  async runBatch(input) {
   const limit=maxProbes(input);
   const result:ReasoningMaintenanceBatch={probes:0,retiredJobs:0,purgedAccounting:0,skipped:0};
   for(let probe=0;probe<limit;probe+=1) {
    const lane=cursors.next;
    cursors.next=lane==='job'?'accounting':'job';
    result.probes+=1;
    try {
     const outcome=await transaction(pool,async client=>{
      const candidate=await discover(client,lane,cursors[lane]);
      if(!candidate) return {retired:false,purged:0};
      // This is deliberately process-local progress: a later rollback must not
      // make one blocked candidate the next probe again.
      cursors[lane]=candidate.id;
      if(lane==='job') return {retired:await retireJob(client,candidate),purged:0};
      return {retired:false,purged:await purgeAccounting(client,candidate)};
     });
     if(outcome.retired) result.retiredJobs+=1;
     else if(outcome.purged===1) result.purgedAccounting+=1;
     else result.skipped+=1;
    } catch(error) {
     if(isExpectedContention(error)) {result.skipped+=1;continue;}
     throw error;
    }
   }
   return result;
  },
 };
}
