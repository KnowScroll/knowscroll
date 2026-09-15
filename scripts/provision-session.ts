import { execFileSync } from 'node:child_process';
import { mkdir, open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { authenticateAndLock, pool, provisionIdentity, revokeSession, transaction } from '../packages/db/src/index.ts';

function usage(): never {
 throw new Error('Usage: provision-session.ts --out PATH [--universe-id UUID] [--device-id UUID] [--expires-in-hours N]');
}

const values = new Map<string,string>();
for (let i=2; i<process.argv.length; i+=2) {
 const key=process.argv[i], value=process.argv[i+1];
 if (!key?.startsWith('--') || value === undefined || values.has(key)) usage();
 values.set(key, value);
}
for (const key of values.keys()) if (!['--out','--universe-id','--device-id','--expires-in-hours'].includes(key)) usage();
const outValue=values.get('--out'); if (!outValue) usage();
const outputPath=resolve(outValue);

async function safeDestination(path: string): Promise<string> {
 await mkdir(dirname(path), {recursive:true});
 const parent=await realpath(dirname(path));
 const canonicalPath=join(parent,basename(path));
 let root: string;
 try { root=execFileSync('git',['-C',parent,'rev-parse','--show-toplevel'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); }
 catch { return canonicalPath; }
 try { execFileSync('git',['-C',root,'check-ignore','--quiet','--',canonicalPath],{stdio:'ignore'}); }
 catch { throw new Error('Credential destination is inside a Git repository and is not ignored'); }
 return canonicalPath;
}

try {
 const safePath=await safeDestination(outputPath);
 const handle=await open(safePath,'wx',0o600);
 const expiresRaw=values.get('--expires-in-hours');
 let provisioned: Awaited<ReturnType<typeof provisionIdentity>> | undefined;
 try {
  provisioned=await provisionIdentity({
   universeId:values.get('--universe-id'), deviceId:values.get('--device-id'),
   expiresInHours:expiresRaw === undefined ? undefined : Number(expiresRaw),
  });
  await handle.writeFile(`${JSON.stringify(provisioned,null,2)}\n`,{encoding:'utf8'});
 } catch (error) {
  await handle.close(); await unlink(safePath);
  if (provisioned) {
   try { await transaction(async client=>revokeSession(client,await authenticateAndLock(client,provisioned!.token))); }
   catch { /* Preserve the credential delivery error; operators can revoke by session ID if cleanup also failed. */ }
  }
  throw error;
 }
 await handle.close();
 console.log(`Provisioned device credential at ${isAbsolute(outValue) ? outputPath : outValue}`);
} finally { await pool.end(); }
