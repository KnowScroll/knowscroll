/** ADR-0023 contract checks: the brief schema/compiler and migration 0013's own guards.
 * These are shared-contract checks, not the runtime or import proof (#94 lanes own those). */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {compileSubmitRequest,generationBrief,briefSource} from '../packages/contracts/src/generation.ts';
import {prepareCutroomRequest} from '../apps/worker/src/cutroom/http-client.ts';

const databaseUrl=process.env.DATABASE_URL??(()=>{throw new Error('DATABASE_URL required');})();
const databaseName=new URL(databaseUrl).pathname.slice(1);
if(!databaseName.startsWith('knowscroll_test_'))throw new Error(`Generation contract tests require a disposable knowscroll_test_* database, received ${databaseName}`);

const REVISION='86d6e2c8b74228db4a5a953e53c53a7b77cef46e';
const claim=(id:string,role:'main'|'supporting')=>({id,role});
const sentence=(text:string,claimIds:string[])=>({text,claimIds});

function brief(assetId:string) {
 return {
  version:1 as const,
  worldId:'library-world',
  narration:[
   sentence('A wax seal closes the charter.',['claim-seal']),
   sentence('The barons gather in the stone hall.',['claim-hall']),
   sentence('A king sets his hand to the page.',['claim-king']),
   sentence('The copy leaves for the shires.',['claim-seal']),
  ],
  claims:[claim('claim-seal','main'),claim('claim-hall','supporting'),claim('claim-king','supporting')],
  claimSources:[
   {claimId:'claim-seal',assetId,assetRevision:1},
   {claimId:'claim-hall',assetId,assetRevision:1},
   {claimId:'claim-king',assetId,assetRevision:1},
  ],
  criteria:{
   mustShow:[{id:'show-seal',text:'A wax seal.',type:'presence' as const,claimId:'claim-seal'}],
   mustNotShow:[{id:'never-flag',text:'A modern flag.',type:'presence' as const}],
   depictionPolicyVersion:'depiction-v1',
  },
  style:{id:'library',version:1,text:'Quiet, documentary, no captions burned in.'},
 };
}

test('a brief keeps its evidence lineage and compiles to a valid pinned request', () => {
 const assetId=randomUUID();
 const parsed=generationBrief.parse(brief(assetId));
 assert.deepEqual(briefSource(parsed),{assetId,assetRevision:1});

 const request=compileSubmitRequest({brief:parsed,requestId:`ks-gen-${randomUUID()}`,until:'video',budgetCents:220});
 const prepared=prepareCutroomRequest(request);
 assert.equal(prepared.until,'video');
 assert.equal(createHash('sha256').update(prepared.body).digest('hex'),prepared.bodySha256);
 // Evidence never crosses the wire: no source, asset or truth state in the body.
 const body=prepared.body;
 for(const forbidden of ['claimSources','assetId','assetRevision','truthState','sourceUrl'])assert.ok(!body.includes(forbidden),forbidden);

 // Re-preparing the stored bytes reproduces the same identity and digest, which is what a
 // restarted worker must check before it is allowed to send anything.
 const again=prepareCutroomRequest(JSON.parse(prepared.body));
 assert.equal(again.bodySha256,prepared.bodySha256);
});

test('a brief without complete, single-source claim lineage is rejected', () => {
 const assetId=randomUUID();
 const unsourced={...brief(assetId),claimSources:brief(assetId).claimSources.slice(0,2)};
 assert.throws(()=>generationBrief.parse(unsourced));
 const twoAssets={...brief(assetId),claimSources:[
  ...brief(assetId).claimSources.slice(0,2),
  {claimId:'claim-king',assetId:randomUUID(),assetRevision:1},
 ]};
 assert.throws(()=>generationBrief.parse(twoAssets));
 const foreignClaim={...brief(assetId),claimSources:[...brief(assetId).claimSources,{claimId:'claim-ghost',assetId,assetRevision:1}]};
 assert.throws(()=>generationBrief.parse(foreignClaim));
});

