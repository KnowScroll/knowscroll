/**
 * The worker's intake: opening a due inquiry into its Job, sealed context, Step and fair enqueue
 * (ADR-0038 §4, ADR-0042 §4). Locks are taken in ADR-0017 order, universe row first.
 */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { INQUIRY_DIRTY_SCOPE } from '@knowscroll/contracts/reasoning-inquiry-context';
import {
  type InquiryPair,
  serializeBridgeInquiryRequest,
  selectInquiryPairs,
} from '@knowscroll/core/reasoning/bridge-inquiry';
import { enqueueFairInTransaction } from '../fairness.ts';
import { sealInquiryContext, readInquiryInputs } from '../inquiry-context.ts';
import { ReasoningDenied } from '../runtime-policy.ts';
import { openedToday } from './consent.ts';
import { inTransaction } from '../../sql/transactions.ts';
import { requestRoute, resolveInquiryPolicy } from './route.ts';
import type { InquiryRoute, InquiryRow } from './shared.ts';

export type OpenResult =
  | 'opened'
  | 'nothing_to_ask'
  | 'waiting'
  | 'withdrawn'
  | 'failed'
  | 'gone';
/** The worker's intake: every pending inquiry whose first mail is older than the route's coalescing
 * delay, while none of its universe's is already in flight, is opened in its own transaction. */
export async function openDueInquiries(
  pool: pg.Pool,
  input: { limit?: number } = {},
): Promise<Record<OpenResult, number>> {
  const counts: Record<OpenResult, number> = {
    opened: 0,
    nothing_to_ask: 0,
    waiting: 0,
    withdrawn: 0,
    failed: 0,
    gone: 0,
  };
  const route = (
    await pool.query<InquiryRoute>(
      'SELECT * FROM background_inquiry_route WHERE enabled',
    )
  ).rows[0];
  if (!route) return counts;
  const due = (
    await pool.query<{ id: string }>(
      `
      SELECT
        i.id
      FROM
        background_inquiry i
      WHERE
        i.status = 'pending'
        AND i.first_mail_at <= clock_timestamp() - ($1 * interval '1 second')
        AND NOT EXISTS (
          SELECT
            1
          FROM
            background_inquiry q
          WHERE
            q.universe_id = i.universe_id
            AND q.kind = i.kind
            AND q.status = 'queued'
        )
      ORDER BY
        i.first_mail_at,
        i.id
      LIMIT
        $2
    `,
      [route.coalescing_delay_seconds, input.limit ?? 10],
    )
  ).rows;
  for (const row of due) {
    try {
      counts[
        await inTransaction(pool, (client) => openInquiry(client, row.id))
      ] += 1;
    } catch {
      /* another worker or a Clear moved it; the next pass sees its new state */
    }
  }
  return counts;
}
const sha = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
/** The offered pairs' codes and names, as the inquiry records them for the reader's list. */
const pairsView = (pairs: readonly InquiryPair[]) =>
  JSON.stringify(
    pairs.map((p) => ({
      a: { code: p.a.code, name: p.a.name },
      b: { code: p.b.code, name: p.b.name },
    })),
  );
/** What every Job an opening creates shares: the universe and epoch, the route, the cause and the deadline. */
type InquiryJobShape = {
  universeId: string;
  privacyEpoch: number;
  route: InquiryRoute;
  through: string;
  deadline: Date;
};
async function insertInquiryJob(
  client: pg.PoolClient,
  jobId: string,
  job: InquiryJobShape,
  status: 'queued' | 'waiting',
): Promise<void> {
  await client.query(
    `
      INSERT INTO
        reasoning_job (
          id,
          universe_id,
          privacy_epoch,
          status,
          class,
          budget_owner_id,
          policy_version,
          deadline,
          wake_kind,
          dirty_scope,
          through_sequence
        )
      VALUES
        (
          $1,
          $2,
          $3,
          $4,
          'background_inquiry',
          $2,
          $5,
          $6,
          'dirty',
          $7,
          $8
        )
    `,
    [
      jobId,
      job.universeId,
      job.privacyEpoch,
      status,
      job.route.policy_version,
      job.deadline,
      INQUIRY_DIRTY_SCOPE,
      job.through,
    ],
  );
}
/** One inquiry's own Job, sealed context, Step and exact request bytes, enqueued fairly (ADR-0038 §4).
 * `bind` names the Job on the inquiry's row first, so the policy resolver can see its buckets while sealing. */
