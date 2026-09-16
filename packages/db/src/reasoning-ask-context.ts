import {createHash} from 'node:crypto';
import type pg from 'pg';
import {ASK_CONTEXT_LIMITS,ASK_CONTEXT_VERSIONS,askContextDependency,askContextDependencyKey,askContextPayload,compileDirectAskContextInput,type AskContextDependency,type AskContextPayload} from '../../contracts/src/reasoning-ask-context.ts';
import {contextScroll,type ContextRefusal,type ContextValidation} from '../../contracts/src/reasoning-context.ts';
import {explicitAskInput,exposureInput} from '../../contracts/src/index.ts';
import {explicitAskLedgerKey} from './explicit-ask.ts';
import type {AuthScope} from './identity.ts';
import {ReasoningDenied,validateReasoningPolicy,type ReasoningAuthority,type ReasoningContextCheck,type ReasoningScope} from './reasoning-runtime-policy.js';
type PolicyResolver=ReasoningAuthority['resolvePolicy'];
type ContextResult={contextId:string;contentHash:string;readSetHash:string};
type LineageRow={
 ask_id:string;ask_event_id:string;ask_sequence:string;ask_client_id:string;ask_ledger_client_id:string;ask_payload:unknown;ask_causation_id:string|null;ask_session_id:string;
 exposure_event_id:string;exposure_sequence:string;exposure_client_id:string;exposure_payload:unknown;exposure_causation_id:string|null;
 exposure_id:string;exposure_client_id_row:string;decision_id:string;asset_id:string;
 decision_account_revision:number;decision_policy_version:string;decision_candidates:unknown;decision_privacy_epoch:number;
 asset_revision:number;asset_kind:string;asset_title:string;asset_summary:string;asset_body:string;asset_source_title:string;asset_source_url:string;asset_truth_state:string;
};
type SessionRow={id:string;device_id:string;universe_id:string;privacy_epoch:number;expires_at:Date;revoked_at:Date|null};
type SealedRow={canonical_payload:string;content_hash:string;metadata_content_hash:string;read_set_hash:string;universe_id:string;privacy_epoch:number;job_id:string;policy_version:string;source_policy_version:string};
type DependencyRow={identity:string;canonical_dependency:string;universe_id:string;privacy_epoch:number};
function deny(reason:ContextRefusal):never { throw new ReasoningDenied(`context_${reason}`); }

