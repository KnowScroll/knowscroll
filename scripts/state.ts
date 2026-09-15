import {execFileSync} from 'node:child_process';
import {pool} from '../packages/db/src/index.ts';
try {
 const migrations=(await pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
 const jobs=(await pool.query('SELECT status,count(*)::integer FROM job GROUP BY status')).rows;
 const workers=(await pool.query("SELECT worker_id,last_seen,last_seen>now()-interval '3 seconds' AS recently_seen FROM worker_heartbeat ORDER BY last_seen DESC LIMIT 5")).rows;
 let api=false;try{api=(await fetch(`http://127.0.0.1:${process.env.PORT ?? 4310}/health`)).ok;}catch{}
 let git='uncommitted bootstrap';try{git=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}
 console.log(JSON.stringify({observedAt:new Date().toISOString(),git,migrations,jobs,workers,api,capabilities:{reasoning:false,cutroom:false,worldEvolution:false}},null,2));
} finally {await pool.end();}
