import type pg from 'pg';

import {exposureInput,interactionInput} from '../../contracts/src/index.ts';
import {traceRevisitCandidate,traceRevisitEventId,traceRevisitReceipt,traceRevisitScroll,type TraceRevisit} from '../../contracts/src/trace-revisit.ts';
import {UnauthorizedSession,type AuthScope} from './identity.ts';

export class TraceRevisitError extends Error {
 constructor(readonly kind:'invalid'|'not_found'|'stale_epoch'|'source_changed'|'lineage') {
  super(kind);this.name='TraceRevisitError';
 }
}

type Lineage={
 event_id:string;asset_id:string;created_at:Date;keep_id:string|null;keep_universe:string|null;keep_kind:string|null;
 keep_epoch:number|null;keep_key:string|null;keep_causation:string|null;keep_payload:unknown;kept_at:Date|null;
 exposure_id:string|null;exposure_universe:string|null;exposure_asset:string|null;exposure_key:string|null;
 exposure_event_id:string|null;exposure_event_universe:string|null;exposure_kind:string|null;exposure_epoch:number|null;
 exposure_event_key:string|null;exposure_causation:string|null;exposure_payload:unknown;
 decision_id:string|null;decision_universe:string|null;decision_epoch:number|null;candidates:unknown;
};
type SelectedScroll=TraceRevisit['scroll'];
export type SavedTrace={eventId:string;assetId:string;title:string;createdAt:Date};

function record(value:unknown):Record<string,unknown>|null {
 return typeof value==='object'&&value!==null&&!Array.isArray(value)?value as Record<string,unknown>:null;
}
function sameId(value:unknown,expected:string|null):boolean {
 return typeof value==='string'&&expected!==null&&value.toLowerCase()===expected;
}
function lineageError():never {throw new TraceRevisitError('lineage');}

async function currentScope(client:pg.PoolClient,scope:AuthScope):Promise<void> {
 const row=(await client.query<{universe_epoch:number;session_epoch:number|null;live:boolean|null}>(
  `SELECT u.privacy_epoch AS universe_epoch,s.privacy_epoch AS session_epoch,
    (s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) AS live
   FROM universe u LEFT JOIN device_session s ON s.universe_id=u.id AND s.id=$2 AND s.device_id=$3
   WHERE u.id=$1`,[scope.universeId,scope.sessionId,scope.deviceId],
 )).rows[0];
 if(!row) throw new UnauthorizedSession();
 if(row.universe_epoch!==scope.privacyEpoch) throw new TraceRevisitError('stale_epoch');
 if(row.session_epoch!==scope.privacyEpoch||row.live!==true) throw new UnauthorizedSession();
}

async function readLineage(client:pg.PoolClient,scope:AuthScope,eventId?:string):Promise<Lineage[]> {
 return (await client.query<Lineage>(
  `SELECT t.event_id,t.asset_id,t.created_at,k.id AS keep_id,k.universe_id AS keep_universe,k.kind AS keep_kind,
    k.privacy_epoch AS keep_epoch,k.client_key AS keep_key,k.causation_id AS keep_causation,k.payload AS keep_payload,k.created_at AS kept_at,
    e.id AS exposure_id,e.universe_id AS exposure_universe,e.asset_id AS exposure_asset,e.client_key AS exposure_key,
    el.id AS exposure_event_id,el.universe_id AS exposure_event_universe,el.kind AS exposure_kind,el.privacy_epoch AS exposure_epoch,
    el.client_key AS exposure_event_key,el.causation_id AS exposure_causation,el.payload AS exposure_payload,
    d.id AS decision_id,d.universe_id AS decision_universe,d.privacy_epoch AS decision_epoch,d.candidates
   FROM trace t LEFT JOIN ledger k ON k.id=t.event_id AND k.universe_id=t.universe_id
   LEFT JOIN exposure e ON e.id::text=lower(k.payload->>'exposureId') AND e.universe_id=t.universe_id
   LEFT JOIN ledger el ON el.id=e.event_id AND el.universe_id=t.universe_id
   LEFT JOIN decision d ON d.id=e.decision_id AND d.universe_id=t.universe_id
   WHERE t.universe_id=$1 ${eventId===undefined?'':'AND t.event_id=$2'} ORDER BY t.created_at,t.event_id`,
  eventId===undefined?[scope.universeId]:[scope.universeId,eventId],
 )).rows;
}

