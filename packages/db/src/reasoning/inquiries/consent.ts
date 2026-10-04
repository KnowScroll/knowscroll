/**
 * Standing consent for background inquiries and the daily count of inquiries opened (ADR-0038 §1,
 * ADR-0042 §4). A consent change runs under the caller's authenticated universe lock.
 */
import { randomUUID } from 'node:crypto';
import {
  INQUIRY_DAILY_LIMIT,
  type InquiryConsentResponse,
  type InquiryConsentView,
  inquiryConsentInput,
} from '@knowscroll/contracts/inquiries';
import type pg from 'pg';
import type { AuthScope } from '../../identity.ts';
import { InquiryError } from './shared.ts';
import { withdrawInquiries } from './stopping.ts';

/** Inquiries the mailbox opened today (UTC): a family counts once, its children never (ADR-0042 §4). */
export async function openedToday(
  client: pg.PoolClient,
  universeId: string,
  privacyEpoch: number,
): Promise<number> {
  return (
    await client.query<{ n: number }>(
      `
      SELECT
        count(*)::int AS n
      FROM
        background_inquiry
      WHERE
        universe_id = $1
        AND privacy_epoch = $2
        AND parent_id IS NULL
        AND opened_at >= (
          date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        )
    `,
      [universeId, privacyEpoch],
    )
  ).rows[0]!.n;
}
export async function readInquiryConsent(
  client: pg.PoolClient,
  scope: { universeId: string; privacyEpoch: number },
): Promise<InquiryConsentView> {
  const row = (
    await client.query<{
      enabled: boolean;
      daily_limit: number;
      changed_at: Date;
    }>(
      `
      SELECT
        enabled,
        daily_limit,
        changed_at
      FROM
        background_inquiry_consent
      WHERE
        universe_id = $1
        AND privacy_epoch = $2
    `,
      [scope.universeId, scope.privacyEpoch],
    )
  ).rows[0];
  const available =
    (await client.query('SELECT 1 FROM background_inquiry_route WHERE enabled'))
      .rowCount === 1;
  const used = await openedToday(client, scope.universeId, scope.privacyEpoch);
  return {
    enabled: row?.enabled ?? false,
    dailyLimit: row?.daily_limit ?? INQUIRY_DAILY_LIMIT.default,
    changedAt: row ? row.changed_at.toISOString() : null,
    available,
    usedToday: used,
  };
}
/**
 * ADR-0038 §1: set or clear the standing consent. The caller holds the authenticated universe lock
 * (`authenticateAndLock`), so the request comes from a live session of this universe; the schema
 * refuses a consent change without its recorded request. An exact retry replays; a reused key with
 * other content is a conflict. Turning it off withdraws everything not yet sent.
 */
export async function setInquiryConsent(
  client: pg.PoolClient,
  scope: AuthScope,
  raw: unknown,
): Promise<InquiryConsentResponse> {
  const parsed = inquiryConsentInput.safeParse(raw);
  if (!parsed.success) throw new InquiryError(400, 'Invalid consent request');
  const input = parsed.data;
  const respond = async () => ({
    privacyEpoch: scope.privacyEpoch,
    consent: await readInquiryConsent(client, scope),
  });
  const old = (
    await client.query<{
      privacy_epoch: number;
      enabled: boolean;
      daily_limit: number;
    }>(
      `
      SELECT
        privacy_epoch,
        enabled,
        daily_limit
      FROM
        background_inquiry_consent_request
      WHERE
        universe_id = $1
        AND client_request_id = $2
    `,
      [scope.universeId, input.clientRequestId],
    )
  ).rows[0];
  if (old) {
    if (
      old.privacy_epoch !== input.expectedPrivacyEpoch ||
      old.enabled !== input.enabled ||
      (input.dailyLimit !== undefined && input.dailyLimit !== old.daily_limit)
    ) {
      throw new InquiryError(
        409,
        'Consent request key reused with different content',
      );
    }
    return respond();
  }
  if (input.expectedPrivacyEpoch !== scope.privacyEpoch)
    throw new InquiryError(409, 'Consent privacy epoch is stale');
  const current = (
    await client.query<{ daily_limit: number }>(
      `
      SELECT
        daily_limit
      FROM
        background_inquiry_consent
      WHERE
        universe_id = $1
        AND privacy_epoch = $2
      FOR UPDATE
    `,
      [scope.universeId, scope.privacyEpoch],
    )
  ).rows[0];
  const dailyLimit =
    input.dailyLimit ?? current?.daily_limit ?? INQUIRY_DAILY_LIMIT.default;
  const requestId = randomUUID();
  await client.query(
    `
      INSERT INTO
        background_inquiry_consent_request (
          id,
          universe_id,
          privacy_epoch,
          session_id,
          client_request_id,
          enabled,
          daily_limit
        )
      VALUES
        ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      requestId,
      scope.universeId,
      scope.privacyEpoch,
      scope.sessionId,
      input.clientRequestId,
      input.enabled,
      dailyLimit,
    ],
  );
  if (current) {
    await client.query(
      `
      UPDATE background_inquiry_consent
      SET
        enabled = $3,
        daily_limit = $4,
        revision = revision + 1,
        request_id = $5
      WHERE
        universe_id = $1
        AND privacy_epoch = $2
    `,
      [
        scope.universeId,
        scope.privacyEpoch,
        input.enabled,
        dailyLimit,
        requestId,
      ],
    );
  } else {
    await client.query(
      `
      INSERT INTO
        background_inquiry_consent (
          universe_id,
          privacy_epoch,
          enabled,
          daily_limit,
          revision,
          request_id
        )
      VALUES
        ($1, $2, $3, $4, 1, $5)
    `,
      [
        scope.universeId,
        scope.privacyEpoch,
        input.enabled,
        dailyLimit,
        requestId,
      ],
    );
  }
  if (!input.enabled)
    await withdrawInquiries(
      client,
      scope.universeId,
      scope.privacyEpoch,
      'consent_off',
    );
  return respond();
}
