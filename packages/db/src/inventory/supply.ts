/**
 * #164 — shared supply (ADR-0046 §3): the operator's writing route and material candidates, and the
 * shared requests the Quartermaster funds. Nothing here names a universe; no privacy operation
 * erases or exports it.
 *
 * A funded request holds one unit of its route's bucket until it is sent (the unit is consumed) or
 * settles unsent (it is released): migration 0040 keeps that account, so a request is funded only
 * while a unit is left. Its one send is admitted by `admitRequest`, committed before the request goes
 * out: it marks the request `sending`, so a request is sent at most once and never retried. A request
 * no one waits for any more, or whose route was disabled, is cancelled there instead. Settlement is
 * `settleRequest`; the waiters' demands are then decided again (`inventory/demand.ts`).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { checkMaterialUrl, MATERIAL_POLICY_VERSION } from '../../../core/src/scrolls/material.ts';
import type { ScrollPlanItem } from '../../../core/src/scrolls/writing.ts';

/** Bench value: a request marked `sending` this long ago with no settlement (its worker died) is failed as `outcome_unknown`, never sent again. */
export const ABANDONED_SEND_MS = 30 * 60_000;

export type RequestOutcome =
  | { status: 'fulfilled'; writingId: string | null; assetId: string }
  | { status: 'refused'; writingId: string | null; reasons: readonly string[] }
  | { status: 'failed' | 'cancelled'; reasons: readonly string[] };

/** Every decision about supply is made under this one lock: after the universe lock, before the
 * route's bucket row. A transaction may decide several concepts' needs; with one lock taken in one
 * order, two such transactions cannot wait on each other. */
export async function lockSupply(client: pg.PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('ks-inventory'))");
}

/** Installs and enables one route (disabling any other); its request cap becomes its bucket. */
export async function installScrollWritingRoute(client: pg.PoolClient, input: { id: string; transport: 'fixture' | 'minimax'; model: string; requestCap: number }): Promise<void> {
  const bucket = randomUUID();
  await client.query(`INSERT INTO reasoning_bucket(id,dimension,unit,capacity) VALUES($1,'route_quota','requests',$2)`, [bucket, input.requestCap]);
  await client.query('UPDATE scroll_writing_route SET enabled=false WHERE enabled');
  await client.query('INSERT INTO scroll_writing_route(id,transport,model,request_bucket_id,enabled) VALUES($1,$2,$3,$4,true)',
    [input.id, input.transport, input.model, bucket]);
}

/** ADR-0041's plan items, installed as material: only allowlisted pages, only concepts the substrate holds (the schema checks those). */
export async function installMaterialCandidates(client: pg.PoolClient, items: readonly ScrollPlanItem[]): Promise<{ installed: number }> {
  let installed = 0;
  for (const item of items) {
    const checked = checkMaterialUrl(item.url);
    if (!checked.ok) throw new Error(`Material ${item.url} is refused: ${checked.reason}`);
    installed += (await client.query('INSERT INTO scroll_material_candidate(id,url,concept_codes) VALUES($1,$2,$3) ON CONFLICT (url) DO NOTHING',
      [randomUUID(), checked.url, item.conceptCodes])).rowCount ?? 0;
  }
  return { installed };
}

export interface SupplyFacts {
  openRequestId: string | null;
  route: { id: string; requestsLeft: number } | null;
  candidates: { id: string; conceptCodes: string[]; requested: boolean }[];
}

/** What the Quartermaster knows about a concept's supply. The caller holds `lockSupply`; the
 * route's bucket stays locked until it commits, so the budget it decided on is still there to fund. */
export async function loadSupplyFacts(client: pg.PoolClient, conceptId: string): Promise<SupplyFacts> {
  const open = (await client.query<{ id: string }>(`SELECT id FROM supply_request WHERE concept_id=$1 AND modality='scroll' AND status IN ('open','sending')`, [conceptId])).rows[0];
  const route = (await client.query<{ id: string; left: string }>(
    `SELECT r.id, b.capacity - b.reserved - b.consumed AS left FROM scroll_writing_route r JOIN reasoning_bucket b ON b.id = r.request_bucket_id
     WHERE r.enabled FOR UPDATE OF b`,
  )).rows[0];
  const candidates = (await client.query<{ id: string; concept_codes: string[]; requested: boolean }>(
    `SELECT m.id, m.concept_codes,
       EXISTS (SELECT 1 FROM supply_request s WHERE s.candidate_id = m.id AND s.concept_id = $1 AND supply_request_uses_material(s.status, s.reasons)) AS requested
     FROM scroll_material_candidate m ORDER BY m.created_at, m.id`, [conceptId],
  )).rows;
  return {
    openRequestId: open?.id ?? null,
    route: route ? { id: route.id, requestsLeft: Number(route.left) } : null,
    candidates: candidates.map(c => ({ id: c.id, conceptCodes: c.concept_codes, requested: c.requested })),
  };
}

/** A funded request: the concept, modality, rights policy and chosen material, nothing of the reader's.
 * Opening it takes one unit of the route's bucket (migration 0040). */
