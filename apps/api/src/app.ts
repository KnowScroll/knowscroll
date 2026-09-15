import Fastify from 'fastify';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { exposureInput, interactionInput, uuid, type ScrollAsset } from '../../../packages/contracts/src/index.ts';
import { pool, transaction, lockUniverse, OWNER_ID } from '../../../packages/db/src/index.ts';
import { compose } from '../../../packages/core/src/composer.ts';
class HttpError extends Error { constructor(public statusCode:number,message:string){super(message);} }
export function buildApp(token: string) {
 if(token.length<24) throw new Error('KS_DEV_TOKEN must contain at least 24 characters');
 const app = Fastify({logger:false,bodyLimit:16384});
 app.setErrorHandler((error, _req, reply)=> {
  const status = error instanceof Error && 'statusCode' in error ? Number(error.statusCode) : 500;
  const code = Number.isInteger(status) && status >= 400 && status < 500 ? status : 500;
  reply.code(code).send({error: code >= 500 ? 'Internal operation failed' : (error as Error).message});
 });
 app.addHook('onRequest',async(req,reply)=> {
  if(req.url==='/health') return;
  const actual=Buffer.from(req.headers.authorization ?? ''), expected=Buffer.from(`Bearer ${token}`);
  if(actual.length!==expected.length || !timingSafeEqual(actual,expected)) return reply.code(401).send({error:'Unauthorized'});
 });
 app.get('/health',async()=> {await pool.query('SELECT 1');return {status:'ok',database:true};});
 app.get('/v1/universe',async()=> transaction(async c=> {
  await lockUniverse(c);
  const u=(await c.query('SELECT revision FROM universe WHERE id=$1',[OWNER_ID])).rows[0];
  const traces=(await c.query(`SELECT t.event_id AS "eventId", t.asset_id AS "assetId",a.title,t.created_at AS "createdAt"
   FROM trace t JOIN asset a ON a.id=t.asset_id WHERE t.universe_id=$1 ORDER BY t.created_at`,[OWNER_ID])).rows;
  return {universeId:OWNER_ID,revision:u.revision,traces,capabilities:{reasoning:false,reels:false,worldEvolution:false}};
 }));
 app.get('/v1/feed',async()=>transaction(async c=> {
  await lockUniverse(c);
  const account=(await c.query('SELECT * FROM accounts WHERE universe_id=$1',[OWNER_ID])).rows[0];
  const assets=(await c.query(`SELECT id AS "assetId",revision,kind,title,summary,body,source_title AS "sourceTitle",source_url AS "sourceUrl",truth_state AS "truthState" FROM asset WHERE kind='Scroll' ORDER BY editorial_order`)).rows as ScrollAsset[];
  const items=compose(assets,account.kept_asset_ids);
  const decisionId=randomUUID();
  await c.query('INSERT INTO decision(id,universe_id,account_revision,policy_version,candidates) VALUES($1,$2,$3,$4,$5)',[decisionId,OWNER_ID,account.revision,'editorial-unkept-v1',JSON.stringify(items)]);
  return {decisionId,universeId:OWNER_ID,accountRevision:account.revision,items};
 }));
 app.post('/v1/exposures',async(req,reply)=> {
  const parsed=exposureInput.safeParse(req.body); if(!parsed.success) throw new HttpError(400,'Invalid exposure');
  const b=parsed.data;
  const result=await transaction(async c=> {
   await lockUniverse(c);
   const old=(await c.query('SELECT * FROM exposure WHERE universe_id=$1 AND client_key=$2',[OWNER_ID,b.clientExposureId])).rows[0];
   if(old) { if(old.decision_id!==b.decisionId || old.asset_id!==b.assetId) throw new HttpError(409,'Exposure key reused with different content');return {exposureId:old.id,eventId:old.event_id}; }
   const d=(await c.query('SELECT candidates FROM decision WHERE id=$1 AND universe_id=$2',[b.decisionId,OWNER_ID])).rows[0];
   if(!d || !d.candidates.some((a:ScrollAsset)=>a.assetId===b.assetId)) throw new HttpError(422,'Asset was not selected in this decision');
   const exposureId=randomUUID(), eventId=randomUUID();
   await c.query('INSERT INTO ledger(id,universe_id,kind,client_key,payload) VALUES($1,$2,$3,$4,$5)',[eventId,OWNER_ID,'exposure',b.clientExposureId,JSON.stringify({...b,exposureId})]);
   await c.query('INSERT INTO exposure(id,universe_id,decision_id,asset_id,event_id,client_key) VALUES($1,$2,$3,$4,$5,$6)',[exposureId,OWNER_ID,b.decisionId,b.assetId,eventId,b.clientExposureId]);
   return {exposureId,eventId};
  });return reply.code(201).send(result);
 });
 app.post('/v1/interactions',async(req,reply)=> {
  const parsed=interactionInput.safeParse(req.body);if(!parsed.success) throw new HttpError(400,'Invalid interaction');
  const b=parsed.data;
  const result=await transaction(async c=> {
   await lockUniverse(c);
   const old=(await c.query(`SELECT l.id,l.payload,j.id AS job_id FROM ledger l JOIN job j ON j.event_id=l.id WHERE l.universe_id=$1 AND l.kind='keep' AND l.client_key=$2`,[OWNER_ID,b.clientEventId])).rows[0];
   if(old) {if(old.payload.exposureId!==b.exposureId || old.payload.assetId!==b.assetId) throw new HttpError(409,'Event key reused with different content');return {eventId:old.id,jobId:old.job_id,status:'accepted'};}
   const ex=(await c.query('SELECT event_id FROM exposure WHERE id=$1 AND universe_id=$2 AND asset_id=$3',[b.exposureId,OWNER_ID,b.assetId])).rows[0];
   if(!ex) throw new HttpError(422,'A matching exposure is required');
   const eventId=randomUUID(),jobId=randomUUID();
   await c.query('INSERT INTO ledger(id,universe_id,kind,client_key,causation_id,payload) VALUES($1,$2,$3,$4,$5,$6)',[eventId,OWNER_ID,'keep',b.clientEventId,ex.event_id,JSON.stringify(b)]);
   await c.query('INSERT INTO job(id,universe_id,event_id,kind) VALUES($1,$2,$3,$4)',[jobId,OWNER_ID,eventId,'project_keep']);
   return {eventId,jobId,status:'accepted'};
  });return reply.code(202).send(result);
 });
 app.get<{Params:{eventId:string}}>('/v1/events/:eventId',async req=> {
  if(!uuid.safeParse(req.params.eventId).success) throw new HttpError(400,'Invalid event ID');
  const row=(await pool.query(`SELECT l.id AS "eventId", l.causation_id AS "causationId",l.payload->>'exposureId' AS "exposureId",l.kind,j.id AS "jobId",j.status AS "jobStatus",COALESCE(j.status='completed',false) AS projected FROM ledger l LEFT JOIN job j ON j.event_id=l.id WHERE l.id=$1 AND l.universe_id=$2`,[req.params.eventId,OWNER_ID])).rows[0];
  if(!row) throw new HttpError(404,'Event not found');return row;
 });
 return app;
}
