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
    const child=spawn(command,args,{cwd:root,env,stdio:quiet?['ignore','pipe','pipe']:'inherit',detached:process.platform!=='win32'});
    activeCommands.add(child);
    let stdout='',stderr='';child.stdout?.on('data',chunk=>stdout+=chunk);child.stderr?.on('data',chunk=>stderr+=chunk);
    child.once('error',error=>{activeCommands.delete(child);reject(error);});child.once('exit',code=>{activeCommands.delete(child);code===0?resolveRun({stdout,stderr}):reject(new Error(`${command} ${args.join(' ')} exited ${code}: ${stderr || stdout}`));});
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
const createdDatabases:string[]=[];
const activeCommands=new Set<ChildProcess>();
let admin:pg.Client|undefined,api:ManagedProcess|undefined,worker:ManagedProcess|undefined,cleanupPromise:Promise<void>|undefined;
let interrupted=false;
function throwIfInterrupted() { if(interrupted) throw new Error('isolated journey runner interrupted'); }
async function cleanup() {
  if(cleanupPromise) return cleanupPromise;
  cleanupPromise=(async()=>{
    const errors:unknown[]=[];
    for(const managed of [worker,api]) try { await stop(managed); } catch(error) { errors.push(error); }
    if(admin) {
      for(const name of createdDatabases) try { await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`); } catch(error) { errors.push(error); }
      try { await admin.end(); } catch(error) { errors.push(error); }
    }
    if(errors.length) throw new AggregateError(errors,'isolated journey cleanup failed');
  })();
  return cleanupPromise;
}
function onSignal() { interrupted=true;for(const child of activeCommands) {try { if(child.pid) globalThis.process.kill(-child.pid,'SIGTERM');else child.kill('SIGTERM'); } catch { child.kill('SIGTERM'); }} }
const onInterrupt=()=>onSignal(),onTerminate=()=>onSignal();
process.once('SIGINT',onInterrupt);process.once('SIGTERM',onTerminate);
let primaryError:unknown;
try {
  let config:Record<string,string>={};try { config=localConfig(await readFile(resolve(root,'.env'),'utf8')); } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
  const sourceUrl=process.env.DATABASE_URL ?? config.DATABASE_URL;
  if(!sourceUrl) throw new Error('DATABASE_URL is required in the environment or local .env');
  const source=new URL(sourceUrl);
  if(source.hostname!=='127.0.0.1' && source.hostname!=='localhost' && source.hostname!=='::1') throw new Error('isolated runner only permits a loopback PostgreSQL server');
  admin=new pg.Client({connectionString:databaseUrl(sourceUrl,'postgres'),connectionTimeoutMillis:5000});await admin.connect();throwIfInterrupted();
  for(const name of Object.values(names)) { await admin.query(`CREATE DATABASE ${quoteIdentifier(name)}`);createdDatabases.push(name);throwIfInterrupted(); }
  const port=await freePort();
  const token=randomBytes(32).toString('hex');
  const actualUrl=databaseUrl(sourceUrl,names.actual),decoyUrl=databaseUrl(sourceUrl,names.decoy);
  const runtimeEnvironment=Object.fromEntries(
    ['PATH','HOME','LANG','LC_ALL','KS_DEV_ROOT','npm_config_cache','COREPACK_HOME','TMPDIR'].flatMap(name => {
      const value=process.env[name];return value===undefined ? [] : [[name,value]];
    })
  );
  const environment={...runtimeEnvironment,...Object.fromEntries(Object.keys(config).map(key=>[key,''])),DATABASE_URL:actualUrl,KS_DEV_TOKEN:token,PORT:String(port),NODE_ENV:'test'};
  for(const url of [actualUrl,decoyUrl]) { await run('pnpm',['exec','tsx','scripts/migrate.ts'],{...environment,DATABASE_URL:url},true);throwIfInterrupted(); }
  await run('pnpm',['exec','tsx','scripts/seed.ts'],environment,true);throwIfInterrupted();
  api=start('pnpm',['exec','tsx','apps/api/src/main.ts'],environment);
  worker=start('pnpm',['exec','tsx','apps/worker/src/main.ts'],environment);
  const base=`http://127.0.0.1:${port}`;await waitForHealth(base,token,[api,worker]);throwIfInterrupted();
  await run('pnpm',['exec','tsx','scripts/verify-journey.ts'],{...environment,JOURNEY_RECEIPT_PATH:`artifacts/j001-isolated-${suffix}.json`});throwIfInterrupted();
  let wrongPathRejected=false;
  try { await run('pnpm',['exec','tsx','scripts/verify-journey.ts'],{...environment,JOURNEY_DATABASE_URL:decoyUrl,JOURNEY_RECEIPT_PATH:`artifacts/j001-isolated-${suffix}-wrong.json`},true);throwIfInterrupted(); }
  catch(error) { if(/no single persisted decision\/exposure\/keep\/job\/Accounts\/Trace lineage exists/.test(String(error))) wrongPathRejected=true; else throw error; }
  if(!wrongPathRejected) throw new Error('negative proof unexpectedly passed: verifier accepted a different database than the API and worker');
  console.log(JSON.stringify({journey:'J001',result:'passed',runtime:{apiPort:port,database:'isolated disposable PostgreSQL',worker:'separate process'},negativeWrongRuntimePath:'rejected as expected'}));
} catch(error) {
  primaryError=error;throw error;
} finally {
  process.off('SIGINT',onInterrupt);process.off('SIGTERM',onTerminate);
  try { await cleanup(); } catch(error) { if(primaryError) console.error('isolated journey cleanup failed after primary error',error);else throw error; }
}