export async function openRequest(client: pg.PoolClient, input: { conceptId: string; routeId: string; candidateId: string; offeredCodes: readonly string[] }): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO supply_request(id,concept_id,modality,rights_policy,route_id,candidate_id,offered_codes,status) VALUES($1,$2,'scroll',$3,$4,$5,$6,'open')`,
    [id, input.conceptId, MATERIAL_POLICY_VERSION, input.routeId, input.candidateId, input.offeredCodes],
  );
  return id;
}

export interface QueuedRequest { id: string; url: string; offeredCodes: string[]; transport: 'fixture' | 'minimax'; model: string }

/** The oldest open request on the enabled route. */
export async function nextOpenRequest(client: pg.Pool | pg.PoolClient): Promise<QueuedRequest | null> {
  const row = (await client.query<{ id: string; url: string; offered_codes: string[]; transport: 'fixture' | 'minimax'; model: string }>(
    `SELECT r.id, m.url, r.offered_codes, w.transport, w.model FROM supply_request r
     JOIN scroll_material_candidate m ON m.id = r.candidate_id JOIN scroll_writing_route w ON w.id = r.route_id AND w.enabled
     WHERE r.status = 'open' ORDER BY r.created_at, r.id LIMIT 1`,
  )).rows[0];
  return row ? { id: row.id, url: row.url, offeredCodes: row.offered_codes, transport: row.transport, model: row.model } : null;
}

/** The last step before the one send, committed before it: a request still open, still awaited and
 * on an enabled route becomes `sending`, which consumes the unit it held. Otherwise nothing is sent:
 * a request no one waits for, or whose route was disabled, is cancelled with that reason. */
export async function admitRequest(client: pg.PoolClient, requestId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  await lockSupply(client);
  const current = (await client.query<{ status: string; enabled: boolean }>(
    'SELECT r.status, w.enabled FROM supply_request r JOIN scroll_writing_route w ON w.id = r.route_id WHERE r.id=$1 FOR UPDATE OF r', [requestId])).rows[0]!;
  if (current.status !== 'open') return { ok: false, reason: 'request_not_open' };
  if (!current.enabled) return cancel(client, requestId, 'route_disabled');
  const awaited = (await client.query(`SELECT 1 FROM demand_waiter WHERE request_id=$1 AND status='waiting' LIMIT 1`, [requestId])).rowCount;
  if (!awaited) return cancel(client, requestId, 'no_waiters');
  await client.query(`UPDATE supply_request SET status='sending', sent_at=clock_timestamp() WHERE id=$1`, [requestId]);
  return { ok: true };
}

async function cancel(client: pg.PoolClient, requestId: string, reason: string): Promise<{ ok: false; reason: string }> {
  await settleRequest(client, requestId, { status: 'cancelled', reasons: [reason] });
  return { ok: false, reason };
}

export async function settleRequest(client: pg.PoolClient, requestId: string, outcome: RequestOutcome): Promise<void> {
  const fulfilled = outcome.status === 'fulfilled';
  await client.query(
    `UPDATE supply_request SET status=$2, reasons=$3, writing_id=$4, asset_id=$5, settled_at=clock_timestamp() WHERE id=$1 AND status IN ('open','sending')`,
    [requestId, outcome.status, JSON.stringify(fulfilled ? [] : outcome.reasons), 'writingId' in outcome ? outcome.writingId : null, fulfilled ? outcome.assetId : null],
  );
}

/** Requests that can no longer be sent as they are: those on a route that is no longer enabled
 * (cancelled, never sent) and those left `sending` by a worker that died (failed, `outcome_unknown`:
 * they may have reached the provider, so they are never sent again). Returns how many were settled. */
export async function settleStrandedRequests(client: pg.Pool | pg.PoolClient): Promise<number> {
  const disabled = await client.query(
    `UPDATE supply_request r SET status='cancelled', reasons='["route_disabled"]', settled_at=clock_timestamp()
     FROM scroll_writing_route w WHERE w.id = r.route_id AND NOT w.enabled AND r.status = 'open'`);
  const abandoned = await client.query(
    `UPDATE supply_request SET status='failed', reasons='["outcome_unknown"]', settled_at=clock_timestamp()
     WHERE status='sending' AND sent_at < clock_timestamp() - ($1 * interval '1 millisecond')`, [ABANDONED_SEND_MS]);
  return (disabled.rowCount ?? 0) + (abandoned.rowCount ?? 0);
}

/** ADR-0046 §5: a correction to a page cancels the open requests that would be written from it
 * (`material_corrected` or `material_revoked`); a request already sending is refused at admission
 * (`source_changed`). Called under the substrate lock. */
export async function cancelRequestsForCorrectedMaterial(client: pg.PoolClient, url: string, action: 'corrected' | 'revoked'): Promise<number> {
  return (await client.query(
    `UPDATE supply_request SET status='cancelled', reasons=jsonb_build_array($2::text), settled_at=clock_timestamp()
     WHERE status='open' AND candidate_id IN (SELECT id FROM scroll_material_candidate WHERE url=$1)`, [url, `material_${action}`])).rowCount ?? 0;
}
