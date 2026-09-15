/** Runs J001 against disposable PostgreSQL databases and separately launched API/worker processes. */
import {randomBytes} from 'node:crypto';
import {spawn, type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import pg from 'pg';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

function localConfig(text:string) {
  return Object.fromEntries(text.split('\n').flatMap(line => {
    const match=/^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    return match ? [[match[1],match[2]]] : [];
  }));
}
function databaseUrl(base:string,name:string) { const url=new URL(base);url.pathname=`/${name}`;return url.toString(); }
function quoteIdentifier(value:string) { return `"${value.replaceAll('"','""')}"`; }
function run(command:string,args:string[],env:NodeJS.ProcessEnv,quiet=false) {
  return new Promise<{stdout:string;stderr:string}>((resolveRun,reject) => {
    const child=spawn(command,args,{cwd:root,env,stdio:quiet?['ignore','pipe','pipe']:'inherit'});
    let stdout='',stderr='';child.stdout?.on('data',chunk=>stdout+=chunk);child.stderr?.on('data',chunk=>stderr+=chunk);
    child.once('error',reject);child.once('exit',code=>code===0?resolveRun({stdout,stderr}):reject(new Error(`${command} ${args.join(' ')} exited ${code}: ${stderr || stdout}`)));
  });
}
type ManagedProcess={child:ChildProcess; startupError?:Error};
function start(command:string,args:string[],env:NodeJS.ProcessEnv):ManagedProcess {
  const child=spawn(command,args,{cwd:root,env,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
  const managed:ManagedProcess={child};child.once('error',error=>{managed.startupError=error;});
  child.stdout?.on('data',chunk=>process.stdout.write(`[isolated ${command}] ${chunk}`));
  child.stderr?.on('data',chunk=>process.stderr.write(`[isolated ${command}] ${chunk}`));
  return managed;
}
async function freePort() { return await new Promise<number>((resolvePort,reject) => { const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const address=s.address();if(!address || typeof address==='string') return reject(new Error('No TCP port assigned'));const port=address.port;s.close(error=>error?reject(error):resolvePort(port));});}); }
async function waitForHealth(base:string,token:string,processes:ManagedProcess[]) {
  let last:unknown;
  for(let attempt=0;attempt<80;attempt++) { for(const process of processes) {if(process.startupError) throw process.startupError;if(process.child.exitCode!==null) throw new Error(`isolated process exited before health check: ${process.child.exitCode}`);} try { const response=await fetch(`${base}/health`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(1000)});if(response.ok) return;last=await response.text(); } catch(error) {last=error;} await setTimeout(100); }
  throw new Error(`isolated API never became healthy: ${String(last)}`);
}
async function stop(managed:ManagedProcess|undefined) { const child=managed?.child;if(!child || child.exitCode!==null || !child.pid) return;try { globalThis.process.kill(-child.pid,'SIGTERM'); } catch { child.kill('SIGTERM'); } await Promise.race([new Promise<void>(resolveExit=>child.once('exit',()=>resolveExit())),setTimeout(5000)]);if(child.exitCode===null) {try { globalThis.process.kill(-child.pid,'SIGKILL'); } catch { child.kill('SIGKILL'); }} }

const suffix=randomBytes(8).toString('hex');
const names={actual:`knowscroll_journey_${suffix}`,decoy:`knowscroll_journey_decoy_${suffix}`};
let admin:pg.Client|undefined,api:ManagedProcess|undefined,worker:ManagedProcess|undefined;
try {
  let config:Record<string,string>={};try { config=localConfig(await readFile(resolve(root,'.env'),'utf8')); } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
  const sourceUrl=process.env.DATABASE_URL ?? config.DATABASE_URL;
  if(!sourceUrl) throw new Error('DATABASE_URL is required in the environment or local .env');
  const source=new URL(sourceUrl);
  if(source.hostname!=='127.0.0.1' && source.hostname!=='localhost' && source.hostname!=='::1') throw new Error('isolated runner only permits a loopback PostgreSQL server');
  admin=new pg.Client({connectionString:databaseUrl(sourceUrl,'postgres')});await admin.connect();
  for(const name of Object.values(names)) await admin.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
  const port=await freePort();
  const token=randomBytes(32).toString('hex');
  const actualUrl=databaseUrl(sourceUrl,names.actual),decoyUrl=databaseUrl(sourceUrl,names.decoy);
  const environment={...process.env,DATABASE_URL:actualUrl,KS_DEV_TOKEN:token,PORT:String(port),MINIMAX_API_KEY:'',CUTROOM_BASE_URL:'',NODE_ENV:'test'};
  for(const url of [actualUrl,decoyUrl]) await run('pnpm',['exec','tsx','scripts/migrate.ts'],{...environment,DATABASE_URL:url},true);
  await run('pnpm',['exec','tsx','scripts/seed.ts'],environment,true);
  api=start('pnpm',['exec','tsx','apps/api/src/main.ts'],environment);
  worker=start('pnpm',['exec','tsx','apps/worker/src/main.ts'],environment);
  const base=`http://127.0.0.1:${port}`;await waitForHealth(base,token,[api,worker]);
  let wrongPathRejected=false;
  try { await run('pnpm',['exec','tsx','scripts/verify-journey.ts'],{...environment,JOURNEY_DATABASE_URL:decoyUrl,JOURNEY_RECEIPT_PATH:`artifacts/j001-isolated-${suffix}-wrong.json`},true); }
  catch(error) { if(/no single persisted decision\/exposure\/keep\/job\/Accounts\/Trace lineage exists/.test(String(error))) wrongPathRejected=true; else throw error; }
  if(!wrongPathRejected) throw new Error('negative proof unexpectedly passed: verifier accepted a different database than the API and worker');
  await run('pnpm',['exec','tsx','scripts/verify-journey.ts'],{...environment,JOURNEY_RECEIPT_PATH:`artifacts/j001-isolated-${suffix}.json`});
  console.log(JSON.stringify({journey:'J001',result:'passed',runtime:{apiPort:port,database:'isolated disposable PostgreSQL',worker:'separate process'},negativeWrongRuntimePath:'rejected as expected'}));
} finally {
  await stop(worker);await stop(api);
  if(admin) { for(const name of Object.values(names)) await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`); await admin.end(); }
}
