import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { HistoryClearInput, HistoryClearReceipt } from '../../contracts/src/index.ts';
import type { AuthScope } from './identity.ts';
import {eraseReasoningForHistoryClear} from './reasoning-storage.ts';

export class HistoryClearConflict extends Error {
 readonly statusCode = 409;
 constructor(message = 'History clear conflicts with the current privacy epoch') {
  super(message);
  this.name = 'HistoryClearConflict';
 }
}

function receiptFromRow(row: Record<string, unknown>): HistoryClearReceipt {
 const clearedAt=row.cleared_at;
 return {
  receiptId:String(row.id),
  privacyEpoch:Number(row.epoch_after),
  clearedAt:clearedAt instanceof Date ? clearedAt.toISOString() : new Date(String(clearedAt)).toISOString(),
 };
}

export async function clearScrollHistory(
 client:pg.PoolClient,
 scope:AuthScope,
 input:HistoryClearInput,
):Promise<HistoryClearReceipt> {
 const old=(await client.query(
  'SELECT id,epoch_before,epoch_after,cleared_at FROM history_clear_receipt WHERE universe_id=$1 AND request_id=$2',
  [scope.universeId,input.requestId],
 )).rows[0];
 if(old) {
  if(old.epoch_before!==input.expectedPrivacyEpoch) throw new HistoryClearConflict('History clear key was reused with a different expected privacy epoch');
  return receiptFromRow(old);
 }
 if(input.expectedPrivacyEpoch!==scope.privacyEpoch) throw new HistoryClearConflict();

 const nextEpoch=scope.privacyEpoch+1;
 const universe=await client.query(`UPDATE universe SET privacy_epoch=$3,revision=revision+1
  WHERE id=$1 AND privacy_epoch=$2 RETURNING privacy_epoch`,[scope.universeId,scope.privacyEpoch,nextEpoch]);
 if(!universe.rowCount) throw new HistoryClearConflict();
 const session=await client.query(`UPDATE device_session SET privacy_epoch=$3
  WHERE id=$1 AND universe_id=$2 AND privacy_epoch=$4 AND revoked_at IS NULL`,
  [scope.sessionId,scope.universeId,nextEpoch,scope.privacyEpoch]);
 if(session.rowCount!==1) throw new Error('Authenticated session could not advance with history clear');

 await eraseReasoningForHistoryClear(client,{universeId:scope.universeId,epochBefore:scope.privacyEpoch,epochAfter:nextEpoch});
 await client.query('DELETE FROM job WHERE universe_id=$1',[scope.universeId]);
 await client.query('DELETE FROM trace WHERE universe_id=$1',[scope.universeId]);
 await client.query('DELETE FROM exposure WHERE universe_id=$1',[scope.universeId]);
 await client.query('DELETE FROM ledger WHERE universe_id=$1',[scope.universeId]);
 await client.query('DELETE FROM decision WHERE universe_id=$1',[scope.universeId]);
 const accounts=await client.query(`UPDATE accounts SET kept_asset_ids='{}'::uuid[],revision=revision+1
  WHERE universe_id=$1`,[scope.universeId]);
 if(accounts.rowCount!==1) throw new Error('Universe accounts state is missing');

 const receipt=(await client.query(`INSERT INTO history_clear_receipt
  (id,universe_id,request_id,epoch_before,epoch_after,cleared_at)
  VALUES($1,$2,$3,$4,$5,clock_timestamp()) RETURNING id,epoch_after,cleared_at`,
  [randomUUID(),scope.universeId,input.requestId,scope.privacyEpoch,nextEpoch])).rows[0];
 return receiptFromRow(receipt);
}