function selectedSnapshot(row:Lineage,scope:AuthScope):SelectedScroll {
 if(!row.keep_id||!row.exposure_id||!row.exposure_event_id||!row.decision_id) lineageError();
 if([row.keep_epoch,row.exposure_epoch,row.decision_epoch].some(epoch=>epoch!==scope.privacyEpoch)) throw new TraceRevisitError('stale_epoch');
 if(row.keep_kind!=='keep'||row.exposure_kind!=='exposure'||row.exposure_causation!==null
  ||row.keep_causation!==row.exposure_event_id||row.keep_id!==row.event_id
  ||row.exposure_asset!==row.asset_id
  ||[row.keep_universe,row.exposure_universe,row.exposure_event_universe,row.decision_universe].some(id=>id!==scope.universeId)) lineageError();
 const keep=interactionInput.safeParse(row.keep_payload);
 if(!keep.success||!sameId(keep.data.assetId,row.asset_id)||!sameId(keep.data.exposureId,row.exposure_id)
  ||!sameId(keep.data.clientEventId,row.keep_key)) lineageError();
 const payload=record(row.exposure_payload);
 if(!payload||Object.keys(payload).sort().join(',')!=='assetId,clientExposureId,decisionId,exposureId') lineageError();
 const exposure=exposureInput.safeParse({decisionId:payload.decisionId,assetId:payload.assetId,clientExposureId:payload.clientExposureId});
 if(!exposure.success||!sameId(payload.exposureId,row.exposure_id)||!sameId(exposure.data.assetId,row.asset_id)
  ||!sameId(exposure.data.decisionId,row.decision_id)||!sameId(exposure.data.clientExposureId,row.exposure_key)
  ||row.exposure_key!==row.exposure_event_key) lineageError();
 if(!Array.isArray(row.candidates)) lineageError();
 // Count canonical IDs BEFORE parsing: one valid plus one malformed/mixed-case
 // candidate for the same asset is still ambiguous history.
 const matching=row.candidates.filter(candidate=>sameId(record(candidate)?.assetId,row.asset_id));
 if(matching.length!==1) lineageError();
 const selected=traceRevisitCandidate.safeParse(matching[0]);
 if(!selected.success) lineageError();
 return selected.data;
}

/** Caller owns the same transaction's authenticateAndLock universe/session. */
export async function readTraceRevisit(client:pg.PoolClient,scope:AuthScope,eventId:unknown):Promise<TraceRevisit> {
 const parsed=traceRevisitEventId.safeParse(eventId);
 if(!parsed.success) throw new TraceRevisitError('invalid');
 await currentScope(client,scope);
 const rows=await readLineage(client,scope,parsed.data);
 if(rows.length===0) throw new TraceRevisitError('not_found');
 if(rows.length!==1) lineageError();
 const row=rows[0]!,selected=selectedSnapshot(row,scope);
 const asset=(await client.query(
  `SELECT id AS "assetId",revision,kind,title,summary,body,source_title AS "sourceTitle",source_url AS "sourceUrl",truth_state AS "truthState"
   FROM asset WHERE id=$1 FOR SHARE`,[row.asset_id],
 )).rows[0];
 // No new lock acquisition after the source wait. Time, unlike locked rows,
 // continues to advance while a correction holds the asset.
 await currentScope(client,scope);
 const current=traceRevisitScroll.safeParse(asset);
 if(!current.success||Object.keys(selected).some(key=>selected[key as keyof SelectedScroll]!==current.data[key as keyof SelectedScroll])) {
  throw new TraceRevisitError('source_changed');
 }
 return traceRevisitReceipt.parse({mode:'kept_revisit',traceEventId:row.event_id,universeId:scope.universeId,
  privacyEpoch:scope.privacyEpoch,exposureId:row.exposure_id,keptAt:row.kept_at!.toISOString(),scroll:selected});
}

/** Historical titles do not certify present source availability. */
export async function listSavedTraces(client:pg.PoolClient,scope:AuthScope):Promise<SavedTrace[]> {
 await currentScope(client,scope);
 const rows=await readLineage(client,scope);
 const counts=new Map<string,number>();
 for(const row of rows) counts.set(row.event_id,(counts.get(row.event_id)??0)+1);
 const traces=rows.map(row=>{
  let title='Saved Scroll unavailable';
  try {if(counts.get(row.event_id)===1) title=selectedSnapshot(row,scope).title;}
  catch(error) {if(!(error instanceof TraceRevisitError)) throw error;}
  return {eventId:row.event_id,assetId:row.asset_id,title,createdAt:row.created_at};
 });
 await currentScope(client,scope);
 return traces;
}
