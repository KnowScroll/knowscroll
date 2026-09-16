import {createHash, randomUUID} from 'node:crypto';
import type pg from 'pg';

import {
  explicitAskInput,
  exposureInput,
  type ExplicitAskInput,
  type ExplicitAskReceipt,
  type ScrollAsset,
} from '../../contracts/src/index.ts';
import type {AuthScope} from './identity.ts';

export class ExplicitAskError extends Error {
  constructor(public readonly kind:'invalid'|'stale_epoch'|'conflict'|'source') {
    super(kind);
    this.name='ExplicitAskError';
  }
}

type ExistingAsk={ask_id:string;event_id:string;privacy_epoch:number;exposure_id:string;payload:unknown};
type SourceRow={
  exposure_id:string; exposure_event_id:string; exposure_client_id:string; exposure_payload:unknown;
  decision_id:string; decision_candidates:unknown; decision_privacy_epoch:number;
  asset_id:string; asset_revision:number; asset_kind:string; asset_title:string; asset_summary:string;
  asset_body:string; asset_source_title:string; asset_source_url:string; asset_truth_state:string;
};

const ASK_LEDGER_KEY_DOMAIN='knowscroll:explicit-ask:ledger-key:v1';

function canonical(value:unknown):string {
  if(value===null || typeof value==='boolean' || typeof value==='number' || typeof value==='string') return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if(typeof value==='object') {
    const object=value as Record<string,unknown>;
    return `{${Object.keys(object).sort().map(key=>`${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  throw new Error('Stored Ask source contains non-JSON data');
}

function uuidFromDigest(value:string):string {
  const bytes=createHash('sha256').update(value,'utf8').digest().subarray(0,16);
  bytes[6]=(bytes[6]!&0x0f)|0x40;
  bytes[8]=(bytes[8]!&0x3f)|0x80;
  const hex=bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function explicitAskLedgerKey(sessionId:string,clientAskId:string):string {
  return uuidFromDigest(`${ASK_LEDGER_KEY_DOMAIN}\u0000${sessionId.toLowerCase()}\u0000${clientAskId.toLowerCase()}`);
}

function asRecord(value:unknown):Record<string,unknown>|null {
  return typeof value==='object' && value!==null && !Array.isArray(value)?value as Record<string,unknown>:null;
}

function exactKeys(value:Record<string,unknown>,keys:readonly string[]):boolean {
  const actual=Object.keys(value).sort();
  return actual.length===keys.length && actual.every((key,index)=>key===keys[index]);
}

function uuidEquals(left:unknown,right:string):boolean {
  return typeof left==='string' && left.toLowerCase()===right.toLowerCase();
}

function scrollFromRow(row:SourceRow):ScrollAsset {
  return {
    assetId:row.asset_id,revision:row.asset_revision,kind:'Scroll',title:row.asset_title,summary:row.asset_summary,
    body:row.asset_body,sourceTitle:row.asset_source_title,sourceUrl:row.asset_source_url,truthState:'documented',
  };
}

function validExposurePayload(row:SourceRow):boolean {
  const payload=asRecord(row.exposure_payload);
  if(!payload || !exactKeys(payload,['assetId','clientExposureId','decisionId','exposureId'])) return false;
  const parsed=exposureInput.safeParse({decisionId:payload.decisionId,assetId:payload.assetId,clientExposureId:payload.clientExposureId});
  return parsed.success
    && uuidEquals(payload.exposureId,row.exposure_id)
    && uuidEquals(parsed.data.decisionId,row.decision_id)
    && uuidEquals(parsed.data.assetId,row.asset_id)
    && uuidEquals(parsed.data.clientExposureId,row.exposure_client_id);
}

function selectedCurrentScroll(row:SourceRow):boolean {
  if(row.asset_kind!=='Scroll' || row.asset_truth_state!=='documented' || !Array.isArray(row.decision_candidates)) return false;
  const candidates=row.decision_candidates.flatMap(candidate=>{
    const record=asRecord(candidate);
    if(!record || record.kind!=='Scroll' || !uuidEquals(record.assetId,row.asset_id)
      || !Number.isInteger(record.revision) || (record.revision as number)<=0
      || typeof record.title!=='string' || typeof record.summary!=='string' || typeof record.body!=='string'
      || typeof record.sourceTitle!=='string' || typeof record.sourceUrl!=='string' || record.truthState!=='documented') return [];
    return [{assetId:String(record.assetId).toLowerCase(),revision:record.revision as number,kind:'Scroll' as const,
      title:record.title,summary:record.summary,body:record.body,sourceTitle:record.sourceTitle,
      sourceUrl:record.sourceUrl,truthState:'documented' as const}];
  });
  return candidates.length===1 && canonical(candidates[0])===canonical(scrollFromRow(row));
}

async function currentScope(client:pg.PoolClient,scope:AuthScope):Promise<boolean> {
  const row=(await client.query<{privacy_epoch:number}>(`SELECT u.privacy_epoch
    FROM universe u JOIN device_session s ON s.universe_id=u.id
    WHERE u.id=$1 AND s.id=$2 AND s.device_id=$3 AND s.privacy_epoch=$4
      AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()`,
    [scope.universeId,scope.sessionId,scope.deviceId,scope.privacyEpoch])).rows[0];
  return row?.privacy_epoch===scope.privacyEpoch;
}

async function existingAsk(client:pg.PoolClient,scope:AuthScope,input:ExplicitAskInput):Promise<ExistingAsk|null> {
  return (await client.query<ExistingAsk>(`SELECT a.id AS ask_id,a.event_id,a.privacy_epoch,a.exposure_id,l.payload
    FROM explicit_ask a JOIN ledger l ON l.id=a.event_id AND l.universe_id=a.universe_id
    WHERE a.universe_id=$1 AND a.session_id=$2 AND a.client_ask_id=$3`,
    [scope.universeId,scope.sessionId,input.clientAskId])).rows[0]??null;
}

function replayMatches(existing:ExistingAsk,input:ExplicitAskInput,scope:AuthScope):boolean {
  const payload=asRecord(existing.payload);
  return existing.privacy_epoch===scope.privacyEpoch && uuidEquals(existing.exposure_id,input.exposureId)
    && payload!==null && payload.question===input.question
    && uuidEquals(payload.exposureId,input.exposureId)
    && uuidEquals(payload.sessionId,scope.sessionId)
    && uuidEquals(payload.clientAskId,input.clientAskId)
    && payload.expectedPrivacyEpoch===scope.privacyEpoch;
}

async function source(client:pg.PoolClient,scope:AuthScope,exposureId:string):Promise<SourceRow|null> {
  return (await client.query<SourceRow>(`SELECT e.id AS exposure_id,e.event_id AS exposure_event_id,e.client_key AS exposure_client_id,
      origin.payload AS exposure_payload,d.id AS decision_id,d.candidates AS decision_candidates,d.privacy_epoch AS decision_privacy_epoch,
      a.id AS asset_id,a.revision AS asset_revision,a.kind AS asset_kind,a.title AS asset_title,a.summary AS asset_summary,
      a.body AS asset_body,a.source_title AS asset_source_title,a.source_url AS asset_source_url,a.truth_state AS asset_truth_state
    FROM exposure e
    JOIN ledger origin ON origin.id=e.event_id AND origin.universe_id=e.universe_id
    JOIN decision d ON d.id=e.decision_id AND d.universe_id=e.universe_id
    JOIN asset a ON a.id=e.asset_id
    WHERE e.id=$1 AND e.universe_id=$2 AND origin.kind='exposure' AND origin.privacy_epoch=$3 AND d.privacy_epoch=$3`,
    [exposureId,scope.universeId,scope.privacyEpoch])).rows[0]??null;
}

async function lockAsset(client:pg.PoolClient,assetId:string):Promise<boolean> {
  return Boolean((await client.query('SELECT id FROM asset WHERE id=$1 FOR SHARE',[assetId])).rowCount);
}

function parse(input:unknown):ExplicitAskInput {
  const parsed=explicitAskInput.safeParse(input);
  if(!parsed.success) throw new ExplicitAskError('invalid');
  return parsed.data;
}

export async function recordExplicitAsk(
  client:pg.PoolClient,
  authenticated:AuthScope,
  rawInput:ExplicitAskInput,
):Promise<ExplicitAskReceipt> {
  const input=parse(rawInput);
  if(input.expectedPrivacyEpoch!==authenticated.privacyEpoch || !await currentScope(client,authenticated)) {
    throw new ExplicitAskError('stale_epoch');
  }

  const existing=await existingAsk(client,authenticated,input);
  if(existing) {
    if(!replayMatches(existing,input,authenticated)) throw new ExplicitAskError('conflict');
    return {askId:existing.ask_id,eventId:existing.event_id,status:'recorded_only'};
  }

  const first=await source(client,authenticated,input.exposureId);
  if(!first || !validExposurePayload(first) || !selectedCurrentScroll(first)) throw new ExplicitAskError('source');
  if(!await lockAsset(client,first.asset_id)) throw new ExplicitAskError('source');
  if(!await currentScope(client,authenticated)) throw new ExplicitAskError('stale_epoch');
  const selected=await source(client,authenticated,input.exposureId);
  if(!selected || selected.asset_id!==first.asset_id || !validExposurePayload(selected) || !selectedCurrentScroll(selected)) {
    throw new ExplicitAskError('source');
  }

  const askId=randomUUID();
  const eventId=randomUUID();
  const payload={
    question:input.question, exposureId:selected.exposure_id, decisionId:selected.decision_id, assetId:selected.asset_id,
    sessionId:authenticated.sessionId, clientAskId:input.clientAskId, expectedPrivacyEpoch:authenticated.privacyEpoch,
  };
  await client.query(`INSERT INTO ledger(id,universe_id,kind,client_key,causation_id,payload,privacy_epoch)
    VALUES($1,$2,'ask',$3,$4,$5,$6)`,
    [eventId,authenticated.universeId,explicitAskLedgerKey(authenticated.sessionId,input.clientAskId),selected.exposure_event_id,JSON.stringify(payload),authenticated.privacyEpoch]);
  await client.query(`INSERT INTO explicit_ask(id,event_id,universe_id,privacy_epoch,session_id,client_ask_id,exposure_id)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [askId,eventId,authenticated.universeId,authenticated.privacyEpoch,authenticated.sessionId,input.clientAskId,selected.exposure_id]);
  return {askId,eventId,status:'recorded_only'};
}
