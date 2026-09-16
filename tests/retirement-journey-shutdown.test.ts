import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

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
