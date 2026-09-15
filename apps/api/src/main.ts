import { buildApp } from './app.ts';
import { pool } from '../../../packages/db/src/index.ts';
if(process.env.NODE_ENV==='production') throw new Error('Bootstrap identity is development-only; implement production authentication before deployment');
const app=buildApp(process.env.KS_DEV_TOKEN ?? '');
await app.listen({host:'127.0.0.1',port:Number(process.env.PORT ?? 4310)});
console.log(JSON.stringify({service:'api',port:Number(process.env.PORT ?? 4310),identity:'local-development-only'}));
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,async()=>{await app.close();await pool.end();process.exit(0);});
