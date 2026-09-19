/** Separate caller/server restart proof against a synthetic local HTTP stand-in, never Cutroom. */
import assert from 'node:assert/strict';
import {fork,execFileSync,type ChildProcess} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';

type Peer={role:string;child:ChildProcess;messages:any[];exit:Promise<{code:number|null;signal:NodeJS.Signals|null}>;ended:boolean};
const directory=await mkdtemp(join(tmpdir(),'knowscroll-cutroom-http-'));
const receiptPath=resolve(process.argv[2]??'artifacts/cutroom-http.json');
const peers:Peer[]=[];let phase='setup',failed=false,interrupted=false,forced=false;
const stopSignal=()=>{interrupted=true;for(const peer of peers)if(!peer.ended)peer.child.kill('SIGTERM');};
process.on('SIGTERM',stopSignal);process.on('SIGINT',stopSignal);
function start(role:string,mode:string,origin?:string) {
 const child=fork(resolve('scripts/fixtures/cutroom-http-peer.ts'),[mode,directory,...(origin?[origin]:[])],{
  execArgv:['--import','tsx'],stdio:['ignore','ignore','ignore','ipc'],env:{PATH:process.env.PATH??'',TMPDIR:process.env.TMPDIR??tmpdir()},
 });
 const peer:Peer={role,child,messages:[],ended:false,exit:new Promise(resolve=>{
  child.once('exit',(code,signal)=>{peer.ended=true;resolve({code,signal});});
  child.once('error',()=>{peer.ended=true;resolve({code:1,signal:null});});
 })};
 child.on('message',message=>peer.messages.push(message));peers.push(peer);return peer;
}
async function message(peer:Peer,kind:string):Promise<any> {
 const existing=peer.messages.find(value=>value?.kind===kind);if(existing)return existing;
 return new Promise((resolve,reject)=>{
  const cleanup=()=>{clearTimeout(timer);peer.child.off('message',onMessage);peer.child.off('exit',onExit);};
  const onMessage=(value:any)=>{if(value?.kind===kind){cleanup();resolve(value);}else if(value?.kind==='failed'){cleanup();reject(new Error('Fixture failed'));}};
  const onExit=()=>{cleanup();reject(new Error('Fixture exited before its acknowledgement'));};
  const timer=setTimeout(()=>{cleanup();reject(new Error('Fixture acknowledgement timed out'));},15000);
  peer.child.on('message',onMessage);peer.child.once('exit',onExit);
  if(peer.ended||interrupted)onExit();
 });
}
async function exit(peer:Peer) {
 let timer:ReturnType<typeof setTimeout>|undefined;
 try {return await Promise.race([peer.exit,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Fixture exit timed out')),5000);})]);}
 finally {clearTimeout(timer);}
}
async function stop(peer:Peer) {
 if(!peer.ended)peer.child.kill('SIGTERM');
 assert.deepEqual(await exit(peer),{code:0,signal:null});
 assert(peer.messages.some(value=>value?.kind==='stopped'));
}
let assertions:Record<string,unknown>={};
try {
 await writeFile(join(directory,'input.json'),JSON.stringify({contractVersion:1,requestId:randomUUID(),worldId:'fixture-world',
  narration:Array.from({length:4},(_,i)=>({text:`Synthetic sentence ${i}.`,claimIds:['claim']})),claims:[{id:'claim',role:'main'}],
  criteria:{mustShow:[{id:'shape',text:'A square.',type:'presence',claimId:'claim'}],mustNotShow:[],depictionPolicyVersion:'fixture-v1'},
  style:{id:'fixture',version:1,text:'Synthetic'},options:{until:'video',budgetCents:1}}),{mode:0o600});
 phase='first-submit';const firstServer=start('server-before-restart','server'),firstOrigin=(await message(firstServer,'ready')).origin;
 const firstCaller=start('caller-before-restart','first',firstOrigin),first=await message(firstCaller,'done');
 assert.deepEqual(await exit(firstCaller),{code:0,signal:null});
 const committed=JSON.parse(await readFile(join(directory,'state.json'),'utf8'));
 assert.equal(committed.bodySha256,first.bodySha256);assert.equal(first.writeUncertain,true);
 await stop(firstServer);
 phase='restart-reconcile';const secondServer=start('server-after-restart','server'),secondOrigin=(await message(secondServer,'ready')).origin;
 const secondCaller=start('caller-after-restart','recover',secondOrigin),second=await message(secondCaller,'done');
 assert.deepEqual(await exit(secondCaller),{code:0,signal:null});
 const state=JSON.parse(await readFile(join(directory,'state.json'),'utf8'));
 assert.equal(state.bodySha256,first.bodySha256);assert.equal(second.bodySha256,first.bodySha256);
 assert.equal(state.submits,1);assert.equal(state.reads,5);assert.equal(state.cancels,1);
 assert.notEqual(firstServer.child.pid,secondServer.child.pid);assert.notEqual(firstCaller.child.pid,secondCaller.child.pid);
 await stop(secondServer);
 assertions={lostSubmitAcknowledgementUncertain:true,callerAndStandInProcessesReplaced:true,originalBytesAndIdentityReconciled:true,
  generationSubmits:state.submits,readRequests:state.reads,cancelRequests:state.cancels,syntheticPathIsOnlyMetadata:true,
  bodySha256:first.bodySha256};
} catch {failed=true;}
finally {
 phase=failed?phase:'cleanup';
 for(const peer of peers)if(!peer.ended) {
  peer.child.kill('SIGTERM');
  try {await exit(peer);}catch {forced=true;peer.child.kill('SIGKILL');try{await exit(peer);}catch{failed=true;}}
 }
 try {await rm(directory,{recursive:true});}catch{failed=true;}
 process.off('SIGTERM',stopSignal);process.off('SIGINT',stopSignal);
}
let directoryAbsent=false;try{await access(directory);}catch(error){directoryAbsent=(error as NodeJS.ErrnoException).code==='ENOENT';}
failed=failed||interrupted||forced||!directoryAbsent||peers.some(peer=>!peer.ended);
const files=['apps/worker/src/cutroom/http-client.ts','scripts/fixtures/cutroom-http-peer.ts','scripts/run-isolated-cutroom-http-journey.ts',
 ...['version.ts','request.ts','responses.ts','events.ts','record.ts','routes.ts','errors.ts','source.json'].map(name=>'packages/contracts/src/cutroom-v1/'+name)];
const source={revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0,
 files:await Promise.all(files.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))};
const receipt={check:'cutroom-http-fixture-restart',result:failed?'failed':'passed',observedAt:new Date().toISOString(),source,assertions,
 processes:await Promise.all(peers.map(async peer=>({role:peer.role,pid:peer.child.pid,...(peer.ended?await peer.exit:{code:null,signal:null}),stoppedAcknowledgement:peer.messages.some(value=>value?.kind==='stopped')}))),
 cleanup:{processesExited:peers.every(peer=>peer.ended),directoryAbsent,forced},...(failed?{failurePhase:phase}:{}),
 limits:['Synthetic local HTTP stand-in, not real Cutroom or provider execution','Stand-in persistence and lifecycle do not certify upstream durability or canonical idempotency','No real media, import, publication, funding or owner deployment','Caller intent persistence is a fixture, not a product GenerationJob store']};
await mkdir(dirname(receiptPath),{recursive:true});await writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({check:receipt.check,result:receipt.result,receiptPath}));if(failed)throw new Error('Cutroom HTTP fixture journey failed');
