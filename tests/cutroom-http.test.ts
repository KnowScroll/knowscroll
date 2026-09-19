import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import test from 'node:test';
import {createCutroomHttpClient,prepareCutroomRequest,type CutroomRunRef} from '../apps/worker/src/cutroom/http-client.ts';

const ref:CutroomRunRef={requestId:'request-1',runId:'run-1',until:'video'};
const status={contractVersion:1,requestId:ref.requestId,runId:ref.runId,state:'running',lastSeq:0};
const accepted={contractVersion:1,outcome:'accepted',requestId:ref.requestId,runId:ref.runId,replayed:false};
const request=()=>({contractVersion:1,requestId:ref.requestId,worldId:'fixture-world',
 narration:Array.from({length:4},(_,i)=>({text:`Synthetic sentence ${i}.`,claimIds:['claim-1']})),
 claims:[{id:'claim-1',role:'main'}],criteria:{mustShow:[{id:'criterion-1',text:'A blue square.',type:'presence',claimId:'claim-1'}],mustNotShow:[],depictionPolicyVersion:'fixture-v1'},
 style:{id:'fixture',version:1,text:'Simple shapes.'},options:{until:'video',budgetCents:1}});
type Seen={method:string;url:string;body:string};
type Handler=(req:IncomingMessage,res:ServerResponse,seen:Seen)=>void;
function json(res:ServerResponse,code:number,value:unknown) {res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(value));}
async function fixture(body:(context:{origin:string;seen:Seen[];handle:(handler:Handler)=>void})=>Promise<void>) {
 let handler:Handler=(_req,res)=>json(res,200,status);const seen:Seen[]=[];
 const server=createServer((req,res)=>{
  const chunks:Buffer[]=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
   const call={method:req.method!,url:req.url!,body:Buffer.concat(chunks).toString('utf8')};seen.push(call);handler(req,res,call);
  });
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();assert(address&&typeof address!=='string');
 try {await body({origin:`http://127.0.0.1:${address.port}`,seen,handle:value=>{handler=value;}});}
 finally {server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}

test('Cutroom schemas match all seven pinned upstream source hashes',async()=>{
 const root='packages/contracts/src/cutroom-v1/';
 const manifest=JSON.parse(await readFile(root+'source.json','utf8'));
 assert.equal(manifest.revision,'86d6e2c8b74228db4a5a953e53c53a7b77cef46e');assert.equal(manifest.files.length,7);
 for(const file of manifest.files)assert.equal(createHash('sha256').update(await readFile(root+file.path)).digest('hex'),file.sha256,file.path);
});

test('preparation rejects undeclared fields, untyped/event-negative criteria, unsupported variation and invalid budgets',()=>{
 const invalid=[
  {...request(),sources:['not-a-contract-field']},
  {...request(),criteria:{...request().criteria,mustShow:[{id:'x',text:'Untyped.'}]}},
  {...request(),criteria:{...request().criteria,mustNotShow:[{id:'x',text:'An event.',type:'event'}]}},
  {...request(),options:{until:'video',budgetCents:0}},
  {...request(),options:{until:'video',budgetCents:1,planVaryOn:'order'}},
  {...request(),contractVersion:2},
  {...request(),requestId:'x'.repeat(1025)},
  {...request(),requestId:'\ud800'},
  {...request(),style:{id:'fixture',version:1,text:'x'.repeat(256*1024)}},
 ];
 for(const input of invalid)assert.throws(()=>prepareCutroomRequest(input));
 const prepared=prepareCutroomRequest(request());assert(Object.isFrozen(prepared));
 assert.equal(createHash('sha256').update(prepared.body).digest('hex'),prepared.bodySha256);
});

test('submit holds exact immutable bytes and identity across explicit replay and caller mutation',async()=>{
 await fixture(async f=>{
  const input=request(),prepared=prepareCutroomRequest(input),client=createCutroomHttpClient({origin:f.origin});
  input.narration[0]!.text='Changed after preparation';input.requestId='changed';
  f.handle((_req,res)=>json(res,202,{...accepted,replayed:f.seen.length>1}));
  const first=await client.submit(prepared),second=await client.submit(prepared);
  assert.equal(first.kind,'accepted');assert.equal(second.kind,'accepted');
  if(second.kind==='accepted')assert.equal(second.value.replayed,true);
  assert.deepEqual(f.seen.map(x=>x.body),[prepared.body,prepared.body]);
  assert.equal(f.seen.length,2);assert(f.seen.every(x=>x.url==='/v1/runs'&&x.method==='POST'));
  assert.throws(()=>client.submit({...prepared}));assert.equal(f.seen.length,2);
 });
});

test('lost submit acknowledgement is uncertain; lookup and observed404 never resubmit automatically',async()=>{
 await fixture(async f=>{
  const client=createCutroomHttpClient({origin:f.origin}),prepared=prepareCutroomRequest(request());
  f.handle((req,res)=>req.method==='POST'?req.socket.destroy():json(res,200,status));
  assert.deepEqual(await client.submit(prepared),{kind:'transport_error',code:'network',writeUncertain:true});
  assert.equal((await client.lookup(prepared.requestId)).kind,'ok');
  f.handle((_req,res)=>json(res,404,{contractVersion:1,error:'not-found',detail:'Synthetic missing observation'}));
  assert.deepEqual(await client.lookup(prepared.requestId),{kind:'not_found'});
  assert.equal(f.seen.filter(x=>x.method==='POST').length,1);assert.equal(f.seen.length,3);
 });
});

test('submit rejects wrong status/body/version/identity and preserves uncertainty for unusable acknowledgements',async t=>{
 for(const [code,body,kind] of [
  [202,accepted,'accepted'],
  [409,{contractVersion:1,outcome:'refused',requestId:ref.requestId,reason:'conflict',detail:'Fixture conflict'},'refused'],
  [422,{contractVersion:1,outcome:'refused',reason:'unsupported',detail:'Fixture unsupported'},'refused'],
  [500,{contractVersion:1,error:'internal',detail:'Never logged by client'},'remote_error'],
  [200,accepted,'protocol_error'],[409,accepted,'protocol_error'],
  [422,{contractVersion:1,outcome:'refused',reason:'conflict',detail:''},'protocol_error'],
  [202,{...accepted,requestId:'other'},'protocol_error'],[202,{...accepted,runId:'..'},'protocol_error'],
  [202,{...accepted,contractVersion:2},'protocol_error'],[202,{...accepted,unexpected:true},'protocol_error'],
 ] as const)await t.test(`${code} ${JSON.stringify(body)} => ${kind}`,async()=>{
  await fixture(async f=>{f.handle((_req,res)=>json(res,code,body));
   const result=await createCutroomHttpClient({origin:f.origin}).submit(prepareCutroomRequest(request()));
   assert.equal(result.kind,kind);if('writeUncertain' in result)assert.equal(result.writeUncertain,true);
   assert.equal(f.seen.length,1);
  });
 });
});

test('status, cancellation and lookup validate original identity, encode paths and snapshot caller references',async()=>{
 await fixture(async f=>{
  const client=createCutroomHttpClient({origin:f.origin});
  f.handle((_req,res)=>json(res,200,status));
  assert.equal((await client.status(ref)).kind,'ok');assert.equal((await client.cancel(ref)).kind,'ok');
  assert.equal(f.seen[1]!.body,'');assert.equal(f.seen[1]!.url,'/v1/runs/run-1/cancel');
  const mutable={...ref},pending=client.status(mutable);mutable.requestId='other';mutable.runId='other';
  assert.equal((await pending).kind,'ok','response authority uses the request-time binding');
  f.handle((_req,res)=>json(res,200,{...status,requestId:'foreign'}));
  assert.equal((await client.lookup(ref.requestId)).kind,'protocol_error');assert.equal((await client.status(ref)).kind,'protocol_error');
  f.handle((_req,res)=>json(res,200,{...status,runId:'foreign'}));
  assert.equal((await client.cancel(ref)).kind,'protocol_error');
  const encoded={...ref,runId:'a/b?c#d'};f.handle((_req,res)=>json(res,200,{...status,runId:encoded.runId}));
  assert.equal((await client.status(encoded)).kind,'ok');assert.equal(f.seen.at(-1)!.url,'/v1/runs/a%2Fb%3Fc%23d');
  assert.throws(()=>client.status({...ref,runId:'..'}));
 });
});

test('result variants remain distinct and completed stage plus identity are checked; record carries no publication authority',async t=>{
 const base={contractVersion:1,requestId:ref.requestId,runId:ref.runId,costCents:0};
 const budgets={reason:'budget',limit:'ceiling',estimateCents:2,ceilingCents:1,capCents:5};
 const variants=[
  {...base,status:'completed',until:'plan',estimateCents:1},
  {...base,status:'completed',until:'stills',estimateCents:1,stills:[],degradations:[]},
  {...base,status:'completed',until:'video',estimateCents:1,stills:[],degradations:[],video:{path:'/engine/private/fixture.mp4'}},
  {...base,status:'refused',...budgets},{...base,status:'stopped',...budgets},
  {...base,status:'stopped',reason:'rule',rule:'fixture',step:'plan',detail:'Synthetic stop'},
  {...base,status:'failed',detail:'Synthetic failure'},{...base,status:'cancelled'},
 ];
 for(const value of variants)await t.test(value.status+('until' in value?' '+value.until:''),async()=>{
  await fixture(async f=>{f.handle((_req,res)=>json(res,200,value));
   const binding={...ref,until:('until' in value?value.until:'video') as CutroomRunRef['until']};
   const result=await createCutroomHttpClient({origin:f.origin}).result(binding);assert.equal(result.kind,'ok');
   if(result.kind==='ok')assert.deepEqual(result.value,value);
  });
 });
 await fixture(async f=>{
  const client=createCutroomHttpClient({origin:f.origin});
  f.handle((_req,res)=>json(res,200,variants[0]));assert.equal((await client.result(ref)).kind,'protocol_error');
  f.handle((_req,res)=>json(res,200,{...variants[2],requestId:'foreign'}));assert.equal((await client.result(ref)).kind,'protocol_error');
  for(const state of ['running','finished']) {
   f.handle((_req,res)=>json(res,409,{...status,state}));
   assert.equal((await client.result(ref)).kind,'pending');assert.equal((await client.record(ref)).kind,'pending');
  }
  const take={takeId:'take-1',shotId:'shot-0',number:1,used:true,observationId:'obs-1',reconciliationId:'rec-1',checks:[{gate:'gate2',outcome:'accept'}]};
  f.handle((_req,res)=>json(res,200,{contractVersion:1,runId:ref.runId,pictures:[],takes:[take,{...take,takeId:'take-2',number:2,used:false,checks:[{gate:'gate2',outcome:'fail'}]}],degradations:[]}));
  assert.equal((await client.record(ref)).kind,'ok');
  f.handle((_req,res)=>json(res,200,{contractVersion:1,runId:ref.runId,pictures:[],takes:[],degradations:[]}));
  assert.equal((await client.record(ref)).kind,'ok');
  // Successor pin 86d6e2c (ADR-0021): the pre-takes record shape is no longer tolerated, and take entries stay strict.
  for(const record of [
   {contractVersion:1,runId:ref.runId,pictures:[],degradations:[]},
   {contractVersion:1,runId:ref.runId,pictures:[],takes:[{...take,unexpected:true}],degradations:[]},
   {contractVersion:1,runId:ref.runId,pictures:[],takes:[{...take,number:0}],degradations:[]},
   {contractVersion:1,runId:ref.runId,pictures:[],takes:[{...take,checks:[{gate:'gate2',outcome:'maybe'}]}],degradations:[]},
   {contractVersion:1,runId:'foreign',pictures:[],takes:[],degradations:[]},
  ]) {
   f.handle((_req,res)=>json(res,200,record));
   assert.equal((await client.record(ref)).kind,'protocol_error');
  }
 });
});

test('events validate page/event identity, strict progression, terminal ordering and exact next cursor',async()=>{
 await fixture(async f=>{
  const client=createCutroomHttpClient({origin:f.origin});
  const event={contractVersion:1,runId:ref.runId,seq:2,at:'2026-09-19T00:00:00Z',type:'run.accepted'};
  const page={contractVersion:1,runId:ref.runId,events:[event],nextSince:2};
  for(const [body,kind] of [
   [page,'ok'],[{...page,events:[],nextSince:1},'ok'],
   [{...page,nextSince:3},'protocol_error'],[{...page,events:[],nextSince:0},'protocol_error'],
   [{...page,events:[{...event,seq:1}],nextSince:1},'protocol_error'],
   [{...page,events:[event,event]},'protocol_error'],
   [{...page,runId:'foreign'},'protocol_error'],[{...page,events:[{...event,runId:'foreign'}]},'protocol_error'],
   [{...page,events:[{...event,contractVersion:2}]},'protocol_error'],
   [{...page,events:[{...event,type:'run.finished',status:'completed'},{...event,seq:3}],nextSince:3},'protocol_error'],
  ] as const){f.handle((_req,res)=>json(res,200,body));assert.equal((await client.events(ref,1)).kind,kind);}
  assert.throws(()=>client.events(ref,-1));assert.throws(()=>client.events(ref,Number.MAX_SAFE_INTEGER+1));
 });
});

test('typed route errors remain distinct; mismatched error/status is a protocol failure',async()=>{
 await fixture(async f=>{
  const client=createCutroomHttpClient({origin:f.origin});
  for(const operation of [()=>client.lookup(ref.requestId),()=>client.status(ref),()=>client.events(ref,0),()=>client.result(ref),()=>client.record(ref),()=>client.cancel(ref)]) {
   f.handle((_req,res)=>json(res,404,{contractVersion:1,error:'not-found',detail:''}));assert.equal((await operation()).kind,'not_found');
   f.handle((_req,res)=>json(res,500,{contractVersion:1,error:'internal',detail:''}));assert.equal((await operation()).kind,'remote_error');
   f.handle((_req,res)=>json(res,404,{contractVersion:1,error:'internal',detail:''}));assert.equal((await operation()).kind,'protocol_error');
  }
  f.handle((_req,res)=>json(res,400,{contractVersion:1,error:'invalid',detail:''}));
  assert.equal((await client.lookup(ref.requestId)).kind,'remote_error');assert.equal((await client.events(ref,0)).kind,'remote_error');
  assert.equal((await client.status(ref)).kind,'protocol_error');
 });
});

test('loopback bounds, body limits, malformed data and redirects fail closed without another request',async()=>{
 for(const origin of ['https://127.0.0.1:80','http://example.com:80','http://127.0.0.1:0','http://user@127.0.0.1:80','http://127.0.0.1:80/path','http://127.0.0.1:80/?x=1','http://127.0.0.1:80/#x'])assert.throws(()=>createCutroomHttpClient({origin}));
 await fixture(async f=>{
  const client=createCutroomHttpClient({origin:f.origin,maxResponseBytes:64});
  f.handle((_req,res)=>{res.writeHead(200,{'content-type':'application/json','content-length':'99999'});res.end('{}');});
  assert.deepEqual(await client.status(ref),{kind:'protocol_error',code:'body_limit',writeUncertain:false});
  f.handle((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write(' '.repeat(65));res.end('{}');});
  assert.deepEqual(await client.status(ref),{kind:'protocol_error',code:'body_limit',writeUncertain:false});
  f.handle((_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<html>');});assert.equal((await client.status(ref)).kind,'protocol_error');
  f.handle((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(Buffer.from([255]));});assert.equal((await client.status(ref)).kind,'protocol_error');
  f.handle((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end('{');});assert.equal((await client.status(ref)).kind,'protocol_error');
  const count=f.seen.length;f.handle((_req,res)=>{res.writeHead(302,{location:f.origin+'/must-not-follow'});res.end();});
  assert.equal((await client.status(ref)).kind,'transport_error');assert.equal(f.seen.length,count+1);
 });
});

test('pre-abort sends nothing, in-flight abort preserves write uncertainty, and timeout bounds a stalled body',async()=>{
 await fixture(async f=>{
  const prepared=prepareCutroomRequest(request()),client=createCutroomHttpClient({origin:f.origin});
  const before=new AbortController();before.abort();
  assert.deepEqual(await client.submit(prepared,before.signal),{kind:'transport_error',code:'aborted',writeUncertain:false});assert.equal(f.seen.length,0);
  let arrived!:()=>void;const seen=new Promise<void>(resolve=>{arrived=resolve;});
  f.handle((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{');arrived();});
  const during=new AbortController(),pending=client.submit(prepared,during.signal);await seen;during.abort();
  assert.deepEqual(await pending,{kind:'transport_error',code:'aborted',writeUncertain:true});
  f.handle((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{');});
  const timeout=createCutroomHttpClient({origin:f.origin,timeoutMs:100});
  assert.deepEqual(await timeout.status(ref),{kind:'transport_error',code:'timeout',writeUncertain:false});
 });
});
