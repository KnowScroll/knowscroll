/**
 * #164 — a reader's content demand (ADR-0046 §1–§2, §4–§5, §7).
 *
 * A demand is written in the transaction that observed the need, never while recording is paused:
 *   - `exhaustion`: a v3 feed decision for a reader with a live planet or region whose subtree holds
 *     no eligible Scroll they have not been shown;
 *   - `branch_gap`: a continuation the reader opened, or was offered, into a concept with nothing
 *     else unseen.
 * One live demand per universe, epoch and concept: a later cause joins it (bounded). The
 * Quartermaster (`packages/core/src/inventory/quartermaster.ts`) decides then, when supply settles
 * and when a correction withdraws a binding; every decision is appended to the demand's history and
 * applied here as a private binding, a waiter on a shared request, a funded request, or the reason
 * the need cannot be met. Callers hold the universe lock; deciding takes the one supply lock after
 * it, and the route's bucket row after that.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { decideDemand, withinConcept, type DemandFacts, type QuartermasterDecision } from '../../../core/src/inventory/quartermaster.ts';
import type { AuthScope } from '../identity.ts';
import { lockUniverse, transaction } from '../index.ts';
import { loadSupplyFacts, lockSupply, openRequest } from './supply.ts';

/** Bench value: how many distinct causes one demand keeps. */
const MAX_CAUSES = 8;

type Cause =
  | { kind: 'exhaustion'; decisionId: string; placeId: string; seen: number; total: number }
  | { kind: 'branch_gap'; bridgeId: string; exposureId: string };
type Trigger = 'demand_written' | 'cause_joined' | 'need_observed' | 'supply_settled' | 'binding_withdrawn';
type Recorded<T> = T & { at: string };
type Waiter = { id: string; request_id: string; asset_id: string | null };
type DecisionEntry = { version: string; adapt: string; decision: string; reason?: string; assetId?: string; requestId?: string; trigger: Trigger };
interface DemandRow {
  id: string; universe_id: string; privacy_epoch: number; concept_id: string; code: string;
  status: string; decision: string | null; reason: string | null; causes: Recorded<Cause>[]; decisions: Recorded<DecisionEntry>[];
}

const causeKey = (c: Cause) => (c.kind === 'exhaustion' ? `exhaustion:${c.placeId}` : `branch_gap:${c.bridgeId}:${c.exposureId}`);
const stamped = (value: object) => JSON.stringify(value);
const APPEND = (column: string, param: string) => `${column} || jsonb_build_array(${param}::jsonb || jsonb_build_object('at', clock_timestamp()))`;

async function isPaused(client: pg.PoolClient, universeId: string): Promise<boolean> {
  return (await client.query<{ paused: boolean }>('SELECT recording_paused_at IS NOT NULL AS paused FROM universe WHERE id=$1', [universeId])).rows[0]!.paused;
}

async function conceptParents(client: pg.PoolClient): Promise<Map<string, string | null>> {
  return new Map((await client.query<{ code: string; parent: string | null }>(
    'SELECT c.code, p.code AS parent FROM concept c LEFT JOIN concept p ON p.id = c.parent_id')).rows.map(r => [r.code, r.parent]));
}

/** Eligible Scrolls with their primary concept, newest first, and whether this reader was ever shown
 * each; `serving` is being shown in this very transaction (an opened continuation's target). */
async function eligibleScrolls(client: pg.PoolClient, universeId: string, serving: string | null): Promise<DemandFacts['scrolls']> {
  return (await client.query<{ asset_id: string; primary: string; shown: boolean }>(
    `SELECT a.id AS asset_id, c.code AS primary, EXISTS (SELECT 1 FROM exposure e WHERE e.universe_id = $1 AND e.asset_id = a.id) AS shown
     FROM asset a JOIN asset_concept ac ON ac.asset_id = a.id AND ac.role = 'primary' JOIN concept c ON c.id = ac.concept_id
     WHERE a.kind = 'Scroll' AND scroll_is_eligible(a.id) ORDER BY a.editorial_order DESC NULLS LAST, a.id`, [universeId],
  )).rows.map(r => ({ assetId: r.asset_id, primary: r.primary, shown: r.shown || r.asset_id === serving }));
}

