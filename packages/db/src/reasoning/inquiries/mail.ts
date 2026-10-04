import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  INQUIRY_KIND,
  INQUIRY_CONTEXT_LIMITS,
} from '@knowscroll/contracts/reasoning-inquiry-context';
import { inTransaction } from './route.ts';

// Mail ----------------------------------------------------------------------------------------

/** Why a look is worth it (ADR-0042 §5): a planet or region formed, a bridge between two live places
 * revoked, or a personal hypothesis about a live place created or changed. */
export type InquiryMailCause =
  | { kind: 'place_formed'; deltaId: string }
  | { kind: 'bridge_revoked'; bridgeId: string }
  | { kind: 'hypothesis_changed'; hypothesisId: string; revision: number };
/**
 * ADR-0038 §3: called for each cause, in its transaction and under its universe lock (`applyDeltas` for
 * a place the Cartographer forms). Only with consent in this epoch and while recording; later mail joins
 * the pending inquiry (at most 16 causes: the inquiry reads every live place when it runs anyway).
 * Nothing earlier is ever mailed: the schema requires this transaction's delta, or a revocation or
 * hypothesis revision since consent was turned on (ADR-0042 §5).
 */
export async function postInquiryMail(
  client: pg.PoolClient,
  universeId: string,
  cause: InquiryMailCause,
): Promise<boolean> {
  const state = (
    await client.query<{
      privacy_epoch: number;
      recording: boolean;
      enabled: boolean | null;
    }>(
      `
      SELECT
        u.privacy_epoch,
        u.recording_paused_at IS NULL AS recording,
        c.enabled
      FROM
        universe u
        LEFT JOIN background_inquiry_consent c ON c.universe_id = u.id
        AND c.privacy_epoch = u.privacy_epoch
      WHERE
        u.id = $1
    `,
      [universeId],
    )
  ).rows[0];
  if (!state?.recording || !state.enabled) return false;
  let pending = (
    await client.query<{ id: string; causes: number }>(
      `
      SELECT
        i.id,
        (
          SELECT
            count(*)::int
          FROM
            inquiry_mail m
          WHERE
            m.inquiry_id = i.id
        ) AS causes
      FROM
        background_inquiry i
      WHERE
        i.universe_id = $1
        AND i.kind = $2
        AND i.status = 'pending'
      FOR UPDATE
    `,
      [universeId, INQUIRY_KIND],
    )
  ).rows[0];
  if (!pending) {
    pending = { id: randomUUID(), causes: 0 };
    await client.query(
      `
      INSERT INTO
        background_inquiry (id, universe_id, privacy_epoch, kind, status)
      VALUES
        ($1, $2, $3, $4, 'pending')
    `,
      [pending.id, universeId, state.privacy_epoch, INQUIRY_KIND],
    );
  }
  if (pending.causes >= INQUIRY_CONTEXT_LIMITS.maxCausesPerInquiry)
    return false;
  await client.query(
    `
      INSERT INTO
        inquiry_mail (
          id,
          universe_id,
          privacy_epoch,
          kind,
          inquiry_id,
          cause_kind,
          cause_delta_id,
          cause_bridge_id,
          cause_hypothesis_id,
          cause_hypothesis_revision
        )
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `,
    [
      randomUUID(),
      universeId,
      state.privacy_epoch,
      INQUIRY_KIND,
      pending.id,
      cause.kind,
      cause.kind === 'place_formed' ? cause.deltaId : null,
      cause.kind === 'bridge_revoked' ? cause.bridgeId : null,
      cause.kind === 'hypothesis_changed' ? cause.hypothesisId : null,
      cause.kind === 'hypothesis_changed' ? cause.revision : null,
    ],
  );
  return true;
}
/** Revoked bridges (shared, or the reader's own) between two of a consenting, recording reader's live
 * planets or regions, revoked since that reader's consent was turned on (or recording resumed), not yet mailed.
 * A reader whose pending inquiry already holds its 16 causes is left until that inquiry opens (#182), so
 * their revocations never fill a pass and hold up everyone else's. */
const REVOKED_CONNECTIONS = `SELECT u.id AS universe_id, b.id AS bridge_id FROM bridge b
  JOIN atlas_place f ON f.anchor_concept_id = b.from_concept_id AND f.state = 'live' AND f.kind IN ('planet','region')
  JOIN atlas_place t ON t.universe_id = f.universe_id AND t.anchor_concept_id = b.to_concept_id AND t.state = 'live' AND t.kind IN ('planet','region')
  JOIN universe u ON u.id = f.universe_id AND u.recording_paused_at IS NULL
  JOIN background_inquiry_consent c ON c.universe_id = u.id AND c.privacy_epoch = u.privacy_epoch AND c.enabled
  WHERE b.status = 'revoked' AND (b.universe_id IS NULL OR b.universe_id = u.id)
    AND b.status_changed_at > inquiry_mail_since(u.id, u.privacy_epoch)
    AND NOT EXISTS (SELECT 1 FROM inquiry_mail m WHERE m.universe_id = u.id AND m.cause_bridge_id = b.id)
    AND NOT EXISTS (SELECT 1 FROM background_inquiry i WHERE i.universe_id = u.id AND i.kind = '${INQUIRY_KIND}' AND i.status = 'pending'
      AND (SELECT count(*) FROM inquiry_mail m WHERE m.inquiry_id = i.id) >= ${INQUIRY_CONTEXT_LIMITS.maxCausesPerInquiry})`;
/**
 * ADR-0042 §5.3: a source correction that revoked a connection between two of a reader's live places asks
 * for a look again, from current evidence. The correction holds the exclusive substrate lock, which
 * follows universe locks (ADR-0031 §7), so its own transaction cannot mail: the worker does, each pass,
 * under each universe's lock with the facts checked again, once per universe and bridge.
 */
export async function mailRevokedConnections(
  pool: pg.Pool,
  input: { limit?: number } = {},
): Promise<number> {
  const found = (
    await pool.query<{ universe_id: string; bridge_id: string }>(
      `${REVOKED_CONNECTIONS} ORDER BY b.status_changed_at, b.id LIMIT $1`,
      [input.limit ?? 10],
    )
  ).rows;
  let mailed = 0;
  for (const row of found) {
    try {
      const posted = await inTransaction(pool, async (client) => {
        await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE', [
          row.universe_id,
        ]);
        const still = (
          await client.query(`${REVOKED_CONNECTIONS} AND u.id=$1 AND b.id=$2`, [
            row.universe_id,
            row.bridge_id,
          ])
        ).rowCount;
        return still
          ? postInquiryMail(client, row.universe_id, {
              kind: 'bridge_revoked',
              bridgeId: row.bridge_id,
            })
          : false;
      });
      if (posted) mailed += 1;
    } catch {
      /* a pause or a Clear moved it meanwhile; the next pass sees its new state */
    }
  }
  return mailed;
}
