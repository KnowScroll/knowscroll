import type pg from 'pg';

// Privacy -------------------------------------------------------------------------------------

/** Clear/Reset (after the epoch advanced): mail, inquiries and consent go before the atlas deltas and
 * semantic proposals they reference. The Jobs themselves go with the rest of the reasoning graph. */
export async function eraseInquiries(
  client: pg.PoolClient,
  universeId: string,
): Promise<void> {
  await client.query('DELETE FROM inquiry_mail WHERE universe_id=$1', [
    universeId,
  ]);
  await client.query('DELETE FROM background_inquiry WHERE universe_id=$1', [
    universeId,
  ]);
  await client.query(
    'DELETE FROM background_inquiry_consent WHERE universe_id=$1',
    [universeId],
  );
  await client.query(
    'DELETE FROM background_inquiry_consent_request WHERE universe_id=$1',
    [universeId],
  );
}
export async function exportInquiries(
  client: pg.PoolClient,
  universeId: string,
) {
  const q = async (sql: string) => (await client.query(sql, [universeId])).rows;
  return {
    consent: await q(
      'SELECT privacy_epoch, enabled, daily_limit, revision, changed_at FROM background_inquiry_consent WHERE universe_id=$1 ORDER BY privacy_epoch',
    ),
    consentRequests: await q(
      'SELECT id, privacy_epoch, enabled, daily_limit, requested_at FROM background_inquiry_consent_request WHERE universe_id=$1 ORDER BY requested_at, id',
    ),
    mail: await q(`SELECT id, privacy_epoch, kind, inquiry_id, cause_kind, cause_delta_id, cause_bridge_id, cause_hypothesis_id, cause_hypothesis_revision, sequence, created_at
      FROM inquiry_mail WHERE universe_id=$1 ORDER BY sequence`),
    inquiries:
      await q(`SELECT id, privacy_epoch, kind, role, parent_id, status, first_mail_at, opened_at, closed_at, pairs, input_bytes, sent, reasons, proposal_id
      FROM background_inquiry WHERE universe_id=$1 ORDER BY first_mail_at, id`),
  };
}