/** Called in the feed's transaction after a v3 decision is recorded. */
export async function observeExhaustion(client: pg.PoolClient, scope: AuthScope, decisionId: string): Promise<void> {
  if (await isPaused(client, scope.universeId)) return;
  const places = (await client.query<{ id: string; concept_id: string; code: string }>(
    `SELECT p.id, c.id AS concept_id, c.code FROM atlas_place p JOIN concept c ON c.id = p.anchor_concept_id
     WHERE p.universe_id = $1 AND p.state = 'live' AND p.kind IN ('planet','region') ORDER BY p.created_at, p.id`, [scope.universeId])).rows;
  if (places.length === 0) return;
  const parents = await conceptParents(client);
  const scrolls = await eligibleScrolls(client, scope.universeId, null);
  for (const place of places) {
    const within = withinConcept(parents, place.code);
    const inSubtree = scrolls.filter(s => within(s.primary));
    if (inSubtree.length === 0 || inSubtree.some(s => !s.shown)) continue;
    await observeNeed(client, scope, place.concept_id, { kind: 'exhaustion', decisionId, placeId: place.id, seen: inSubtree.length, total: inSubtree.length }, null);
  }
}

/** Called by `openBranch` once the continuation is recorded (`served` is the Scroll it opens, being
 * shown now), and for each continuation offered with a target the reader was already shown. */
export async function observeBranchGap(client: pg.PoolClient, scope: AuthScope, gap: { concept: string; bridgeId: string; exposureId: string; served: string | null }): Promise<void> {
  if (await isPaused(client, scope.universeId)) return;
  const within = withinConcept(await conceptParents(client), gap.concept);
  if ((await eligibleScrolls(client, scope.universeId, gap.served)).some(s => within(s.primary) && !s.shown)) return;
  const conceptId = (await client.query<{ id: string }>('SELECT id FROM concept WHERE code=$1', [gap.concept])).rows[0]!.id;
  await observeNeed(client, scope, conceptId, { kind: 'branch_gap', bridgeId: gap.bridgeId, exposureId: gap.exposureId }, gap.served);
}

/** Called with the continuations just listed for an encounter: one offered with a target the reader
 * was already shown may lead into a concept with nothing unseen. Its origin is the reader's latest
 * exposure to the encounter in this epoch; an encounter they were not shown offers them nothing yet. */
export async function observeOfferedGaps(client: pg.PoolClient, scope: AuthScope, originAssetId: string,
  branches: readonly { bridgeId: string; toConcept: { code: string }; seen: boolean }[]): Promise<void> {
  const seen = branches.filter(b => b.seen);
  if (seen.length === 0) return;
  const origin = (await client.query<{ id: string }>(
    `SELECT e.id FROM exposure e JOIN ledger l ON l.id = e.event_id WHERE e.universe_id = $1 AND e.asset_id = $2 AND l.privacy_epoch = $3
     ORDER BY l.created_at DESC, e.id DESC LIMIT 1`, [scope.universeId, originAssetId, scope.privacyEpoch])).rows[0];
  if (!origin) return;
  for (const branch of seen) await observeBranchGap(client, scope, { concept: branch.toConcept.code, bridgeId: branch.bridgeId, exposureId: origin.id, served: null });
}

