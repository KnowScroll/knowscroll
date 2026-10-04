/**
 * Recording what a reader was shown and what they kept. Each function runs in the caller's
 * authenticated transaction, under the universe lock it already holds. The ledger event and its
 * exposure or projection job are written together; a retried request with the same client key
 * replays the stored result before anything else runs, and the same key with different content is
 * refused (ADR-0004, ADR-0005, ADR-0009).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { z } from 'zod';
import type {
  exposureInput,
  InteractionInput,
  ScrollAsset,
} from '@knowscroll/contracts';
import type { AuthScope } from './identity.ts';
import { refreshPersonalModel } from './semantic/personal-model.ts';
import { projectWorldsForEncounter } from './worlds.ts';

/** A refusal the API returns as-is: its global error handler answers `statusCode` with `message`. */
export class EncounterError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Records one exposure of an asset the decision served: the ledger event, the exposure row, then
 * the reader's world system and personal model, in that order. A retried request with the same
 * client key returns the stored exposure before any projection runs; the same key with different
 * content is refused ('Exposure key reused with different content').
 */
export async function recordExposure(
  client: pg.PoolClient,
  scope: AuthScope,
  body: z.infer<typeof exposureInput>,
): Promise<{ exposureId: string; eventId: string }> {
  const decision = (
    await client.query<{ candidates: ScrollAsset[]; privacy_epoch: number }>(
      'SELECT candidates, privacy_epoch FROM decision WHERE id=$1 AND universe_id=$2',
      [body.decisionId, scope.universeId],
    )
  ).rows[0];
  if (!decision)
    throw new EncounterError(422, 'Asset was not selected in this decision');
  if (decision.privacy_epoch !== scope.privacyEpoch)
    throw new EncounterError(409, 'Decision belongs to an older privacy epoch');
  const old = (
    await client.query<{
      id: string;
      decision_id: string;
      asset_id: string;
      event_id: string;
    }>('SELECT * FROM exposure WHERE universe_id=$1 AND client_key=$2', [
      scope.universeId,
      body.clientExposureId,
    ])
  ).rows[0];
  if (old) {
    if (old.decision_id !== body.decisionId || old.asset_id !== body.assetId)
      throw new EncounterError(
        409,
        'Exposure key reused with different content',
      );
    return { exposureId: old.id, eventId: old.event_id };
  }
  if (
    !decision.candidates.some(
      (asset: ScrollAsset) => asset.assetId === body.assetId,
    )
  )
    throw new EncounterError(422, 'Asset was not selected in this decision');
  const exposureId = randomUUID();
  const eventId = randomUUID();
  await client.query(
    'INSERT INTO ledger(id,universe_id,kind,client_key,payload,privacy_epoch) VALUES($1,$2,$3,$4,$5,$6)',
    [
      eventId,
      scope.universeId,
      'exposure',
      body.clientExposureId,
      JSON.stringify({ ...body, exposureId }),
      scope.privacyEpoch,
    ],
  );
  await client.query(
    `
        INSERT INTO
          exposure (
            id,
            universe_id,
            decision_id,
            asset_id,
            event_id,
            client_key
          )
        VALUES
          ($1, $2, $3, $4, $5, $6)
      `,
    [
      exposureId,
      scope.universeId,
      body.decisionId,
      body.assetId,
      eventId,
      body.clientExposureId,
    ],
  );
  // A brand-new exposure is the only new evidence this endpoint produces, so the world projection
  // must run in this same transaction and never lag behind it (ADR-0028).
  await projectWorldsForEncounter(client, scope.universeId);
  // The private personal model follows the same evidence in the same transaction (ADR-0032).
  await refreshPersonalModel(client, scope.universeId);
  return { exposureId, eventId };
}

/**
 * Records a Keep of an exposed asset: the ledger event, its `project_keep` job, then the personal
 * model. A retried request with the same client key returns the stored event and job; the same key
 * with different content is refused ('Event key reused with different content').
 */
export async function recordKeep(
  client: pg.PoolClient,
  scope: AuthScope,
  body: InteractionInput,
): Promise<{ eventId: string; jobId: string; status: 'accepted' }> {
  const exposure = (
    await client.query<{
      event_id: string;
      asset_id: string;
      privacy_epoch: number;
    }>(
      `
        SELECT
          e.event_id,
          e.asset_id,
          l.privacy_epoch
        FROM
          exposure e
          JOIN ledger l ON l.id = e.event_id
        WHERE
          e.id = $1
          AND e.universe_id = $2
      `,
      [body.exposureId, scope.universeId],
    )
  ).rows[0];
  if (!exposure)
    throw new EncounterError(422, 'A matching exposure is required');
  if (exposure.privacy_epoch !== scope.privacyEpoch)
    throw new EncounterError(409, 'Exposure belongs to an older privacy epoch');
  const old = (
    await client.query<{
      id: string;
      payload: Pick<InteractionInput, 'exposureId' | 'assetId'>;
      job_id: string;
    }>(
      `
        SELECT
          l.id,
          l.payload,
          j.id AS job_id
        FROM
          ledger l
          JOIN job j ON j.event_id = l.id
        WHERE
          l.universe_id = $1
          AND l.kind = 'keep'
          AND l.client_key = $2
      `,
      [scope.universeId, body.clientEventId],
    )
  ).rows[0];
  if (old) {
    if (
      old.payload.exposureId !== body.exposureId ||
      old.payload.assetId !== body.assetId
    )
      throw new EncounterError(409, 'Event key reused with different content');
    return { eventId: old.id, jobId: old.job_id, status: 'accepted' };
  }
  if (exposure.asset_id !== body.assetId)
    throw new EncounterError(422, 'A matching exposure is required');
  const eventId = randomUUID();
  const jobId = randomUUID();
  await client.query(
    `
        INSERT INTO
          ledger (
            id,
            universe_id,
            kind,
            client_key,
            causation_id,
            payload,
            privacy_epoch
          )
        VALUES
          ($1, $2, $3, $4, $5, $6, $7)
      `,
    [
      eventId,
      scope.universeId,
      'keep',
      body.clientEventId,
      exposure.event_id,
      JSON.stringify(body),
      scope.privacyEpoch,
    ],
  );
  await client.query(
    'INSERT INTO job(id,universe_id,event_id,kind,privacy_epoch) VALUES($1,$2,$3,$4,$5)',
    [jobId, scope.universeId, eventId, 'project_keep', scope.privacyEpoch],
  );
  await refreshPersonalModel(client, scope.universeId);
  return { eventId, jobId, status: 'accepted' };
}

/** One ledger event of this universe with its projection job's state, or undefined. */
export async function readLedgerEvent(
  client: pg.PoolClient,
  scope: AuthScope,
  eventId: string,
) {
  return (
    await client.query(
      `
        SELECT
          l.id AS "eventId",
          l.causation_id AS "causationId",
          l.payload ->> 'exposureId' AS "exposureId",
          l.kind,
          j.id AS "jobId",
          j.status AS "jobStatus",
          COALESCE(j.status = 'completed', FALSE) AS projected
        FROM
          ledger l
          LEFT JOIN job j ON j.event_id = l.id
        WHERE
          l.id = $1
          AND l.universe_id = $2
      `,
      [eventId, scope.universeId],
    )
  ).rows[0];
}
