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
/** v2 (ADR-0037) adds foundation Stars; everything v1 decides is unchanged. */
export const CARTOGRAPHER_V2 = 'cartographer-v2';
export const CARTOGRAPHER_POLICY = CARTOGRAPHER_V2;
const FOUNDATION_KINDS: ReadonlySet<RelationKind> = new Set(['explains', 'prerequisite_for']);
const FOUNDATION_MIN_CONNECTIONS = 3;
const FOUNDATION_MIN_PLACES = 2;
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
  /** v2: whether this place is a foundation, and the connections its recognition cited. */
  loadBearing?: boolean;
  foundationBasis?: readonly TypedRelation[] | null;
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
  | Common & { kind: 'sighting_retired'; placeId: string; evidence: { relation: TypedRelation } | { rejectedPlaceId: string } | { met: { state: PlaceAccount['state']; episodes: number } } }
  | Common & { kind: 'place_rejected'; placeId: string; evidence: Record<string, never> }
  | Common & { kind: 'place_released'; placeId: string; evidence: { rejectedPlaceId: string } }
  | Common & { kind: 'foundation_recognised'; evidence: { relations: TypedRelation[]; holdsUp: string[] } }
  | Common & { kind: 'foundation_withdrawn'; evidence: { relations: TypedRelation[] } };

const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const relationKey = (r: TypedRelation) => `${r.from}|${r.to}|${r.kind}|${'claimId' in r.ref ? `c:${r.ref.claimId}` : `b:${r.ref.bridgeId}`}`;
// A sourced claim is the preferred basis for a sighting; an admitted bridge is the fallback.
const basisOrder = (r: TypedRelation) => `${r.from}|${r.to}|${r.kind}|${'claimId' in r.ref ? `0:${r.ref.claimId}` : `1:${r.ref.bridgeId}`}`;

