/** The reader's views of inquiries and the bridges they found (ADR-0039, ADR-0044). */
import type pg from 'pg';
import {
  type InquiryWire,
  type InquiriesResponse,
  INQUIRY_LIST_LIMIT,
} from '@knowscroll/contracts/inquiries';
import type { AuthScope } from '../../identity.ts';
import { readInquiryConsent } from './consent.ts';
import type { InquiryRow } from './shared.ts';

const READER_STATUS: Record<string, InquiryWire['status']> = {
  pending: 'waiting',
  queued: 'looking',
  admitted: 'found',
  none: 'nothing_found',
  rejected: 'did_not_hold_up',
  nothing_to_ask: 'nothing_to_ask',
  failed: 'failed',
  withdrawn: 'withdrawn',
};
async function foundBridge(
  client: pg.PoolClient,
  proposalId: string,
): Promise<InquiryWire['found']> {
  return connectionView(client, 'b.proposal_id', proposalId);
}
/** ADR-0039: the same view of any bridge by id (a Relic's connection, a correction on return). */
export async function bridgeConnection(
  client: pg.PoolClient,
  bridgeId: string,
): Promise<InquiryWire['found']> {
  return connectionView(client, 'b.id', bridgeId);
}
async function connectionView(
  client: pg.PoolClient,
  column: 'b.id' | 'b.proposal_id',
  value: string,
): Promise<InquiryWire['found']> {
  const b = (
    await client.query<{
      id: string;
      status: 'admitted' | 'revoked' | 'superseded';
      relation_type: string;
      mechanism: string;
      from_code: string;
      from_name: string;
      to_code: string;
      to_name: string;
    }>(
      `SELECT b.id, b.status, b.relation_type, b.mechanism, f.code AS from_code, f.name AS from_name, t.code AS to_code, t.name AS to_name
     FROM bridge b JOIN concept f ON f.id = b.from_concept_id JOIN concept t ON t.id = b.to_concept_id WHERE ${column}=$1`,
      [value],
    )
  ).rows[0];
  if (!b) return null;
  // The evidence it was admitted on, even if a source was corrected since (current snapshots first),
  // each saying whether it has since lost its current support (ADR-0044 M4).
  const evidence = (
    await client.query<{
      key: string;
      statement: string;
      supports: 'from' | 'to' | 'mechanism' | 'limitation';
      source_title: string;
      source_url: string;
      withdrawn: boolean;
    }>(
      `
      SELECT DISTINCT
        ON (cl.key, e.supports) cl.key,
        cl.statement,
        e.supports,
        s.title AS source_title,
        s.url AS source_url,
        NOT claim_is_supported (cl.id) AS withdrawn
      FROM
        bridge_evidence e
        JOIN claim cl ON cl.id = e.claim_id
        JOIN claim_support cs ON cs.claim_id = cl.id
        AND cs.support_kind = 'supports'
        JOIN source_snapshot ss ON ss.id = cs.snapshot_id
        JOIN semantic_source s ON s.id = ss.source_id
      WHERE
        e.bridge_id = $1
      ORDER BY
        cl.key,
        e.supports,
        (ss.status = 'current') DESC,
        s.key
    `,
      [b.id],
    )
  ).rows;
  return {
    bridgeId: b.id,
    bridgeStatus: b.status,
    relationType: b.relation_type as NonNullable<
      InquiryWire['found']
    >['relationType'],
    fromConcept: { code: b.from_code, name: b.from_name },
    toConcept: { code: b.to_code, name: b.to_name },
    sentence: b.mechanism,
    evidence: evidence.map((e) => ({
      claimKey: e.key,
      statement: e.statement,
      supports: e.supports,
      sourceTitle: e.source_title,
      sourceUrl: e.source_url,
      withdrawn: e.withdrawn,
    })),
  };
}
/** `GET /v1/inquiries`: this universe's inquiries in the current epoch, newest first. A family is its
 * children, each with its own pair and outcome; the parent that only waited for them is not listed. */
export async function listInquiries(
  client: pg.PoolClient,
  scope: AuthScope,
): Promise<InquiriesResponse> {
  const rows = (
    await client.query<InquiryRow>(
      `
      SELECT
        *
      FROM
        background_inquiry
      WHERE
        universe_id = $1
        AND privacy_epoch = $2
        AND role <> 'parent'
      ORDER BY
        first_mail_at DESC,
        id DESC
      LIMIT
        $3
    `,
      [scope.universeId, scope.privacyEpoch, INQUIRY_LIST_LIMIT],
    )
  ).rows;
  const inquiries: InquiryWire[] = [];
  for (const r of rows) {
    inquiries.push({
      inquiryId: r.id,
      status: READER_STATUS[r.status]!,
      requestedAt: r.first_mail_at.toISOString(),
      closedAt: r.closed_at ? r.closed_at.toISOString() : null,
      pairs: r.pairs ?? [],
      reasons: r.reasons,
      found:
        r.status === 'admitted' && r.proposal_id
          ? await foundBridge(client, r.proposal_id)
          : null,
    });
  }
  return {
    privacyEpoch: scope.privacyEpoch,
    consent: await readInquiryConsent(client, scope),
    inquiries,
  };
}
