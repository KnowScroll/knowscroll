import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {
 appendRestrictedReasoningReceipt,
 type TrustedReasoningReceiptOrigin,
} from './reasoning-storage.ts';

type Usage={inputTokens:number|null;outputTokens:number|null;cacheReadTokens:number|null;cacheWriteTokens:number|null;costMicroUsd:number|null};
type Reservation={id:string;attempt_id:string;bucket_id:string;amount:string;state:'held'|'accounted'|'released';usage_basis:string;handling:string;recognized:string;usage_known:boolean};
type Accounting={attempt_id:string;universe_id:string;state:string;binding_hash:string|null;runtime_policy_version:string|null;output_authority:string;review_required:boolean};
type Receipt={id:string;attempt_id:string;remote_disposition:'terminal'|'unconfirmed';outcome:string;input_tokens:number|null;output_tokens:number|null;cache_read_tokens:number|null;cache_write_tokens:number|null;cost_micro_usd:number|null};
type ReconciliationResult={receiptId:string;attemptId:string;fingerprint:string;replayed:boolean;settlementId?:string;revision?:number;reviewRequired:boolean};

const max=9007199254740991n;
const asBigInt=(value:string|number):bigint=>{
 const parsed=typeof value==='number'?BigInt(value):BigInt(value);
 if(parsed<0n||parsed>max) throw new Error('Reasoning counter exceeds safe storage range');
 return parsed;
};
const asNullableBigInt=(value:number|null):bigint|null=>value===null?null:asBigInt(value);
const usageValue=(basis:string,usage:Usage):bigint|null=>{
 const input=asNullableBigInt(usage.inputTokens),output=asNullableBigInt(usage.outputTokens);
 switch(basis) {
  case 'input_tokens': return input;
  case 'output_tokens': return output;
  case 'total_tokens': {
   if(input===null||output===null) return null;
   const total=input+output;
   if(total>max) throw new Error('Reasoning total usage exceeds safe storage range');
   return total;
  }
  case 'cost_micro_usd': return asNullableBigInt(usage.costMicroUsd);
  case 'requests': return 1n;
  case 'remote_slots': return 1n;
  default: return null;
 }
};
const receiptUsage=(receipt:Receipt):Usage=>({inputTokens:receipt.input_tokens,outputTokens:receipt.output_tokens,
 cacheReadTokens:receipt.cache_read_tokens,cacheWriteTokens:receipt.cache_write_tokens,costMicroUsd:receipt.cost_micro_usd});
const text=(value:bigint)=>value.toString();

async function withTransaction<T>(db:pg.Pool,fn:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
 const client=await db.connect();
 try {await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}
 catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
}

async function pauseBuckets(client:pg.PoolClient,bucketIds:string[]):Promise<void> {
 if(bucketIds.length===0) return;
 await client.query('UPDATE reasoning_bucket SET paused=true WHERE id=ANY($1::uuid[])',[bucketIds]);
}

async function freeze(
 client:pg.PoolClient,accounting:Accounting,reservations:Reservation[],
):Promise<'held'|'released'> {
 await pauseBuckets(client,reservations.map(reservation=>reservation.bucket_id));
 const remoteReleased=reservations.filter(reservation=>reservation.handling==='remote').every(reservation=>reservation.state==='released');
 await client.query(`UPDATE reasoning_accounting SET review_required=true,reconciliation_hold=true,idempotency_hold=true,
  liability_state='held',remote_state=$2,remote_disposition=CASE WHEN $2='released' THEN 'terminal' ELSE remote_disposition END,
  all_duties_closed_at=NULL WHERE attempt_id=$1`,[accounting.attempt_id,remoteReleased?'released':'held']);
 return remoteReleased?'released':'held';
}

function snapshot(reservations:Reservation[]):Usage {
 const value=(basis:string):number|null=>{
  const row=reservations.find(reservation=>reservation.usage_basis===basis&&reservation.usage_known);
  return row?Number(asBigInt(row.recognized)):null;
 };
 return {inputTokens:value('input_tokens'),outputTokens:value('output_tokens'),cacheReadTokens:null,cacheWriteTokens:null,costMicroUsd:value('cost_micro_usd')};
}

