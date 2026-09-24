import {createHash} from 'node:crypto';
import type pg from 'pg';

import {
  DIRECT_CONTEXT_LIMITS,
  DIRECT_CONTEXT_VERSIONS,
  compileDirectContextInput,
  candidateScroll,
  contextScroll,
  directContextDependency,
  directContextDependencyKey,
  directContextPayload,
  type ContextRefusal,
  type ContextValidation,
  type DirectContextDependency,
  type DirectContextPayload,
} from '../../contracts/src/reasoning-context.ts';
import {exposureInput, interactionInput} from '../../contracts/src/index.ts';
import type {AuthScope} from './identity.ts';
import {
  ReasoningDenied,
  validateReasoningPolicy,
  type ReasoningAuthority,
  type ReasoningContextCheck,
  type ReasoningScope,
} from './reasoning-runtime-policy.js';

type PolicyResolver=ReasoningAuthority['resolvePolicy'];
type CompileInput={contextId:string;jobId:string;keepEventIds:string[]};
type ContextResult={contextId:string;contentHash:string;readSetHash:string};
type LineageRow={
  keep_id:string; keep_sequence:string; keep_client_id:string; keep_payload:unknown; keep_causation_id:string | null;
  exposure_event_id:string; exposure_sequence:string; exposure_client_id:string; exposure_payload:unknown;
  exposure_id:string; exposure_client_id_row:string; decision_id:string; asset_id:string;
  decision_account_revision:number; decision_policy_version:string; decision_candidates:unknown; decision_privacy_epoch:number;
  asset_revision:number; asset_kind:string; asset_title:string; asset_summary:string; asset_body:string;
  asset_source_title:string; asset_source_url:string; asset_truth_state:string;
};
type SessionRow={id:string;device_id:string;universe_id:string;privacy_epoch:number;expires_at:Date;revoked_at:Date | null};
type SealedRow={
  canonical_payload:string; content_hash:string; read_set_hash:string; universe_id:string; privacy_epoch:number;
  job_id:string; policy_version:string; source_policy_version:string;
};
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

function dependencyIdentity(read:DirectContextDependency):string { return directContextDependencyKey(read); }

