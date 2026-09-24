import assert from 'node:assert/strict';
import type {Pool} from 'pg';

export type HttpJourney = {
  universeId: string;
  asset: {assetId: string; revision: number; sourceTitle: string; sourceUrl: string; truthState: string};
  decisionId: string;
  accountRevision: number;
  exposure: {exposureId: string; eventId: string; clientExposureId: string};
  accepted: {eventId: string; jobId: string; status: string; clientEventId: string};
  beforeRevision: number;
  afterRevision: number;
};

type Row = Record<string, unknown>;

function single(rows: Row[], message: string): Row {
  assert.equal(rows.length, 1, message);
  return rows[0]!;
}

/**
 * Proves the HTTP identifiers resolve to one persisted causal path. This is
 * deliberately separate from endpoint assertions: an HTTP server aimed at a
 * different database can return plausible JSON but cannot satisfy this query.
 */
export async function verifyPersistedJourney(pool: Pick<Pool, 'query'>, journey: HttpJourney) {
  assert.equal(journey.accepted.status, 'accepted');
  assert.ok(journey.afterRevision > journey.beforeRevision, 'universe revision must advance after projection');
  const rows = (await pool.query<Row>(`
    SELECT
      d.id AS decision_id, d.universe_id AS decision_universe_id,
      d.account_revision AS decision_account_revision, d.policy_version, d.ranking_version, d.candidates,
      e.id AS exposure_id, e.universe_id AS exposure_universe_id,
      e.asset_id AS exposure_asset_id, e.event_id AS exposure_event_id,
      le.id AS ledger_exposure_id, le.kind AS ledger_exposure_kind,
      le.client_key::text AS exposure_client_key, le.universe_id AS ledger_exposure_universe_id, le.payload AS exposure_payload,
      lk.id AS keep_event_id, lk.kind AS keep_kind, lk.causation_id,
      lk.client_key::text AS keep_client_key, lk.universe_id AS keep_universe_id, lk.payload AS keep_payload,
      j.id AS job_id, j.universe_id AS job_universe_id, j.kind AS job_kind, j.status AS job_status,
      j.attempts AS job_attempts, j.completed_at,
      t.event_id AS trace_event_id, t.asset_id AS trace_asset_id, t.universe_id AS trace_universe_id,
      a.revision AS accounts_revision, a.kept_asset_ids,
      u.revision AS universe_revision, asset.revision AS asset_revision,
      asset.source_title AS source_title, asset.source_url AS source_url, asset.truth_state AS truth_state
    FROM decision d
    JOIN exposure e ON e.decision_id=d.id
    JOIN ledger le ON le.id=e.event_id
    JOIN ledger lk ON lk.id=$3
    JOIN job j ON j.id=$4 AND j.event_id=lk.id
    JOIN trace t ON t.universe_id=lk.universe_id AND t.event_id=lk.id
    JOIN accounts a ON a.universe_id=lk.universe_id
    JOIN universe u ON u.id=lk.universe_id
    JOIN asset ON asset.id=e.asset_id
    WHERE d.id=$1 AND e.id=$2
  `, [journey.decisionId, journey.exposure.exposureId, journey.accepted.eventId, journey.accepted.jobId])).rows;
  const row = single(rows, 'no single persisted decision/exposure/keep/job/Accounts/Trace lineage exists for the HTTP receipt');
  assert.equal(row.decision_id, journey.decisionId);
  assert.equal(row.decision_universe_id, journey.universeId);
  assert.equal(row.exposure_universe_id, journey.universeId);
  assert.equal(row.ledger_exposure_universe_id, journey.universeId);
  assert.equal(row.keep_universe_id, journey.universeId);
  assert.equal(row.job_universe_id, journey.universeId);
  assert.equal(row.trace_universe_id, journey.universeId);
  assert.equal(row.exposure_id, journey.exposure.exposureId);
  assert.equal(row.exposure_event_id, journey.exposure.eventId);
  assert.equal(row.ledger_exposure_id, journey.exposure.eventId);
  assert.equal(row.ledger_exposure_kind, 'exposure');
  assert.equal(row.exposure_client_key, journey.exposure.clientExposureId);
  assert.equal(row.keep_event_id, journey.accepted.eventId);
  assert.equal(row.keep_kind, 'keep');
  assert.equal(row.keep_client_key, journey.accepted.clientEventId);
  assert.equal(row.causation_id, journey.exposure.eventId, 'keep must be caused by the recorded exposure');
  assert.equal(row.job_id, journey.accepted.jobId);
  assert.equal(row.job_kind, 'project_keep');
  assert.equal(row.job_status, 'completed', 'the admitted job must be completed');
  assert.ok(Number(row.job_attempts) >= 1, 'completed job must record an attempt');
  assert.ok(row.completed_at, 'completed job must have completion time');
  assert.equal(row.trace_event_id, journey.accepted.eventId);
  assert.equal(row.trace_asset_id, journey.asset.assetId);
  assert.equal(row.exposure_asset_id, journey.asset.assetId);
  assert.equal(row.asset_revision, journey.asset.revision);
  assert.equal(row.source_title, journey.asset.sourceTitle);
  assert.equal(row.source_url, journey.asset.sourceUrl);
  assert.equal(row.truth_state, journey.asset.truthState);
  assert.equal(row.decision_account_revision, journey.accountRevision);
  // Retrieval and ranking are recorded as a pair: composer-semantic-v3 (the default, ADR-0032) considers
  // kept encounters and gates them; composer-signals-v2 retrieves only unkept ones (ADR-0028).
  assert.ok(
    (row.policy_version === 'semantic-retrieval-v3' && row.ranking_version === 'composer-semantic-v3')
      || (row.policy_version === 'editorial-unkept-v1' && row.ranking_version === 'composer-signals-v2'),
    `unexpected retrieval/ranking pair ${row.policy_version}/${row.ranking_version}`,
  );
  assert.ok(Array.isArray(row.candidates) && row.candidates.some((candidate: {assetId?: string}) => candidate.assetId===journey.asset.assetId), 'decision must persist the selected asset');
  assert.ok(Number(row.accounts_revision) > journey.beforeRevision, 'Accounts projection must advance');
  assert.ok(Number(row.universe_revision) > journey.beforeRevision, 'universe projection must advance');
  assert.ok(Array.isArray(row.kept_asset_ids) && row.kept_asset_ids.includes(journey.asset.assetId), 'Accounts must retain the explicitly kept asset');
  const exposurePayload = row.exposure_payload as {decisionId?: string; assetId?: string; exposureId?: string; clientExposureId?: string};
  const keepPayload = row.keep_payload as {exposureId?: string; assetId?: string; kind?: string; clientEventId?: string};
  assert.deepEqual(exposurePayload, {decisionId: journey.decisionId, assetId: journey.asset.assetId, exposureId: journey.exposure.exposureId, clientExposureId: journey.exposure.clientExposureId});
  assert.deepEqual(keepPayload, {exposureId: journey.exposure.exposureId, assetId: journey.asset.assetId, kind: 'keep', clientEventId: journey.accepted.clientEventId});
  const replayCounts = (await pool.query<{events: number; jobs: number}>(`
    SELECT
      (SELECT count(*)::int FROM ledger WHERE universe_id=$1 AND kind='keep' AND client_key=$2) AS events,
      (SELECT count(*)::int FROM job WHERE event_id=$3) AS jobs
  `, [journey.universeId, journey.accepted.clientEventId, journey.accepted.eventId])).rows[0]!;
  assert.equal(replayCounts.events, 1, 'retry must not add a second keep event');
  assert.equal(replayCounts.jobs, 1, 'retry must not add a second projection job');
  return {
    decision: {id: row.decision_id, accountRevision: row.decision_account_revision, policyVersion: row.policy_version},
    lineage: {exposureEventId: row.exposure_event_id, keepEventId: row.keep_event_id, jobId: row.job_id, traceEventId: row.trace_event_id},
    projection: {accountsRevision: row.accounts_revision, universeRevision: row.universe_revision, completedAt: row.completed_at}
  };
}
