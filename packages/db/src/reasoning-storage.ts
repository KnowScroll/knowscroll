import {lockFairnessResources,releaseNotSentFairness,clearFairnessMembership} from './reasoning-fairness-accounting.js';
import {createHash} from 'node:crypto';
import type pg from 'pg';
import {reasoningReceipt,type ReasoningReceipt} from '../../contracts/src/reasoning.ts';
import {lockUniverse} from './index.ts';

export type ReasoningClearScope = {universeId:string;epochBefore:number;epochAfter:number};
export type ReasoningClearResult = {privateJobsDeleted:number;accountingRetained:number};
export type TrustedReasoningReceiptOrigin = 'worker'|'reconciler';
export type AppendReasoningReceiptResult = {receiptId:string;attemptId:string;fingerprint:string;replayed:boolean};

export class ReasoningReceiptConflict extends Error {
 constructor(message='Reasoning receipt conflicts with retained accounting') {
  super(message);this.name='ReasoningReceiptConflict';
 }
}

export class UnknownReasoningReceipt extends Error {
 constructor() {super('Unknown reasoning accounting identity');this.name='UnknownReasoningReceipt';}
}

function receiptFingerprint(receipt:ReasoningReceipt):string {
 const canonical={
  version:receipt.version,receiptId:receipt.receiptId,attemptId:receipt.attemptId,
  dispatchId:receipt.dispatchId,requestId:receipt.requestId,routeId:receipt.routeId,
  routeProfileVersion:receipt.routeProfileVersion,evidenceKind:receipt.evidenceKind,
  observedAt:receipt.observedAt,remoteDisposition:receipt.remoteDisposition,
  outcome:receipt.outcome,httpStatus:receipt.httpStatus,
  usage:{
   inputTokens:receipt.usage.inputTokens,outputTokens:receipt.usage.outputTokens,
   cacheReadTokens:receipt.usage.cacheReadTokens,cacheWriteTokens:receipt.usage.cacheWriteTokens,
   costMicroUsd:receipt.usage.costMicroUsd,
  },
 };
 return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function assertTrustedOrigin(receipt:ReasoningReceipt,origin:TrustedReasoningReceiptOrigin):void {
 switch(origin) {
  case 'worker':
   if(receipt.evidenceKind==='original_transport') return;
   throw new ReasoningReceiptConflict('Worker receipts must be original transport evidence');
  case 'reconciler':
   if(receipt.evidenceKind==='provider_lookup'||receipt.evidenceKind==='operator_reconciliation') return;
   throw new ReasoningReceiptConflict('Reconciler receipts require lookup or operator evidence');
  default:
   throw new ReasoningReceiptConflict('Reasoning receipt origin is not trusted');
 }
}

/** Caller already holds the universe lock and has passed the new-clear branch. */
export async function eraseReasoningForHistoryClear(
 client:pg.PoolClient,
 scope:ReasoningClearScope,
):Promise<ReasoningClearResult> {
 const {universeId}=scope;
 if(!Number.isInteger(scope.epochBefore)||scope.epochBefore<0||scope.epochAfter!==scope.epochBefore+1) {
  throw new Error('History-clear reasoning scope must advance exactly one privacy epoch');
 }
 await client.query('SELECT id FROM reasoning_job WHERE universe_id=$1 ORDER BY id FOR UPDATE',[universeId]);

 await client.query(
  'SELECT id FROM reasoning_step WHERE universe_id=$1 ORDER BY id FOR UPDATE',[universeId],
 );
 const attempts=(await client.query(
  'SELECT id FROM reasoning_attempt WHERE universe_id=$1 ORDER BY id FOR UPDATE',[universeId],
 )).rows.map(row=>String(row.id));
 const accountings=(await client.query(
  'SELECT attempt_id,state,dispatch_id FROM reasoning_accounting WHERE universe_id=$1 ORDER BY attempt_id FOR UPDATE',[universeId],
 )).rows as Array<{attempt_id:string;state:string;dispatch_id:string|null}>;
 const accountingIds=accountings.map(accounting=>accounting.attempt_id);
 const accountingByAttempt=new Map(accountings.map(accounting=>[accounting.attempt_id,accounting]));
 for(const attemptId of attempts) {
  if(!accountingByAttempt.has(attemptId)) throw new Error('Private reasoning attempt is missing retained accounting');
 }
 const permits:Array<{id:string;attempt_id:string;state:'reserved'|'consumed'|'revoked'|'expired'}>=accountingIds.length===0?[]:(await client.query(
  `SELECT id,attempt_id,state FROM reasoning_permit
   WHERE attempt_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,[accountingIds],
 )).rows;
 const permitAttempts=new Set(permits.map(permit=>permit.attempt_id));
 for(const attemptId of attempts) {
  if(!permitAttempts.has(attemptId)) throw new Error('Every private reasoning attempt must have one retained permit');
 }
 const unconsumedAttemptIds=permits.filter(permit=>permit.state!=='consumed').map(permit=>permit.attempt_id);
 const reservedAttemptIds=permits.filter(permit=>permit.state==='reserved').map(permit=>permit.attempt_id);

 await lockFairnessResources(client,accountingIds,universeId);
 if(unconsumedAttemptIds.length>0) {
  const closed=await client.query(
   `UPDATE reasoning_accounting SET state='not_sent',output_authority='withdrawn',
      liability_state='settled',remote_state='released',remote_disposition='not_sent',
      reconciliation_hold=false,idempotency_hold=false,closure_basis=COALESCE(closure_basis,'evidence'),
      risk_closure_id=CASE WHEN closure_basis IS NULL THEN NULL ELSE risk_closure_id END,
      all_duties_closed_at=COALESCE(all_duties_closed_at,clock_timestamp())
    WHERE attempt_id=ANY($1::uuid[]) AND state IN ('reserved','not_sent') AND dispatch_id IS NULL`,[unconsumedAttemptIds],
  );
  if(closed.rowCount!==unconsumedAttemptIds.length) throw new Error('Unconsumed reasoning accounting could not close atomically');
  if(reservedAttemptIds.length>0) {
   const revoked=await client.query(
    `UPDATE reasoning_permit SET state='revoked',closed_at=clock_timestamp()
     WHERE attempt_id=ANY($1::uuid[]) AND state='reserved'`,[reservedAttemptIds],
   );
   if(revoked.rowCount!==reservedAttemptIds.length) throw new Error('Unconsumed reasoning permits could not be revoked');
  }

  const releases=(await client.query(
   `SELECT r.bucket_id,sum(r.amount)::text AS amount
    FROM reasoning_reservation r
    WHERE r.attempt_id=ANY($1::uuid[]) AND r.state='held'
    GROUP BY r.bucket_id ORDER BY r.bucket_id`,[unconsumedAttemptIds],
  )).rows as Array<{bucket_id:string;amount:string}>;
  if(releases.length>0) {
   const heldCount=Number((await client.query(
    `SELECT count(*)::int AS count FROM reasoning_reservation
     WHERE attempt_id=ANY($1::uuid[]) AND state='held'`,[unconsumedAttemptIds],
   )).rows[0].count);
   await client.query(
    `SELECT id FROM reasoning_bucket WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [releases.map(release=>release.bucket_id)],
   );
   for(const release of releases) {
    const bucket=await client.query(
     `UPDATE reasoning_bucket SET reserved=reserved-$2::bigint
      WHERE id=$1 AND reserved>=$2::bigint RETURNING id`,[release.bucket_id,release.amount],
    );
    if(bucket.rowCount!==1) throw new Error('Reasoning bucket reservation underflow');
   }
   const released=await client.query(
    `UPDATE reasoning_reservation SET state='released'
    WHERE attempt_id=ANY($1::uuid[]) AND state='held'`,[unconsumedAttemptIds],
   );
   if(released.rowCount!==heldCount) throw new Error('Unconsumed reasoning reservations did not release exactly once');
  }
 }

 for(const attemptId of unconsumedAttemptIds) await releaseNotSentFairness(client,attemptId);
 if(accountingIds.length>0) {
  await client.query(
   `UPDATE reasoning_accounting SET output_authority='withdrawn'
    WHERE universe_id=$1 AND output_authority='eligible'`,[universeId],
  );
 }

 await client.query('SET CONSTRAINTS ALL DEFERRED');
 await client.query('DELETE FROM reasoning_attempt WHERE universe_id=$1',[universeId]);
 await client.query('DELETE FROM reasoning_step WHERE universe_id=$1',[universeId]);
 await client.query('DELETE FROM reasoning_context WHERE universe_id=$1',[universeId]);
 const deleted=await client.query('DELETE FROM reasoning_job WHERE universe_id=$1',[universeId]);
 await clearFairnessMembership(client,universeId);
 return {privateJobsDeleted:deleted.rowCount??0,accountingRetained:accountings.length};
}

