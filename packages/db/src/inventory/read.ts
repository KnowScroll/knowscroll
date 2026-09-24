/**
 * #164 — reading a reader's inventory (ADR-0046 §2, §6): their demands (`GET /v1/inventory`), each
 * place's live demand (`GET /v1/atlas`) and the bound Scrolls the Composer serves first. A demand
 * names its concept and, once bound, the Scroll's id and title: never a source or its material.
 */
import type pg from 'pg';
import { INVENTORY_LIST_LIMIT, type InventoryDemand, type InventoryResponse, type PlaceDemand } from '../../../contracts/src/inventory.ts';
import type { V3Bound } from '../../../core/src/composer/semantic.ts';
import type { AuthScope } from '../identity.ts';

type Row = {
  id: string; status: InventoryDemand['status']; decision: InventoryDemand['decision']; reason: string | null; code: string; name: string;
  causes: { kind: 'exhaustion' | 'branch_gap' }[]; created_at: Date; changed_at: Date;
  asset_id: string | null; title: string | null; binding_status: 'active' | 'withdrawn' | null; origin_bridge_id: string | null; origin_exposure_id: string | null;
};

/** Each demand with its latest binding: the Scroll while that binding stands, and whether it was withdrawn. */
const DEMANDS = `SELECT d.id, d.status, d.decision, d.reason, c.code, c.name, d.causes, d.created_at, d.changed_at,
    b.asset_id, a.title, b.status AS binding_status, b.origin_bridge_id, b.origin_exposure_id
  FROM content_demand d JOIN concept c ON c.id = d.concept_id
  LEFT JOIN LATERAL (SELECT * FROM encounter_binding WHERE demand_id = d.id ORDER BY bound_at DESC, id DESC LIMIT 1) b ON true
  LEFT JOIN asset a ON a.id = b.asset_id`;

const scrollOf = (r: Row) => (r.status === 'bound' && r.binding_status === 'active' ? { assetId: r.asset_id!, title: r.title! } : null);

export async function readInventory(client: pg.PoolClient, scope: AuthScope): Promise<InventoryResponse> {
  const rows = (await client.query<Row>(`${DEMANDS} WHERE d.universe_id = $1 AND d.privacy_epoch = $2 ORDER BY d.changed_at DESC, d.id LIMIT $3`,
    [scope.universeId, scope.privacyEpoch, INVENTORY_LIST_LIMIT])).rows;
  return {
    privacyEpoch: scope.privacyEpoch,
    demands: rows.map(r => ({
      demandId: r.id, status: r.status, decision: r.decision, reason: r.reason, concept: { code: r.code, name: r.name },
      causes: r.causes.map(c => c.kind), scroll: scrollOf(r), withdrawn: r.binding_status === 'withdrawn',
      origin: r.origin_bridge_id ? { bridgeId: r.origin_bridge_id, exposureId: r.origin_exposure_id! } : null,
      createdAt: r.created_at.toISOString(), changedAt: r.changed_at.toISOString(),
    })),
  };
}

/** The live demand for each concept that has one, for the places anchored on them. */
export async function placeDemands(client: pg.PoolClient, universeId: string): Promise<Map<string, PlaceDemand>> {
  const rows = (await client.query<Row>(`${DEMANDS} WHERE d.universe_id = $1 AND d.status IN ('waiting','bound','cannot_meet')`, [universeId])).rows;
  return new Map(rows.map(r => [r.code, {
    demandId: r.id, status: r.status as PlaceDemand['status'], reason: r.reason as PlaceDemand['reason'], scroll: scrollOf(r), withdrawn: r.binding_status === 'withdrawn',
  }]));
}

/** Bindings the Composer serves first: still standing, still eligible (rechecked at serve time) and
 * never yet shown to this reader. */
export async function loadBoundScrolls(client: pg.PoolClient, universeId: string): Promise<V3Bound[]> {
  return (await client.query<{ id: string; demand_id: string; asset_id: string; code: string; place_id: string | null; origin_bridge_id: string | null; origin_exposure_id: string | null }>(
    `SELECT b.id, b.demand_id, b.asset_id, c.code, b.place_id, b.origin_bridge_id, b.origin_exposure_id
     FROM encounter_binding b JOIN content_demand d ON d.id = b.demand_id JOIN concept c ON c.id = d.concept_id
     WHERE b.universe_id = $1 AND b.status = 'active' AND scroll_is_eligible(b.asset_id)
       AND NOT EXISTS (SELECT 1 FROM exposure e WHERE e.universe_id = $1 AND e.asset_id = b.asset_id)
     ORDER BY b.bound_at, b.id`, [universeId],
  )).rows.map(r => ({
    assetId: r.asset_id, demandId: r.demand_id, bindingId: r.id, concept: r.code, placeId: r.place_id,
    origin: r.origin_bridge_id ? { bridgeId: r.origin_bridge_id, exposureId: r.origin_exposure_id! } : null,
  }));
}
