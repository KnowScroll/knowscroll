import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import pg from 'pg';

import {runMigrations} from '../packages/db/src/migrations.ts';

const databaseUrl = process.env.DATABASE_URL ?? (() => { throw new Error('DATABASE_URL required'); })();
const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!databaseName.startsWith('knowscroll_test_')) {
  throw new Error(`Reasoning storage tests require a disposable knowscroll_test_* database, received ${databaseName}`);
}

const migrationNames = [
  '0001_bootstrap.sql',
  '0002_identity_epochs.sql',
  '0003_history_clear.sql',
  '0004_reasoning_storage.sql',
] as const;

type PrivateGraph = {
  universeId: string;
  epoch: number;
  jobId: string;
  contextId: string;
  stepId: string;
};

type AttemptGraph = PrivateGraph & {
  attemptId: string;
  requestId: string;
  permitId: string;
  reservationSetId: string;
  bucketId: string;
  dispatchId: string | null;
};

async function withSchema(name: string, fn: (pool: pg.Pool, directory: string) => Promise<void>): Promise<void> {
  const schema = `reasoning_${name}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({connectionString: databaseUrl});
  const directory = await mkdtemp(join(tmpdir(), 'knowscroll-reasoning-storage-'));
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new pg.Pool({connectionString: url.toString(), max: 4});
  try {
    await fn(pool, directory);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await rm(directory, {recursive: true});
  }
}

async function copyMigrations(directory: string, count: number = migrationNames.length): Promise<void> {
  for (const name of migrationNames.slice(0, count)) {
    await writeFile(join(directory, name), await readFile(join('packages/db/migrations', name), 'utf8'));
  }
}

async function install(pool: pg.Pool, directory: string): Promise<void> {
  await copyMigrations(directory);
  await runMigrations(pool, {directory});
}

async function insertUniverse(pool: pg.Pool, epoch = 0): Promise<string> {
  const universeId = randomUUID();
  await pool.query('INSERT INTO universe(id,privacy_epoch) VALUES($1,$2)', [universeId, epoch]);
  await pool.query('INSERT INTO accounts(universe_id) VALUES($1)', [universeId]);
  return universeId;
}

async function insertPrivateGraph(pool: pg.Pool, universeId: string, epoch = 0, ordinal = 1): Promise<PrivateGraph> {
  const jobId = randomUUID();
  const contextId = randomUUID();
  const stepId = randomUUID();
  await pool.query(
    `INSERT INTO reasoning_job
       (id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id)
     VALUES($1,$2,$3,'queued','interactive',$2,'policy-v1',clock_timestamp()+interval '1 hour','direct',$4)`,
    [jobId, universeId, epoch, randomUUID()],
  );
  await pool.query(
    `INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version)
     VALUES($1,$2,$3,$4,$5,'policy-v1','source-v1')`,
    [contextId, jobId, universeId, epoch, 'a'.repeat(64)],
  );
  await pool.query(
    `INSERT INTO reasoning_context_read(context_id,universe_id,privacy_epoch,kind,scope_kind,scope_universe_id,entity_key,revision)
     VALUES($1,$2,$3,'source','public',NULL,'source:fixture',1)`,
    [contextId, universeId, epoch],
  );
  await pool.query(
    `INSERT INTO reasoning_step(id,job_id,universe_id,privacy_epoch,context_id,ordinal,status)
     VALUES($1,$2,$3,$4,$5,$6,'pending')`,
    [stepId, jobId, universeId, epoch, contextId, ordinal],
  );
  return {universeId, epoch, jobId, contextId, stepId};
}

async function insertAttempt(
  pool: pg.Pool,
  graph: PrivateGraph,
  options: {ordinal?: number; previousAttemptId?: string | null; active?: boolean; consumed?: boolean; bucketId?: string} = {},
): Promise<AttemptGraph> {
  const attemptId = randomUUID();
  const requestId = randomUUID();
  const permitId = randomUUID();
  const reservationSetId = randomUUID();
  const bucketId = options.bucketId ?? randomUUID();
  const dispatchId = options.consumed ? randomUUID() : null;
  const ordinal = options.ordinal ?? 1;

  await pool.query(
    `INSERT INTO reasoning_accounting
       (attempt_id,universe_id,privacy_epoch,request_id,route_id,route_profile_version,max_output_tokens,deadline)
     VALUES($1,$2,$3,$4,'minimax-m3','profile-v1',512,clock_timestamp()+interval '1 hour')`,
    [attemptId, graph.universeId, graph.epoch, requestId],
  );
  await pool.query(
    `INSERT INTO reasoning_bucket(id,dimension,unit,window_id,capacity)
     VALUES($1,'request_rate','requests','window-v1',100) ON CONFLICT(id) DO NOTHING`,
    [bucketId],
  );
  await pool.query(
    `INSERT INTO reasoning_permit(id,attempt_id,universe_id,privacy_epoch,reservation_set_id,expires_at)
     VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '10 minutes')`,
    [permitId, attemptId, graph.universeId, graph.epoch, reservationSetId],
  );
  await pool.query(
    `INSERT INTO reasoning_reservation(id,attempt_id,reservation_set_id,bucket_id,dimension,unit,amount)
     VALUES($1,$2,$3,$4,'request_rate','requests',1)`,
    [randomUUID(), attemptId, reservationSetId, bucketId],
  );
  await pool.query(
    `INSERT INTO reasoning_attempt
       (id,job_id,step_id,context_id,universe_id,privacy_epoch,ordinal,previous_attempt_id,lease_fence,request_hash,permit_id,reservation_set_id,active)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12)`,
    [
      attemptId, graph.jobId, graph.stepId, graph.contextId, graph.universeId, graph.epoch,
      ordinal, options.previousAttemptId ?? null, 'b'.repeat(64), permitId, reservationSetId, options.active ?? true,
    ],
  );

  if (dispatchId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE reasoning_accounting SET state='dispatch_committed',dispatch_id=$2,dispatch_committed_at=clock_timestamp()
         WHERE attempt_id=$1`,
        [attemptId, dispatchId],
      );
      await client.query(
        `UPDATE reasoning_permit SET state='consumed',dispatch_id=$2,consumed_at=clock_timestamp() WHERE attempt_id=$1`,
        [attemptId, dispatchId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return {...graph, attemptId, requestId, permitId, reservationSetId, bucketId, dispatchId};
}

async function insertReceipt(pool: pg.Pool, attempt: AttemptGraph, fingerprint = 'c'.repeat(64)): Promise<string> {
  assert(attempt.dispatchId);
  const receiptId = randomUUID();
  await pool.query(
    `INSERT INTO reasoning_receipt
       (id,attempt_id,universe_id,privacy_epoch,request_id,dispatch_id,route_id,route_profile_version,fingerprint,
        evidence_kind,observed_at,remote_disposition,outcome,input_tokens,output_tokens)
     VALUES($1,$2,$3,$4,$5,$6,'minimax-m3','profile-v1',$7,'original_transport',clock_timestamp(),'terminal','success',10,5)`,
    [receiptId, attempt.attemptId, attempt.universeId, attempt.epoch, attempt.requestId, attempt.dispatchId, fingerprint],
  );
  return receiptId;
}

test('reasoning storage migration and invariants against isolated PostgreSQL', async (t) => {
  await t.test('fresh and populated 0001-0003 upgrades preserve rows, checksums, and repeat cleanly', async () => {
    await withSchema('upgrade', async (pool, directory) => {
      await copyMigrations(directory, 3);
      assert.deepEqual((await runMigrations(pool, {directory})).applied, migrationNames.slice(0, 3));
      const universeId = await insertUniverse(pool);
      const assetId = randomUUID();
      const eventId = randomUUID();
      await pool.query(
        `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
         VALUES($1,1,'Scroll','title','summary','body','source','https://example.test','documented',1)`,
        [assetId],
      );
      await pool.query(
        `INSERT INTO ledger(id,universe_id,kind,client_key,payload,privacy_epoch)
         VALUES($1,$2,'keep',$3,$4,0)`,
        [eventId, universeId, randomUUID(), JSON.stringify({assetId})],
      );
      const before = await pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name');
      const originalRows = await Promise.all([
        pool.query('SELECT * FROM universe WHERE id=$1', [universeId]),
        pool.query('SELECT * FROM accounts WHERE universe_id=$1', [universeId]),
        pool.query('SELECT * FROM asset WHERE id=$1', [assetId]),
        pool.query('SELECT * FROM ledger WHERE id=$1', [eventId]),
      ]);

      await copyMigrations(directory, 4);
      assert.deepEqual(await runMigrations(pool, {directory}), {applied: ['0004_reasoning_storage.sql'], adopted: []});
      assert.deepEqual(await runMigrations(pool, {directory}), {applied: [], adopted: []});
      const upgradedRows = await Promise.all([
        pool.query('SELECT * FROM universe WHERE id=$1', [universeId]),
        pool.query('SELECT * FROM accounts WHERE universe_id=$1', [universeId]),
        pool.query('SELECT * FROM asset WHERE id=$1', [assetId]),
        pool.query('SELECT * FROM ledger WHERE id=$1', [eventId]),
      ]);
      assert.deepEqual(upgradedRows.map((result) => result.rows), originalRows.map((result) => result.rows));
      const after = await pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name');
      assert.deepEqual(after.rows.slice(0, 3), before.rows);
      for (const [index, name] of migrationNames.entries()) {
        const sql = await readFile(join('packages/db/migrations', name), 'utf8');
        assert.equal(after.rows[index]?.checksum, createHash('sha256').update(sql).digest('hex'));
      }
    });

    await withSchema('fresh', async (pool, directory) => {
      await copyMigrations(directory);
      assert.deepEqual((await runMigrations(pool, {directory})).applied, [...migrationNames]);
      assert.deepEqual(await runMigrations(pool, {directory}), {applied: [], adopted: []});
    });
  });

  await t.test('composite scope, context scope, and immutable snapshots reject cross-boundary mutation', async () => {
    await withSchema('scope', async (pool, directory) => {
      await install(pool, directory);
      const firstUniverse = await insertUniverse(pool, 2);
      const secondUniverse = await insertUniverse(pool, 2);
      const first = await insertPrivateGraph(pool, firstUniverse, 2);
      const second = await insertPrivateGraph(pool, secondUniverse, 2);

      await assert.rejects(pool.query(
        `INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version)
         VALUES($1,$2,$3,3,$4,'policy-v1','source-v1')`,
        [randomUUID(), first.jobId, firstUniverse, 'd'.repeat(64)],
      ));
      await assert.rejects(pool.query(
        `INSERT INTO reasoning_context_read(context_id,universe_id,privacy_epoch,kind,scope_kind,scope_universe_id,entity_key,revision)
         VALUES($1,$2,2,'entity','universe',$3,'entity:wrong',1)`,
        [first.contextId, firstUniverse, secondUniverse],
      ));
      await assert.rejects(pool.query(
        `INSERT INTO reasoning_step(id,job_id,universe_id,privacy_epoch,context_id,ordinal,status)
         VALUES($1,$2,$3,2,$4,2,'pending')`,
        [randomUUID(), first.jobId, firstUniverse, second.contextId],
      ));

      const attempt = await insertAttempt(pool, first);
      for (const [scopeUniverse, scopeEpoch] of [[secondUniverse, 2], [firstUniverse, 3]] as const) {
        const accountId = randomUUID();
        await pool.query(
          `INSERT INTO reasoning_accounting(attempt_id,universe_id,privacy_epoch,request_id,route_id,route_profile_version,max_output_tokens,deadline)
           VALUES($1,$2,2,$3,'minimax-m3','profile-v1',1,clock_timestamp()+interval '1 hour')`,
          [accountId, firstUniverse, randomUUID()],
        );
        await assert.rejects(pool.query(
          `INSERT INTO reasoning_permit(id,attempt_id,universe_id,privacy_epoch,reservation_set_id,expires_at)
           VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 minute')`,
          [randomUUID(), accountId, scopeUniverse, scopeEpoch, randomUUID()],
        ));
      }
      await assert.rejects(pool.query('UPDATE reasoning_context SET content_hash=$2 WHERE id=$1', [first.contextId, 'e'.repeat(64)]));
      await assert.rejects(pool.query('UPDATE reasoning_context_read SET revision=2 WHERE context_id=$1', [first.contextId]));
      await assert.rejects(pool.query('DELETE FROM reasoning_context_read WHERE context_id=$1', [first.contextId]));
      await assert.rejects(pool.query(
        `INSERT INTO reasoning_context_read(context_id,universe_id,privacy_epoch,kind,scope_kind,scope_universe_id,entity_key,revision)
         VALUES($1,$2,2,'policy','public',NULL,'policy:late',1)`,
        [first.contextId, firstUniverse],
      ));
      await assert.rejects(pool.query('UPDATE reasoning_attempt SET request_hash=$2 WHERE id=$1', [attempt.attemptId, 'f'.repeat(64)]));
      await assert.rejects(pool.query('UPDATE reasoning_accounting SET request_id=$2 WHERE attempt_id=$1', [attempt.attemptId, randomUUID()]));
      await pool.query('UPDATE reasoning_attempt SET active=false WHERE id=$1', [attempt.attemptId]);
      await assert.rejects(pool.query('UPDATE reasoning_attempt SET active=true WHERE id=$1', [attempt.attemptId]));
    });
  });

  await t.test('duplicate ordinals, request/dispatch identities, and active Attempts fail closed', async () => {
    await withSchema('unique', async (pool, directory) => {
      await install(pool, directory);
      const universeId = await insertUniverse(pool);
      const graph = await insertPrivateGraph(pool, universeId);
      await assert.rejects(pool.query(
        `INSERT INTO reasoning_step(id,job_id,universe_id,privacy_epoch,context_id,ordinal,status)
         VALUES($1,$2,$3,0,$4,1,'pending')`,
        [randomUUID(), graph.jobId, universeId, graph.contextId],
      ));
      const attempt = await insertAttempt(pool, graph, {consumed: true});
      await assert.rejects(pool.query(
        `INSERT INTO reasoning_accounting(attempt_id,universe_id,privacy_epoch,request_id,route_id,route_profile_version,max_output_tokens,deadline)
         VALUES($1,$2,0,$3,'minimax-m3','profile-v1',1,clock_timestamp()+interval '1 hour')`,
        [randomUUID(), universeId, attempt.requestId],
      ));
      await assert.rejects(pool.query(
        `INSERT INTO reasoning_accounting
          (attempt_id,universe_id,privacy_epoch,request_id,route_id,route_profile_version,max_output_tokens,deadline,state,dispatch_id,dispatch_committed_at)
         VALUES($1,$2,0,$3,'minimax-m3','profile-v1',1,clock_timestamp()+interval '1 hour','dispatch_committed',$4,clock_timestamp())`,
        [randomUUID(), universeId, randomUUID(), attempt.dispatchId],
      ));
      await assert.rejects(insertAttempt(pool, graph));
      await assert.rejects(insertAttempt(pool, graph, {ordinal: 2, previousAttemptId: attempt.attemptId}));
    });
  });

  await t.test('Attempt predecessor must be the immediately prior Attempt on the same Step', async () => {
    await withSchema('predecessor', async (pool, directory) => {
      await install(pool, directory);
      const universeId = await insertUniverse(pool);
      const graph = await insertPrivateGraph(pool, universeId);
      const otherStepId = randomUUID();
      await pool.query(
        `INSERT INTO reasoning_step(id,job_id,universe_id,privacy_epoch,context_id,ordinal,status)
         VALUES($1,$2,$3,0,$4,2,'pending')`,
        [otherStepId, graph.jobId, universeId, graph.contextId],
      );
      const first = await insertAttempt(pool, graph, {active: false});
      const other = await insertAttempt(pool, {...graph, stepId: otherStepId}, {active: false});
      await assert.rejects(insertAttempt(pool, graph, {ordinal: 2, previousAttemptId: other.attemptId}));
      const second = await insertAttempt(pool, graph, {ordinal: 2, previousAttemptId: first.attemptId});
      assert.equal(second.stepId, graph.stepId);
    });
  });

  await t.test('Permit, reservation, and bucket lifecycle identities move only once', async () => {
    await withSchema('lifecycle', async (pool, directory) => {
      await install(pool, directory);
      const universeId = await insertUniverse(pool);
      const consumed = await insertAttempt(pool, await insertPrivateGraph(pool, universeId), {consumed: true});
      await assert.rejects(pool.query(
        "UPDATE reasoning_permit SET state='revoked',dispatch_id=NULL,consumed_at=NULL,closed_at=clock_timestamp() WHERE id=$1",
        [consumed.permitId],
      ));
      await assert.rejects(pool.query('UPDATE reasoning_reservation SET amount=2 WHERE attempt_id=$1', [consumed.attemptId]));
      await pool.query("UPDATE reasoning_reservation SET state='accounted' WHERE attempt_id=$1", [consumed.attemptId]);
      await assert.rejects(pool.query("UPDATE reasoning_reservation SET state='released' WHERE attempt_id=$1", [consumed.attemptId]));
      await assert.rejects(pool.query("UPDATE reasoning_bucket SET unit='tokens' WHERE id=$1", [consumed.bucketId]));

      const revoked = await insertAttempt(pool, await insertPrivateGraph(pool, universeId));
      await pool.query("UPDATE reasoning_permit SET state='revoked',closed_at=clock_timestamp() WHERE id=$1", [revoked.permitId]);
      await assert.rejects(pool.query("UPDATE reasoning_permit SET state='expired' WHERE id=$1", [revoked.permitId]));
    });
  });

  await t.test('typed reservations and settlement adjustments reject wrong units and duplicate buckets', async () => {
    await withSchema('units', async (pool, directory) => {
      await install(pool, directory);
      const universeId = await insertUniverse(pool);
      const attempt = await insertAttempt(pool, await insertPrivateGraph(pool, universeId), {consumed: true});
      await assert.rejects(pool.query(
        `INSERT INTO reasoning_reservation(id,attempt_id,reservation_set_id,bucket_id,dimension,unit,amount)
         VALUES($1,$2,$3,$4,'request_rate','tokens',1)`,
        [randomUUID(), attempt.attemptId, attempt.reservationSetId, attempt.bucketId],
      ));
      await assert.rejects(pool.query(
        `INSERT INTO reasoning_reservation(id,attempt_id,reservation_set_id,bucket_id,dimension,unit,amount)
         VALUES($1,$2,$3,$4,'request_rate','requests',1)`,
        [randomUUID(), attempt.attemptId, attempt.reservationSetId, attempt.bucketId],
      ));

      const receiptId = await insertReceipt(pool, attempt);
      const settlementId = randomUUID();
      await pool.query(
        `INSERT INTO reasoning_settlement(id,attempt_id,receipt_id,receipt_fingerprint,revision,basis,liability,remote_concurrency)
         VALUES($1,$2,$3,$4,1,'measured','settled','released')`,
        [settlementId, attempt.attemptId, receiptId, 'c'.repeat(64)],
      );
      await assert.rejects(pool.query(
        `INSERT INTO reasoning_settlement_adjustment(settlement_id,attempt_id,bucket_id,unit,delta)
         VALUES($1,$2,$3,'tokens',1)`,
        [settlementId, attempt.attemptId, attempt.bucketId],
      ));
      await pool.query(
        `INSERT INTO reasoning_settlement_adjustment(settlement_id,attempt_id,bucket_id,unit,delta)
         VALUES($1,$2,$3,'requests',1)`,
        [settlementId, attempt.attemptId, attempt.bucketId],
      );
      await assert.rejects(pool.query(
        `INSERT INTO reasoning_settlement_adjustment(settlement_id,attempt_id,bucket_id,unit,delta)
         VALUES($1,$2,$3,'requests',2)`,
        [settlementId, attempt.attemptId, attempt.bucketId],
      ));
    });
  });

  await t.test('receipts and settlements are append-only with cumulative revision identity', async () => {
    await withSchema('evidence', async (pool, directory) => {
      await install(pool, directory);
      const universeId = await insertUniverse(pool);
      const attempt = await insertAttempt(pool, await insertPrivateGraph(pool, universeId), {consumed: true});
      const firstReceipt = await insertReceipt(pool, attempt);
      const firstSettlement = randomUUID();
      await pool.query(
        `INSERT INTO reasoning_settlement(id,attempt_id,receipt_id,receipt_fingerprint,revision,basis,liability,remote_concurrency,input_tokens)
         VALUES($1,$2,$3,$4,1,'measured','partially_settled','held',10)`,
        [firstSettlement, attempt.attemptId, firstReceipt, 'c'.repeat(64)],
      );
      await assert.rejects(pool.query('UPDATE reasoning_receipt SET input_tokens=11 WHERE id=$1', [firstReceipt]));
      await assert.rejects(pool.query('DELETE FROM reasoning_receipt WHERE id=$1', [firstReceipt]));
      await assert.rejects(pool.query('UPDATE reasoning_settlement SET input_tokens=11 WHERE id=$1', [firstSettlement]));

      const secondReceipt = await insertReceipt(pool, attempt, 'd'.repeat(64));
      const secondSettlement = randomUUID();
      await pool.query(
        `INSERT INTO reasoning_settlement
          (id,attempt_id,receipt_id,receipt_fingerprint,revision,supersedes_settlement_id,basis,liability,remote_concurrency,input_tokens)
         VALUES($1,$2,$3,$4,2,$5,'measured','settled','released',12)`,
        [secondSettlement, attempt.attemptId, secondReceipt, 'd'.repeat(64), firstSettlement],
      );
      const thirdReceipt = await insertReceipt(pool, attempt, 'e'.repeat(64));
      await assert.rejects(pool.query(
        `INSERT INTO reasoning_settlement
          (id,attempt_id,receipt_id,receipt_fingerprint,revision,supersedes_settlement_id,basis,liability,remote_concurrency)
         VALUES($1,$2,$3,$4,3,$5,'measured','settled','released')`,
        [randomUUID(), attempt.attemptId, thirdReceipt, 'e'.repeat(64), firstSettlement],
      ));
      const fourthReceipt = await insertReceipt(pool, attempt, 'f'.repeat(64));
      await assert.rejects(pool.query(
        `INSERT INTO reasoning_settlement
          (id,attempt_id,receipt_id,receipt_fingerprint,revision,supersedes_settlement_id,basis,liability,remote_concurrency)
         VALUES($1,$2,$3,$4,2,$5,'measured','settled','released')`,
        [randomUUID(), attempt.attemptId, fourthReceipt, 'f'.repeat(64), firstSettlement],
      ));
      await assert.rejects(pool.query(
        `INSERT INTO reasoning_settlement
          (id,attempt_id,receipt_id,receipt_fingerprint,revision,supersedes_settlement_id,basis,liability,remote_concurrency)
         VALUES($1,$2,$3,$4,3,$5,'measured','settled','released')`,
        [randomUUID(), attempt.attemptId, secondReceipt, 'd'.repeat(64), secondSettlement],
      ));
      await assert.rejects(pool.query('DELETE FROM reasoning_settlement WHERE id=$1', [secondSettlement]));
    });
  });

  await t.test('eligible accounting purge cascades evidence while direct child deletion is blocked', async () => {
    await withSchema('retention', async (pool, directory) => {
      await install(pool, directory);
      const universeId = await insertUniverse(pool);
      const attempt = await insertAttempt(pool, await insertPrivateGraph(pool, universeId), {consumed: true});
      const receiptId = await insertReceipt(pool, attempt);
      const settlementId = randomUUID();
      await pool.query(
        `INSERT INTO reasoning_settlement(id,attempt_id,receipt_id,receipt_fingerprint,revision,basis,liability,remote_concurrency)
         VALUES($1,$2,$3,$4,1,'measured','settled','released')`,
        [settlementId, attempt.attemptId, receiptId, 'c'.repeat(64)],
      );
      await pool.query(
        `INSERT INTO reasoning_settlement_adjustment(settlement_id,attempt_id,bucket_id,unit,delta)
         VALUES($1,$2,$3,'requests',1)`,
        [settlementId, attempt.attemptId, attempt.bucketId],
      );

      await assert.rejects(pool.query('DELETE FROM reasoning_permit WHERE id=$1', [attempt.permitId]));
      await assert.rejects(pool.query('DELETE FROM reasoning_reservation WHERE attempt_id=$1', [attempt.attemptId]));
      await assert.rejects(pool.query('DELETE FROM reasoning_receipt WHERE id=$1', [receiptId]));
      await assert.rejects(pool.query('DELETE FROM reasoning_settlement WHERE id=$1', [settlementId]));
      await assert.rejects(pool.query('DELETE FROM reasoning_settlement_adjustment WHERE settlement_id=$1', [settlementId]));
      await assert.rejects(pool.query('DELETE FROM reasoning_accounting WHERE attempt_id=$1', [attempt.attemptId]));

      await pool.query('DELETE FROM reasoning_attempt WHERE id=$1', [attempt.attemptId]);
      await pool.query(
        `UPDATE reasoning_accounting SET state='responded',liability_state='settled',remote_state='released',
          remote_disposition='terminal',reconciliation_hold=false,idempotency_hold=false,closure_basis='evidence',
          all_duties_closed_at=clock_timestamp()-interval '31 days'
         WHERE attempt_id=$1`,
        [attempt.attemptId],
      );
      assert.equal((await pool.query('DELETE FROM reasoning_accounting WHERE attempt_id=$1', [attempt.attemptId])).rowCount, 1);
      for (const table of ['reasoning_permit', 'reasoning_reservation', 'reasoning_receipt', 'reasoning_settlement', 'reasoning_settlement_adjustment']) {
        assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE attempt_id=$1`, [attempt.attemptId])).rows[0]?.count, 0);
      }
    });
  });
});
