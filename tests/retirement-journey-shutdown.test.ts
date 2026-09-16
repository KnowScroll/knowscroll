import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import test from 'node:test';

test('child exit can precede delivery of its final stopped event', {timeout: 5_000}, async (t) => {
  const finalLine=JSON.stringify({service:'reasoning-maintenance',event:'stopped'})+'\n';
  const delayedWriter=`setTimeout(()=>process.stdout.write(${JSON.stringify(finalLine)}),100)`;
  const childProgram=`const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(delayedWriter)}],{stdio:['ignore',1,'ignore']});child.unref()`;
  const child=spawn(process.execPath,['-e',childProgram],{detached:true,stdio:['ignore','pipe','inherit']});
  t.after(()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}});
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
  await closed;

  assert.equal(output,finalLine);
  assert.deepEqual(order,['exit','data','close']);
});
