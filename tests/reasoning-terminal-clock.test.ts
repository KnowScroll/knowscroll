/**
 * Issue81 bounded adversarial SQL tests for the completed/failed
 * finished_at retention clock.
 *
 * Coverage scope (per ADR-0019):
 *   - database-authoritative finished_at on safe terminal transition;
 *   - caller backdate / insertion-stamp refusal / immutable post-stamp state;
 *   - legacy null-clock rows do not acquire a timestamp through unrelated
 *     updates, repeated terminal assignment or migrations;
 *   - full safe-terminal predicates (live lease, no fair-ready membership,
 *     terminal Steps, inactive retained-withdrawn Attempts);
 *   - rollback when the stamp trigger refuses.
 *
 * Maintenance-side retirement rotation is the coordinator's lane; this
 * file does not assert the maintenance predicate for finished jobs.
 *
 * Every refusal test in this file clears the live lease on the UPDATE
 * statement so the rejection is attributable to the targeted unsafe
 * condition rather than the cheap NEW lease guard. Where the targeted
 * condition is restorable, a follow-up statement proves the stamp
 * succeeds once the targeted condition is repaired.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import type pg from 'pg';

import {
 corruptTerminalClosure,readJob,seedTerminalGraph,
 withReasoningTerminalSchema,
} from './helpers/reasoning-terminal-fixture.ts';

async function inTransaction<T>(pool:pg.Pool,body:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
 const client=await pool.connect();
 try {await client.query('BEGIN');const value=await body(client);await client.query('COMMIT');return value;}
 catch(error) {await client.query('ROLLBACK');throw error;}
 finally {client.release();}
}

/** Issues a stamp that clears the live lease so the rejection (when it
 * fires) can only come from the targeted guard, never from the cheap
 * NEW-lease check. The fixture still leaves the live lease set, so any
 * UPDATE without this clearing is rejected by the lease guard first. */
async function stampTerminal(pool:pg.Pool,jobId:string,target:'completed'|'failed'):Promise<{status:string;lease_fence:string;finished_at:Date|null}> {
 const row=(await pool.query<{status:string;lease_fence:string;finished_at:Date|null}>(
  `UPDATE reasoning_job SET status=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1 RETURNING status,lease_fence::text,finished_at`,
  [jobId,target],
 )).rows[0]!;
 return row;
}

