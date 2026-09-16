import assert from 'node:assert/strict';
import test from 'node:test';

import {seedDirectContextGraph,withReasoningContextSchema} from './helpers/reasoning-context-fixture.ts';

async function bindOriginalSession(
  pool: import('pg').Pool,
  graph: Awaited<ReturnType<typeof seedDirectContextGraph>>,
) {
  await pool.query(
    `INSERT INTO reasoning_context_job_session(job_id,universe_id,privacy_epoch,session_id)
     VALUES($1,$2,$3,$4)`,
    [graph.jobId,graph.scope.universeId,graph.scope.privacyEpoch,graph.scope.sessionId],
  );
}

test('idle direct withdrawal clock guard rejects raw bypasses while preserving its live-lease predecessor', async t => {
  await t.test('the unchanged live-worker branch does not need a new original-session binding', async () => {
    await withReasoningContextSchema('idle_legacy_live_lease', async pool => {
      const graph=await seedDirectContextGraph(pool);
      await pool.query(`UPDATE reasoning_job
        SET status='running',lease_owner='legacy-worker',lease_fence=1,
            lease_expires_at=clock_timestamp()+interval '1 hour'
        WHERE id=$1`,[graph.jobId]);
      const row=(await pool.query<{status:string;withdrawn_at:Date}>(`UPDATE reasoning_job
        SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,withdrawn_at='2000-01-01T00:00:00Z'
        WHERE id=$1 RETURNING status,withdrawn_at`,[graph.jobId])).rows[0]!;
      assert.equal(row.status,'cancelled');
      assert.ok(row.withdrawn_at.getUTCFullYear()>2025,'the database, not caller text, stamps withdrawal time');
    });
  });

  await t.test('idle cancellation requires the immutable original live session and exactly one fence advance', async () => {
    await withReasoningContextSchema('idle_cancel_raw_guards', async pool => {
      const unbound=await seedDirectContextGraph(pool);
      await assert.rejects(pool.query(`UPDATE reasoning_job
        SET status='cancelled',lease_fence=lease_fence+1,withdrawn_at=clock_timestamp()
        WHERE id=$1`,[unbound.jobId]),/requires a safely withdrawn Job/);

      const graph=await seedDirectContextGraph(pool);
      await bindOriginalSession(pool,graph);
      await assert.rejects(pool.query(`UPDATE reasoning_job
        SET status='cancelled',lease_fence=lease_fence+2,withdrawn_at=clock_timestamp()
        WHERE id=$1`,[graph.jobId]),/requires a safely withdrawn Job/);
      await pool.query('UPDATE device_session SET revoked_at=clock_timestamp() WHERE id=$1',[graph.scope.sessionId]);
      await assert.rejects(pool.query(`UPDATE reasoning_job
        SET status='cancelled',lease_fence=lease_fence+1,withdrawn_at=clock_timestamp()
        WHERE id=$1`,[graph.jobId]),/requires a safely withdrawn Job/);
      assert.deepEqual((await pool.query('SELECT status,lease_fence::text,withdrawn_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0],
        {status:'queued',lease_fence:'0',withdrawn_at:null});
    });
  });

  await t.test('deadline expiry is database-clock gated but does not require a live original session', async () => {
    await withReasoningContextSchema('idle_expiry_clock', async pool => {
      const graph=await seedDirectContextGraph(pool);
      await bindOriginalSession(pool,graph);
      await pool.query('UPDATE device_session SET revoked_at=clock_timestamp() WHERE id=$1',[graph.scope.sessionId]);
      await assert.rejects(pool.query(`UPDATE reasoning_job
        SET status='expired',lease_fence=lease_fence+1,withdrawn_at=clock_timestamp()
        WHERE id=$1`,[graph.jobId]),/requires a safely withdrawn Job/);
      await pool.query("UPDATE reasoning_job SET deadline=clock_timestamp()-interval '1 millisecond' WHERE id=$1",[graph.jobId]);
      const row=(await pool.query<{status:string;lease_fence:string;withdrawn_at:Date}>(`UPDATE reasoning_job
        SET status='expired',lease_fence=lease_fence+1,withdrawn_at=clock_timestamp()
        WHERE id=$1 RETURNING status,lease_fence::text,withdrawn_at`,[graph.jobId])).rows[0]!;
      assert.deepEqual({status:row.status,leaseFence:row.lease_fence},{status:'expired',leaseFence:'1'});
      assert.ok(row.withdrawn_at instanceof Date);
    });
  });

  await t.test('an expired running lease cannot impersonate the idle queued/waiting path', async () => {
    await withReasoningContextSchema('idle_running_refusal', async pool => {
      const graph=await seedDirectContextGraph(pool);
      await bindOriginalSession(pool,graph);
      await pool.query(`UPDATE reasoning_job SET status='running',lease_owner='stale-worker',lease_fence=1,
        lease_expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1`,[graph.jobId]);
      await assert.rejects(pool.query(`UPDATE reasoning_job
        SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,
            lease_fence=lease_fence+1,withdrawn_at=clock_timestamp()
        WHERE id=$1`,[graph.jobId]),/requires a safely withdrawn Job/);
    });
  });
});
