/** Read-only checks the worker's answer and inquiry loops make before scheduling, on the pool, outside any transaction. */
import type pg from 'pg';

export type RouteTransport = 'fixture' | 'minimax';

export async function enabledInquiryRouteTransport(
  pool: pg.Pool,
  policyVersion: string,
): Promise<{ transport: RouteTransport } | undefined> {
  return (
    await pool.query<{ transport: RouteTransport }>(
      'SELECT transport FROM background_inquiry_route WHERE enabled AND policy_version=$1',
      [policyVersion],
    )
  ).rows[0];
}

export async function enabledAnswerRouteTransport(
  pool: pg.Pool,
  policyVersion: string,
): Promise<{ transport: RouteTransport } | undefined> {
  return (
    await pool.query<{ transport: RouteTransport }>(
      'SELECT transport FROM ask_answer_route WHERE enabled AND policy_version=$1',
      [policyVersion],
    )
  ).rows[0];
}

/** Whether an answer request is ready to be scheduled for this policy version. */
export async function hasWaitingAnswer(
  pool: pg.Pool,
  policyVersion: string,
): Promise<boolean> {
  return Boolean(
    (
      await pool.query(
        `
          SELECT
            1
          FROM
            reasoning_fairness_ready r
            JOIN ask_answer_request a ON a.job_id = r.job_id
          WHERE
            a.policy_version = $1
          LIMIT
            1
        `,
        [policyVersion],
      )
    ).rowCount,
  );
}

/** Whether anything at all (either family) is ready to be scheduled for this policy version. */
export async function hasWaitingReasoningJob(
  pool: pg.Pool,
  policyVersion: string,
): Promise<boolean> {
  return Boolean(
    (
      await pool.query(
        'SELECT 1 FROM reasoning_fairness_ready WHERE policy_version=$1 LIMIT 1',
        [policyVersion],
      )
    ).rowCount,
  );
}

export type EnabledRoute = {
  policy_version: string;
  transport: RouteTransport;
};

export async function enabledAnswerRoute(
  pool: pg.Pool,
): Promise<EnabledRoute | undefined> {
  return (
    await pool.query<EnabledRoute>(
      'SELECT policy_version,transport FROM ask_answer_route WHERE enabled',
    )
  ).rows[0];
}

export async function enabledInquiryRoute(
  pool: pg.Pool,
): Promise<EnabledRoute | undefined> {
  return (
    await pool.query<EnabledRoute>(
      'SELECT policy_version, transport FROM background_inquiry_route WHERE enabled',
    )
  ).rows[0];
}

/** The admitted answer's Step; the request row exists for any admitted answer job. */
export async function answerRequestStep(
  pool: pg.Pool,
  jobId: string,
): Promise<{ ask_id: string; step_id: string }> {
  return (
    await pool.query<{ ask_id: string; step_id: string }>(
      'SELECT ask_id, step_id FROM ask_answer_request WHERE job_id=$1',
      [jobId],
    )
  ).rows[0]!;
}

/** The admitted inquiry and the Step of this attempt (its first, or a continuation). */
export async function inquiryAttemptStep(
  pool: pg.Pool,
  jobId: string,
  attemptId: string,
): Promise<{ id: string; step_id: string }> {
  return (
    await pool.query<{ id: string; step_id: string }>(
      `
        SELECT
          i.id,
          a.step_id
        FROM
          background_inquiry i
          JOIN reasoning_attempt a ON a.job_id = i.job_id
        WHERE
          i.job_id = $1
          AND a.id = $2
      `,
      [jobId, attemptId],
    )
  ).rows[0]!;
}

/** The attempt's accounting state, or undefined when no row exists. */
export async function attemptAccountingState(
  pool: pg.Pool,
  attemptId: string,
): Promise<string | undefined> {
  return (
    await pool.query<{ state: string }>(
      'SELECT state FROM reasoning_accounting WHERE attempt_id=$1',
      [attemptId],
    )
  ).rows[0]?.state;
}