export async function appendRestrictedReasoningReceipt(
 client:pg.PoolClient,
 input:unknown,
 origin:TrustedReasoningReceiptOrigin,
):Promise<AppendReasoningReceiptResult> {
 const receipt=reasoningReceipt.parse(input);
 assertTrustedOrigin(receipt,origin);
 const fingerprint=receiptFingerprint(receipt);
 const candidate=(await client.query(
  'SELECT universe_id FROM reasoning_accounting WHERE attempt_id=$1',[receipt.attemptId],
 )).rows[0];
 if(!candidate) throw new UnknownReasoningReceipt();
 await lockUniverse(client,String(candidate.universe_id));

 const accounting=(await client.query(
  `SELECT * FROM reasoning_accounting
   WHERE attempt_id=$1 AND universe_id=$2 AND request_id=$3 AND dispatch_id=$4
    AND route_id=$5 AND route_profile_version=$6 FOR UPDATE`,
  [receipt.attemptId,candidate.universe_id,receipt.requestId,receipt.dispatchId,receipt.routeId,receipt.routeProfileVersion],
 )).rows[0];
 if(!accounting) throw new ReasoningReceiptConflict();

 const existing=(await client.query(
  'SELECT attempt_id,fingerprint FROM reasoning_receipt WHERE id=$1',[receipt.receiptId],
 )).rows[0];
 if(existing) {
  if(existing.attempt_id===receipt.attemptId&&existing.fingerprint===fingerprint) {
   return {receiptId:receipt.receiptId,attemptId:receipt.attemptId,fingerprint,replayed:true};
  }
  throw new ReasoningReceiptConflict('Reasoning receipt id was reused with conflicting evidence');
 }
 if(accounting.closure_basis==='operator_risk') {
  throw new ReasoningReceiptConflict('Operator risk closure ended late receipt acceptance');
 }
 if(accounting.state==='reserved'||accounting.state==='not_sent') {
  throw new ReasoningReceiptConflict('Reasoning receipt has no consumed dispatch authority');
 }

 await client.query(
  `INSERT INTO reasoning_receipt
   (id,attempt_id,universe_id,privacy_epoch,request_id,dispatch_id,route_id,route_profile_version,
    fingerprint,evidence_kind,observed_at,remote_disposition,outcome,http_status,
    input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_micro_usd)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
  [receipt.receiptId,receipt.attemptId,accounting.universe_id,accounting.privacy_epoch,
   receipt.requestId,receipt.dispatchId,receipt.routeId,receipt.routeProfileVersion,fingerprint,
   receipt.evidenceKind,receipt.observedAt,receipt.remoteDisposition,receipt.outcome,receipt.httpStatus,
   receipt.usage.inputTokens,receipt.usage.outputTokens,receipt.usage.cacheReadTokens,
   receipt.usage.cacheWriteTokens,receipt.usage.costMicroUsd],
 );
 await client.query(
  `UPDATE reasoning_accounting SET state='responded',remote_disposition=$2,
    liability_state='held',remote_state='held',reconciliation_hold=true,idempotency_hold=true,
    closure_basis=NULL,risk_closure_id=NULL,all_duties_closed_at=NULL
   WHERE attempt_id=$1`,[receipt.attemptId,receipt.remoteDisposition],
 );
 return {receiptId:receipt.receiptId,attemptId:receipt.attemptId,fingerprint,replayed:false};
}

export async function purgeClosedReasoningAccounting(
 client:pg.PoolClient,
 universeId:string,
 limit=100,
):Promise<number> {
 if(!Number.isInteger(limit)||limit<1||limit>1000) throw new Error('Reasoning cleanup limit must be 1 through 1000');
 await lockUniverse(client,universeId);
 const candidates=(await client.query(
  `SELECT a.attempt_id FROM reasoning_accounting a
   WHERE a.universe_id=$1 AND a.all_duties_closed_at<clock_timestamp()-interval '30 days'
    AND a.liability_state='settled' AND a.remote_state='released'
    AND NOT a.reconciliation_hold AND NOT a.idempotency_hold
    AND NOT EXISTS(SELECT 1 FROM reasoning_attempt p WHERE p.id=a.attempt_id)
   ORDER BY a.attempt_id FOR UPDATE OF a LIMIT $2`,[universeId,limit],
 )).rows.map(row=>String(row.attempt_id));
 if(candidates.length===0) return 0;
 const deleted=await client.query(
  `DELETE FROM reasoning_accounting
   WHERE universe_id=$1 AND attempt_id=ANY($2::uuid[])
    AND all_duties_closed_at<clock_timestamp()-interval '30 days'
    AND liability_state='settled' AND remote_state='released'
    AND NOT reconciliation_hold AND NOT idempotency_hold
    AND NOT EXISTS(SELECT 1 FROM reasoning_attempt p WHERE p.id=reasoning_accounting.attempt_id)`,
  [universeId,candidates],
 );
 return deleted.rowCount??0;
}