async function observeNeed(client: pg.PoolClient, scope: AuthScope, conceptId: string, cause: Cause, serving: string | null): Promise<void> {
  const live = (await client.query<{ id: string; status: string; causes: Cause[] }>(
    `SELECT id, status, causes FROM content_demand WHERE universe_id=$1 AND privacy_epoch=$2 AND concept_id=$3 AND modality='scroll' AND status <> 'cancelled'`,
    [scope.universeId, scope.privacyEpoch, conceptId])).rows[0];
  if (!live) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO content_demand(id,universe_id,privacy_epoch,concept_id,modality,status,causes) VALUES($1,$2,$3,$4,'scroll','open',${APPEND("'[]'::jsonb", '$5')})`,
      [id, scope.universeId, scope.privacyEpoch, conceptId, stamped(cause)]);
    return decide(client, id, 'demand_written', serving);
  }
  const joined = live.causes.length < MAX_CAUSES && !live.causes.some(c => causeKey(c) === causeKey(cause));
  if (joined) await client.query(`UPDATE content_demand SET causes = ${APPEND('causes', '$2')} WHERE id=$1`, [live.id, stamped(cause)]);
  // A waiting demand waits for its request; any other meets its need again.
  if (live.status !== 'waiting') await decide(client, live.id, joined ? 'cause_joined' : 'need_observed', serving);
}

async function decide(client: pg.PoolClient, demandId: string, trigger: Trigger, serving: string | null = null): Promise<void> {
  const demand = (await client.query<DemandRow>(
    `SELECT d.id, d.universe_id, d.privacy_epoch, d.concept_id, c.code, d.status, d.decision, d.reason, d.causes, d.decisions
     FROM content_demand d JOIN concept c ON c.id = d.concept_id WHERE d.id=$1`, [demandId])).rows[0]!;
  await lockSupply(client);
  const waiter = (await client.query<Waiter>(
    `SELECT w.id, w.request_id, r.asset_id FROM demand_waiter w JOIN supply_request r ON r.id = w.request_id WHERE w.demand_id=$1 AND w.status='waiting'`, [demandId])).rows[0];
  // How this demand's own requests ended: those it was still waiting for when they settled.
  const settled = (await client.query<{ status: DemandFacts['settled'][number] }>(
    `SELECT DISTINCT ON (r.id) r.status FROM demand_waiter w JOIN supply_request r ON r.id = w.request_id
     WHERE w.demand_id=$1 AND w.status <> 'cancelled' AND r.status NOT IN ('open','sending') AND (w.settled_at IS NULL OR w.settled_at >= r.settled_at)
     ORDER BY r.id`, [demandId])).rows.map(r => r.status);
  const supply = await loadSupplyFacts(client, demand.concept_id);
  const decision = decideDemand({
    concept: demand.code, parents: await conceptParents(client), scrolls: await eligibleScrolls(client, demand.universe_id, serving),
    openRequestId: supply.openRequestId, route: supply.route, candidates: supply.candidates, settled,
  });
  const applied = await apply(client, demand, decision, waiter, supply.route?.id ?? null);
  const entry: DecisionEntry = { version: decision.version, adapt: decision.adapt, decision: decision.decision, ...applied.ref, trigger };
  const last = demand.decisions.at(-1);
  const changed = !last || (['decision', 'reason', 'assetId', 'requestId'] as const).some(k => last[k] !== entry[k]);
  if (!changed && demand.status === applied.status && demand.decision === decision.decision && demand.reason === (entry.reason ?? null)) return;
  await client.query(
    `UPDATE content_demand SET status=$2, decision=$3, reason=$4, changed_at=clock_timestamp(),
       decisions = CASE WHEN $5 THEN ${APPEND('decisions', '$6')} ELSE decisions END WHERE id=$1`,
    [demandId, applied.status, decision.decision, entry.reason ?? null, changed, stamped(entry)]);
}

/** Carries out one decision. A waiter it replaces is settled: `bound` when the Scroll it waited for is
 * the one bound, else `released`. Returns the demand's new status and what the decision names. */
async function apply(client: pg.PoolClient, demand: DemandRow, decision: QuartermasterDecision, waiter: Waiter | undefined, routeId: string | null,
): Promise<{ status: 'bound' | 'waiting' | 'cannot_meet'; ref: Pick<DecisionEntry, 'reason' | 'assetId' | 'requestId'> }> {
  const settle = async (status: 'bound' | 'released') => {
    if (waiter) await client.query(`UPDATE demand_waiter SET status=$2, settled_at=clock_timestamp() WHERE id=$1`, [waiter.id, status]);
  };
  switch (decision.decision) {
    case 'reuse':
      await bind(client, demand, decision.assetId);
      await settle(waiter?.asset_id === decision.assetId ? 'bound' : 'released');
      return { status: 'bound', ref: { assetId: decision.assetId } };
    case 'join':
      if (waiter?.request_id !== decision.requestId) { await settle('released'); await wait(client, demand, decision.requestId); }
      return { status: 'waiting', ref: { requestId: decision.requestId } };
    case 'fund': {
      await settle('released');
      const requestId = await openRequest(client, { conceptId: demand.concept_id, routeId: routeId!, candidateId: decision.candidateId, offeredCodes: decision.offeredCodes });
      await wait(client, demand, requestId);
      return { status: 'waiting', ref: { requestId } };
    }
    case 'cannot_meet':
      await settle('released');
      return { status: 'cannot_meet', ref: { reason: decision.reason } };
  }
}

async function wait(client: pg.PoolClient, demand: DemandRow, requestId: string): Promise<void> {
  await client.query(`INSERT INTO demand_waiter(id,demand_id,universe_id,privacy_epoch,request_id,status) VALUES($1,$2,$3,$4,$5,'waiting')`,
    [randomUUID(), demand.id, demand.universe_id, demand.privacy_epoch, requestId]);
}

/** A private binding. It keeps the place whose exhaustion caused the need and, for a continuation's
 * gap, its origin (ADR-0046 §4), from the demand's latest cause of each kind. */
async function bind(client: pg.PoolClient, demand: DemandRow, assetId: string): Promise<void> {
  const latest = <K extends Cause['kind']>(kind: K) => [...demand.causes].reverse().find((c): c is Recorded<Extract<Cause, { kind: K }>> => c.kind === kind);
  const place = latest('exhaustion');
  const origin = latest('branch_gap');
  await client.query(
    `INSERT INTO encounter_binding(id,demand_id,universe_id,privacy_epoch,asset_id,place_id,origin_bridge_id,origin_exposure_id,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active')`,
    [randomUUID(), demand.id, demand.universe_id, demand.privacy_epoch, assetId, place?.placeId ?? null, origin?.bridgeId ?? null, origin?.exposureId ?? null]);
}

