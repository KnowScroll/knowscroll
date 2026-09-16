import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import pg from 'pg';
import {trackPoolDisconnect} from '../scripts/lib/pg-disconnect.ts';

test('child exit can precede delivery of its final stopped event', {timeout: 5_000}, async (t) => {
  const directory=await mkdtemp(join(tmpdir(),'knowscroll-retirement-close-'));
  const marker=join(directory,'release');
  const finalLine=JSON.stringify({service:'reasoning-maintenance',event:'stopped'})+'\n';
  const gatedWriter=`const {existsSync}=require('node:fs');const poll=()=>existsSync(${JSON.stringify(marker)})?process.stdout.write(${JSON.stringify(finalLine)}):setTimeout(poll,5);poll()`;
  const childProgram=`const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(gatedWriter)}],{stdio:['ignore',1,'ignore']});child.unref()`;
  const child=spawn(process.execPath,['-e',childProgram],{detached:true,stdio:['ignore','pipe','inherit']});
  t.after(async()=>{
    if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
    await rm(directory,{recursive:true,force:true});
  });
  assert(child.stdout);
  let output='';
  const order:string[]=[];
  child.stdout.on('data',chunk=>{output+=String(chunk);order.push('data');});
  child.on('exit',()=>{order.push('exit');});
  child.on('close',()=>{order.push('close');});
  const exited=once(child,'exit'),closed=once(child,'close');

  await exited;
  assert.equal(output,'');
  assert.deepEqual(order,['exit']);
  await writeFile(marker,'release');
  await closed;

  assert.equal(output,finalLine);
  assert.deepEqual(order,['exit','data','close']);
});

test('pg pool end can resolve before its released client physically disconnects', {timeout: 10_000}, async () => {
  const config=Object.fromEntries((await readFile('.env','utf8').catch(()=>''))
    .split('\n').filter(line=>/^[A-Z_][A-Z0-9_]*=/.test(line)).map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));
  const base=new URL(process.env.DATABASE_URL??config.DATABASE_URL??'');
  const name=`knowscroll_test_pg_disconnect_${randomUUID().replaceAll('-','')}`;
  const adminUrl=new URL(base);adminUrl.pathname='/postgres';
  const testUrl=new URL(base);testUrl.pathname=`/${name}`;
  const admin=new pg.Client({connectionString:adminUrl.toString()});
  const pool=new pg.Pool({connectionString:testUrl.toString()});
  let created=false,poolEndStarted=false,client:pg.PoolClient|undefined,releaseEnd:undefined|(()=>void),endRequested:undefined|(()=>void);
  let endReleased=false;
  const endRequest=new Promise<void>(resolve=>{endRequested=resolve;});
  const endRelease=new Promise<void>(resolve=>{releaseEnd=()=>{endReleased=true;resolve();};});
  const errors:unknown[]=[];
  const removes:pg.PoolClient[]=[];
  pool.on('connect',connected=>{client=connected;});
  pool.on('remove',removed=>{removes.push(removed);});
  pool.on('error',error=>{errors.push(error);});
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);created=true;
    await pool.query('SELECT 1');
    assert(client);
    const originalEnd=client.end.bind(client);
    client.end=((callback:(error:Error)=>void)=>{
      endRequested?.();
      if(endReleased)return originalEnd(callback);
      void endRelease.then(()=>originalEnd(callback));
    }) as typeof client.end;

    poolEndStarted=true;
    await Promise.all([endRequest,pool.end()]);
    assert.equal(removes.length,0);
    assert.equal(Number((await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1',[name])).rows[0]!.count),1);

    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);created=false;
    for(let i=0;i<100&&errors.length===0;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(errors.length,1);
    assert.equal(errors[0]&&typeof errors[0]==='object'&&'code' in errors[0]&&(errors[0] as {code?:unknown}).code==='57P01'?'57P01':'unknown','57P01');
    releaseEnd?.();
    for(let i=0;i<100&&removes.length===0;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(removes.length>0);
  } finally {
    releaseEnd?.();
    if(!poolEndStarted)await pool.end().catch(()=>{});
    for(let i=0;i<100&&removes.length===0;i++)await new Promise(resolve=>setTimeout(resolve,10));
    if(created)await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
});

test('tracked physical disconnect precedes ordinary database drop', {timeout: 10_000}, async () => {
  const config=Object.fromEntries((await readFile('.env','utf8').catch(()=>''))
    .split('\n').filter(line=>/^[A-Z_][A-Z0-9_]*=/.test(line)).map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));
  const base=new URL(process.env.DATABASE_URL??config.DATABASE_URL??'');
  const name=`knowscroll_test_pg_disconnect_${randomUUID().replaceAll('-','')}`;
  const adminUrl=new URL(base);adminUrl.pathname='/postgres';
  const testUrl=new URL(base);testUrl.pathname=`/${name}`;
  const admin=new pg.Client({connectionString:adminUrl.toString()});
  const pool=new pg.Pool({connectionString:testUrl.toString()});
  const tracker=trackPoolDisconnect(pool);
  let created=false,poolEndStarted=false,client:pg.PoolClient|undefined,releaseEnd:undefined|(()=>void),endRequested:undefined|(()=>void);
  let endReleased=false;
  const endRequest=new Promise<void>(resolve=>{endRequested=resolve;});
  const endRelease=new Promise<void>(resolve=>{releaseEnd=()=>{endReleased=true;resolve();};});
  const errors:unknown[]=[];
  pool.on('connect',connected=>{client=connected;});
  pool.on('error',error=>{errors.push(error);});
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);created=true;
    await pool.query('SELECT 1');
    assert(client);
    const originalEnd=client.end.bind(client);
    client.end=((callback:(error:Error)=>void)=>{
      endRequested?.();
      if(endReleased)return originalEnd(callback);
      void endRelease.then(()=>originalEnd(callback));
    }) as typeof client.end;

    poolEndStarted=true;
    await Promise.all([endRequest,pool.end()]);
    assert.equal(tracker.pendingCount(),1);
    assert.equal(await tracker.wait(admin,name),false);
    assert.equal(tracker.pendingCount(),1);
    assert.equal(Number((await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1',[name])).rows[0]!.count),1);
    assert.equal(errors.length,0);

    releaseEnd?.();
    assert.equal(await tracker.wait(admin,name),true);
    assert.equal(tracker.pendingCount(),0);
    await admin.query(`DROP DATABASE "${name}"`);created=false;
    assert.equal(errors.length,0);
    assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount,0);
  } finally {
    releaseEnd?.();
    if(!poolEndStarted)await pool.end().catch(()=>{});
    if(created)await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
});
