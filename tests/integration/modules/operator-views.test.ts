import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { releaseQueues } from '@knowscroll/backend/job-queues';
import {
  applyQueueDeclarations,
  createBoss,
  defineQueue,
  drainConsumers,
  jobConsumer,
  startConsumers,
} from '@knowscroll/backend/infrastructure/jobs';
import {
  OPS_READER_ROLE,
  OPS_READER_VIEWS,
  createOpsJobViews,
  dropOpsJobViews,
  grantOpsReader,
} from '@knowscroll/backend/infrastructure/postgres';
import { RETENTION_QUEUES } from '@knowscroll/backend/modules/operator';
import { readOperatorPanelsFor } from '@knowscroll/backend/modules/operator/nest-providers';
import { supplyWorld, type SupplyWorld } from '../support/supply-world.js';

/** Text that must never come out of an ops view. Each is planted in a private column below. */
const PRIVATE = {
  ask: 'CI-PRIVATE-ASK-TEXT',
  refusedAnswer: 'CI-PRIVATE-REFUSED-ANSWER',
  script: 'CI-PRIVATE-REEL-SCRIPT',
  note: 'CI-PRIVATE-OPERATOR-NOTE',
  detail: 'CI-PRIVATE-REMOTE-DETAIL',
  job: 'CI-PRIVATE-JOB-PAYLOAD',
};

/** The columns each view shows. A new column is a reviewed change to this list (D-044). */
const SHOWN_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  business_runs: [
    'run_id',
    'owner_module',
    'purpose',
    'role_id',
    'role_version',
    'policy_version',
    'provider',
    'model',
    'state',
    'created_at',
    'updated_at',
    'closed_at',
    'redacted',
  ],
  geography_runs: ['run_id', 'status', 'outcome', 'desired_revision', 'created_at', 'updated_at'],
  jobs: [
    'job_id',
    'queue',
    'state',
    'priority',
    'retry_count',
    'retry_limit',
    'created_at',
    'start_after',
    'started_at',
    'completed_at',
    'keep_until',
    'dead_letter_queue',
    'failure',
    'failure_class',
    'failure_code',
    'waiting_seconds',
  ],
  journey_events: [
    'stage',
    'started_at',
    'ended_at',
    'state',
    'code',
    'label',
    'count',
    'universe_id',
    'request_id',
    'work_id',
    'recipe_key',
    'production_run_id',
    'reasoning_run_id',
    'attempt_id',
    'exposure_id',
    'offer_id',
    'decision_id',
    'asset_id',
    'reel_order_id',
    'command_id',
    'subject_id',
  ],
  model_attempts: [
    'scope_kind',
    'attempt_id',
    'run_id',
    'step',
    'role_id',
    'role_version',
    'provider',
    'model',
    'prompt_version',
    'state',
    'outcome_code',
    'reserved_tokens',
    'input_tokens',
    'output_tokens',
    'cached_tokens',
    'reasoning_tokens',
    'request_bytes',
    'reserved_at',
    'dispatched_at',
    'settled_at',
    'written_off_at',
    'redacted',
  ],
  privacy_operations: ['kind', 'operation_id', 'state', 'failure_code', 'attempts', 'requested_at', 'completed_at'],
  production_runs: [
    'production_run_id',
    'recipe_key',
    'policy_version',
    'take',
    'state',
    'target_revision',
    'asset_id',
    'asset_revision',
    'writer_run_id',
    'writer_run_state',
    'model_attempts',
    'refused_answers',
    'created_at',
    'completed_at',
  ],
  queue_backlog: [
    'queue',
    'ready',
    'scheduled',
    'retrying',
    'active',
    'failed',
    'oldest_waiting_seconds',
    'last_completed_at',
  ],
  recent_errors: ['occurred_at', 'source', 'ref_id', 'state', 'code', 'label'],
  reel_attempts: [
    'attempt_id',
    'order_id',
    'take',
    'paid',
    'state',
    'outcome_code',
    'pool_state',
    'ceiling_cents',
    'estimate_cents',
    'remote_cost_cents',
    'remote_outcome',
    'reserved_at',
    'dispatched_at',
    'finished_at',
    'settled_at',
  ],
  reel_orders: [
    'reel_order_id',
    'script_name',
    'recipe_key',
    'until',
    'asset_id',
    'created_at',
    'published_at',
    'attempts',
    'settled_cents',
    'claimed_open_cents',
    'latest_attempt_state',
  ],
  rejected_answers: [
    'attempt_id',
    'run_id',
    'step',
    'model',
    'reason',
    'answer_kind',
    'answer_chars',
    'truncated',
    'issue_count',
    'issue_codes',
    'recorded_at',
    'expires_at',
  ],
};