/**
 * After supply changes (the worker, outside any universe): every demand still waiting on a request
 * that has settled and, for a newly written Scroll (`assetId`), every live demand whose concept's
 * subtree holds it gets its own fresh decision, one universe at a time in its own transaction under
 * its lock. Returns how many demands were decided.
 */
export async function redecideForSupply(pool: pg.Pool, assetId: string | null = null): Promise<number> {
  const rows = (await pool.query<{ universe_id: string; id: string }>(
    `SELECT d.universe_id, d.id FROM content_demand d JOIN demand_waiter w ON w.demand_id = d.id AND w.status = 'waiting'
       JOIN supply_request r ON r.id = w.request_id AND r.status NOT IN ('open','sending')
     UNION
     SELECT d.universe_id, d.id FROM content_demand d
     WHERE d.status IN ('waiting','cannot_meet') AND d.concept_id IN (
       WITH RECURSIVE up(id) AS (SELECT concept_id FROM asset_concept WHERE asset_id = $1 AND role = 'primary'
         UNION SELECT c.parent_id FROM concept c JOIN up ON c.id = up.id WHERE c.parent_id IS NOT NULL)
       SELECT id FROM up)
     ORDER BY 1, 2`, [assetId])).rows;
  const byUniverse = new Map<string, string[]>();
  for (const r of rows) byUniverse.set(r.universe_id, [...(byUniverse.get(r.universe_id) ?? []), r.id]);
  let decided = 0;
  for (const [universeId, demands] of byUniverse) {
    decided += await transaction(async client => {
      await lockUniverse(client, universeId);
      if (await isPaused(client, universeId)) return 0;
      let n = 0;
      for (const id of demands) {
        // Rechecked under the lock: the reader may have cleared, paused or moved on meanwhile.
        const live = (await client.query(`SELECT 1 FROM content_demand d JOIN universe u ON u.id = d.universe_id AND u.privacy_epoch = d.privacy_epoch
          WHERE d.id=$1 AND d.status IN ('waiting','cannot_meet')`, [id])).rowCount;
        if (live) { await decide(client, id, 'supply_settled'); n += 1; }
      }
      return n;
    }, pool);
  }
  return decided;
}