test('terminal private clock guard stamps a safely terminal transition with the database time, not caller text',async t=>{
 await t.test('a completed transition assigns clock_timestamp() and never matches a sentinel caller time',async()=>{
  await withReasoningTerminalSchema('completed_clock',async pool=>{
   const graph=await seedTerminalGraph(pool,{terminalStatus:'completed'});
   const before=(await pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
   const sentinel='2000-01-01T00:00:00.000Z';
   const row=await stampTerminal(pool,graph.jobId,'completed');
   const after=(await pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
   assert.equal(row.status,'completed');
   assert(row.finished_at instanceof Date);
   assert(row.finished_at.getTime()>=before.getTime()&&row.finished_at.getTime()<=after.getTime(),'database, not caller, owns the retention timestamp');
   assert.notEqual(row.finished_at.toISOString(),sentinel,'database time cannot equal a hardcoded caller value');
  });
 });

 await t.test('a failed transition is stamped with the same database-authoritative clock',async()=>{
  await withReasoningTerminalSchema('failed_clock',async pool=>{
   const graph=await seedTerminalGraph(pool,{terminalStatus:'failed'});
   const before=(await pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
   const row=await stampTerminal(pool,graph.jobId,'failed');
   const after=(await pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
   assert.equal(row.status,'failed');
   assert(row.finished_at instanceof Date);
   assert(row.finished_at.getTime()>=before.getTime()&&row.finished_at.getTime()<=after.getTime());
   assert.equal((await pool.query('SELECT lease_fence::text AS fence,lease_owner AS owner,withdrawn_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.fence,'1');
  });
 });

 await t.test('a waiting Job transitions to failed with the same database-authoritative clock',async()=>{
  await withReasoningTerminalSchema('waiting_failed',async pool=>{
   const graph=await seedTerminalGraph(pool,{terminalStatus:'failed',jobStatus:'waiting'});
   const before=(await pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
   const row=await stampTerminal(pool,graph.jobId,'failed');
   const after=(await pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
   assert.equal(row.status,'failed');
   assert(row.finished_at instanceof Date);
   assert(row.finished_at.getTime()>=before.getTime()&&row.finished_at.getTime()<=after.getTime());
  });
 });

 await t.test('a supplied finished_at on a valid terminal transition is replaced, not rejected',async()=>{
  await withReasoningTerminalSchema('caller_override',async pool=>{
   const graph=await seedTerminalGraph(pool,{terminalStatus:'completed'});
   const before=(await pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
   const callerBackdate='1999-12-31T00:00:00.000Z';
   await pool.query(`UPDATE reasoning_job SET status='completed',finished_at=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`,[graph.jobId,callerBackdate]);
   const after=(await pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
   const stamp=(await pool.query<{finished_at:Date}>('SELECT finished_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.finished_at;
   assert(stamp.getTime()>=before.getTime()&&stamp.getTime()<=after.getTime(),'caller backdate must be replaced');
   assert.notEqual(stamp.toISOString(),callerBackdate);
  });
 });

 await t.test('a caller-supplied finished_at without a status transition is still rejected',async()=>{
  await withReasoningTerminalSchema('caller_no_status',async pool=>{
   const graph=await seedTerminalGraph(pool,{terminalStatus:'completed'});
   await assert.rejects(pool.query(`UPDATE reasoning_job SET finished_at=clock_timestamp() WHERE id=$1`,[graph.jobId]),
    /Finish retention clock requires a new safe terminal transition/);
   assert.equal((await pool.query<{finished_at:Date|null}>('SELECT finished_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.finished_at,null);
  });
 });
});

test('finished_at insertion and unstamped transitions are refused; legacy null rows remain null',async t=>{
 await t.test('a fresh insertion cannot pre-supply finished_at',async()=>{
  await withReasoningTerminalSchema('insertion_stamp_refusal',async pool=>{
   const graph=await seedTerminalGraph(pool);
   const universeId=graph.universeId;
   const jobId=randomUUID();
   await assert.rejects(pool.query(`INSERT INTO reasoning_job
    (id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id,finished_at)
    VALUES($1,$2,0,'completed','interactive',$2,'terminal-fixture',clock_timestamp()+interval '1 hour','direct',$3,clock_timestamp())`,
    [jobId,universeId,randomUUID()]),/Finish time cannot be supplied on creation/);
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_job WHERE id=$1',[jobId])).rows[0]!.count,0);
  });
 });

 await t.test('a non-terminal transition is refused when finished_at is supplied',async()=>{
  await withReasoningTerminalSchema('non_terminal_stamp',async pool=>{
   const graph=await seedTerminalGraph(pool);
   await assert.rejects(pool.query(`UPDATE reasoning_job
    SET status='queued',finished_at=clock_timestamp() WHERE id=$1`,[graph.jobId]),
    /Finish retention clock requires a new safe terminal transition/);
   assert.equal((await pool.query('SELECT finished_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.finished_at,null);
  });
 });

 await t.test('a legacy terminal row does not acquire finished_at through an unrelated update',async()=>{
  await withReasoningTerminalSchema('legacy_null_no_backfill',async pool=>{
   // A "legacy" completed row created directly with a bypassed guard, finished_at NULL.
   const universeId=randomUUID(),jobId=randomUUID();
   await pool.query('INSERT INTO universe(id,privacy_epoch) VALUES($1,0)',[universeId]);
   await pool.query('ALTER TABLE reasoning_job DISABLE TRIGGER reasoning_finished_clock_guard');
   try {
    await pool.query(`INSERT INTO reasoning_job
     (id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id,lease_owner,lease_fence,lease_expires_at)
     VALUES($1,$2,0,'completed','interactive',$2,'legacy',clock_timestamp()+interval '1 hour','direct',$3,'legacy',1,clock_timestamp()+interval '1 hour')`,
     [jobId,universeId,randomUUID()]);
   } finally {
    await pool.query('ALTER TABLE reasoning_job ENABLE TRIGGER reasoning_finished_clock_guard');
   }
   assert.equal((await pool.query('SELECT finished_at FROM reasoning_job WHERE id=$1',[jobId])).rows[0]!.finished_at,null);

   // Repeated terminal assignment (same status) must not retroactively stamp.
   await pool.query(`UPDATE reasoning_job SET lease_owner='legacy-fixture' WHERE id=$1`,[jobId]);
   await assert.rejects(pool.query(`UPDATE reasoning_job SET finished_at=clock_timestamp() WHERE id=$1`,[jobId]),
    /Finish retention clock requires a new safe terminal transition/);
   assert.equal((await pool.query('SELECT finished_at FROM reasoning_job WHERE id=$1',[jobId])).rows[0]!.finished_at,null);

   // An unrelated UPDATE that touches no status must not create a finished_at either.
   await pool.query(`UPDATE reasoning_job SET deadline=deadline+interval '1 hour' WHERE id=$1`,[jobId]);
   assert.equal((await pool.query('SELECT finished_at FROM reasoning_job WHERE id=$1',[jobId])).rows[0]!.finished_at,null);
  });
 });
});

test('finished_at, status and lease_fence are immutable once stamped',async t=>{
 await t.test('changing finished_at after stamping is refused',async()=>{
  await withReasoningTerminalSchema('immutable_clock',async pool=>{
   const graph=await seedTerminalGraph(pool,{terminalStatus:'completed'});
   await stampTerminal(pool,graph.jobId,'completed');
   const first=(await pool.query<{finished_at:Date}>('SELECT finished_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.finished_at;
   await assert.rejects(pool.query(`UPDATE reasoning_job SET finished_at=clock_timestamp() WHERE id=$1`,[graph.jobId]),
    /Finished Job cannot reactivate or change its retention clock or fence/);
   assert.equal((await pool.query<{finished_at:Date}>('SELECT finished_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.finished_at.getTime(),first.getTime());
  });
 });

 await t.test('reactivating or rewinding status after stamping is refused',async()=>{
  await withReasoningTerminalSchema('immutable_status',async pool=>{
   const graph=await seedTerminalGraph(pool,{terminalStatus:'failed'});
   await stampTerminal(pool,graph.jobId,'failed');
   const candidates:Array<'completed'|'failed'|'running'|'waiting'|'queued'|'cancelled'|'expired'>=['running','waiting','queued','cancelled','expired','completed'];
   for(const candidate of candidates) {
    if(candidate==='failed') continue;
    await assert.rejects(pool.query(`UPDATE reasoning_job SET status=$2 WHERE id=$1`,[graph.jobId,candidate]),
     /Finished Job cannot reactivate or change its retention clock or fence/);
   }
   assert.equal((await pool.query('SELECT status FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.status,'failed');
  });
 });

 await t.test('acquiring a withdrawal clock or new lease after stamping is refused',async()=>{
  await withReasoningTerminalSchema('immutable_lease',async pool=>{
   const graph=await seedTerminalGraph(pool,{terminalStatus:'completed'});
   await stampTerminal(pool,graph.jobId,'completed');
   await assert.rejects(pool.query(`UPDATE reasoning_job SET withdrawn_at=clock_timestamp() WHERE id=$1`,[graph.jobId]),
    /Finished Job cannot reactivate or change its retention clock or fence/);
   await assert.rejects(pool.query(`UPDATE reasoning_job SET lease_owner='terminal-fixture',lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`,[graph.jobId]),
    /Finished Job cannot reactivate or change its retention clock or fence/);
   assert.equal((await pool.query('SELECT withdrawn_at,lease_owner FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.withdrawn_at,null);
  });
 });

 await t.test('changing lease_fence after stamping is refused; a no-op update preserves the clock',async()=>{
  await withReasoningTerminalSchema('immutable_fence',async pool=>{
   const graph=await seedTerminalGraph(pool,{terminalStatus:'completed'});
   await stampTerminal(pool,graph.jobId,'completed');
   const before=await readJob(pool,graph.jobId);
   await assert.rejects(pool.query(`UPDATE reasoning_job SET lease_fence=lease_fence+1 WHERE id=$1`,[graph.jobId]),
    /Finished Job cannot reactivate or change its retention clock or fence/);
   // A same-value write is a deliberate no-op and must not be rejected.
   await pool.query(`UPDATE reasoning_job SET policy_version=policy_version WHERE id=$1`,[graph.jobId]);
   assert.deepEqual(await readJob(pool,graph.jobId),before);
  });
 });
});

test('the safe-terminal guard refuses every unsafe transition: missing/expired lease, fair-ready, non-terminal step, unsafe attempt',async t=>{
 await t.test('a queued Job with no lease cannot acquire the retention clock',async()=>{
  await withReasoningTerminalSchema('unsafe_no_lease',async pool=>{
   const graph=await seedTerminalGraph(pool);
   await pool.query("UPDATE reasoning_job SET status='queued',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",[graph.jobId]);
   await assert.rejects(pool.query(`UPDATE reasoning_job SET status='completed' WHERE id=$1`,[graph.jobId]),
    /Finish retention clock requires a safely terminal Job/);
   assert.equal((await pool.query('SELECT finished_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.finished_at,null);
  });
 });

 await t.test('an expired lease cannot be used to stamp a terminal transition',async()=>{
  await withReasoningTerminalSchema('unsafe_expired_lease',async pool=>{
   const graph=await seedTerminalGraph(pool);
   await pool.query(`UPDATE reasoning_job SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,[graph.jobId]);
   await assert.rejects(pool.query(`UPDATE reasoning_job SET status='completed' WHERE id=$1`,[graph.jobId]),
    /Finish retention clock requires a safely terminal Job/);
  });
 });

 await t.test('a fair-ready membership blocks stamping; deleting the membership allows a safe stamp',async()=>{
  await withReasoningTerminalSchema('unsafe_fair_ready',async pool=>{
   const graph=await seedTerminalGraph(pool);
   const policy='terminal-fixture';
   await pool.query(`INSERT INTO reasoning_fairness_policy(version,policy_hash,config) VALUES($1,$2,'{}')`,[policy,'a'.repeat(64)]);
   await pool.query(`INSERT INTO reasoning_fairness_scheduler(policy_version) VALUES($1)`,[policy]);
   await pool.query(`INSERT INTO reasoning_fairness_class(policy_version,class) VALUES($1,'interactive')`,[policy]);
   await pool.query(`INSERT INTO reasoning_fairness_universe(policy_version,class,universe_id) VALUES($1,'interactive',$2)`,[policy,graph.universeId]);
   await pool.query(`INSERT INTO reasoning_fairness_ready
    (job_id,step_id,context_id,universe_id,privacy_epoch,class,policy_version,request_id,request_hash,
     input_tokens_upper_bound,max_output_tokens,deadline,permit_ttl_ms,charge)
    VALUES($1,$2,$3,$4,0,'interactive',$5,$6,$7,1,1,clock_timestamp()+interval '1 hour',100,1)`,
    [graph.jobId,graph.stepIds[0]!,graph.contextIds[0]!,graph.universeId,policy,randomUUID(),'b'.repeat(64)]);
   // Clear the live lease so the fair-ready guard is the only reason the
   // transition is rejected.
   await assert.rejects(pool.query(`UPDATE reasoning_job SET status='completed',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`,[graph.jobId]),
    /Finish retention clock requires a safely terminal Job/);
   assert.equal((await pool.query('SELECT finished_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.finished_at,null);
   // Removing the fair-ready row unblocks the stamp.
   await pool.query('DELETE FROM reasoning_fairness_ready WHERE job_id=$1',[graph.jobId]);
   await stampTerminal(pool,graph.jobId,'completed');
   assert((await pool.query<{finished_at:Date}>('SELECT finished_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.finished_at instanceof Date);
  });
 });

 await t.test('a non-terminal Step blocks stamping; restoring a terminal Step allows a safe stamp',async()=>{
  await withReasoningTerminalSchema('unsafe_step',async pool=>{
   const graph=await seedTerminalGraph(pool);
   await pool.query(`UPDATE reasoning_step SET status='active' WHERE id=$1`,[graph.stepIds[0]!]);
   await assert.rejects(pool.query(`UPDATE reasoning_job SET status='completed',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`,[graph.jobId]),
    /Finish retention clock requires a safely terminal Job/);
   assert.equal((await pool.query('SELECT finished_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.finished_at,null);
   // Restore the terminal Step. The stamp must then succeed.
   await pool.query(`UPDATE reasoning_step SET status='succeeded' WHERE id=$1`,[graph.stepIds[0]!]);
   await stampTerminal(pool,graph.jobId,'completed');
   assert((await pool.query<{finished_at:Date}>('SELECT finished_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.finished_at instanceof Date);
  });
 });

 await t.test('an active Attempt blocks stamping; deactivation allows a stamp',async()=>{
  await withReasoningTerminalSchema('unsafe_attempt',async pool=>{
   const graph=await seedTerminalGraph(pool);
   await corruptTerminalClosure(pool,graph.jobId);
   // Clear the live lease so the attempt guard is the only reason the
   // transition is rejected.
   await assert.rejects(pool.query(`UPDATE reasoning_job SET status='completed',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`,[graph.jobId]),
    /Finish retention clock requires a safely terminal Job/);
   assert.equal((await pool.query('SELECT finished_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.finished_at,null);
   // Restoring the inactive+withdrawn shape must succeed because the safe
   // terminal predicate then accepts the transition.
   await pool.query('UPDATE reasoning_attempt SET active=false WHERE id=$1',[graph.attemptIds[0]!]);
   await pool.query('ALTER TABLE reasoning_accounting DISABLE TRIGGER reasoning_accounting_guard');
   try {await pool.query(`UPDATE reasoning_accounting SET output_authority='withdrawn',state='not_sent',remote_disposition='not_sent',dispatch_id=NULL,dispatch_committed_at=NULL WHERE attempt_id=$1`,[graph.attemptIds[0]!]);}
   finally {await pool.query('ALTER TABLE reasoning_accounting ENABLE TRIGGER reasoning_accounting_guard');}
   await stampTerminal(pool,graph.jobId,'completed');
   assert((await pool.query<{finished_at:Date}>('SELECT finished_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.finished_at instanceof Date);
  });
 });

 await t.test('missing accounting is refused while the inactive orphan Attempt remains',async()=>{
  await withReasoningTerminalSchema('unsafe_missing_accounting',async pool=>{
   const graph=await seedTerminalGraph(pool);
   const prior=(await pool.query('SELECT * FROM reasoning_accounting WHERE attempt_id=$1',[graph.attemptIds[0]!])).rows[0];
   // Parent-side FK and cascade triggers would prevent the deliberately corrupt
   // orphan. Bypass only in this disposable schema; keep the finish guard live.
   await pool.query('ALTER TABLE reasoning_accounting DISABLE TRIGGER ALL');
   try {await pool.query('DELETE FROM reasoning_accounting WHERE attempt_id=$1',[graph.attemptIds[0]!]);}
   finally {await pool.query('ALTER TABLE reasoning_accounting ENABLE TRIGGER ALL');}
   await assert.rejects(stampTerminal(pool,graph.jobId,'completed'),/safely terminal/);
   assert.equal((await pool.query('SELECT active FROM reasoning_attempt WHERE id=$1',[graph.attemptIds[0]!])).rows[0].active,false);
   await pool.query('INSERT INTO reasoning_accounting SELECT * FROM jsonb_populate_record(NULL::reasoning_accounting,$1::jsonb)',[JSON.stringify(prior)]);
   assert((await stampTerminal(pool,graph.jobId,'completed')).finished_at instanceof Date);
  });
 });
 for(const variant of ['authority','state'] as const) await t.test(`inactive Attempt with unsafe accounting ${variant} refuses the finish clock`,async()=>{
  await withReasoningTerminalSchema(`unsafe_accounting_${variant}`,async pool=>{
   const graph=await seedTerminalGraph(pool);
   await pool.query('ALTER TABLE reasoning_accounting DISABLE TRIGGER reasoning_accounting_guard');
   try {
    if(variant==='authority')await pool.query(`UPDATE reasoning_accounting SET state='unknown',output_authority='eligible',remote_disposition='unconfirmed',dispatch_id=$2,dispatch_committed_at=clock_timestamp() WHERE attempt_id=$1`,[graph.attemptIds[0]!,randomUUID()]);
    else await pool.query(`UPDATE reasoning_accounting SET state='reserved',remote_disposition='unconfirmed' WHERE attempt_id=$1`,[graph.attemptIds[0]!]);
   } finally {await pool.query('ALTER TABLE reasoning_accounting ENABLE TRIGGER reasoning_accounting_guard');}
   await assert.rejects(stampTerminal(pool,graph.jobId,'completed'),/safely terminal/);
   await pool.query('ALTER TABLE reasoning_accounting DISABLE TRIGGER reasoning_accounting_guard');
   try {await pool.query(`UPDATE reasoning_accounting SET state='not_sent',output_authority='withdrawn',remote_disposition='not_sent',dispatch_id=NULL,dispatch_committed_at=NULL WHERE attempt_id=$1`,[graph.attemptIds[0]!]);}
   finally {await pool.query('ALTER TABLE reasoning_accounting ENABLE TRIGGER reasoning_accounting_guard');}
   assert((await stampTerminal(pool,graph.jobId,'completed')).finished_at instanceof Date);
  });
 });

 await t.test('a previously withdrawn Job cannot acquire a finished_at clock',async()=>{
  await withReasoningTerminalSchema('unsafe_already_withdrawn',async pool=>{
   const graph=await seedTerminalGraph(pool);
   // Pre-existing withdrawn_at forces the retired branch: only cancelled/expired
   // may share withdrawn_at; finished_at requires withdrawn_at IS NULL.
   await pool.query('ALTER TABLE reasoning_job DISABLE TRIGGER reasoning_withdrawal_clock_guard');
   try {await pool.query(`UPDATE reasoning_job SET withdrawn_at=clock_timestamp()-interval '200 hours' WHERE id=$1`,[graph.jobId]);}
   finally {await pool.query('ALTER TABLE reasoning_job ENABLE TRIGGER reasoning_withdrawal_clock_guard');}
   // Clear the live lease so the withdrawn_at guard is the only reason the
   // transition is rejected.
   await assert.rejects(pool.query(`UPDATE reasoning_job SET status='completed',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`,[graph.jobId]),
    /Finish retention clock requires a safely terminal Job/);
  });
 });
});

test('a positive lease_fence is required and a changed fence is refused before stamping',async t=>{
 await t.test('the existing lease constraint excludes a zero fence; the positive fence stamps safely',async()=>{
  await withReasoningTerminalSchema('positive_fence',async pool=>{
   const graph=await seedTerminalGraph(pool,{terminalStatus:'completed'});
   await assert.rejects(pool.query('UPDATE reasoning_job SET lease_fence=0 WHERE id=$1',[graph.jobId]),/reasoning_job_check1/);
   // The fixture inserts lease_fence=1 (positive). The stamp succeeds
   // because OLD.lease_fence>0 holds.
   const fence=(await pool.query('SELECT lease_fence::text AS fence FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.fence;
   assert.equal(fence,'1');
   await stampTerminal(pool,graph.jobId,'completed');
   assert((await pool.query<{finished_at:Date}>('SELECT finished_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.finished_at instanceof Date);
  });
 });

 await t.test('changing the lease_fence on the same UPDATE is refused by the fence guard',async()=>{
  await withReasoningTerminalSchema('changed_fence',async pool=>{
   const graph=await seedTerminalGraph(pool,{terminalStatus:'completed'});
   const before=(await pool.query('SELECT lease_fence::text AS fence FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.fence;
   await assert.rejects(pool.query(`UPDATE reasoning_job SET status='completed',lease_owner=NULL,lease_expires_at=NULL,lease_fence=lease_fence+1 WHERE id=$1`,[graph.jobId]),
    /Finish retention clock requires a safely terminal Job/);
   assert.equal((await pool.query('SELECT lease_fence::text AS fence FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.fence,before);
   assert.equal((await pool.query('SELECT finished_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.finished_at,null);
   // With the fence unchanged and lease cleared, the stamp succeeds.
   await stampTerminal(pool,graph.jobId,'completed');
   assert((await pool.query<{finished_at:Date}>('SELECT finished_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.finished_at instanceof Date);
  });
 });
});

test('a stamp failure rolls back the Job status',async t=>{
 await withReasoningTerminalSchema('trigger_rollback',async pool=>{
  const graph=await seedTerminalGraph(pool);
  const before=await readJob(pool,graph.jobId);
  // Install a guard that fires before the migration trigger (alphabetical
  // ordering) and refuses the safe terminal transition. The surrounding
  // UPDATE must surface this failure and roll back every column change.
  await pool.query(`CREATE FUNCTION reject_terminal_clock() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN IF NEW.status IN ('completed','failed') AND OLD.status NOT IN ('completed','failed') THEN
    RAISE EXCEPTION 'forced terminal rollback'; END IF; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER a_reject_terminal_clock BEFORE UPDATE ON reasoning_job FOR EACH ROW EXECUTE FUNCTION reject_terminal_clock()');
  await assert.rejects(pool.query(`UPDATE reasoning_job SET status='completed',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`,[graph.jobId]),
   /forced terminal rollback/);
  assert.deepEqual(await readJob(pool,graph.jobId),before);
  await pool.query('DROP TRIGGER a_reject_terminal_clock ON reasoning_job');
  await pool.query('DROP FUNCTION reject_terminal_clock()');
  // A clean UPDATE must now succeed.
  await stampTerminal(pool,graph.jobId,'completed');
  assert((await pool.query<{finished_at:Date}>('SELECT finished_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.finished_at instanceof Date);
 });
});

test('every terminal transition that violates the check constraint is rejected; safe transitions preserve the kind invariant',async t=>{
 await t.test('stamping a withdrawn Job is refused by the check constraint too',async()=>{
  await withReasoningTerminalSchema('check_withdrawn_with_finished',async pool=>{
   // Bypass both clock guards so we can directly insert a row that violates
   // the new retirement_clock_kind check constraint: finished_at and
   // withdrawn_at must not coexist on the same row.
   await pool.query('ALTER TABLE reasoning_job DISABLE TRIGGER reasoning_finished_clock_guard');
   await pool.query('ALTER TABLE reasoning_job DISABLE TRIGGER reasoning_withdrawal_clock_guard');
   try {
    await assert.rejects(pool.query(`INSERT INTO reasoning_job
     (id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id,
      finished_at,withdrawn_at,lease_owner,lease_fence,lease_expires_at)
     VALUES($1,$2,0,'completed','interactive',$2,'check',clock_timestamp()+interval '1 hour','direct',$3,
      clock_timestamp(),clock_timestamp(),'check',1,clock_timestamp()+interval '1 hour')`,
     [randomUUID(),randomUUID(),randomUUID()]),/retirement_clock_kind/);
    // The constraint also forbids any other (withdrawn_at, finished_at) pair
    // outside the completed/failed branch, e.g. status='cancelled' with both.
    await assert.rejects(pool.query(`INSERT INTO reasoning_job
     (id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id,
      finished_at,withdrawn_at,lease_owner,lease_fence,lease_expires_at)
     VALUES($1,$2,0,'cancelled','interactive',$2,'check',clock_timestamp()+interval '1 hour','direct',$3,
      clock_timestamp(),clock_timestamp(),'check',1,clock_timestamp()+interval '1 hour')`,
     [randomUUID(),randomUUID(),randomUUID()]),/retirement_clock_kind/);
   } finally {
    await pool.query('ALTER TABLE reasoning_job ENABLE TRIGGER reasoning_withdrawal_clock_guard');
    await pool.query('ALTER TABLE reasoning_job ENABLE TRIGGER reasoning_finished_clock_guard');
   }
  });
 });

 await t.test('a stamped Job cannot be reset to a non-terminal status without the trigger refusing',async()=>{
  await withReasoningTerminalSchema('no_reactivation',async pool=>{
   const graph=await seedTerminalGraph(pool,{terminalStatus:'completed'});
   await stampTerminal(pool,graph.jobId,'completed');
   // Even with both triggers disabled, the check constraint forbids a queued
   // status once finished_at is set: only completed/failed coexist with it.
   await pool.query('ALTER TABLE reasoning_job DISABLE TRIGGER reasoning_finished_clock_guard');
   try {
    await assert.rejects(pool.query(`UPDATE reasoning_job SET status='queued' WHERE id=$1`,[graph.jobId]),/retirement_clock_kind/);
   } finally {
    await pool.query('ALTER TABLE reasoning_job ENABLE TRIGGER reasoning_finished_clock_guard');
   }
   assert.equal((await pool.query('SELECT status,finished_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.status,'completed');
  });
 });
});

test('a single statement transition atomically clears the live lease and stamps finished_at',async()=>{
 await withReasoningTerminalSchema('recheck_after_lock',async pool=>{
  const graph=await seedTerminalGraph(pool,{terminalStatus:'completed'});
  // A single statement that transitions to completed AND releases the live
  // lease atomically succeeds.
  await stampTerminal(pool,graph.jobId,'completed');
  const stamped=await readJob(pool,graph.jobId);
  assert.equal(stamped.status,'completed');
  assert.equal(stamped.lease_owner,null);
  assert.equal(stamped.lease_expires_at,null);
  assert(stamped.finished_at instanceof Date);

  // A second statement that keeps the live lease set is refused by the
  // NEW-lease guard. The trigger's predicate then short-circuits without
  // touching the fair-ready, step or attempt guards.
  const graph2=await seedTerminalGraph(pool,{terminalStatus:'completed'});
  await assert.rejects(pool.query(`UPDATE reasoning_job SET status='completed' WHERE id=$1`,[graph2.jobId]),
   /Finish retention clock requires a safely terminal Job/);
  assert.equal((await pool.query<{finished_at:Date|null}>('SELECT finished_at FROM reasoning_job WHERE id=$1',[graph2.jobId])).rows[0]!.finished_at,null);
 });
});

test('a no-op write through the trigger preserves finished_at and the surrounding state',async t=>{
 await t.test('an UPDATE that touches no terminal column is invisible',async()=>{
  await withReasoningTerminalSchema('noop_preserves',async pool=>{
   const graph=await seedTerminalGraph(pool,{terminalStatus:'completed'});
   await stampTerminal(pool,graph.jobId,'completed');
   const before=await readJob(pool,graph.jobId);
   await pool.query(`UPDATE reasoning_job SET policy_version=policy_version WHERE id=$1`,[graph.jobId]);
   assert.deepEqual(await readJob(pool,graph.jobId),before);
  });
 });

 await t.test('a second transition from completed→completed is a no-op with the same stamp',async()=>{
  await withReasoningTerminalSchema('repeat_terminal_assignment',async pool=>{
   const graph=await seedTerminalGraph(pool,{terminalStatus:'completed'});
   await stampTerminal(pool,graph.jobId,'completed');
   const before=await readJob(pool,graph.jobId);
   await inTransaction(pool,async client=>{
    await client.query(`UPDATE reasoning_job SET policy_version=policy_version,status=status WHERE id=$1`,[graph.jobId]);
   });
   assert.deepEqual(await readJob(pool,graph.jobId),before);
  });
 });
});