function canonical(value:unknown):string {
  if(value===null || typeof value==='boolean' || typeof value==='number' || typeof value==='string') return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if(typeof value==='object') {
    const record=value as Record<string,unknown>;
    return `{${Object.keys(record).sort().map(key=>`${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  throw new Error('Canonical context values must be JSON data');
}

function digest(value:string):string { return createHash('sha256').update(value,'utf8').digest('hex'); }

function canonicalHash(value:unknown):string { return digest(canonical(value)); }

function codepointCompare(left:string,right:string):number { return left<right?-1:left>right?1:0; }

function asIso(value:Date | string):string {
  const date=value instanceof Date?value:new Date(value);
  if(!Number.isFinite(date.getTime())) throw new Error('Invalid stored timestamp');
  return date.toISOString();
}

function dependencyIdentity(read:AskContextDependency):string { return askContextDependencyKey(read); }

function sortDependencies(reads:AskContextDependency[]):AskContextDependency[] {
  const unique=new Map<string,AskContextDependency>();
  for(const read of reads) {
    const identity=dependencyIdentity(read);
    const existing=unique.get(identity);
    if(existing && canonical(existing)!==canonical(read)) throw new Error('Conflicting typed dependency');
    unique.set(identity,read);
  }
  return [...unique.values()].sort((left,right)=>codepointCompare(dependencyIdentity(left),dependencyIdentity(right)));
}

function policyDigest(policy:unknown,scope:ReasoningScope):{version:string;hash:string} {
  const resolved=validateReasoningPolicy(policy,scope).policy;
  const canonicalPolicy={
    scope:{jobId:scope.jobId,privacyEpoch:scope.privacyEpoch,universeId:scope.universeId},
    policy:{
      ...resolved,
      requiredDimensions:[...resolved.requiredDimensions].sort(),
      buckets:[...resolved.buckets].sort((left,right)=>codepointCompare(left.bucketId,right.bucketId)),
    },
  };
  return {version:resolved.policyVersion,hash:canonicalHash(canonicalPolicy)};
}

function scrollFromRow(row:LineageRow):unknown {
  return {
    assetId:row.asset_id,revision:row.asset_revision,kind:row.asset_kind,
    title:row.asset_title,summary:row.asset_summary,body:row.asset_body,
    sourceTitle:row.asset_source_title,sourceUrl:row.asset_source_url,truthState:row.asset_truth_state,
  };
}

function selectedCandidate(row:LineageRow):{ok:true;asset:AskContextPayload['asset']}|{ok:false;reason:ContextRefusal} {
  const candidates=Array.isArray(row.decision_candidates)?row.decision_candidates:[];
  const matched=candidates.filter(candidate=>typeof candidate==='object' && candidate!==null
    && typeof (candidate as Record<string,unknown>).assetId==='string'
    && String((candidate as Record<string,unknown>).assetId).toLowerCase()===row.asset_id);
  if(matched.length!==1) return {ok:false,reason:'stale_lineage'};
  const candidate=contextScroll.safeParse({...record(matched[0])!,assetId:row.asset_id});
  if(!candidate.success) return {ok:false,reason:'stale_lineage'};
  const current=contextScroll.safeParse(scrollFromRow(row));
  if(!current.success) return {ok:false,reason:'stale_asset'};
  if(canonical(candidate.data)!==canonical(current.data)) return {ok:false,reason:'stale_asset'};
  return {ok:true,asset:current.data};
}

async function lockUniverse(client:pg.PoolClient,universeId:string,epoch:number):Promise<void> {
  const row=(await client.query<{privacy_epoch:number}>('SELECT privacy_epoch FROM universe WHERE id=$1 FOR UPDATE',[universeId])).rows[0];
  if(!row) deny('foreign');
  if(row.privacy_epoch!==epoch) deny('obsolete_epoch');
}

async function currentSession(client:pg.PoolClient,scope:{sessionId:string;deviceId?:string;universeId:string;privacyEpoch:number},lock:boolean):Promise<SessionRow|null> {
  const query=`SELECT id,device_id,universe_id,privacy_epoch,expires_at,revoked_at FROM device_session
    WHERE id=$1 AND universe_id=$2 AND privacy_epoch=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp()${lock?' FOR UPDATE':''}`;
  const row=(await client.query<SessionRow>(query,[scope.sessionId,scope.universeId,scope.privacyEpoch])).rows[0]??null;
  if(row && scope.deviceId!==undefined && row.device_id!==scope.deviceId) return null;
  return row;
}

async function lockAssets(client:pg.PoolClient,assetIds:string[]):Promise<void> {
  const sorted=[...new Set(assetIds)].sort(codepointCompare);
  const rows=await client.query<{id:string}>('SELECT id FROM asset WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',[sorted]);
  if(rows.rowCount!==sorted.length) deny('stale_asset');
}

function record(value:unknown):Record<string,unknown>|null {
  return typeof value==='object' && value!==null && !Array.isArray(value)?value as Record<string,unknown>:null;
}

async function highWater(client:pg.PoolClient,universeId:string,epoch:number):Promise<string> {
  const row=(await client.query<{watermark:string}>('SELECT COALESCE(MAX(seq),0)::text AS watermark FROM ledger WHERE universe_id=$1 AND privacy_epoch=$2',[universeId,epoch])).rows[0];
  return row?.watermark??'0';
}

async function lockDirectJob(client:pg.PoolClient,scope:AuthScope,jobId:string,lock=true):Promise<{intentId:string;policyVersion:string}|null> {
  const row=(await client.query<{intent_id:string | null;policy_version:string}>(
    `SELECT intent_id,policy_version FROM reasoning_job WHERE id=$1 AND universe_id=$2 AND privacy_epoch=$3
      AND status='queued' AND wake_kind='direct' AND deadline>clock_timestamp()${lock?' FOR UPDATE':''}`,[jobId,scope.universeId,scope.privacyEpoch],
  )).rows[0];
  if(!row || !row.intent_id) return null;
  return {intentId:row.intent_id,policyVersion:row.policy_version};
}


async function readLineage(client:pg.PoolClient,universeId:string,epoch:number,askId:string):Promise<LineageRow|null> {
  const row=(await client.query<LineageRow>(`SELECT q.id AS ask_id,q.event_id AS ask_event_id,q.client_ask_id AS ask_client_id,q.session_id AS ask_session_id,
    k.seq::text AS ask_sequence,k.client_key AS ask_ledger_client_id,k.payload AS ask_payload,k.causation_id AS ask_causation_id,
    le.id AS exposure_event_id,le.seq::text AS exposure_sequence,le.client_key AS exposure_client_id,le.payload AS exposure_payload,le.causation_id AS exposure_causation_id,
    e.id AS exposure_id,e.client_key AS exposure_client_id_row,e.decision_id,e.asset_id,
    d.account_revision AS decision_account_revision,d.policy_version AS decision_policy_version,d.candidates AS decision_candidates,d.privacy_epoch AS decision_privacy_epoch,
    a.revision AS asset_revision,a.kind AS asset_kind,a.title AS asset_title,a.summary AS asset_summary,a.body AS asset_body,
    a.source_title AS asset_source_title,a.source_url AS asset_source_url,a.truth_state AS asset_truth_state
    FROM explicit_ask q
    JOIN ledger k ON k.id=q.event_id AND k.universe_id=q.universe_id AND k.privacy_epoch=q.privacy_epoch AND k.kind='ask'
    JOIN exposure e ON e.id=q.exposure_id AND e.universe_id=q.universe_id
    JOIN ledger le ON le.id=e.event_id AND le.universe_id=q.universe_id AND le.privacy_epoch=q.privacy_epoch AND le.kind='exposure'
    JOIN decision d ON d.id=e.decision_id AND d.universe_id=q.universe_id AND d.privacy_epoch=q.privacy_epoch
    JOIN asset a ON a.id=e.asset_id
    WHERE q.id=$1 AND q.universe_id=$2 AND q.privacy_epoch=$3`,[askId,universeId,epoch])).rows[0];
  return row&&validLineagePayloads(row,epoch)?row:null;
}

function validLineagePayloads(row:LineageRow,epoch:number):boolean {
  const ask=record(row.ask_payload);
  if(!ask || Object.keys(ask).length!==7 || ask.decisionId!==row.decision_id || ask.assetId!==row.asset_id
    || ask.sessionId!==row.ask_session_id || row.ask_causation_id!==row.exposure_event_id
    || row.ask_ledger_client_id!==explicitAskLedgerKey(row.ask_session_id,row.ask_client_id)) return false;
  const parsed=explicitAskInput.safeParse({clientAskId:ask.clientAskId,exposureId:ask.exposureId,expectedPrivacyEpoch:ask.expectedPrivacyEpoch,question:ask.question});
  if(!parsed.success || parsed.data.clientAskId!==row.ask_client_id || parsed.data.exposureId!==row.exposure_id || parsed.data.expectedPrivacyEpoch!==epoch) return false;
  const exposure=record(row.exposure_payload);
  if(!exposure || Object.keys(exposure).length!==4 || exposure.exposureId!==row.exposure_id) return false;
  const source=exposureInput.safeParse({decisionId:exposure.decisionId,assetId:exposure.assetId,clientExposureId:exposure.clientExposureId});
  return source.success && source.data.decisionId===row.decision_id && source.data.assetId===row.asset_id
    && source.data.clientExposureId===row.exposure_client_id && row.exposure_client_id===row.exposure_client_id_row;
}

function lineagePayload(row:LineageRow,scope:{universeId:string;privacyEpoch:number;jobId:string}):{fact:AskContextPayload['fact'];asset:AskContextPayload['asset'];dependencies:AskContextDependency[]}|{reason:ContextRefusal} {
  const selected=selectedCandidate(row);
  if(!selected.ok) return selected;
  const {universeId,privacyEpoch,jobId}=scope;
  const ask=record(row.ask_payload)!;
  const asset=selected.asset;
  const fact={askId:row.ask_id,askEventId:row.ask_event_id,askSequence:row.ask_sequence,askClientId:row.ask_client_id,question:ask.question as string,
    exposureEventId:row.exposure_event_id,exposureSequence:row.exposure_sequence,exposureClientId:row.exposure_client_id,
    exposureId:row.exposure_id,decisionId:row.decision_id,decisionPolicyVersion:row.decision_policy_version,decisionAccountRevision:row.decision_account_revision,assetId:row.asset_id};
  const binding={id:row.ask_id,universeId,privacyEpoch,jobId,eventId:row.ask_event_id,sessionId:row.ask_session_id,exposureId:row.exposure_id,clientAskId:row.ask_client_id};
  const hashScope={universeId,privacyEpoch};
  const dependencies:AskContextDependency[]=[
    {kind:'ask',id:row.ask_event_id,...hashScope,sequence:row.ask_sequence,hash:canonicalHash({id:row.ask_event_id,...hashScope,sequence:row.ask_sequence,clientId:row.ask_ledger_client_id,causationId:row.ask_causation_id,payload:row.ask_payload})},
    {kind:'ask_binding',...binding,hash:canonicalHash(binding)},
    {kind:'exposure_event',id:row.exposure_event_id,...hashScope,sequence:row.exposure_sequence,hash:canonicalHash({id:row.exposure_event_id,...hashScope,sequence:row.exposure_sequence,clientId:row.exposure_client_id,causationId:row.exposure_causation_id,payload:row.exposure_payload})},
    {kind:'exposure',id:row.exposure_id,...hashScope,assetId:row.asset_id,hash:canonicalHash({id:row.exposure_id,...hashScope,assetId:row.asset_id,clientId:row.exposure_client_id_row,decisionId:row.decision_id,eventId:row.exposure_event_id})},
    {kind:'decision_candidate',id:row.decision_id,...hashScope,assetId:row.asset_id,hash:canonicalHash({decisionId:row.decision_id,...hashScope,accountRevision:row.decision_account_revision,policyVersion:row.decision_policy_version,asset})},
    {kind:'asset',id:asset.assetId,revision:asset.revision,hash:canonicalHash(asset)},
  ];
  return {fact,asset,dependencies:sortDependencies(dependencies)};
}

export async function compileDirectAskContext(client:pg.PoolClient,authenticatedScope:AuthScope,input:unknown,resolvePolicy:PolicyResolver):Promise<ContextResult> {
  const parsed=compileDirectAskContextInput.safeParse(input);
  if(!parsed.success) deny('malformed');
  const request=parsed.data;
  await lockUniverse(client,authenticatedScope.universeId,authenticatedScope.privacyEpoch);
  const session=await currentSession(client,authenticatedScope,true);
  if(!session) deny('inactive_session');
  const job=await lockDirectJob(client,authenticatedScope,request.jobId);
  if(!job) {
    const existing=(await client.query<{universe_id:string;privacy_epoch:number}>('SELECT universe_id,privacy_epoch FROM reasoning_job WHERE id=$1',[request.jobId])).rows[0];
    if(existing && (existing.universe_id!==authenticatedScope.universeId || existing.privacy_epoch!==authenticatedScope.privacyEpoch)) deny('foreign');
    deny('unsupported');
  }
  if(job.intentId!==request.askId) deny('stale_lineage');
  const binding=(await client.query<{session_id:string}>('SELECT session_id FROM reasoning_context_job_session WHERE job_id=$1',[request.jobId])).rows[0];
  if(binding && binding.session_id!==session.id) deny('inactive_session');
  const askBinding=(await client.query<{ask_id:string;session_id:string}>('SELECT ask_id,session_id FROM reasoning_context_job_ask WHERE job_id=$1',[request.jobId])).rows[0];
  if(askBinding && (askBinding.ask_id!==request.askId || askBinding.session_id!==session.id)) deny('stale_lineage');
  const initial=await readLineage(client,authenticatedScope.universeId,authenticatedScope.privacyEpoch,request.askId);
  if(!initial) deny('stale_lineage');
  if(initial.ask_session_id!==session.id) deny('inactive_session');
  await lockAssets(client,[initial.asset_id]);
  const rows=await readLineage(client,authenticatedScope.universeId,authenticatedScope.privacyEpoch,request.askId);
  if(!rows || rows.asset_id!==initial.asset_id || rows.ask_session_id!==session.id) deny('stale_lineage');
  const scope={universeId:authenticatedScope.universeId,privacyEpoch:authenticatedScope.privacyEpoch,jobId:request.jobId};
  const lineage=lineagePayload(rows,scope);
  if('reason' in lineage) deny(lineage.reason);
  const policy=policyDigest(await resolvePolicy(client,scope),scope);
  const currentJob=await lockDirectJob(client,authenticatedScope,request.jobId,false);
  if(!currentJob || currentJob.intentId!==request.askId) deny('stale_lineage');
  if(policy.version!==currentJob.policyVersion) deny('changed_policy');
  const current=await currentSession(client,authenticatedScope,false);
  if(!current || asIso(current.expires_at)!==asIso(session.expires_at)) deny('inactive_session');
  const dependencies=sortDependencies([...lineage.dependencies,
    {kind:'session',id:current.id,universeId:current.universe_id,privacyEpoch:current.privacy_epoch,expiresAt:asIso(current.expires_at)},
    {kind:'runtime_policy',version:policy.version,hash:policy.hash},
  ]);
  const payload=askContextPayload.safeParse({version:1,kind:'direct_ask_evidence_v1',contextId:request.contextId,jobId:request.jobId,intentId:request.askId,
    universeId:scope.universeId,privacyEpoch:scope.privacyEpoch,sessionId:current.id,sessionExpiresAt:asIso(current.expires_at),
    compilerVersion:ASK_CONTEXT_VERSIONS.compiler,promptVersion:ASK_CONTEXT_VERSIONS.prompt,sourcePolicyVersion:ASK_CONTEXT_VERSIONS.sourcePolicy,
    runtimePolicyVersion:policy.version,runtimePolicyHash:policy.hash,eventHighWater:await highWater(client,scope.universeId,scope.privacyEpoch),selection:'explicit_ask_id',
    fact:lineage.fact,asset:lineage.asset,dependencies});
  if(!payload.success) deny('malformed');
  const canonicalPayload=canonical(payload.data);
  if(Buffer.byteLength(canonicalPayload,'utf8')>ASK_CONTEXT_LIMITS.maxBytes) deny('bounds_exceeded');
  const contentHash=digest(canonicalPayload);
  const canonicalDependencies=dependencies.map(read=>({identity:dependencyIdentity(read),value:canonical(read)}));
  const readSetHash=digest(canonical(canonicalDependencies));
  if(!binding) await client.query('INSERT INTO reasoning_context_job_session(job_id,universe_id,privacy_epoch,session_id) VALUES($1,$2,$3,$4)',[request.jobId,scope.universeId,scope.privacyEpoch,current.id]);
  if(!askBinding) await client.query('INSERT INTO reasoning_context_job_ask(job_id,universe_id,privacy_epoch,session_id,ask_id) VALUES($1,$2,$3,$4,$5)',[request.jobId,scope.universeId,scope.privacyEpoch,current.id,request.askId]);
  await client.query('INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version) VALUES($1,$2,$3,$4,$5,$6,$7)',[request.contextId,request.jobId,scope.universeId,scope.privacyEpoch,contentHash,policy.version,ASK_CONTEXT_VERSIONS.sourcePolicy]);
  for(const dependency of canonicalDependencies) await client.query('INSERT INTO reasoning_context_dependency(context_id,universe_id,privacy_epoch,identity,canonical_dependency) VALUES($1,$2,$3,$4,$5)',[request.contextId,scope.universeId,scope.privacyEpoch,dependency.identity,dependency.value]);
  await client.query('INSERT INTO reasoning_context_payload(context_id,universe_id,privacy_epoch,canonical_payload,content_hash,read_set_hash) VALUES($1,$2,$3,$4,$5,$6)',[request.contextId,scope.universeId,scope.privacyEpoch,canonicalPayload,contentHash,readSetHash]);
  return {contextId:request.contextId,contentHash,readSetHash};
}

async function loadSealed(client:pg.PoolClient,scope:ReasoningContextCheck):Promise<{payload:AskContextPayload;sealed:SealedRow;dependencies:AskContextDependency[]}|{reason:ContextRefusal}> {
  const sealed=(await client.query<SealedRow>(
    `SELECT p.canonical_payload,p.content_hash,p.read_set_hash,p.universe_id,p.privacy_epoch,c.job_id,c.content_hash AS metadata_content_hash,c.policy_version,c.source_policy_version
     FROM reasoning_context_payload p JOIN reasoning_context c ON c.id=p.context_id AND c.universe_id=p.universe_id AND c.privacy_epoch=p.privacy_epoch
     WHERE p.context_id=$1 AND p.universe_id=$2 AND p.privacy_epoch=$3`,[scope.contextId,scope.universeId,scope.privacyEpoch],
  )).rows[0];
  if(!sealed) return {reason:'missing'};
  if(sealed.job_id!==scope.jobId) return {reason:'foreign'};
  const step=(await client.query<{id:string}>(
    'SELECT id FROM reasoning_step WHERE id=$1 AND job_id=$2 AND context_id=$3 AND universe_id=$4 AND privacy_epoch=$5',
    [scope.stepId,scope.jobId,scope.contextId,scope.universeId,scope.privacyEpoch],
  )).rows[0];
  if(!step) return {reason:'foreign'};
  const reads=(await client.query<{present:boolean}>('SELECT EXISTS(SELECT 1 FROM reasoning_context_read WHERE context_id=$1) AS present',[scope.contextId])).rows[0];
  if(reads?.present) return {reason:'unsupported'};
  let payloadValue:unknown;
  try { payloadValue=JSON.parse(sealed.canonical_payload); } catch { return {reason:'corrupt_seal'}; }
  const payload=askContextPayload.safeParse(payloadValue);
  if(!payload.success || canonical(payload.data)!==sealed.canonical_payload || digest(sealed.canonical_payload)!==sealed.content_hash || sealed.content_hash!==sealed.metadata_content_hash) return {reason:'corrupt_seal'};
  if(payload.data.contextId!==scope.contextId || payload.data.jobId!==scope.jobId || payload.data.universeId!==scope.universeId || payload.data.privacyEpoch!==scope.privacyEpoch
    || sealed.policy_version!==payload.data.runtimePolicyVersion || sealed.source_policy_version!==ASK_CONTEXT_VERSIONS.sourcePolicy) return {reason:'corrupt_seal'};
  const rows=(await client.query<DependencyRow>(
    `SELECT identity,canonical_dependency,universe_id,privacy_epoch FROM reasoning_context_dependency
      WHERE context_id=$1 ORDER BY identity`,[scope.contextId],
  )).rows;
  let dependencies:AskContextDependency[];
  try {
    dependencies=sortDependencies(rows.map(row=>{
      const parsed=askContextDependency.parse(JSON.parse(row.canonical_dependency));
      if(canonical(parsed)!==row.canonical_dependency || dependencyIdentity(parsed)!==row.identity
        || row.universe_id!==scope.universeId || row.privacy_epoch!==scope.privacyEpoch) throw new Error('bad dependency');
      return parsed;
    }));
  } catch { return {reason:'corrupt_seal'}; }
  const expected=sortDependencies(payload.data.dependencies);
  if(expected.length!==dependencies.length || canonical(expected)!==canonical(dependencies)
    || digest(canonical(dependencies.map(read=>({identity:dependencyIdentity(read),value:canonical(read)}))))!==sealed.read_set_hash) return {reason:'corrupt_seal'};
  return {payload:payload.data,sealed,dependencies};
}

export async function validateDirectAskContext(client:pg.PoolClient,scope:ReasoningContextCheck,resolvePolicy:PolicyResolver,phase:'lock'|'recheck'):Promise<ContextValidation> {
  if(phase!=='lock'&&phase!=='recheck') deny('malformed');
  const universe=(await client.query<{privacy_epoch:number}>('SELECT privacy_epoch FROM universe WHERE id=$1',[scope.universeId])).rows[0];
  if(!universe) return {valid:false,reason:'foreign'};
  if(universe.privacy_epoch!==scope.privacyEpoch) return {valid:false,reason:'obsolete_epoch'};
  const sealed=await loadSealed(client,scope);
  if('reason' in sealed) return {valid:false,reason:sealed.reason};
  const {payload}=sealed;
  if(payload.runtimePolicyVersion!==scope.policyVersion) return {valid:false,reason:'unsupported'};
  const job=(await client.query<{intent_id:string|null;policy_version:string;wake_kind:string;live:boolean}>(
    'SELECT intent_id,policy_version,wake_kind,deadline>clock_timestamp() AS live FROM reasoning_job WHERE id=$1 AND universe_id=$2 AND privacy_epoch=$3',[scope.jobId,scope.universeId,scope.privacyEpoch])).rows[0];
  if(!job || job.wake_kind!=='direct' || job.intent_id!==payload.intentId) return {valid:false,reason:'stale_lineage'};
  if(!job.live) return {valid:false,reason:'unsupported'};
  if(job.policy_version!==scope.policyVersion) return {valid:false,reason:'changed_policy'};
  const binding=(await client.query<{session_id:string;ask_id:string}>(`SELECT s.session_id,a.ask_id FROM reasoning_context_job_session s
    JOIN reasoning_context_job_ask a ON a.job_id=s.job_id AND a.universe_id=s.universe_id AND a.privacy_epoch=s.privacy_epoch AND a.session_id=s.session_id
    WHERE s.job_id=$1 AND s.universe_id=$2 AND s.privacy_epoch=$3`,[scope.jobId,scope.universeId,scope.privacyEpoch])).rows[0];
  if(!binding || binding.session_id!==payload.sessionId || binding.ask_id!==payload.fact.askId) return {valid:false,reason:'corrupt_seal'};
  const session=await currentSession(client,{sessionId:payload.sessionId,universeId:scope.universeId,privacyEpoch:scope.privacyEpoch},false);
  if(!session || asIso(session.expires_at)!==payload.sessionExpiresAt) return {valid:false,reason:'inactive_session'};
  // The caller already holds universe -> original session -> Job. Only source
  // assets may be acquired at this phase; post-resource recheck takes no locks.
  if(phase==='lock') await lockAssets(client,[payload.asset.assetId]);
  let policy:{version:string;hash:string};
  try { policy=policyDigest(await resolvePolicy(client,{universeId:scope.universeId,privacyEpoch:scope.privacyEpoch,jobId:scope.jobId}),scope); }
  catch(error) { if(error instanceof ReasoningDenied) return {valid:false,reason:'changed_policy'}; throw error; }
  if(policy.version!==scope.policyVersion || policy.hash!==payload.runtimePolicyHash) return {valid:false,reason:'changed_policy'};
  const row=await readLineage(client,scope.universeId,scope.privacyEpoch,payload.fact.askId);
  if(!row || row.ask_session_id!==payload.sessionId) return {valid:false,reason:'stale_lineage'};
  const lineage=lineagePayload(row,scope);
  if('reason' in lineage) return {valid:false,reason:lineage.reason};
  if(canonical(payload.asset)!==canonical(lineage.asset)) return {valid:false,reason:'stale_asset'};
  const expected=sortDependencies([...lineage.dependencies,
    {kind:'session',id:session.id,universeId:session.universe_id,privacyEpoch:session.privacy_epoch,expiresAt:asIso(session.expires_at)},
    {kind:'runtime_policy',version:policy.version,hash:policy.hash},
  ]);
  if(canonical(payload.fact)!==canonical(lineage.fact) || canonical(payload.dependencies)!==canonical(expected)) return {valid:false,reason:'stale_lineage'};
  const current=await currentSession(client,{sessionId:payload.sessionId,universeId:scope.universeId,privacyEpoch:scope.privacyEpoch},false);
  if(!current || asIso(current.expires_at)!==payload.sessionExpiresAt) return {valid:false,reason:'inactive_session'};
  const currentJob=(await client.query<{live:boolean}>('SELECT deadline>clock_timestamp() AS live FROM reasoning_job WHERE id=$1',[scope.jobId])).rows[0];
  if(!currentJob?.live) return {valid:false,reason:'unsupported'};
  return {valid:true,contentHash:sealed.sealed.content_hash,readSetHash:sealed.sealed.read_set_hash};
}
