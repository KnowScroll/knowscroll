/**
 * #134 — Relics (ADR-0039 §3-4): durable, private things the reader deliberately keeps. First kind:
 * `connection`, one admitted bridge. The row is immutable; its truth state is derived when read, so
 * a later source correction or the reader's own "seems wrong" is shown on the kept Relic, never
 * hidden. Release removes the row.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { RELIC_LIST_LIMIT, relicKeepInput, relicReleaseInput, type RelicKeepResponse, type RelicReleaseResponse, type RelicsResponse, type RelicWire } from '../../contracts/src/relics.ts';
import { ReturnError } from './away.ts';
import type { AuthScope } from './identity.ts';
import { bridgeConnection } from './reasoning-inquiries.ts';

type RelicRow = { id: string; bridge_id: string; inquiry_id: string | null; validator_version: string; cited_claim_keys: string[]; kept_at: Date };

async function relicView(client: pg.PoolClient, universeId: string, row: RelicRow): Promise<RelicWire> {
  const connection = await bridgeConnection(client, row.bridge_id);
  if (!connection) throw new Error('A Relic outlived its connection');
  const doubted = (await client.query("SELECT 1 FROM connection_feedback WHERE universe_id=$1 AND bridge_id=$2 AND objection='seems_wrong'",
    [universeId, row.bridge_id])).rowCount! > 0;
  return {
    relicId: row.id, kind: 'connection', keptAt: row.kept_at.toISOString(),
    state: connection.bridgeStatus !== 'admitted' ? 'corrected' : doubted ? 'doubted' : 'current',
    connection,
    provenance: { inquiryId: row.inquiry_id, validatorVersion: row.validator_version, citedClaimKeys: row.cited_claim_keys },
  };
}

const COLUMNS = 'id, bridge_id, inquiry_id, validator_version, cited_claim_keys, kept_at';

/** `POST /v1/relics`: 201 with the new Relic, or 200 with the one already kept (same request, or same connection). */
export async function keepRelic(client: pg.PoolClient, scope: AuthScope, raw: unknown): Promise<{ created: boolean; body: RelicKeepResponse }> {
  const parsed = relicKeepInput.safeParse(raw);
  if (!parsed.success) throw new ReturnError(400, 'Invalid Relic');
  const input = parsed.data;
  const replay = (await client.query<RelicRow>(`SELECT ${COLUMNS} FROM relic WHERE universe_id=$1 AND client_request_id=$2`, [scope.universeId, input.clientRequestId])).rows[0];
  if (replay) {
    if (replay.bridge_id !== input.bridgeId) throw new ReturnError(409, 'Relic key reused for a different connection');
    return { created: false, body: { privacyEpoch: scope.privacyEpoch, relic: await relicView(client, scope.universeId, replay) } };
  }
  if (input.expectedPrivacyEpoch !== scope.privacyEpoch) throw new ReturnError(409, 'Privacy epoch is stale');
  const kept = (await client.query<RelicRow>(`SELECT ${COLUMNS} FROM relic WHERE universe_id=$1 AND privacy_epoch=$2 AND bridge_id=$3`,
    [scope.universeId, scope.privacyEpoch, input.bridgeId])).rows[0];
  if (kept) return { created: false, body: { privacyEpoch: scope.privacyEpoch, relic: await relicView(client, scope.universeId, kept) } };
  if ((await client.query<{ paused: boolean }>('SELECT recording_paused_at IS NOT NULL AS paused FROM universe WHERE id=$1', [scope.universeId])).rows[0]!.paused) {
    throw new ReturnError(409, 'Recording is paused');
  }
  const bridge = (await client.query<{ validator_version: string; proposal_id: string }>(
    `SELECT validator_version, proposal_id FROM bridge WHERE id=$1 AND status='admitted'
       AND (scope_kind='shared' OR (universe_id=$2 AND privacy_epoch=$3))`, [input.bridgeId, scope.universeId, scope.privacyEpoch])).rows[0];
  if (!bridge) throw new ReturnError(422, 'Unknown or withdrawn connection');
  if ((await client.query("SELECT 1 FROM connection_feedback WHERE universe_id=$1 AND bridge_id=$2 AND objection='seems_wrong'", [scope.universeId, input.bridgeId])).rowCount) {
    throw new ReturnError(422, 'You marked this connection as seeming wrong');
  }
  const cited = (await client.query<{ key: string }>(
    'SELECT DISTINCT cl.key FROM bridge_evidence e JOIN claim cl ON cl.id = e.claim_id WHERE e.bridge_id=$1 ORDER BY cl.key LIMIT 12', [input.bridgeId])).rows.map(r => r.key);
  // Provenance is the server's to record: the reader's own inquiry that found it, if any.
  const inquiry = (await client.query<{ id: string }>(
    "SELECT id FROM background_inquiry WHERE universe_id=$1 AND privacy_epoch=$2 AND status='admitted' AND proposal_id=$3",
    [scope.universeId, scope.privacyEpoch, bridge.proposal_id])).rows[0];
  const row = (await client.query<RelicRow>(
    `INSERT INTO relic(id, universe_id, privacy_epoch, client_request_id, kind, bridge_id, inquiry_id, validator_version, cited_claim_keys)
     VALUES ($1,$2,$3,$4,'connection',$5,$6,$7,$8) RETURNING ${COLUMNS}`,
    [randomUUID(), scope.universeId, scope.privacyEpoch, input.clientRequestId, input.bridgeId, inquiry?.id ?? null, bridge.validator_version, JSON.stringify(cited)])).rows[0]!;
  return { created: true, body: { privacyEpoch: scope.privacyEpoch, relic: await relicView(client, scope.universeId, row) } };
}

