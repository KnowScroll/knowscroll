/**
 * #134 — Cartographer v1 (ADR-0036). Pure: the substrate, the reader's attention accounts and the
 * current places in; the deltas that should happen out. Every delta carries its cause and evidence;
 * the database applies them and refuses a place change without one.
 *
 * - An `anchored` concept with no live place, never rejected, becomes a region of the nearest live
 *   planet/region anchored on an ancestor within two parent hops, else a free planet.
 * - Each live planet/region offers up to five sightings: concepts one active typed relation or
 *   admitted bridge away that the reader has never been shown, by substrate degree.
 * - A sighting whose relation is no longer active retires; a rejection is the reader's and is final.
 */
export const CARTOGRAPHER_V1 = 'cartographer-v1';
const MAX_PARENT_HOPS = 2;
const MAX_SIGHTINGS_PER_PLACE = 5;

export type RelationKind = 'prerequisite_for' | 'explains' | 'contradicts' | 'analogous_in' | 'applies_to' | 'compares_mechanism';
export interface ConceptNode { code: string; parent: string | null; name: string }
/** An active substrate relation (with its claim) or an admitted shared bridge. The hierarchy is not one. */
export interface TypedRelation { from: string; to: string; kind: RelationKind; ref: { claimId: string } | { bridgeId: string } }
export interface PlaceAccount {
  concept: string; state: 'seen' | 'anchored' | 'dormant';
  episodes: number; daysActive: number; voluntary: number; sourceFamilies: number; mass: number;
  evidence: { episodeIds: string[]; markIds: string[] };
}
export type PlaceKind = 'planet' | 'region' | 'sighting';
export interface PlaceView {
  placeId: string; anchor: string; kind: PlaceKind; parentAnchor: string | null;
  state: 'live' | 'promoted' | 'rejected' | 'retired';
  /** A sighting's relation; null for planets and regions. */
  basis: TypedRelation | null;
}
export interface CartographerInput {
  concepts: readonly ConceptNode[];
  relations: readonly TypedRelation[];
  accounts: readonly PlaceAccount[];
  places: readonly PlaceView[];
  rejectedAnchors: readonly string[];
}

export type CausalClass = 'personal_exploration' | 'substrate_neighbourhood' | 'source_correction' | 'reader_correction';
type Common = { anchor: string; causalClass: CausalClass; policyVersion: string };
export type PlaceDelta =
  | Common & { kind: 'place_formed'; placeKind: 'planet' | 'region'; parentAnchor: string | null; promotesPlaceId?: string;
      evidence: { account: Omit<PlaceAccount, 'concept' | 'evidence'> & PlaceAccount['evidence'] } }
  | Common & { kind: 'sighting_appeared'; parentAnchor: string; evidence: { relation: TypedRelation } }
  | Common & { kind: 'sighting_retired'; placeId: string; evidence: { relation: TypedRelation } | { rejectedPlaceId: string } }
  | Common & { kind: 'place_rejected'; placeId: string; evidence: Record<string, never> }
  | Common & { kind: 'place_released'; placeId: string; evidence: { rejectedPlaceId: string } };

const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const relationKey = (r: TypedRelation) => `${r.from}|${r.to}|${r.kind}|${'claimId' in r.ref ? `c:${r.ref.claimId}` : `b:${r.ref.bridgeId}`}`;

