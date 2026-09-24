/**
 * #134 — the reader's places (ADR-0036). Loads the Cartographer's inputs, applies its deltas under
 * the caller's universe lock, reads the atlas, and records the reader's rejections. Every place
 * change is written with its delta in the same transaction (the schema refuses anything else).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  CARTOGRAPHER_POLICY, planPlaces, planRejection,
  type ConceptNode, type PlaceAccount, type PlaceDelta, type PlaceView, type RelationKind, type TypedRelation,
} from '../../core/src/atlas/cartographer.ts';
import { chronicleLine } from '../../core/src/atlas/chronicle.ts';

export class AtlasConflict extends Error {
  readonly statusCode = 409;
  constructor(message: string) { super(message); this.name = 'AtlasConflict'; }
}
export class AtlasNotFound extends Error {
  readonly statusCode = 404;
  constructor(message = 'Not found') { super(message); this.name = 'AtlasNotFound'; }
}

interface Substrate { concepts: ConceptNode[]; ids: Map<string, string>; codes: Map<string, string>; relations: TypedRelation[] }

async function loadSubstrate(client: pg.PoolClient): Promise<Substrate> {
  const concepts = (await client.query<{ id: string; code: string; name: string; parent: string | null }>(
    'SELECT c.id, c.code, c.name, p.code AS parent FROM concept c LEFT JOIN concept p ON p.id = c.parent_id ORDER BY c.code',
  )).rows;
  const relations: TypedRelation[] = [
    ...(await client.query<{ from: string; to: string; kind: RelationKind; claim_id: string }>(
      `SELECT f.code AS from, t.code AS to, r.kind, r.claim_id FROM concept_relation r
       JOIN concept f ON f.id = r.from_concept_id JOIN concept t ON t.id = r.to_concept_id
       WHERE r.status = 'active' AND r.kind NOT IN ('narrower_than','part_of')`,
    )).rows.map(r => ({ from: r.from, to: r.to, kind: r.kind, ref: { claimId: r.claim_id } })),
    ...(await client.query<{ from: string; to: string; kind: RelationKind; id: string }>(
      `SELECT f.code AS from, t.code AS to, b.relation_type AS kind, b.id FROM bridge b
       JOIN concept f ON f.id = b.from_concept_id JOIN concept t ON t.id = b.to_concept_id
       WHERE b.status = 'admitted' AND b.scope_kind = 'shared'`,
    )).rows.map(r => ({ from: r.from, to: r.to, kind: r.kind, ref: { bridgeId: r.id } })),
  ];
  return {
    concepts: concepts.map(c => ({ code: c.code, parent: c.parent, name: c.name })),
    ids: new Map(concepts.map(c => [c.code, c.id])), codes: new Map(concepts.map(c => [c.id, c.code])), relations,
  };
}

type PlaceRow = PlaceView & { anchorId: string; parentPlaceId: string | null };
async function loadPlaces(client: pg.PoolClient, universeId: string): Promise<PlaceRow[]> {
  return (await client.query<{ id: string; anchor: string; anchor_id: string; kind: PlaceView['kind']; parent_anchor: string | null; parent_place_id: string | null; state: PlaceView['state']; basis: TypedRelation | null; load_bearing: boolean; foundation_basis: TypedRelation[] | null }>(
    `SELECT p.id, c.code AS anchor, c.id AS anchor_id, p.kind, pc.code AS parent_anchor, p.parent_place_id, p.state, p.basis, p.load_bearing,
       (SELECT d.evidence->'relations' FROM atlas_delta d WHERE d.place_id = p.id AND d.kind = 'foundation_recognised' ORDER BY d.created_at DESC, d.id LIMIT 1) AS foundation_basis
     FROM atlas_place p
     JOIN concept c ON c.id = p.anchor_concept_id
     LEFT JOIN atlas_place pp ON pp.id = p.parent_place_id LEFT JOIN concept pc ON pc.id = pp.anchor_concept_id
     WHERE p.universe_id = $1 ORDER BY p.created_at, p.id`, [universeId],
  )).rows.map(r => ({ placeId: r.id, anchor: r.anchor, anchorId: r.anchor_id, kind: r.kind, parentAnchor: r.parent_anchor, parentPlaceId: r.parent_place_id, state: r.state, basis: r.basis,
    loadBearing: r.load_bearing, foundationBasis: r.load_bearing ? r.foundation_basis : null }));
}

const snapshot = (p: { kind: string; state: string; parentPlaceId: string | null }) => ({ kind: p.kind, state: p.state, parentPlaceId: p.parentPlaceId });

async function insertDelta(client: pg.PoolClient, universeId: string, placeId: string, d: { kind: string; causalClass: string; policyVersion: string; evidence: unknown },
  before: object | null, after: object): Promise<void> {
  await client.query(
    `INSERT INTO atlas_delta(id,universe_id,place_id,kind,causal_class,policy_version,evidence,before,after) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [randomUUID(), universeId, placeId, d.kind, d.causalClass, d.policyVersion, JSON.stringify(d.evidence), before ? JSON.stringify(before) : null, JSON.stringify(after)],
  );
}

/** Applies deltas in plan order; parents are resolved by anchor, including places formed earlier in the plan. */
async function applyDeltas(client: pg.PoolClient, universeId: string, substrate: Substrate, places: PlaceRow[], deltas: PlaceDelta[]): Promise<number> {
  const liveByAnchor = new Map(places.filter(p => p.state === 'live').map(p => [p.anchor, p]));
  const byId = new Map(places.map(p => [p.placeId, p]));
  const parentId = (anchor: string | null) => (anchor === null ? null : liveByAnchor.get(anchor)?.placeId ?? null);
  for (const d of deltas) {
    if (d.kind === 'place_formed' || d.kind === 'sighting_appeared') {
      if (d.kind === 'place_formed' && d.promotesPlaceId) {
        const sighting = byId.get(d.promotesPlaceId)!;
        await client.query(`UPDATE atlas_place SET state='promoted' WHERE id=$1 AND state='live'`, [sighting.placeId]);
        const parent = sighting.parentPlaceId;
        await insertDelta(client, universeId, sighting.placeId, { kind: 'sighting_promoted', causalClass: 'personal_exploration', policyVersion: d.policyVersion, evidence: d.evidence },
          snapshot({ kind: 'sighting', state: 'live', parentPlaceId: parent }), snapshot({ kind: 'sighting', state: 'promoted', parentPlaceId: parent }));
        liveByAnchor.delete(d.anchor);
      }
      const id = randomUUID();
      const kind = d.kind === 'place_formed' ? d.placeKind : 'sighting';
      const parent = parentId(d.parentAnchor);
      if (d.parentAnchor !== null && parent === null) throw new Error(`Cartographer planned a parent that is not live: ${d.parentAnchor}`);
      await client.query(
        `INSERT INTO atlas_place(id,universe_id,anchor_concept_id,kind,parent_place_id,basis,policy_version) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [id, universeId, substrate.ids.get(d.anchor), kind, parent, d.kind === 'sighting_appeared' ? JSON.stringify(d.evidence.relation) : null, d.policyVersion],
      );
      await insertDelta(client, universeId, id, d, null, snapshot({ kind, state: 'live', parentPlaceId: parent }));
      const row: PlaceRow = { placeId: id, anchor: d.anchor, anchorId: substrate.ids.get(d.anchor)!, kind, parentAnchor: d.parentAnchor, parentPlaceId: parent, state: 'live',
        basis: d.kind === 'sighting_appeared' ? d.evidence.relation : null };
      liveByAnchor.set(d.anchor, row); byId.set(id, row);
      continue;
    }
    if (d.kind === 'foundation_recognised' || d.kind === 'foundation_withdrawn') {
      const place = liveByAnchor.get(d.anchor)!;
      const bearing = d.kind === 'foundation_recognised';
      await client.query('UPDATE atlas_place SET load_bearing=$2 WHERE id=$1 AND state=\'live\'', [place.placeId, bearing]);
      await insertDelta(client, universeId, place.placeId, d, { loadBearing: !bearing }, { loadBearing: bearing });
      place.loadBearing = bearing;
      place.foundationBasis = bearing && d.kind === 'foundation_recognised' ? d.evidence.relations : null;
      continue;
    }
    const place = byId.get(d.placeId)!;
    const parent = place.parentPlaceId;
    const before = snapshot({ kind: place.kind, state: 'live', parentPlaceId: parent });
    if (d.kind === 'place_released') {
      await client.query(`UPDATE atlas_place SET kind='planet', parent_place_id=NULL WHERE id=$1 AND state='live'`, [place.placeId]);
      await insertDelta(client, universeId, place.placeId, d, before, snapshot({ kind: 'planet', state: 'live', parentPlaceId: null }));
      place.kind = 'planet'; place.parentAnchor = null; place.parentPlaceId = null;
    } else {
      const state = d.kind === 'place_rejected' ? 'rejected' : 'retired';
      await client.query(`UPDATE atlas_place SET state=$2 WHERE id=$1 AND state='live'`, [place.placeId, state]);
      await insertDelta(client, universeId, place.placeId, d, before, snapshot({ kind: place.kind, state, parentPlaceId: parent }));
      place.state = state; liveByAnchor.delete(place.anchor);
    }
  }
  return deltas.length;
}

/** Called by the personal-model refresh after attention accounts are written (never while paused). */
export async function runCartographer(client: pg.PoolClient, universeId: string, accounts: readonly PlaceAccount[]): Promise<number> {
  const substrate = await loadSubstrate(client);
  const places = await loadPlaces(client, universeId);
  const deltas = planPlaces({
    concepts: substrate.concepts, relations: substrate.relations, accounts, places,
    rejectedAnchors: places.filter(p => p.state === 'rejected').map(p => p.anchor),
  });
  return applyDeltas(client, universeId, substrate, places, deltas);
}

export async function rejectPlace(client: pg.PoolClient, universeId: string, placeId: string): Promise<{ deltas: number }> {
  const paused = (await client.query<{ paused: boolean }>('SELECT recording_paused_at IS NOT NULL AS paused FROM universe WHERE id=$1', [universeId])).rows[0]?.paused;
  if (paused) throw new AtlasConflict('Recording is paused');
  const places = await loadPlaces(client, universeId);
  const target = places.find(p => p.placeId === placeId);
  if (!target) throw new AtlasNotFound();
  if (target.state === 'rejected') return { deltas: 0 };
  if (target.state !== 'live' || target.kind === 'sighting') throw new AtlasConflict('Only a live planet or region can be set aside');
  const substrate = await loadSubstrate(client);
  const rejected = await applyDeltas(client, universeId, substrate, places, planRejection(places, placeId));
  // What the rejection changed is re-evaluated at once (e.g. a foundation that held it up).
  const after = await loadPlaces(client, universeId);
  const followUp = planPlaces({ concepts: substrate.concepts, relations: substrate.relations, accounts: await loadStoredAccounts(client, universeId), places: after,
    rejectedAnchors: after.filter(p => p.state === 'rejected').map(p => p.anchor) });
  return { deltas: rejected + await applyDeltas(client, universeId, substrate, after, followUp) };
}

/** The accounts the last refresh wrote, for re-planning outside a refresh (a rejection). */
async function loadStoredAccounts(client: pg.PoolClient, universeId: string): Promise<PlaceAccount[]> {
  return (await client.query<{ code: string; state: PlaceAccount['state']; episodes: number; days_active: number; voluntary: number; source_families: number; mass: number; evidence: { episodeIds?: string[]; markIds?: string[] } }>(
    `SELECT c.code, a.state, a.episodes, a.days_active, a.voluntary, a.source_families, a.mass, a.evidence
     FROM attention_account a JOIN concept c ON c.id = a.concept_id WHERE a.universe_id = $1`, [universeId],
  )).rows.map(r => ({ concept: r.code, state: r.state, episodes: r.episodes, daysActive: r.days_active, voluntary: r.voluntary,
    sourceFamilies: r.source_families, mass: Number(r.mass), evidence: { episodeIds: r.evidence.episodeIds ?? [], markIds: r.evidence.markIds ?? [] } }));
}

export interface AtlasView {
  policyVersion: string;
  places: {
    placeId: string; kind: PlaceView['kind']; parentPlaceId: string | null;
    anchor: { code: string; name: string; description: string };
    basis: { kind: RelationKind; from: string; to: string; claim: { text: string; sourceTitle: string } | null; bridge: { mechanism: string } | null } | null;
    attention: { state: string; episodes: number; daysActive: number; sourceFamilies: number } | null;
    scrolls: { total: number; seen: number };
    formedAt: string; formedBy: string;
    /** ADR-0037: the places this one holds up, and the sourced connections that say so. */
    foundation: { holdsUp: string[]; relations: { kind: RelationKind; from: string; to: string; claim: { text: string; sourceTitle: string } | null; bridge: { mechanism: string } | null }[] } | null;
  }[];
  relations: { fromPlaceId: string; toPlaceId: string; kind: RelationKind; claim: { text: string; sourceTitle: string } | null; bridge: { mechanism: string } | null }[];
  chronicle: { deltaId: string; placeId: string; parentPlaceId: string | null; kind: string; causalClass: string; at: string; line: string }[];
}

const iso = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();

/** `anySnapshot`: a change's own evidence keeps naming the claim even after its source was corrected. */
async function describeRefs(client: pg.PoolClient, relations: TypedRelation[], anySnapshot = false) {
  const claimIds = relations.flatMap(r => ('claimId' in r.ref ? [r.ref.claimId] : []));
  const bridgeIds = relations.flatMap(r => ('bridgeId' in r.ref ? [r.ref.bridgeId] : []));
  const claims = new Map((await client.query<{ id: string; text: string; source_title: string }>(
    `SELECT DISTINCT ON (cl.id) cl.id, cl.statement AS text, src.title AS source_title FROM claim cl
     JOIN claim_support cs ON cs.claim_id = cl.id AND cs.support_kind = 'supports'
     JOIN source_snapshot ss ON ss.id = cs.snapshot_id AND ($2 OR ss.status = 'current') JOIN semantic_source src ON src.id = ss.source_id
     WHERE cl.id = ANY($1::uuid[]) ORDER BY cl.id, (ss.status = 'current') DESC, src.title`, [claimIds, anySnapshot],
  )).rows.map(r => [r.id, { text: r.text, sourceTitle: r.source_title }]));
  const bridges = new Map((await client.query<{ id: string; mechanism: string }>('SELECT id, mechanism FROM bridge WHERE id = ANY($1::uuid[])', [bridgeIds])).rows.map(r => [r.id, { mechanism: r.mechanism }]));
  return (r: TypedRelation) => ({
    claim: 'claimId' in r.ref ? claims.get(r.ref.claimId) ?? null : null,
    bridge: 'bridgeId' in r.ref ? bridges.get(r.ref.bridgeId) ?? null : null,
  });
}

export async function readAtlas(client: pg.PoolClient, universeId: string): Promise<AtlasView> {
  const substrate = await loadSubstrate(client);
  const names = new Map((await client.query<{ code: string; name: string; description: string }>('SELECT code, name, description FROM concept')).rows.map(r => [r.code, r]));
  const places = (await loadPlaces(client, universeId)).filter(p => p.state === 'live');
  const liveAnchor = new Map(places.map(p => [p.anchor, p]));
  const parentOf = new Map(substrate.concepts.map(c => [c.code, c.parent]));
  // A Scroll belongs to the nearest planet/region on its primary concept's ancestor chain; a sighting counts its own anchor.
  const home = (code: string): string | null => {
    for (let c: string | null = code, i = 0; c !== null && i < 64; c = parentOf.get(c) ?? null, i += 1) {
      const p = liveAnchor.get(c);
      if (p && p.kind !== 'sighting') return p.placeId;
    }
    return null;
  };
  const primaries = (await client.query<{ asset_id: string; code: string; seen: boolean }>(
    `SELECT ac.asset_id, c.code, EXISTS (SELECT 1 FROM exposure e WHERE e.universe_id = $1 AND e.asset_id = ac.asset_id) AS seen
     FROM asset_concept ac JOIN concept c ON c.id = ac.concept_id WHERE ac.role = 'primary'`, [universeId],
  )).rows;
  const counts = new Map<string, { total: number; seen: number }>();
  const add = (placeId: string, seen: boolean) => { const c = counts.get(placeId) ?? { total: 0, seen: 0 }; c.total += 1; if (seen) c.seen += 1; counts.set(placeId, c); };
  // A Scroll counts once: toward the sighting its primary concept is, or else toward its home place.
  for (const r of primaries) {
    const sighting = liveAnchor.get(r.code);
    if (sighting?.kind === 'sighting') { add(sighting.placeId, r.seen); continue; }
    const h = home(r.code);
    if (h) add(h, r.seen);
  }
  const accounts = new Map((await client.query<{ code: string; state: string; episodes: number; days_active: number; source_families: number }>(
    `SELECT c.code, a.state, a.episodes, a.days_active, a.source_families FROM attention_account a JOIN concept c ON c.id = a.concept_id WHERE a.universe_id = $1`, [universeId],
  )).rows.map(r => [r.code, { state: r.state, episodes: r.episodes, daysActive: r.days_active, sourceFamilies: r.source_families }]));
  const formed = new Map((await client.query<{ place_id: string; created_at: Date; kind: string }>(
    `SELECT DISTINCT ON (place_id) place_id, created_at, kind FROM atlas_delta WHERE universe_id = $1 AND before IS NULL ORDER BY place_id, created_at`, [universeId],
  )).rows.map(r => [r.place_id, r]));

  const between = substrate.relations.filter(r => liveAnchor.has(r.from) && liveAnchor.has(r.to)
    && liveAnchor.get(r.from)!.kind !== 'sighting' && liveAnchor.get(r.to)!.kind !== 'sighting');
  const refs = await describeRefs(client, [...between, ...places.flatMap(p => [...(p.basis ? [p.basis] : []), ...(p.loadBearing ? p.foundationBasis ?? [] : [])])]);

  const deltas = (await client.query<{ id: string; place_id: string; kind: string; causal_class: string; created_at: Date; evidence: Record<string, unknown>; anchor: string; parent_anchor: string | null; parent_place_id: string | null }>(
    `SELECT d.id, d.place_id, d.kind, d.causal_class, d.created_at, d.evidence, c.code AS anchor, pc.code AS parent_anchor, pp.id AS parent_place_id
     FROM atlas_delta d JOIN atlas_place p ON p.id = d.place_id JOIN concept c ON c.id = p.anchor_concept_id
     LEFT JOIN atlas_place pp ON pp.id = COALESCE((d.after->>'parentPlaceId')::uuid, (d.before->>'parentPlaceId')::uuid) LEFT JOIN concept pc ON pc.id = pp.anchor_concept_id
     WHERE d.universe_id = $1 AND d.kind <> 'sighting_promoted' ORDER BY d.created_at DESC, d.id LIMIT 20`, [universeId],
  )).rows;
  const nameOf = (code: string | null) => (code === null ? null : names.get(code)?.name ?? code);

  return {
    policyVersion: CARTOGRAPHER_POLICY,
    places: places.map(p => {
      const anchor = names.get(p.anchor)!;
      const f = formed.get(p.placeId);
      return {
        placeId: p.placeId, kind: p.kind, parentPlaceId: p.parentAnchor ? liveAnchor.get(p.parentAnchor)?.placeId ?? null : null,
        anchor: { code: p.anchor, name: anchor.name, description: anchor.description },
        basis: p.basis ? { kind: p.basis.kind, from: nameOf(p.basis.from)!, to: nameOf(p.basis.to)!, ...refs(p.basis) } : null,
        // A sighting is by definition not yet met: it never carries the reader's attention.
        attention: p.kind === 'sighting' ? null : accounts.get(p.anchor) ?? null,
        scrolls: counts.get(p.placeId) ?? { total: 0, seen: 0 },
        formedAt: f ? iso(f.created_at) : iso(new Date()), formedBy: f?.kind ?? 'place_formed',
        foundation: p.loadBearing && p.foundationBasis ? {
          holdsUp: [...new Set(p.foundationBasis.map(r => liveAnchor.get(r.to)?.placeId).filter((id): id is string => !!id))],
          relations: p.foundationBasis.map(r => ({ kind: r.kind, from: nameOf(r.from)!, to: nameOf(r.to)!, ...refs(r) })),
        } : null,
      };
    }),
    relations: between.map(r => ({ fromPlaceId: liveAnchor.get(r.from)!.placeId, toPlaceId: liveAnchor.get(r.to)!.placeId, kind: r.kind, ...refs(r) })),
    chronicle: deltas.map(d => ({
      deltaId: d.id, placeId: d.place_id, parentPlaceId: d.parent_place_id, kind: d.kind, causalClass: d.causal_class, at: iso(d.created_at),
      line: chronicleLine({ kind: d.kind, causalClass: d.causal_class, name: nameOf(d.anchor)!, parentName: nameOf(d.parent_anchor),
        relation: (d.evidence.relation as TypedRelation | undefined) ? { ...(d.evidence.relation as TypedRelation), fromName: nameOf((d.evidence.relation as TypedRelation).from)!, toName: nameOf((d.evidence.relation as TypedRelation).to)! } : null,
        holdsUp: ((d.evidence.holdsUp as string[] | undefined) ?? []).map(code => nameOf(code)!) }),
    })),
  };
}

/** One delta and its evidence, readable only in its own universe. */
export async function readAtlasDelta(client: pg.PoolClient, universeId: string, deltaId: string) {
  const d = (await client.query<{ id: string; place_id: string; kind: string; causal_class: string; policy_version: string; evidence: Record<string, unknown>; before: unknown; after: unknown; created_at: Date; anchor: string; name: string }>(
    `SELECT d.id, d.place_id, d.kind, d.causal_class, d.policy_version, d.evidence, d.before, d.after, d.created_at, c.code AS anchor, c.name
     FROM atlas_delta d JOIN atlas_place p ON p.id = d.place_id JOIN concept c ON c.id = p.anchor_concept_id WHERE d.id = $1 AND d.universe_id = $2`, [deltaId, universeId],
  )).rows[0];
  if (!d) throw new AtlasNotFound();
  const relation = d.evidence.relation as TypedRelation | undefined;
  const described = relation ? (await describeRefs(client, [relation], true))(relation) : null;
  return {
    deltaId: d.id, placeId: d.place_id, kind: d.kind, causalClass: d.causal_class, policyVersion: d.policy_version, at: iso(d.created_at),
    anchor: { code: d.anchor, name: d.name }, before: d.before, after: d.after,
    evidence: { ...d.evidence, ...(described ? { relationSupport: described } : {}) },
  };
}

export async function eraseAtlas(client: pg.PoolClient, universeId: string): Promise<void> {
  await client.query('DELETE FROM atlas_delta WHERE universe_id=$1', [universeId]);
  await client.query('DELETE FROM atlas_place WHERE universe_id=$1', [universeId]);
}

export async function exportAtlas(client: pg.PoolClient, universeId: string) {
  const q = async (sql: string) => (await client.query(sql, [universeId])).rows;
  return {
    atlasPlaces: await q(`SELECT p.id, c.code AS anchor, p.kind, p.parent_place_id, p.state, p.basis, p.policy_version, p.created_at, p.changed_at
      FROM atlas_place p JOIN concept c ON c.id = p.anchor_concept_id WHERE p.universe_id=$1 ORDER BY p.created_at, p.id`),
    atlasDeltas: await q(`SELECT id, place_id, kind, causal_class, policy_version, evidence, before, after, created_at
      FROM atlas_delta WHERE universe_id=$1 ORDER BY created_at, id`),
  };
}