/**
 * ADR-0046 §5: a source correction that leaves a bound Scroll with an unsupported claim withdraws
 * its bindings in this universe; a demand whose latest binding that was reopens and is decided again.
 * Runs in every personal-model refresh (the reader's own next act, or the correction catch-up of
 * ADR-0040), under the universe lock and never while paused.
 */
export async function withdrawCorrectedBindings(client: pg.PoolClient, universeId: string): Promise<void> {
  const withdrawn = (await client.query<{ demand_id: string }>(
    `UPDATE encounter_binding SET status='withdrawn', withdrawn_reason='source_correction', withdrawn_at=clock_timestamp()
     WHERE universe_id=$1 AND status='active' AND NOT scroll_is_eligible(asset_id) RETURNING demand_id`, [universeId])).rows;
  for (const demandId of new Set(withdrawn.map(r => r.demand_id))) {
    const reopened = (await client.query(
      `UPDATE content_demand SET status='open', decision=NULL, reason=NULL, changed_at=clock_timestamp()
       WHERE id=$1 AND status='bound' AND (SELECT status FROM encounter_binding WHERE demand_id=$1 ORDER BY bound_at DESC, id DESC LIMIT 1) = 'withdrawn'`,
      [demandId])).rowCount;
    if (reopened) await decide(client, demandId, 'binding_withdrawn');
  }
}

// Privacy -------------------------------------------------------------------------------------

/** Pausing cancels this universe's waiters and the demands still open to supply; never a shared request or another universe's waiter. */
export async function cancelDemands(client: pg.PoolClient, universeId: string, privacyEpoch: number, cause: 'recording_paused'): Promise<void> {
  await client.query(`UPDATE demand_waiter SET status='cancelled', reason=$3, settled_at=clock_timestamp() WHERE universe_id=$1 AND privacy_epoch=$2 AND status='waiting'`,
    [universeId, privacyEpoch, cause]);
  await client.query(`UPDATE content_demand SET status='cancelled', reason=$3, changed_at=clock_timestamp()
    WHERE universe_id=$1 AND privacy_epoch=$2 AND status IN ('open','waiting','cannot_meet')`, [universeId, privacyEpoch, cause]);
}

/** Clear/Reset/deletion (after the epoch advanced): bindings name places, bridges and exposures, so they go before all three. */
export async function eraseInventory(client: pg.PoolClient, universeId: string): Promise<void> {
  await client.query('DELETE FROM encounter_binding WHERE universe_id=$1', [universeId]);
  await client.query('DELETE FROM demand_waiter WHERE universe_id=$1', [universeId]);
  await client.query('DELETE FROM content_demand WHERE universe_id=$1', [universeId]);
}

export async function exportInventory(client: pg.PoolClient, universeId: string) {
  const q = async (sql: string) => (await client.query(sql, [universeId])).rows;
  return {
    demands: await q(`SELECT d.id, d.privacy_epoch, c.code AS concept, d.modality, d.status, d.decision, d.reason, d.causes, d.decisions, d.created_at, d.changed_at
      FROM content_demand d JOIN concept c ON c.id = d.concept_id WHERE d.universe_id=$1 ORDER BY d.created_at, d.id`),
    waiters: await q('SELECT id, demand_id, privacy_epoch, request_id, status, reason, created_at, settled_at FROM demand_waiter WHERE universe_id=$1 ORDER BY created_at, id'),
    bindings: await q(`SELECT id, demand_id, privacy_epoch, asset_id, place_id, origin_bridge_id, origin_exposure_id, status, withdrawn_reason, bound_at, withdrawn_at
      FROM encounter_binding WHERE universe_id=$1 ORDER BY bound_at, id`),
  };
}