export function planPlaces(input: CartographerInput): PlaceDelta[] {
  const parentOf = new Map(input.concepts.map(c => [c.code, c.parent]));
  const depth = (code: string) => { let d = 0; for (let p = parentOf.get(code) ?? null; p !== null && d < 64; p = parentOf.get(p) ?? null) d += 1; return d; };
  const rejected = new Set(input.rejectedAnchors);
  const accounts = new Map(input.accounts.map(a => [a.concept, a]));
  const active = new Set(input.relations.map(relationKey));
  const common = (anchor: string, causalClass: CausalClass) => ({ anchor, causalClass, policyVersion: CARTOGRAPHER_POLICY });
  const deltas: PlaceDelta[] = [];

  // Anchors that currently have a live place, by kind, as the plan unfolds.
  const live = new Map<string, PlaceView>();
  for (const p of input.places) if (p.state === 'live') live.set(p.anchor, p);

  // 1. Sightings retire first: one whose basis is gone (a revoked relation cannot keep offering),
  // and one the reader has now been shown (a sighting is only ever something not yet met; if its
  // concept is already anchored it is promoted below instead).
  for (const p of [...live.values()].sort((a, b) => byCode(a.anchor, b.anchor))) {
    if (p.kind !== 'sighting') continue;
    const met = accounts.get(p.anchor);
    if (p.basis && !active.has(relationKey(p.basis))) {
      deltas.push({ ...common(p.anchor, 'source_correction'), kind: 'sighting_retired', placeId: p.placeId, evidence: { relation: p.basis } });
      live.delete(p.anchor);
    } else if (met && met.state !== 'anchored') {
      deltas.push({ ...common(p.anchor, 'personal_exploration'), kind: 'sighting_retired', placeId: p.placeId, evidence: { met: { state: met.state, episodes: met.episodes } } });
      live.delete(p.anchor);
    }
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
  const relations = [...input.relations].sort((a, b) => byCode(basisOrder(a), basisOrder(b)));
  // Degree counts distinct neighbours: a claim and a bridge for the same pair are one connection.
  const neighbours = new Map<string, Set<string>>();
  for (const r of relations) {
    neighbours.set(r.from, (neighbours.get(r.from) ?? new Set()).add(r.to));
    neighbours.set(r.to, (neighbours.get(r.to) ?? new Set()).add(r.from));
  }
  const degree = new Map([...neighbours].map(([code, set]) => [code, set.size]));
  const anchorsOffering = [...live.values()].filter(p => p.kind === 'planet' || p.kind === 'region').map(p => p.anchor).sort(byCode);
  for (const anchor of anchorsOffering) {
    const offered = new Map<string, TypedRelation>();
    for (const r of relations) {
      const other = r.from === anchor ? r.to : r.to === anchor ? r.from : null;
      if (other === null || offered.has(other) || !parentOf.has(other)) continue;
      if (live.has(other) || rejected.has(other) || accounts.has(other)) continue;
      offered.set(other, r);
    }
    // The cap is per place: sightings it already has count against it.
    const already = [...live.values()].filter(p => p.kind === 'sighting' && p.parentAnchor === anchor).length;
    const chosen = [...offered.entries()]
      .sort(([a], [b]) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || byCode(a, b))
      .slice(0, Math.max(0, MAX_SIGHTINGS_PER_PLACE - already));
    for (const [other, relation] of chosen) {
      deltas.push({ ...common(other, 'substrate_neighbourhood'), kind: 'sighting_appeared', parentAnchor: anchor, evidence: { relation } });
      live.set(other, { placeId: '', anchor: other, kind: 'sighting', parentAnchor: anchor, state: 'live', basis: relation });
    }
  }

  // 4. Foundation Stars (ADR-0037): a planet or region whose anchor explains, or is a prerequisite
  // for, at least three things across at least two of the reader's other live places, each
  // connection sourced (active claim or admitted bridge; a pair counts once). Edge count only
  // triggers it; attention plays no part. Withdrawn, with its cause, when that stops being true.
  const places = [...live.values()].filter(p => p.kind === 'planet' || p.kind === 'region').sort((a, b) => byCode(a.anchor, b.anchor));
  for (const p of places) {
    const counted = new Map<string, TypedRelation>();
    for (const r of relations) {
      if (r.from !== p.anchor || !FOUNDATION_KINDS.has(r.kind) || r.to === p.anchor) continue;
      const target = live.get(r.to);
      if (!target || (target.kind !== 'planet' && target.kind !== 'region')) continue;
      if (!counted.has(`${r.to}|${r.kind}`)) counted.set(`${r.to}|${r.kind}`, r);
    }
    const holdsUp = [...new Set([...counted.values()].map(r => r.to))].sort(byCode);
    const foundation = counted.size >= FOUNDATION_MIN_CONNECTIONS && holdsUp.length >= FOUNDATION_MIN_PLACES;
    if (foundation && !p.loadBearing) {
      deltas.push({ ...common(p.anchor, 'substrate_neighbourhood'), kind: 'foundation_recognised', evidence: { relations: [...counted.values()], holdsUp } });
    } else if (!foundation && p.loadBearing) {
      const previous = [...(p.foundationBasis ?? [])];
      const sourceChanged = previous.some(r => !active.has(relationKey(r)));
      deltas.push({ ...common(p.anchor, sourceChanged ? 'source_correction' : 'reader_correction'), kind: 'foundation_withdrawn', evidence: { relations: previous } });
    }
  }
  return deltas;
}

/** The reader rejects a live planet or region: it goes, its sightings retire, its regions float free. */
export function planRejection(places: readonly PlaceView[], placeId: string): PlaceDelta[] {
  const target = places.find(p => p.placeId === placeId && p.state === 'live' && p.kind !== 'sighting');
  if (!target) throw new Error('That is not a live place');
  const common = (anchor: string) => ({ anchor, causalClass: 'reader_correction' as const, policyVersion: CARTOGRAPHER_POLICY });
  const children = places.filter(p => p.state === 'live' && p.parentAnchor === target.anchor).sort((a, b) => byCode(a.anchor, b.anchor));
  return [
    { ...common(target.anchor), kind: 'place_rejected', placeId: target.placeId, evidence: {} },
    ...children.filter(p => p.kind === 'region').map(p => ({ ...common(p.anchor), kind: 'place_released' as const, placeId: p.placeId, evidence: { rejectedPlaceId: target.placeId } })),
    ...children.filter(p => p.kind === 'sighting').map(p => ({ ...common(p.anchor), kind: 'sighting_retired' as const, placeId: p.placeId, evidence: { rejectedPlaceId: target.placeId } })),
  ];
}