test('migration 0013 guards the generation records', async (t) => {
 const pool=new pg.Pool({connectionString:databaseUrl,max:4});
 const assetId=(await pool.query<{id:string}>('SELECT id FROM asset ORDER BY editorial_order LIMIT 1')).rows[0]?.id;
 assert.ok(assetId,'the seeded library has at least one asset');
 const ids={engine:randomUUID(),brief:randomUUID(),grant:randomUUID(),job:randomUUID(),attempt:randomUUID()};
 const body=JSON.stringify(compileSubmitRequest({brief:generationBrief.parse(brief(assetId)),requestId:`ks-gen-${ids.attempt}`,until:'video',budgetCents:220}));
 const digest=createHash('sha256').update(body).digest('hex');

 try {
  await t.test('an engine origin must be explicit loopback and is retired, never deleted', async () => {
   await assert.rejects(pool.query(
    `INSERT INTO cutroom_engine(id,origin,contract_revision,artifact_root,provider_mode,declared_by)
     VALUES($1,'http://cutroom.example:80',$2,'/tmp/artifacts','standin','coordinator')`,[randomUUID(),REVISION]));
   await pool.query(
    `INSERT INTO cutroom_engine(id,origin,contract_revision,artifact_root,provider_mode,declared_by)
     VALUES($1,'http://127.0.0.1:4390',$2,'/Volumes/Mrigesh SSD/knowscroll-dev/cutroom/instances/owner-local-standin/artifacts','standin','coordinator')`,
    [ids.engine,REVISION]);
   await assert.rejects(pool.query('DELETE FROM cutroom_engine WHERE id=$1',[ids.engine]));
   await assert.rejects(pool.query('UPDATE cutroom_engine SET provider_mode=$2 WHERE id=$1',[ids.engine,'live']));
  });

  await t.test('a brief only moves draft to approved, and a job needs an approved one', async () => {
   await pool.query(
    `INSERT INTO generation_brief(id,source_asset_id,source_asset_revision,truth_state,brief,brief_sha256,authored_by,review_state)
     VALUES($1,$2,1,'synthesis',$3,$4,'coordinator','draft')`,
    [ids.brief,assetId,JSON.stringify(brief(assetId)),createHash('sha256').update(JSON.stringify(brief(assetId))).digest('hex')]);
   await pool.query(
    `INSERT INTO generation_budget_grant(id,mode,cap_cents,expires_at) VALUES($1,'standin',1000,now()+interval '30 days')`,[ids.grant]);
   await assert.rejects(pool.query(
    `INSERT INTO generation_job(id,brief_id,engine_id,grant_id,until,budget_cents,deadline_at)
     VALUES($1,$2,$3,$4,'video',220,now()+interval '1 hour')`,[ids.job,ids.brief,ids.engine,ids.grant]),
    /approved brief/);
   await assert.rejects(pool.query('UPDATE generation_brief SET brief=$2 WHERE id=$1',[ids.brief,JSON.stringify({})]));
   await pool.query(`UPDATE generation_brief SET review_state='approved' WHERE id=$1`,[ids.brief]);
   await pool.query(
    `INSERT INTO generation_job(id,brief_id,engine_id,grant_id,until,budget_cents,deadline_at)
     VALUES($1,$2,$3,$4,'video',220,now()+interval '1 hour')`,[ids.job,ids.brief,ids.engine,ids.grant]);
  });

  await t.test('a grant cannot be over-reserved, and live grants stay under the owner cap', async () => {
   await assert.rejects(pool.query('UPDATE generation_budget_grant SET reserved_cents=1001 WHERE id=$1',[ids.grant]));
   await pool.query('UPDATE generation_budget_grant SET reserved_cents=220 WHERE id=$1',[ids.grant]);
   await assert.rejects(pool.query(
    `INSERT INTO generation_budget_grant(id,mode,cap_cents,expires_at) VALUES($1,'live',100,now()+interval '1 day')`,[randomUUID()]),
    /authorization|violates/);
   await pool.query(
    `INSERT INTO generation_budget_grant(id,mode,cap_cents,authorization_ref,expires_at)
     VALUES($1,'live',200,'owner decision 2026-09-20: <= $2 total',now()+interval '1 day')`,[randomUUID()]);
   await assert.rejects(pool.query(
    `INSERT INTO generation_budget_grant(id,mode,cap_cents,authorization_ref,expires_at)
     VALUES($1,'live',1,'owner decision 2026-09-20',now()+interval '1 day')`,[randomUUID()]),
    /owner cap/);
  });

  await t.test('an attempt keeps its identity and only walks the declared states', async () => {
   await pool.query(
    `INSERT INTO cutroom_attempt(id,job_id,ordinal,request_id,request_body,body_sha256,contract_revision)
     VALUES($1,$2,1,$3,$4,$5,$6)`,[ids.attempt,ids.job,`ks-gen-${ids.attempt}`,body,digest,REVISION]);
   await assert.rejects(pool.query('UPDATE cutroom_attempt SET request_body=$2 WHERE id=$1',[ids.attempt,'{}']));
   await assert.rejects(pool.query(`UPDATE cutroom_attempt SET state='accepted' WHERE id=$1`,[ids.attempt]),/transition|violates/);
   await pool.query(`UPDATE cutroom_attempt SET state='dispatch_committed',dispatch_committed_at=now() WHERE id=$1`,[ids.attempt]);
   await assert.rejects(pool.query(`UPDATE cutroom_attempt SET state='prepared' WHERE id=$1`,[ids.attempt]),/transition/);
   await pool.query(`UPDATE cutroom_attempt SET state='accepted',run_id=$2,accepted_at=now() WHERE id=$1`,[ids.attempt,`run-${ids.attempt}`]);
   await assert.rejects(pool.query('UPDATE cutroom_attempt SET run_id=$2 WHERE id=$1',[ids.attempt,'other-run']));
   // A stored cursor only moves forward: rewinding it would re-read events already recorded.
   await pool.query('UPDATE cutroom_attempt SET next_since=5 WHERE id=$1',[ids.attempt]);
   await assert.rejects(pool.query('UPDATE cutroom_attempt SET next_since=4 WHERE id=$1',[ids.attempt]),/transition/);
   await assert.rejects(pool.query('UPDATE cutroom_attempt SET resend_count=4 WHERE id=$1',[ids.attempt]));
  });

  await t.test('stored events are append-only and keep one row per sequence number', async () => {
   await pool.query(`INSERT INTO cutroom_event(attempt_id,seq,event) VALUES($1,1,'{"type":"run.accepted"}')`,[ids.attempt]);
   await assert.rejects(pool.query(`INSERT INTO cutroom_event(attempt_id,seq,event) VALUES($1,1,'{"type":"other"}')`,[ids.attempt]));
   await assert.rejects(pool.query('UPDATE cutroom_event SET event=$2 WHERE attempt_id=$1',[ids.attempt,'{}']));
   await assert.rejects(pool.query('DELETE FROM cutroom_event WHERE attempt_id=$1',[ids.attempt]));
  });

  await t.test('a generated Reel needs a finished video attempt, real media and the engine mode', async () => {
   const path='/Volumes/Mrigesh SSD/knowscroll-dev/cutroom/instances/owner-local-standin/artifacts/run/a1-render.mp4';
   const sha='a'.repeat(64);
   await pool.query(
    `INSERT INTO media_object(sha256,byte_size,content_type,probe,storage_key)
     VALUES($1,1024,'video/mp4','{"streams":[]}',$2)`,[sha,`sha256/${sha.slice(0,2)}/${sha.slice(2,4)}/${sha}.mp4`]);
   const insertReel=(mode:string)=>pool.query(
    `INSERT INTO generated_reel(id,attempt_id,brief_id,engine_id,cutroom_run_id,media_sha256,engine_path,provider_mode,truth_state,generated_label,lineage)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'synthesis',true,'{"briefSha256":"x"}')`,
    [randomUUID(),ids.attempt,ids.brief,ids.engine,`run-${ids.attempt}`,sha,path,mode]);
   await assert.rejects(insertReel('standin'),/lineage/); // the attempt is not finished yet
   await pool.query(
    `UPDATE cutroom_attempt SET state='finished',finished_at=now(),reported_cost_cents=0,settlement='settled',
      result=jsonb_build_object('status','completed','until','video','video',jsonb_build_object('path',$2::text)) WHERE id=$1`,
    [ids.attempt,path]);
   await assert.rejects(insertReel('live'),/lineage/); // mode must match the engine's declaration
   await insertReel('standin');
   await assert.rejects(pool.query(`UPDATE generated_reel SET availability='eligible' WHERE attempt_id=$1`,[ids.attempt]));
   await assert.rejects(pool.query('DELETE FROM media_object WHERE sha256=$1',[sha]));
  });
 } finally {
  await pool.end();
 }
});