export function planPlaces(input: CartographerInput): PlaceDelta[] {
  const parentOf = new Map(input.concepts.map(c => [c.code, c.parent]));
  const depth = (code: string) => { let d = 0; for (let p = parentOf.get(code) ?? null; p !== null && d < 64; p = parentOf.get(p) ?? null) d += 1; return d; };
  const rejected = new Set(input.rejectedAnchors);
  const accounts = new Map(input.accounts.map(a => [a.concept, a]));
  const active = new Set(input.relations.map(relationKey));
  const common = (anchor: string, causalClass: CausalClass) => ({ anchor, causalClass, policyVersion: CARTOGRAPHER_V1 });
  const deltas: PlaceDelta[] = [];

  // Anchors that currently have a live place, by kind, as the plan unfolds.
  const live = new Map<string, PlaceView>();
  for (const p of input.places) if (p.state === 'live') live.set(p.anchor, p);

  // 1. Sightings whose basis is gone retire first, so a revoked relation cannot keep offering.
  for (const p of [...live.values()].sort((a, b) => byCode(a.anchor, b.anchor))) {
    if (p.kind !== 'sighting' || (p.basis && active.has(relationKey(p.basis)))) continue;
    deltas.push({ ...common(p.anchor, 'source_correction'), kind: 'sighting_retired', placeId: p.placeId, evidence: { relation: p.basis! } });
    live.delete(p.anchor);
  }

  // 2. Anchored concepts become planets or regions, shallowest first.
  const candidates = input.accounts
    .filter(a => a.state === 'anchored' && !rejected.has(a.concept) && parentOf.has(a.concept) && live.get(a.concept)?.kind !== 'planet' && live.get(a.concept)?.kind !== 'region')
    .map(a => a.concept)
    .sort((a, b) => depth(a) - depth(b) || byCode(a, b));
  for (const concept of candidates) {
    let parentAnchor: string | null = null;
    let hop = parentOf.get(concept) ?? null;
    for (let i = 0; i < MAX_PARENT_HOPS && hop !== null; i += 1, hop = parentOf.get(hop) ?? null) {
      const place = live.get(hop);
      if (place && (place.kind === 'planet' || place.kind === 'region')) { parentAnchor = hop; break; }
    }
    const account = accounts.get(concept)!;
    const sighting = live.get(concept);
    deltas.push({
      ...common(concept, 'personal_exploration'), kind: 'place_formed', placeKind: parentAnchor ? 'region' : 'planet', parentAnchor,
      ...(sighting ? { promotesPlaceId: sighting.placeId } : {}),
      evidence: { account: { state: account.state, episodes: account.episodes, daysActive: account.daysActive, voluntary: account.voluntary,
        sourceFamilies: account.sourceFamilies, mass: account.mass, episodeIds: [...account.evidence.episodeIds], markIds: [...account.evidence.markIds] } },
    });
    live.set(concept, { placeId: '', anchor: concept, kind: parentAnchor ? 'region' : 'planet', parentAnchor, state: 'live', basis: null });
  }

  // 3. Each planet/region offers sightings one typed relation away, never shown, never rejected.
  const relations = [...input.relations].sort((a, b) => byCode(relationKey(a), relationKey(b)));
  const degree = new Map<string, number>();
  for (const r of relations) { degree.set(r.from, (degree.get(r.from) ?? 0) + 1); degree.set(r.to, (degree.get(r.to) ?? 0) + 1); }
  const anchorsOffering = [...live.values()].filter(p => p.kind === 'planet' || p.kind === 'region').map(p => p.anchor).sort(byCode);
  for (const anchor of anchorsOffering) {
    const offered = new Map<string, TypedRelation>();
    for (const r of relations) {
      const other = r.from === anchor ? r.to : r.to === anchor ? r.from : null;
      if (other === null || offered.has(other) || !parentOf.has(other)) continue;
      if (live.has(other) || rejected.has(other) || accounts.has(other)) continue;
      offered.set(other, r);
    }
    const chosen = [...offered.entries()]
      .sort(([a], [b]) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || byCode(a, b))
      .slice(0, MAX_SIGHTINGS_PER_PLACE);
    for (const [other, relation] of chosen) {
      deltas.push({ ...common(other, 'substrate_neighbourhood'), kind: 'sighting_appeared', parentAnchor: anchor, evidence: { relation } });
      live.set(other, { placeId: '', anchor: other, kind: 'sighting', parentAnchor: anchor, state: 'live', basis: relation });
    }
  }
  return deltas;
}

/** The reader rejects a live planet or region: it goes, its sightings retire, its regions float free. */
export function planRejection(places: readonly PlaceView[], placeId: string): PlaceDelta[] {
  const target = places.find(p => p.placeId === placeId && p.state === 'live' && p.kind !== 'sighting');
  if (!target) throw new Error('That is not a live place');
  const common = (anchor: string) => ({ anchor, causalClass: 'reader_correction' as const, policyVersion: CARTOGRAPHER_V1 });
  const children = places.filter(p => p.state === 'live' && p.parentAnchor === target.anchor).sort((a, b) => byCode(a.anchor, b.anchor));
  return [
    { ...common(target.anchor), kind: 'place_rejected', placeId: target.placeId, evidence: {} },
    ...children.filter(p => p.kind === 'region').map(p => ({ ...common(p.anchor), kind: 'place_released' as const, placeId: p.placeId, evidence: { rejectedPlaceId: target.placeId } })),
    ...children.filter(p => p.kind === 'sighting').map(p => ({ ...common(p.anchor), kind: 'sighting_retired' as const, placeId: p.placeId, evidence: { rejectedPlaceId: target.placeId } })),
  ];
}