/** `GET /v1/relics`: this epoch's Relics, newest first, each with its derived state. */
export async function listRelics(client: pg.PoolClient, scope: AuthScope): Promise<RelicsResponse> {
  const rows = (await client.query<RelicRow>(`SELECT ${COLUMNS} FROM relic WHERE universe_id=$1 AND privacy_epoch=$2 ORDER BY kept_at DESC, id LIMIT $3`,
    [scope.universeId, scope.privacyEpoch, RELIC_LIST_LIMIT])).rows;
  const relics: RelicWire[] = [];
  for (const row of rows) relics.push(await relicView(client, scope.universeId, row));
  return { privacyEpoch: scope.privacyEpoch, relics };
}

/** `POST /v1/relics/:id/release`: let it go. Allowed while paused (it removes, it records nothing);
 * releasing one that is already gone is the same outcome and answers the same. */
export async function releaseRelic(client: pg.PoolClient, scope: AuthScope, relicId: string, raw: unknown): Promise<RelicReleaseResponse> {
  const parsed = relicReleaseInput.safeParse(raw);
  if (!parsed.success) throw new ReturnError(400, 'Invalid release');
  if (parsed.data.expectedPrivacyEpoch !== scope.privacyEpoch) throw new ReturnError(409, 'Privacy epoch is stale');
  await client.query('DELETE FROM relic WHERE id=$1 AND universe_id=$2 AND privacy_epoch=$3', [relicId, scope.universeId, scope.privacyEpoch]);
  return { privacyEpoch: scope.privacyEpoch, relicId, released: true };
}

// Privacy -------------------------------------------------------------------------------------

/** Clear/Reset/deletion: before the inquiries and personal bridges a Relic names. */
export async function eraseRelics(client: pg.PoolClient, universeId: string): Promise<void> {
  await client.query('DELETE FROM relic WHERE universe_id=$1', [universeId]);
}

export async function exportRelics(client: pg.PoolClient, universeId: string) {
  return (await client.query(`SELECT id, privacy_epoch, kind, bridge_id, inquiry_id, validator_version, cited_claim_keys, kept_at
    FROM relic WHERE universe_id=$1 ORDER BY kept_at, id`, [universeId])).rows;
}