async function openInquiryJob(
  client: pg.PoolClient,
  job: InquiryJobShape,
  inquiryId: string,
  pairs: readonly InquiryPair[],
  bind: (ids: {
    jobId: string;
    stepId: string;
    contextId: string;
    requestId: string;
  }) => Promise<unknown>,
): Promise<void> {
  const ids = {
    jobId: randomUUID(),
    stepId: randomUUID(),
    contextId: randomUUID(),
    requestId: randomUUID(),
  };
  const scope = { universeId: job.universeId, privacyEpoch: job.privacyEpoch };
  await insertInquiryJob(client, ids.jobId, job, 'queued');
  await bind(ids);
  const payload = await sealInquiryContext(
    client,
    { ...scope, jobId: ids.jobId, contextId: ids.contextId, inquiryId },
    pairs,
    resolveInquiryPolicy,
  );
  await client.query(
    `
    INSERT INTO
      reasoning_step (
        id,
        job_id,
        universe_id,
        privacy_epoch,
        context_id,
        ordinal,
        status
      )
    VALUES
      ($1, $2, $3, $4, $5, 1, 'pending')
  `,
    [
      ids.stepId,
      ids.jobId,
      scope.universeId,
      scope.privacyEpoch,
      ids.contextId,
    ],
  );
  // The reserved bytes are rebuilt from the sealed pairs, exactly as the worker will rebuild them.
  const bytes = serializeBridgeInquiryRequest(
    payload.pairs,
    requestRoute(job.route),
  );
  const requestHash = sha(bytes);
  await client.query(
    'UPDATE background_inquiry SET request_hash=$2, input_bytes=$3 WHERE id=$1',
    [inquiryId, requestHash, bytes.byteLength],
  );
  await enqueueFairInTransaction(client, {
    ...scope,
    jobId: ids.jobId,
    stepId: ids.stepId,
    contextId: ids.contextId,
    requestId: ids.requestId,
    requestHash,
    inputTokensUpperBound: bytes.byteLength,
    maxOutputTokens: job.route.max_output_tokens,
    costCeilingMicroUsd: null,
    deadline: job.deadline.toISOString(),
    permitTtlMs: 60_000,
    policyVersion: job.route.policy_version,
    class: 'background_inquiry',
  });
}
/** ADR-0038 §4: one due inquiry, with fresh authority, in the caller's transaction. */
export async function openInquiry(
  client: pg.PoolClient,
  inquiryId: string,
): Promise<OpenResult> {
  const head = (
    await client.query<{ universe_id: string }>(
      'SELECT universe_id FROM background_inquiry WHERE id=$1',
      [inquiryId],
    )
  ).rows[0];
  if (!head) return 'gone';
  // ADR-0017 order: the universe row first, then the inquiry, then everything it creates.
  const universe = (
    await client.query<{ privacy_epoch: number; paused: boolean }>(
      `
      SELECT
        privacy_epoch,
        recording_paused_at IS NOT NULL AS paused
      FROM
        universe
      WHERE
        id = $1
      FOR UPDATE
    `,
      [head.universe_id],
    )
  ).rows[0];
  const inquiry = (
    await client.query<InquiryRow>(
      'SELECT * FROM background_inquiry WHERE id=$1 FOR UPDATE',
      [inquiryId],
    )
  ).rows[0];
  if (
    !universe ||
    !inquiry ||
    inquiry.status !== 'pending' ||
    inquiry.privacy_epoch !== universe.privacy_epoch
  )
    return 'gone';
  const close = async (
    status: 'nothing_to_ask' | 'withdrawn' | 'failed',
    reasons: string[],
  ) => {
    await client.query(
      'UPDATE background_inquiry SET status=$2, reasons=$3 WHERE id=$1',
      [inquiryId, status, JSON.stringify(reasons)],
    );
  };
  const consent = (
    await client.query<{ enabled: boolean; daily_limit: number }>(
      `
      SELECT
        enabled,
        daily_limit
      FROM
        background_inquiry_consent
      WHERE
        universe_id = $1
        AND privacy_epoch = $2
    `,
      [inquiry.universe_id, inquiry.privacy_epoch],
    )
  ).rows[0];
  if (!consent?.enabled) {
    await close('withdrawn', ['consent_off']);
    return 'withdrawn';
  }
  if (universe.paused) {
    await close('withdrawn', ['recording_paused']);
    return 'withdrawn';
  }
  const route = (
    await client.query<InquiryRoute & { due: boolean }>(
      `
      SELECT
        *,
        $1::timestamptz <= clock_timestamp() - (coalescing_delay_seconds * interval '1 second') AS due
      FROM
        background_inquiry_route
      WHERE
        enabled
    `,
      [inquiry.first_mail_at],
    )
  ).rows[0];
  if (!route?.due) return 'waiting';
  const busy = (
    await client.query(
      `SELECT 1 FROM background_inquiry WHERE universe_id=$1 AND kind=$2 AND status='queued'`,
      [inquiry.universe_id, inquiry.kind],
    )
  ).rowCount;
  const used = await openedToday(
    client,
    inquiry.universe_id,
    inquiry.privacy_epoch,
  );
  // Today's limit reached: it stays pending (the reader sees `waiting`) until tomorrow.
  if (busy || used >= consent.daily_limit) return 'waiting';

  let pairs = selectInquiryPairs(
    await readInquiryInputs(client, inquiry.universe_id, inquiry.privacy_epoch),
  );
  if (pairs.length === 0) {
    await close('nothing_to_ask', ['no_candidate_pair']);
    return 'nothing_to_ask';
  }
  const bytesFor = (offered: readonly InquiryPair[]) =>
    serializeBridgeInquiryRequest(offered, requestRoute(route));
  // The request must fit the route's input bound: the last pairs give way first.
  while (
    pairs.length > 1 &&
    bytesFor(pairs).byteLength > route.max_input_tokens
  )
    pairs = pairs.slice(0, -1);
  if (bytesFor(pairs).byteLength > route.max_input_tokens) {
    await close('failed', ['request_too_large']);
    return 'failed';
  }

  const scope = {
    universeId: inquiry.universe_id,
    privacyEpoch: inquiry.privacy_epoch,
  };
  (
    await client.query<{ bucket_id: string }>(
      'SELECT bucket_id FROM background_inquiry_owner_bucket WHERE policy_version=$1 AND universe_id=$2',
      [route.policy_version, scope.universeId],
    )
  ).rows[0]?.bucket_id ??
    (await (async () => {
      const id = randomUUID();
      await client.query(
        "INSERT INTO reasoning_bucket(id,dimension,unit,capacity) VALUES($1,'owner_budget','tokens',$2)",
        [id, route.owner_capacity],
      );
      await client.query(
        'INSERT INTO background_inquiry_owner_bucket(policy_version,universe_id,bucket_id) VALUES($1,$2,$3)',
        [route.policy_version, scope.universeId, id],
      );
      return id;
    })());
  await client.query('SAVEPOINT inquiry_open');
  try {
    const jobBucket = randomUUID();
    await client.query(
      "INSERT INTO reasoning_bucket(id,dimension,unit,capacity) VALUES($1,'job_budget','tokens',$2)",
      [jobBucket, route.job_capacity],
    );
    const through = (
      await client.query<{ n: string }>(
        'SELECT max(sequence)::text AS n FROM inquiry_mail WHERE inquiry_id=$1',
        [inquiryId],
      )
    ).rows[0]!.n;
    const deadline = (
      await client.query<{ at: Date }>(
        `SELECT clock_timestamp() + ($1 * interval '1 second') AS at`,
        [route.job_ttl_seconds],
      )
    ).rows[0]!.at;
    const job: InquiryJobShape = { ...scope, route, through, deadline };
    if (route.max_children >= 2 && pairs.length >= 2) {
      // ADR-0042 §4: the inquiry becomes a parent. Its Job only waits for its children and holds the
      // family's one budget; each pair is asked by a child with its own Job, binding that budget.
      const offered = pairs.slice(0, route.max_children);
      const parentJob = randomUUID();
      await insertInquiryJob(client, parentJob, job, 'waiting');
      await client.query(
        `
          UPDATE background_inquiry
          SET
            status = 'queued',
            role = 'parent',
            policy_version = $2,
            job_id = $3,
            job_bucket_id = $4,
            through_sequence = $5,
            pairs = $6
          WHERE
            id = $1
        `,
        [
          inquiryId,
          route.policy_version,
          parentJob,
          jobBucket,
          through,
          pairsView(offered),
        ],
      );
      for (const pair of offered) {
        const childId = randomUUID();
        // A child keeps its parent's identity: universe, epoch, kind, first mail, route and cause.
        await openInquiryJob(client, job, childId, [pair], (ids) =>
          client.query(
            `
            INSERT INTO
              background_inquiry (
                id,
                universe_id,
                privacy_epoch,
                kind,
                status,
                role,
                parent_id,
                first_mail_at,
                policy_version,
                job_id,
                step_id,
                context_id,
                request_id,
                through_sequence,
                pairs
              )
            SELECT
              $1,
              universe_id,
              privacy_epoch,
              kind,
              'queued',
              'child',
              id,
              first_mail_at,
              policy_version,
              $3,
              $4,
              $5,
              $6,
              through_sequence,
              $7
            FROM
              background_inquiry
            WHERE
              id = $2
          `,
            [
              childId,
              inquiryId,
              ids.jobId,
              ids.stepId,
              ids.contextId,
              ids.requestId,
              pairsView([pair]),
            ],
          ),
        );
      }
    } else {
      await openInquiryJob(client, job, inquiryId, pairs, (ids) =>
        client.query(
          `
          UPDATE background_inquiry
          SET
            status = 'queued',
            policy_version = $2,
            job_id = $3,
            step_id = $4,
            context_id = $5,
            request_id = $6,
            job_bucket_id = $7,
            through_sequence = $8,
            pairs = $9
          WHERE
            id = $1
        `,
          [
            inquiryId,
            route.policy_version,
            ids.jobId,
            ids.stepId,
            ids.contextId,
            ids.requestId,
            jobBucket,
            through,
            pairsView(pairs),
          ],
        ),
      );
    }
    await client.query('RELEASE SAVEPOINT inquiry_open');
    return 'opened';
  } catch (error) {
    if (!(error instanceof ReasoningDenied)) throw error;
    // A context that cannot be sealed now will not seal on retry either: close it, never loop.
    await client.query('ROLLBACK TO SAVEPOINT inquiry_open');
    await close('failed', ['context_refused']);
    return 'failed';
  }
}