function sortDependencies(reads:DirectContextDependency[]):DirectContextDependency[] {
  const unique=new Map<string,DirectContextDependency>();
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

function selectedCandidate(row:LineageRow):{ok:true;asset:DirectContextPayload['assets'][number]}|{ok:false;reason:ContextRefusal} {
  const candidates=Array.isArray(row.decision_candidates)?row.decision_candidates:[];
  const matched=candidates.filter(candidate=>typeof candidate==='object' && candidate!==null
    && (candidate as Record<string,unknown>).assetId===row.asset_id);
  if(matched.length!==1) return {ok:false,reason:'stale_lineage'};
  const candidate=contextScroll.safeParse(candidateScroll(matched[0] as Record<string,unknown>));
  if(!candidate.success) return {ok:false,reason:'stale_lineage'};
  const current=contextScroll.safeParse(scrollFromRow(row));
  if(!current.success) return {ok:false,reason:'stale_asset'};
  if(canonical(candidate.data)!==canonical(current.data)) return {ok:false,reason:'stale_asset'};
  return {ok:true,asset:current.data};
}

function rowDependencies(row:LineageRow,universeId:string,epoch:number,asset:DirectContextPayload['assets'][number]):DirectContextDependency[] {
  const keepHash=canonicalHash({
    causationId:row.keep_causation_id,clientId:row.keep_client_id,id:row.keep_id,payload:row.keep_payload,
    privacyEpoch:epoch,sequence:row.keep_sequence,universeId,
  });
  const exposureEventHash=canonicalHash({
    clientId:row.exposure_client_id,id:row.exposure_event_id,payload:row.exposure_payload,
    privacyEpoch:epoch,sequence:row.exposure_sequence,universeId,
  });
  const exposureHash=canonicalHash({assetId:row.asset_id,clientId:row.exposure_client_id_row,decisionId:row.decision_id,id:row.exposure_id,eventId:row.exposure_event_id,privacyEpoch:epoch,universeId});
  const candidate=contextScroll.parse((Array.isArray(row.decision_candidates)?row.decision_candidates:[])
    .find(value=>typeof value==='object' && value!==null && (value as Record<string,unknown>).assetId===row.asset_id));
  const candidateHash=canonicalHash({
    accountRevision:row.decision_account_revision,asset:candidate,decisionId:row.decision_id,
    policyVersion:row.decision_policy_version,privacyEpoch:epoch,universeId,
  });
  return [
    {kind:'keep',id:row.keep_id,universeId,privacyEpoch:epoch,sequence:row.keep_sequence,hash:keepHash},
    {kind:'exposure_event',id:row.exposure_event_id,universeId,privacyEpoch:epoch,sequence:row.exposure_sequence,hash:exposureEventHash},
    {kind:'exposure',id:row.exposure_id,universeId,privacyEpoch:epoch,assetId:row.asset_id,hash:exposureHash},
    {kind:'decision_candidate',id:row.decision_id,universeId,privacyEpoch:epoch,assetId:row.asset_id,hash:candidateHash},
    {kind:'asset',id:asset.assetId,revision:asset.revision,hash:canonicalHash(asset)},
  ] as DirectContextDependency[];
}

function factFromRow(row:LineageRow):DirectContextPayload['facts'][number] {
  return {
    keepEventId:row.keep_id,keepSequence:row.keep_sequence,keepClientId:row.keep_client_id,
    exposureEventId:row.exposure_event_id,exposureSequence:row.exposure_sequence,exposureClientId:row.exposure_client_id,
    exposureId:row.exposure_id,decisionId:row.decision_id,decisionPolicyVersion:row.decision_policy_version,
    decisionAccountRevision:row.decision_account_revision,assetId:row.asset_id,
  };
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

async function readLineage(client:pg.PoolClient,universeId:string,epoch:number,keepIds:string[]):Promise<LineageRow[]|null> {
  const rows=(await client.query<LineageRow>(
    `SELECT k.id AS keep_id,k.seq::text AS keep_sequence,k.client_key AS keep_client_id,k.payload AS keep_payload,k.causation_id AS keep_causation_id,
      le.id AS exposure_event_id,le.seq::text AS exposure_sequence,le.client_key AS exposure_client_id,le.payload AS exposure_payload,
      e.id AS exposure_id,e.client_key AS exposure_client_id_row,e.decision_id,e.asset_id,
      d.account_revision AS decision_account_revision,d.policy_version AS decision_policy_version,d.candidates AS decision_candidates,d.privacy_epoch AS decision_privacy_epoch,
      a.revision AS asset_revision,a.kind AS asset_kind,a.title AS asset_title,a.summary AS asset_summary,a.body AS asset_body,
      a.source_title AS asset_source_title,a.source_url AS asset_source_url,a.truth_state AS asset_truth_state
     FROM ledger k
     JOIN ledger le ON le.id=k.causation_id AND le.universe_id=k.universe_id
     JOIN exposure e ON e.event_id=le.id AND e.universe_id=k.universe_id
     JOIN decision d ON d.id=e.decision_id AND d.universe_id=k.universe_id
     JOIN asset a ON a.id=e.asset_id
     WHERE k.id=ANY($1::uuid[]) AND k.universe_id=$2 AND k.privacy_epoch=$3 AND k.kind='keep'
       AND le.kind='exposure' AND le.privacy_epoch=$3 AND d.privacy_epoch=$3
       AND k.payload->>'exposureId'=e.id::text AND k.payload->>'assetId'=e.asset_id::text
       AND le.payload->>'exposureId'=e.id::text AND le.payload->>'assetId'=e.asset_id::text
     ORDER BY k.seq,k.id`,[keepIds,universeId,epoch],
  )).rows;
  if(rows.length!==keepIds.length || new Set(rows.map(row=>row.keep_id)).size!==keepIds.length || rows.some(row=>!validLineagePayloads(row))) return null;
  return rows;
}

function record(value:unknown):Record<string,unknown>|null {
  return typeof value==='object' && value!==null && !Array.isArray(value)?value as Record<string,unknown>:null;
}

function validLineagePayloads(row:LineageRow):boolean {
  const keep=interactionInput.safeParse(row.keep_payload);
  if(!keep.success || keep.data.kind!=='keep' || keep.data.clientEventId!==row.keep_client_id
    || keep.data.exposureId!==row.exposure_id || keep.data.assetId!==row.asset_id) return false;
  const exposure=record(row.exposure_payload);
  if(!exposure || Object.keys(exposure).length!==4 || exposure.exposureId!==row.exposure_id) return false;
  const parsed=exposureInput.safeParse({decisionId:exposure.decisionId,assetId:exposure.assetId,clientExposureId:exposure.clientExposureId});
  return parsed.success && parsed.data.decisionId===row.decision_id && parsed.data.assetId===row.asset_id
    && parsed.data.clientExposureId===row.exposure_client_id && row.exposure_client_id===row.exposure_client_id_row;
}

function lineagePayload(rows:LineageRow[],universeId:string,epoch:number):{facts:DirectContextPayload['facts'];assets:DirectContextPayload['assets'];dependencies:DirectContextDependency[]}|{reason:ContextRefusal} {
  const facts:DirectContextPayload['facts']=[];
  const assets=new Map<string,DirectContextPayload['assets'][number]>();
  const dependencies:DirectContextDependency[]=[];
  for(const row of rows) {
    if(row.decision_privacy_epoch!==epoch) return {reason:'stale_lineage'};
    const candidate=selectedCandidate(row);
    if(!candidate.ok) return candidate;
    facts.push(factFromRow(row));
    assets.set(candidate.asset.assetId,candidate.asset);
    dependencies.push(...rowDependencies(row,universeId,epoch,candidate.asset));
  }
  return {
    facts:facts.sort((left,right)=>BigInt(left.keepSequence)===BigInt(right.keepSequence)?codepointCompare(left.keepEventId,right.keepEventId):BigInt(left.keepSequence)<BigInt(right.keepSequence)?-1:1),
    assets:[...assets.values()].sort((left,right)=>codepointCompare(left.assetId,right.assetId)),
    dependencies:sortDependencies(dependencies),
  };
}

async function highWater(client:pg.PoolClient,universeId:string,epoch:number):Promise<string> {
  const row=(await client.query<{watermark:string}>('SELECT COALESCE(MAX(seq),0)::text AS watermark FROM ledger WHERE universe_id=$1 AND privacy_epoch=$2',[universeId,epoch])).rows[0];
  return row?.watermark??'0';
}

async function lockDirectJob(client:pg.PoolClient,scope:AuthScope,jobId:string):Promise<{intentId:string;policyVersion:string}|null> {
  const row=(await client.query<{intent_id:string | null;policy_version:string}>(
    `SELECT intent_id,policy_version FROM reasoning_job WHERE id=$1 AND universe_id=$2 AND privacy_epoch=$3
      AND status='queued' AND wake_kind='direct' AND deadline>clock_timestamp() FOR UPDATE`,[jobId,scope.universeId,scope.privacyEpoch],
  )).rows[0];
  if(!row || !row.intent_id) return null;
  return {intentId:row.intent_id,policyVersion:row.policy_version};
}

function parseInput(input:unknown):CompileInput {
  const parsed=compileDirectContextInput.safeParse(input);
  if(!parsed.success) deny('malformed');
  return parsed.data;
}

export async function compileDirectContext(
  client:pg.PoolClient,
  authenticatedScope:AuthScope,
  input:unknown,
  resolvePolicy:PolicyResolver,
):Promise<ContextResult> {
  const request=parseInput(input);
  await lockUniverse(client,authenticatedScope.universeId,authenticatedScope.privacyEpoch);
  const session=await currentSession(client,authenticatedScope,true);
  if(!session) deny('inactive_session');
  const job=await lockDirectJob(client,authenticatedScope,request.jobId);
  if(!job) {
    const existing=(await client.query<{universe_id:string;privacy_epoch:number}>('SELECT universe_id,privacy_epoch FROM reasoning_job WHERE id=$1',[request.jobId])).rows[0];
    if(existing && (existing.universe_id!==authenticatedScope.universeId || existing.privacy_epoch!==authenticatedScope.privacyEpoch)) deny('foreign');
    deny('unsupported');
  }
  const binding=(await client.query<{session_id:string}>(
    'SELECT session_id FROM reasoning_context_job_session WHERE job_id=$1',[request.jobId],
  )).rows[0];
  if(binding && binding.session_id!==session.id) deny('inactive_session');
  const initial=await readLineage(client,authenticatedScope.universeId,authenticatedScope.privacyEpoch,request.keepEventIds);
  if(!initial) deny('stale_lineage');
  await lockAssets(client,initial.map(row=>row.asset_id));
  const rows=await readLineage(client,authenticatedScope.universeId,authenticatedScope.privacyEpoch,request.keepEventIds);
  if(!rows) deny('stale_lineage');
  const lineage=lineagePayload(rows,authenticatedScope.universeId,authenticatedScope.privacyEpoch);
  if('reason' in lineage) deny(lineage.reason);
  const policy=policyDigest(await resolvePolicy(client,{universeId:authenticatedScope.universeId,privacyEpoch:authenticatedScope.privacyEpoch,jobId:request.jobId}),{
    universeId:authenticatedScope.universeId,privacyEpoch:authenticatedScope.privacyEpoch,jobId:request.jobId,
  });
  const currentJob=await lockDirectJob(client,authenticatedScope,request.jobId);
  if(!currentJob || currentJob.intentId!==job.intentId) deny('stale_lineage');
  if(policy.version!==currentJob.policyVersion) deny('changed_policy');
  const current=await currentSession(client,authenticatedScope,true);
  if(!current || asIso(current.expires_at)!==asIso(session.expires_at)) deny('inactive_session');
  const dependencies=sortDependencies([
    ...lineage.dependencies,
    {kind:'session',id:current.id,universeId:current.universe_id,privacyEpoch:current.privacy_epoch,expiresAt:asIso(current.expires_at)},
    {kind:'runtime_policy',version:policy.version,hash:policy.hash},
  ]);
  if(dependencies.length>DIRECT_CONTEXT_LIMITS.maxDependencies) deny('bounds_exceeded');
  const payload=directContextPayload.safeParse({
    version:1,kind:'direct_scroll_evidence_v1',contextId:request.contextId,jobId:request.jobId,intentId:job.intentId,
    universeId:authenticatedScope.universeId,privacyEpoch:authenticatedScope.privacyEpoch,
    sessionId:current.id,sessionExpiresAt:asIso(current.expires_at),
    compilerVersion:DIRECT_CONTEXT_VERSIONS.compiler,promptVersion:DIRECT_CONTEXT_VERSIONS.prompt,
    sourcePolicyVersion:DIRECT_CONTEXT_VERSIONS.sourcePolicy,runtimePolicyVersion:policy.version,runtimePolicyHash:policy.hash,
    eventHighWater:await highWater(client,authenticatedScope.universeId,authenticatedScope.privacyEpoch),selection:'explicit_keep_ids',
    facts:lineage.facts,assets:lineage.assets,dependencies,
  });
  if(!payload.success) deny('malformed');
  const canonicalPayload=canonical(payload.data);
  if(Buffer.byteLength(canonicalPayload,'utf8')>DIRECT_CONTEXT_LIMITS.maxBytes) deny('bounds_exceeded');
  const contentHash=digest(canonicalPayload);
  const canonicalDependencies=payload.data.dependencies.map(read=>({identity:dependencyIdentity(read),value:canonical(read)}));
  const readSetHash=digest(canonical(canonicalDependencies));
  if(!binding) await client.query(
    `INSERT INTO reasoning_context_job_session(job_id,universe_id,privacy_epoch,session_id) VALUES($1,$2,$3,$4)`,
    [request.jobId,authenticatedScope.universeId,authenticatedScope.privacyEpoch,current.id],
  );
  await client.query(
    `INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [request.contextId,request.jobId,authenticatedScope.universeId,authenticatedScope.privacyEpoch,contentHash,policy.version,DIRECT_CONTEXT_VERSIONS.sourcePolicy],
  );
  for(const dependency of canonicalDependencies) {
    await client.query(
      `INSERT INTO reasoning_context_dependency(context_id,universe_id,privacy_epoch,identity,canonical_dependency)
       VALUES($1,$2,$3,$4,$5)`,
      [request.contextId,authenticatedScope.universeId,authenticatedScope.privacyEpoch,dependency.identity,dependency.value],
    );
  }
  await client.query(
    `INSERT INTO reasoning_context_payload(context_id,universe_id,privacy_epoch,canonical_payload,content_hash,read_set_hash)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [request.contextId,authenticatedScope.universeId,authenticatedScope.privacyEpoch,canonicalPayload,contentHash,readSetHash],
  );
  return {contextId:request.contextId,contentHash,readSetHash};
}

async function loadSealed(client:pg.PoolClient,scope:ReasoningContextCheck):Promise<{payload:DirectContextPayload;sealed:SealedRow;dependencies:DirectContextDependency[]}|{reason:ContextRefusal}> {
  const sealed=(await client.query<SealedRow>(
    `SELECT p.canonical_payload,p.content_hash,p.read_set_hash,p.universe_id,p.privacy_epoch,c.job_id,c.policy_version,c.source_policy_version
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
  const payload=directContextPayload.safeParse(payloadValue);
  if(!payload.success || canonical(payload.data)!==sealed.canonical_payload || digest(sealed.canonical_payload)!==sealed.content_hash) return {reason:'corrupt_seal'};
  if(payload.data.contextId!==scope.contextId || payload.data.jobId!==scope.jobId || payload.data.universeId!==scope.universeId || payload.data.privacyEpoch!==scope.privacyEpoch
    || sealed.policy_version!==payload.data.runtimePolicyVersion || sealed.source_policy_version!==DIRECT_CONTEXT_VERSIONS.sourcePolicy) return {reason:'corrupt_seal'};
  const rows=(await client.query<DependencyRow>(
    `SELECT identity,canonical_dependency,universe_id,privacy_epoch FROM reasoning_context_dependency
      WHERE context_id=$1 ORDER BY identity`,[scope.contextId],
  )).rows;
  let dependencies:DirectContextDependency[];
  try {
    dependencies=sortDependencies(rows.map(row=>{
      const parsed=directContextDependency.parse(JSON.parse(row.canonical_dependency));
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

function sameLineage(payload:DirectContextPayload,lineage:{facts:DirectContextPayload['facts'];assets:DirectContextPayload['assets'];dependencies:DirectContextDependency[]}):boolean {
  const payloadLineage=payload.dependencies.filter(read=>read.kind!=='session'&&read.kind!=='runtime_policy');
  return canonical(payload.facts)===canonical(lineage.facts)
    && canonical(payload.assets)===canonical(lineage.assets)
    && canonical(sortDependencies(payloadLineage))===canonical(lineage.dependencies);
}

function expectedDependencyIdentities(payload:DirectContextPayload):string[] {
  const identities=new Set<string>();
  for(const fact of payload.facts) {
    identities.add(`keep:${fact.keepEventId}`);
    identities.add(`exposure_event:${fact.exposureEventId}`);
    identities.add(`exposure:${fact.exposureId}`);
    identities.add(`decision_candidate:${fact.decisionId}:${fact.assetId}`);
  }
  for(const asset of payload.assets) identities.add(`asset:${asset.assetId}`);
  identities.add(`session:${payload.sessionId}`);
  identities.add(`runtime_policy:${payload.runtimePolicyVersion}`);
  return [...identities].sort(codepointCompare);
}

export async function validateDirectContext(
  client:pg.PoolClient,
  scope:ReasoningContextCheck,
  resolvePolicy:PolicyResolver,
  phase:'lock'|'recheck',
):Promise<ContextValidation> {
  if(phase!=='lock'&&phase!=='recheck') deny('malformed');
  const universe=(await client.query<{privacy_epoch:number}>('SELECT privacy_epoch FROM universe WHERE id=$1',[scope.universeId])).rows[0];
  if(!universe) return {valid:false,reason:'foreign'};
  if(universe.privacy_epoch!==scope.privacyEpoch) return {valid:false,reason:'obsolete_epoch'};
  const sealed=await loadSealed(client,scope);
  if('reason' in sealed) return {valid:false,reason:sealed.reason};
  const {payload}=sealed;
  if(payload.compilerVersion!==DIRECT_CONTEXT_VERSIONS.compiler || payload.promptVersion!==DIRECT_CONTEXT_VERSIONS.prompt
    || payload.sourcePolicyVersion!==DIRECT_CONTEXT_VERSIONS.sourcePolicy || payload.runtimePolicyVersion!==scope.policyVersion) return {valid:false,reason:'unsupported'};
  const job=(await client.query<{intent_id:string | null;policy_version:string;wake_kind:string}>(
    'SELECT intent_id,policy_version,wake_kind FROM reasoning_job WHERE id=$1 AND universe_id=$2 AND privacy_epoch=$3',
    [scope.jobId,scope.universeId,scope.privacyEpoch],
  )).rows[0];
  if(!job || job.wake_kind!=='direct' || job.intent_id!==payload.intentId) return {valid:false,reason:'stale_lineage'};
  if(job.policy_version!==scope.policyVersion) return {valid:false,reason:'changed_policy'};
  const binding=(await client.query<{session_id:string}>(
    'SELECT session_id FROM reasoning_context_job_session WHERE job_id=$1 AND universe_id=$2 AND privacy_epoch=$3',
    [scope.jobId,scope.universeId,scope.privacyEpoch],
  )).rows[0];
  if(!binding || binding.session_id!==payload.sessionId) return {valid:false,reason:'corrupt_seal'};
  const sessionDependency=payload.dependencies.find(read=>read.kind==='session');
  const policyDependency=payload.dependencies.find(read=>read.kind==='runtime_policy');
  if(!sessionDependency || !policyDependency) return {valid:false,reason:'corrupt_seal'};
  if(canonical(expectedDependencyIdentities(payload))!==canonical(payload.dependencies.map(dependencyIdentity).sort())) {
    return {valid:false,reason:'corrupt_seal'};
  }
  const session=await currentSession(client,{sessionId:sessionDependency.id,universeId:scope.universeId,privacyEpoch:scope.privacyEpoch},phase==='lock');
  if(!session || asIso(session.expires_at)!==sessionDependency.expiresAt || session.id!==payload.sessionId || payload.sessionExpiresAt!==sessionDependency.expiresAt) {
    return {valid:false,reason:'inactive_session'};
  }
  if(phase==='lock') await lockAssets(client,payload.assets.map(asset=>asset.assetId));
  let policy:{version:string;hash:string};
  try { policy=policyDigest(await resolvePolicy(client,{universeId:scope.universeId,privacyEpoch:scope.privacyEpoch,jobId:scope.jobId}),{
    universeId:scope.universeId,privacyEpoch:scope.privacyEpoch,jobId:scope.jobId,
  }); } catch(error) {
    if(error instanceof ReasoningDenied) return {valid:false,reason:'changed_policy'};
    throw error;
  }
  if(policy.version!==scope.policyVersion || policy.version!==payload.runtimePolicyVersion || policy.hash!==payload.runtimePolicyHash
    || policyDependency.version!==policy.version || policyDependency.hash!==policy.hash) return {valid:false,reason:'changed_policy'};
  const rows=await readLineage(client,scope.universeId,scope.privacyEpoch,payload.facts.map(fact=>fact.keepEventId));
  if(!rows) return {valid:false,reason:'stale_lineage'};
  const lineage=lineagePayload(rows,scope.universeId,scope.privacyEpoch);
  if('reason' in lineage) return {valid:false,reason:lineage.reason};
  if(!sameLineage(payload,lineage)) {
    const currentAssets=new Map(lineage.assets.map(asset=>[asset.assetId,asset]));
    return {valid:false,reason:payload.assets.some(asset=>canonical(asset)!==canonical(currentAssets.get(asset.assetId)))?'stale_asset':'stale_lineage'};
  }
  // Time can advance while waiting for assets or resolving policy; retained locks
  // prevent mutation, but do not prevent a session from expiring.
  if(!await currentSession(client,{sessionId:payload.sessionId,universeId:scope.universeId,privacyEpoch:scope.privacyEpoch},false))
    return {valid:false,reason:'inactive_session'};
  return {valid:true,contentHash:sealed.sealed.content_hash,readSetHash:sealed.sealed.read_set_hash};
}

export function createDirectContextAuthority(resolvePolicy:PolicyResolver):ReasoningAuthority {
  return {
    resolvePolicy,
    async validateContext(client,scope,phase) {
      const result=await validateDirectContext(client,scope,resolvePolicy,phase);
      if(!result.valid) throw new ReasoningDenied(`context_${result.reason}`);
      return true;
    },
  };
}