async function appendSettlement(
 client:pg.PoolClient,receipt:Receipt,reservations:Reservation[],adjustments:Array<{bucketId:string;delta:bigint}>,liability:'held'|'partially_settled'|'settled',remote:'held'|'released',
):Promise<{settlementId:string;revision:number}> {
 const previous=(await client.query(
  `SELECT id,revision FROM reasoning_settlement WHERE attempt_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,[receipt.attempt_id],
 )).rows[0] as {id:string;revision:number}|undefined;
 const settlementId=randomUUID(),revision=(previous?.revision??0)+1,usage=snapshot(reservations);
 const fingerprint=(await client.query('SELECT fingerprint FROM reasoning_receipt WHERE id=$1',[receipt.id])).rows[0].fingerprint;
 await client.query(`INSERT INTO reasoning_settlement
  (id,attempt_id,receipt_id,receipt_fingerprint,revision,supersedes_settlement_id,basis,liability,remote_concurrency,
   input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_micro_usd)
  VALUES($1,$2,$3,$4,$5,$6,'measured',$7,$8,$9,$10,$11,$12,$13)`,
  [settlementId,receipt.attempt_id,receipt.id,fingerprint,revision,previous?.id??null,liability,remote,
   usage.inputTokens,usage.outputTokens,usage.cacheReadTokens,usage.cacheWriteTokens,usage.costMicroUsd]);
 for(const adjustment of adjustments) {
  await client.query(`INSERT INTO reasoning_settlement_adjustment(settlement_id,attempt_id,bucket_id,unit,delta)
   SELECT $1,r.attempt_id,r.bucket_id,b.unit,$4::bigint FROM reasoning_reservation r
   JOIN reasoning_bucket b ON b.id=r.bucket_id WHERE r.attempt_id=$2 AND r.bucket_id=$3`,
   [settlementId,receipt.attempt_id,adjustment.bucketId,text(adjustment.delta)]);
 }
 return {settlementId,revision};
}

async function settleReceipt(client:pg.PoolClient,receiptId:string):Promise<Omit<ReconciliationResult,'receiptId'|'attemptId'|'fingerprint'|'replayed'>> {
 const receipt=(await client.query(`SELECT id,attempt_id,remote_disposition,outcome,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_micro_usd
  FROM reasoning_receipt WHERE id=$1 FOR UPDATE`,[receiptId])).rows[0] as Receipt|undefined;
 if(!receipt) throw new Error('Reasoning receipt disappeared before settlement');
 const accounting=(await client.query(`SELECT attempt_id,universe_id,state,binding_hash,runtime_policy_version,output_authority,review_required
  FROM reasoning_accounting WHERE attempt_id=$1 FOR UPDATE`,[receipt.attempt_id])).rows[0] as Accounting|undefined;
 if(!accounting) throw new Error('Reasoning accounting disappeared before settlement');
 const reservations=(await client.query(`SELECT id,attempt_id,bucket_id,amount,state,usage_basis,handling,recognized,usage_known
  FROM reasoning_reservation WHERE attempt_id=$1 ORDER BY bucket_id FOR UPDATE`,[receipt.attempt_id])).rows as Reservation[];
 await client.query('SELECT id FROM reasoning_bucket WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[reservations.map(row=>row.bucket_id)]);

 const terminal=(await client.query(`SELECT outcome FROM reasoning_receipt
  WHERE attempt_id=$1 AND remote_disposition='terminal' ORDER BY recorded_at,id`,[receipt.attempt_id])).rows as Array<{outcome:string}>;
 const contradictory=terminal.length>1&&new Set(terminal.map(row=>row.outcome)).size>1;
 const unknown=accounting.binding_hash===null||accounting.runtime_policy_version===null||reservations.some(reservation=>reservation.usage_basis==='unknown'||reservation.handling==='unknown');
 const decreases=reservations.some(reservation=>{
  const next=usageValue(reservation.usage_basis,receiptUsage(receipt));
  return next!==null&&reservation.usage_known&&next<asBigInt(reservation.recognized);
 });
 if(accounting.review_required||contradictory||unknown||decreases) {
  const remoteState=await freeze(client,accounting,reservations);
  const settlement=await appendSettlement(client,receipt,reservations,[],'held',remoteState);
  return {...settlement,reviewRequired:true};
 }

 const adjustments:Array<{bucketId:string;delta:bigint}>=[];
 for(const reservation of reservations) {
  const next=usageValue(reservation.usage_basis,receiptUsage(receipt)),prior=asBigInt(reservation.recognized),amount=asBigInt(reservation.amount);
  if(reservation.handling==='remote') {
   if(!reservation.usage_known) await client.query(`UPDATE reasoning_reservation SET usage_known=true,recognized=1 WHERE id=$1`,[reservation.id]);
   if(receipt.remote_disposition==='terminal'&&reservation.state==='held') {
    const released=await client.query(`UPDATE reasoning_bucket SET reserved=reserved-$2::bigint
     WHERE id=$1 AND reserved>=$2::bigint RETURNING id`,[reservation.bucket_id,text(amount)]);
    if(released.rowCount!==1) throw new Error('Reasoning remote reservation underflow');
    await client.query("UPDATE reasoning_reservation SET state='released' WHERE id=$1 AND state='held'",[reservation.id]);
    adjustments.push({bucketId:reservation.bucket_id,delta:0n});
   }
   continue;
  }
  if(next===null) continue;
  const first=!reservation.usage_known;
  const consumed=reservation.handling==='rate'?(next>amount?next:amount):next;
  const delta=first?consumed:next-prior;
  if(delta<0n) throw new Error('Decreasing usage reached settlement mutation');
  if(first) {
   const bucket=await client.query(`UPDATE reasoning_bucket SET reserved=reserved-$2::bigint,consumed=consumed+$3::bigint,
    paused=paused OR $4 WHERE id=$1 AND reserved>=$2::bigint RETURNING id`,
    [reservation.bucket_id,text(amount),text(delta),next>amount]);
   if(bucket.rowCount!==1) throw new Error('Reasoning reservation underflow');
   await client.query("UPDATE reasoning_reservation SET state='accounted',usage_known=true,recognized=$2::bigint WHERE id=$1 AND state='held'",[reservation.id,text(next)]);
   adjustments.push({bucketId:reservation.bucket_id,delta});
  } else if(delta>0n) {
   await client.query(`UPDATE reasoning_bucket SET consumed=consumed+$2::bigint,paused=paused OR $3 WHERE id=$1`,
    [reservation.bucket_id,text(delta),next>amount]);
   await client.query('UPDATE reasoning_reservation SET recognized=$2::bigint WHERE id=$1',[reservation.id,text(next)]);
   adjustments.push({bucketId:reservation.bucket_id,delta});
  }
 }

 const current=(await client.query(`SELECT id,usage_basis,handling,usage_known,state,recognized,bucket_id FROM reasoning_reservation
  WHERE attempt_id=$1 ORDER BY bucket_id FOR UPDATE`,[receipt.attempt_id])).rows as Reservation[];
 const financial=current.filter(row=>row.handling==='budget'||row.handling==='rate');
 const allKnown=financial.every(row=>row.usage_known);
 const anyKnown=financial.some(row=>row.usage_known);
 const remote=current.filter(row=>row.handling==='remote');
 const terminalRemote=remote.every(row=>row.state==='released');
 const liability=allKnown?'settled':anyKnown?'partially_settled':'held';
 const remoteState=terminalRemote?'released':'held';
 const close=allKnown&&terminalRemote;
 await client.query(`UPDATE reasoning_accounting SET state='responded',liability_state=$2,remote_state=$3,
  remote_disposition=$4,reconciliation_hold=$5,idempotency_hold=$5,review_required=false,
  closure_basis=CASE WHEN $6 THEN 'evidence' ELSE NULL END,risk_closure_id=NULL,
  all_duties_closed_at=CASE WHEN $6 THEN clock_timestamp() ELSE NULL END
  WHERE attempt_id=$1`,[receipt.attempt_id,liability,remoteState,terminalRemote?'terminal':'unconfirmed',!close,close]);
 const settlement=await appendSettlement(client,receipt,current,adjustments,liability,remoteState);
 return {...settlement,reviewRequired:false};
}

export function createReasoningReconciliation(db:pg.Pool) {
 return {
  async recordAndSettleReceipt(input:unknown,origin:TrustedReasoningReceiptOrigin):Promise<ReconciliationResult> {
   return withTransaction(db,async client=>{
    const appended=await appendRestrictedReasoningReceipt(client,input,origin);
    if(appended.replayed) return {...appended,reviewRequired:false};
    const settled=await settleReceipt(client,appended.receiptId);
    return {...appended,...settled};
   });
  },
 };
}

export {settleReceipt};
