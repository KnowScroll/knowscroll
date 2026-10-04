import type pg from 'pg';

/** Clear/Reset: answers and requests go before the Ask facts they reference (ADR-0033 §6). */
export async function eraseAskAnswers(
  client: pg.PoolClient,
  universeId: string,
): Promise<void> {
  await client.query('DELETE FROM ask_answer WHERE universe_id=$1', [
    universeId,
  ]);
  await client.query('DELETE FROM ask_answer_request WHERE universe_id=$1', [
    universeId,
  ]);
}
export async function exportAskAnswers(
  client: pg.PoolClient,
  universeId: string,
) {
  return (
    await client.query(
      `
      SELECT
        r.ask_id,
        r.requested_at,
        a.status,
        a.answer,
        a.basis,
        a.limits,
        a.reasons,
        a.validator_version,
        a.created_at AS answered_at
      FROM
        ask_answer_request r
        LEFT JOIN ask_answer a ON a.ask_id = r.ask_id
      WHERE
        r.universe_id = $1
      ORDER BY
        r.requested_at
    `,
      [universeId],
    )
  ).rows;
}