const failingQueue = defineQueue({
  name: 'fixture.ops-failing',
  purpose: 'CI fixture: a handler that always fails, so a failed job shows in the ops views.',
  payload: z.object({ v: z.literal(1), taskId: z.string() }),
  policy: {
    expireInSeconds: 60,
    retryLimit: 0,
    retryDelaySeconds: 1,
    retryBackoff: false,
    retentionSeconds: 7_200,
    deleteAfterSeconds: 3_600,
    deadLetter: false,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 0.5 },
});

/**
 * The `ops` views (#248, D-044): they show what an operator needs and nothing private. Evidence
 * label: real PostgreSQL and pg-boss; private values are planted by the test in the columns that
 * hold them (an ask's words, a refused answer, a Reel script, an operator's note, a job's payload).
 */
describe('the ops views (real PostgreSQL)', () => {
  let world: SupplyWorld;
  const db = () => world.database.db;

  beforeAll(async () => {
    world = await supplyWorld('operator_views');
    const person = await world.seedPerson();
    // An ask in a person's own words, which the matcher cannot place.
    await world.ask(person, world.textRequest(PRIVATE.ask));
    // A refused writer answer that carries private text.
    world.answerWriterWith(() => ({ kind: 'success', text: PRIVATE.refusedAnswer }));
    await world.ask(await world.seedPerson(), world.catalogueRequest('earth.tides', 'earth.tides.forcing'));
    await world.runProduction('tides');
    // A Reel order with its script, and an attempt an operator wrote off with a note and Cutroom's detail.
    const orderId = randomUUID();
    await sql`insert into content.reel_orders (id, script_name, recipe_key, until, script_sha256, approval_ref, script_json)
      values (${orderId}::uuid, 'ci-reel', 'seasons', 'plan', ${'a'.repeat(64)}, 'CI fixture approval',
        ${JSON.stringify({ narration: PRIVATE.script })}::jsonb)`.execute(db());
    const request = JSON.stringify({ script: PRIVATE.script });
    await sql`insert into content.reel_attempts (id, order_id, take, paid, request_id, request_utf8, request_sha256,
        ceiling_cents, state, operator_note, remote_detail, dispatched_at, pool_state)
      values (${randomUUID()}::uuid, ${orderId}::uuid, 1, false, ${`ks-reel-${'b'.repeat(32)}-1`}, ${request},
        encode(sha256(convert_to(${request}, 'UTF8')), 'hex'), 75, 'written_off', ${PRIVATE.note},
        ${PRIVATE.detail}, now(), 'none')`.execute(db());
    // A job that failed for good, with a payload that carries private text.
    const diagnostics = { onError: () => undefined, onWarning: () => undefined };
    const install = createBoss(world.database.settings, 'install', diagnostics);
    await install.start();
    await applyQueueDeclarations(install, [failingQueue]);
    await install.stop({ graceful: false });
    const worker = createBoss(world.database.settings, 'consumer', diagnostics);
    await worker.start();
    await startConsumers(
      worker,
      [
        jobConsumer(failingQueue, () =>
          Promise.reject(Object.assign(new Error(PRIVATE.job), { code: 'FIXTURE_CRASH', detail: PRIVATE.job })),
        ),
      ],
      () => undefined,
    );
    try {
      await worker.send(failingQueue.name, { v: 1, taskId: PRIVATE.job });
      const failedJobs = async () =>
        (
          await sql<{
            n: string;
          }>`select count(*)::text as n from pgboss.job where name = ${failingQueue.name} and state = 'failed'`.execute(
            db(),
          )
        ).rows[0]?.n;
      for (let waited = 0; (await failedJobs()) !== '1'; waited += 200) {
        if (waited > 20_000) throw new Error('the fixture job did not fail');
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } finally {
      await drainConsumers(worker, 1, 5_000, () => undefined);
    }
  }, 120_000);
  afterAll(async () => {
    await world.close();
  });

  it('plants the private text where the views must not show it', async () => {
    const found = async (query: ReturnType<typeof sql>) => (await query.execute(db())).rows.length;
    expect(await found(sql`select 1 from supply.requests where command::text like ${`%${PRIVATE.ask}%`}`)).toBe(1);
    expect(
      await found(
        sql`select 1 from reasoning.production_rejected_answers where answer_text like ${`%${PRIVATE.refusedAnswer}%`}`,
      ),
    ).toBeGreaterThan(0);
    expect(
      await found(sql`select 1 from content.reel_orders where script_json::text like ${`%${PRIVATE.script}%`}`),
    ).toBe(1);
    expect(await found(sql`select 1 from content.reel_attempts where operator_note = ${PRIVATE.note}`)).toBe(1);
    expect(await found(sql`select 1 from pgboss.job where data::text like ${`%${PRIVATE.job}%`}`)).toBe(1);
  });

  it('lists exactly the reviewed columns in every view', async () => {
    const rows = await sql<{ view: string; columns: string[] }>`
      select table_name as view, array_agg(column_name::text order by ordinal_position) as columns
      from information_schema.columns
      where table_schema = 'ops' and table_name in (select viewname from pg_views where schemaname = 'ops')
      group by table_name`.execute(db());
    expect(Object.fromEntries(rows.rows.map((row) => [row.view, row.columns]))).toEqual(SHOWN_COLUMNS);
  });

  it('shows none of the private text in any row of any view', async () => {
    const views = Object.keys(SHOWN_COLUMNS);
    const shown: Record<string, number> = {};
    for (const view of views) {
      const rows = await sql<{
        row: string;
      }>`select row_to_json(shown)::text as row from ${sql.table(`ops.${view}`)} as shown`.execute(db());
      shown[view] = rows.rows.length;
      const text = rows.rows.map((row) => row.row).join('\n');
      for (const [name, value] of Object.entries(PRIVATE))
        expect(text, `${view} must not show ${name}`).not.toContain(value);
    }
    // The checks above are not vacuous: the views that read the planted records have rows.
    expect(shown['rejected_answers']).toBeGreaterThan(0);
    expect(shown['reel_orders']).toBe(1);
    expect(shown['reel_attempts']).toBe(1);
    expect(shown['jobs']).toBeGreaterThan(0);
    expect(shown['journey_events']).toBeGreaterThan(0);
  });

  it('shows a failed job as its queue, state and code, never its payload or message', async () => {
    const job = await sql<Record<string, unknown>>`
      select state, failure, failure_class, failure_code from ops.jobs where queue = ${failingQueue.name}`.execute(
      db(),
    );
    expect(job.rows).toEqual([
      { state: 'failed', failure: 'handler_failed', failure_class: 'Error', failure_code: 'FIXTURE_CRASH' },
    ]);
    const backlog = await sql<{
      failed: string;
    }>`select failed::text from ops.queue_backlog where queue = ${failingQueue.name}`.execute(db());
    expect(backlog.rows).toEqual([{ failed: '1' }]);
    const errors = await sql<{
      source: string;
      code: string;
    }>`select source, code from ops.recent_errors where label = ${failingQueue.name}`.execute(db());
    expect(errors.rows).toEqual([{ source: 'job', code: 'FIXTURE_CRASH' }]);
  });

  it('shows a refused answer as its verdict and the codes of the findings', async () => {
    const refused = await sql<{ reason: string; answer_chars: number; issue_count: number; issue_codes: string[] }>`
      select reason, answer_chars, issue_count, issue_codes from ops.rejected_answers`.execute(db());
    expect(refused.rows.length).toBeGreaterThan(0);
    for (const row of refused.rows) {
      expect(row.reason).toMatch(/^[A-Z_]+$/);
      expect(row.answer_chars).toBe(PRIVATE.refusedAnswer.length);
    }
  });

  it("counts a Reel order's cents and shows its script name but not its script", async () => {
    const order = await sql<Record<string, unknown>>`
      select script_name, until, attempts::int as attempts, settled_cents::int as settled, latest_attempt_state from ops.reel_orders`.execute(
      db(),
    );
    expect(order.rows).toEqual([
      { script_name: 'ci-reel', until: 'plan', attempts: 1, settled: 0, latest_attempt_state: 'written_off' },
    ]);
  });

  it('feeds the Operator panels, and keeps the pieces Tier 0 has no source for unavailable', async () => {
    const panels = await readOperatorPanelsFor(db())();
    expect(panels.overview.queues.status).toBe('available');
    expect(panels.production.reelOrders).toMatchObject({ status: 'available', data: [{ scriptName: 'ci-reel' }] });
    expect(panels.production.refusedAnswers.status).toBe('available');
    expect(panels.overview.recentErrors).toMatchObject({ status: 'available' });
    expect(panels.overview.requestLatency.status).toBe('unavailable');
    expect(JSON.stringify(panels)).not.toContain('CI-PRIVATE');
  });

  describe('the read-only role', () => {
    const asReader = <T>(work: (query: (text: ReturnType<typeof sql>) => Promise<unknown[]>) => Promise<T>) =>
      db()
        .transaction()
        .execute(async (trx) => {
          await sql`set local role ${sql.id(OPS_READER_ROLE)}`.execute(trx);
          return work(async (text) => (await text.execute(trx)).rows);
        });

    it('selects every allowlisted view', async () => {
      for (const view of OPS_READER_VIEWS)
        await asReader((query) => query(sql`select * from ${sql.table(`ops.${view}`)} limit 1`));
    });

    it('is refused the journey view, the tables and the sign-in audit', async () => {
      for (const forbidden of [
        'ops.journey_events',
        'ops.operator_sign_ins',
        'reasoning.external_attempts',
        'supply.requests',
        'identity.accounts',
        'pgboss.job',
      ])
        await expect(
          asReader((query) => query(sql`select 1 from ${sql.table(forbidden)} limit 1`)),
          forbidden,
        ).rejects.toMatchObject({
          code: '42501',
        });
    });

    it('holds no privilege to change anything', async () => {
      for (const view of OPS_READER_VIEWS) {
        const held = await sql<{ any: boolean }>`
          select has_table_privilege(${OPS_READER_ROLE}, ${`ops.${view}`}, 'insert, update, delete, truncate, references, trigger') as any`.execute(
          db(),
        );
        expect(held.rows, view).toEqual([{ any: false }]);
      }
    });
  });

  describe('the job views around a pg-boss upgrade', () => {
    it('are dropped and rebuilt without changing what they show, and granted again', async () => {
      const before = (
        await sql`select queue, ready, scheduled, retrying, active, failed from ops.queue_backlog order by queue`.execute(
          db(),
        )
      ).rows;
      await dropOpsJobViews(db());
      await expect(sql`select 1 from ops.jobs`.execute(db())).rejects.toMatchObject({ code: '42P01' });
      const panels = await readOperatorPanelsFor(db())();
      expect(panels.overview.queues).toEqual({ status: 'unavailable', reason: 'view_missing' });
      await createOpsJobViews(db());
      expect(await grantOpsReader(db())).toBe('granted');
      expect(
        (
          await sql`select queue, ready, scheduled, retrying, active, failed from ops.queue_backlog order by queue`.execute(
            db(),
          )
        ).rows,
      ).toEqual(before);
    });

    it('name every view the reader may select, and every view that exists', async () => {
      const present = (
        await sql<{ viewname: string }>`select viewname from pg_views where schemaname = 'ops'`.execute(db())
      ).rows.map((row) => row.viewname);
      expect([...OPS_READER_VIEWS, 'journey_events'].sort()).toEqual(present.sort());
    });
  });

  it('names only declared queues as retention jobs', () => {
    const declared = releaseQueues.map((queue) => queue.name);
    for (const name of RETENTION_QUEUES) expect(declared, name).toContain(name);
  });
});
