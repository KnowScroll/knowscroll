import { readFile } from 'node:fs/promises';
import { pool, transaction, OWNER_ID } from '../packages/db/src/index.ts';
const assets = JSON.parse(await readFile('content/editorial-scrolls.json','utf8')) as Array<Record<string,unknown>>;
try { await transaction(async c=> {
 await c.query('INSERT INTO universe(id) VALUES($1) ON CONFLICT DO NOTHING',[OWNER_ID]);
 await c.query('INSERT INTO accounts(universe_id) VALUES($1) ON CONFLICT DO NOTHING',[OWNER_ID]);
 for (const [i,a] of assets.entries()) await c.query(`INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
 VALUES($1,1,'Scroll',$2,$3,$4,$5,$6,'documented',$7) ON CONFLICT(id) DO NOTHING`,[a.assetId,a.title,a.summary,a.body,a.sourceTitle,a.sourceUrl,i]);
}); console.log('Editorial library installed; existing content and user history preserved.'); } finally { await pool.end(); }
