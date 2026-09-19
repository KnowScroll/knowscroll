/** Synthetic Cutroom stand-in / caller. Never loaded by the product worker. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {open,readFile} from 'node:fs/promises';
import {basename,join} from 'node:path';
import {createCutroomHttpClient,prepareCutroomRequest} from '../../apps/worker/src/cutroom/http-client.ts';
import {SubmitRequest} from '../../packages/contracts/src/cutroom-v1/request.ts';

const [mode,directory,origin]=process.argv.slice(2);
if(!directory||!basename(directory).startsWith('knowscroll-cutroom-http-'))throw new Error('Disposable Cutroom fixture directory required');
const send=(value:unknown)=>new Promise<void>((resolve,reject)=>process.send?.(value,error=>error?reject(error):resolve()));
async function durable(path:string,value:unknown) {
 const file=await open(path,'w',0o600);try {await file.writeFile(JSON.stringify(value));await file.sync();}finally{await file.close();}
}
type State={requestId:string;runId:string;bodySha256:string;submits:number;cancels:number;reads:number};
const statePath=join(directory,'state.json');
const readState=async()=>JSON.parse(await readFile(statePath,'utf8')) as State;
try {
 if(mode==='server') {
  const server=createServer(async(req,res)=>{
   const json=(code:number,value:unknown)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(value));};
   try {
    const url=new URL(req.url!,'http://127.0.0.1');
    if(req.method==='POST'&&url.pathname==='/v1/runs') {
     const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
     const text=Buffer.concat(chunks).toString('utf8'),body=SubmitRequest.parse(JSON.parse(text));
     const bodySha256=createHash('sha256').update(text).digest('hex');
     let prior:State|undefined;
     try {prior=await readState();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
     if(prior) {
      prior.submits++;await durable(statePath,prior);
      if(prior.requestId!==body.requestId||prior.bodySha256!==bodySha256)json(409,{contractVersion:1,outcome:'refused',reason:'conflict',requestId:body.requestId,detail:'Fixture body conflict'});
      else json(202,{contractVersion:1,outcome:'accepted',requestId:prior.requestId,runId:prior.runId,replayed:true});
      return;
     }
     const state:State={requestId:body.requestId,runId:'fixture-run',bodySha256,submits:1,cancels:0,reads:0};
     // A fixture commit followed by deliberate loss of the acknowledgement.
     await durable(statePath,state);req.socket.destroy();return;
    }
    const state=await readState();
    const status={contractVersion:1,runId:state.runId,requestId:state.requestId,state:'finished',lastSeq:2};
    if(req.method==='POST'&&url.pathname===`/v1/runs/${state.runId}/cancel`) {
     state.cancels++;await durable(statePath,state);json(200,status);return;
    }
    state.reads++;await durable(statePath,state);
    if(url.pathname==='/v1/runs'&&url.searchParams.get('requestId')===state.requestId)json(200,status);
    else if(url.pathname===`/v1/runs/${state.runId}`)json(200,status);
    else if(url.pathname===`/v1/runs/${state.runId}/events`)json(200,{contractVersion:1,runId:state.runId,nextSince:2,events:[
     {contractVersion:1,runId:state.runId,seq:1,at:'2026-09-19T00:00:00Z',type:'run.accepted'},
     {contractVersion:1,runId:state.runId,seq:2,at:'2026-09-19T00:00:01Z',type:'run.finished',status:'completed'},
    ]});
    else if(url.pathname===`/v1/runs/${state.runId}/result`)json(200,{contractVersion:1,runId:state.runId,requestId:state.requestId,costCents:0,status:'completed',until:'video',estimateCents:1,stills:[],degradations:[],video:{path:'/synthetic/no-media-exists.mp4'}});
    else if(url.pathname===`/v1/runs/${state.runId}/record`)json(200,{contractVersion:1,runId:state.runId,pictures:[],degradations:[]});
    else json(404,{contractVersion:1,error:'not-found',detail:'Fixture observation only'});
   } catch {json(500,{contractVersion:1,error:'internal',detail:'Fixture failure'});}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert(address&&typeof address!=='string');
  let stopping=false;
  process.on('SIGTERM',()=>{if(stopping)return;stopping=true;server.closeAllConnections();server.close(async()=>{await send({kind:'stopped'});process.exit(0);});});
  await send({kind:'ready',origin:`http://127.0.0.1:${address.port}`});
 } else {
  assert(origin);const client=createCutroomHttpClient({origin});
  if(mode==='first') {
   const prepared=prepareCutroomRequest(JSON.parse(await readFile(join(directory,'input.json'),'utf8')));
   await durable(join(directory,'intent.json'),{body:prepared.body,bodySha256:prepared.bodySha256});
   const outcome=await client.submit(prepared);
   assert.deepEqual(outcome,{kind:'transport_error',code:'network',writeUncertain:true});
   await send({kind:'done',writeUncertain:true,bodySha256:prepared.bodySha256});
  } else if(mode==='recover') {
   const intent=JSON.parse(await readFile(join(directory,'intent.json'),'utf8'));
   const prepared=prepareCutroomRequest(JSON.parse(intent.body));
   assert.equal(prepared.body,intent.body);assert.equal(prepared.bodySha256,intent.bodySha256);
   const lookup=await client.lookup(prepared.requestId);assert.equal(lookup.kind,'ok');if(lookup.kind!=='ok')throw new Error('Fixture lookup failed');
   const ref={runId:lookup.value.runId,requestId:lookup.value.requestId,until:prepared.until};
   assert.equal((await client.status(ref)).kind,'ok');
   const events=await client.events(ref,0);assert.equal(events.kind,'ok');
   const result=await client.result(ref);assert.equal(result.kind,'ok');
   if(result.kind!=='ok'||result.value.status!=='completed'||result.value.until!=='video')throw new Error('Fixture result failed');
   assert.equal(result.value.video.path,'/synthetic/no-media-exists.mp4');
   assert.equal((await client.record(ref)).kind,'ok');assert.equal((await client.cancel(ref)).kind,'ok');
   await send({kind:'done',originalIdentityReconciled:true,bodySha256:prepared.bodySha256,syntheticPathIsOnlyMetadata:true});
  } else throw new Error('Unknown fixture mode');
  process.exit(0);
 }
} catch {await send({kind:'failed',code:'cutroom_fixture_failed'});process.exit(1);}
