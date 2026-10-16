/**
 * ADR-0049: how the reader's recorded places are drawn as a sky of stars.
 *
 * A star is a live top-level place (stored kind `planet`). Its worlds are the live regions under it
 * (facet worlds) and the Idea Rooms on it or on those regions (question worlds). Its possibilities
 * are the live sightings at its edge. Every condition and every reason below is derived from the
 * Atlas response alone, so the same response always draws the same sky. Nothing here reads time
 * away, attention decay, watch time or a count of views (ADR-0049 §3–§4).
 *
 * The contract for other clients is docs/contracts/universe-star-view.md.
 */
import type { WebAtlasResponse } from '@knowscroll/contracts/atlas';

type Atlas = WebAtlasResponse;
type Place = Atlas['places'][number];
type Relation = Atlas['relations'][number];
export type ChronicleEntry = Atlas['chronicle'][number];
export type RelationKind = Relation['kind'];
type Room = Place['rooms'][number];

export type StarCondition = 'quiet' | 'stirring' | 'tense' | 'luminous';

export type StarReasonKind = 'luminous' | 'tension' | 'world' | 'question' | 'connection' | 'possibilities' | 'quiet';
export interface StarReason {
  kind: StarReasonKind;
  text: string;
}

export interface FacetWorld {
  kind: 'facet';
  id: string;
  placeId: string;
  name: string;
  description: string;
  /** 1 for a region directly under the star, 2 for a region inside that one. */
  depth: number;
  parentName: string;
  /** Why this world belongs to its star, in words a reader can check. */
  relation: string;
  luminous: boolean;
  moreToRead: boolean;
  demand: Place['demand'];
  formedAt: string;
}

export interface QuestionPosition {
  role: Room['inhabitants'][number]['role'];
  label: string;
  claims: { key: string; statement: string; truthState: string; supportKind: string }[];
}

export interface QuestionWorld {
  kind: 'question';
  id: string;
  roomId: string;
  /** The place the room is on: the star itself or one of its facet worlds. */
  placeId: string;
  placeName: string;
  question: string;
  state: Room['state'];
  positions: QuestionPosition[];
  relation: string;
  openedAt: string;
}

export type StarWorld = FacetWorld | QuestionWorld;

export interface Possibility {
  placeId: string;
  name: string;
  description: string;
  /** The place this possibility is offered from (the star or one of its worlds). */
  fromName: string;
  relationKind: RelationKind | null;
  /** "in tension with Gravity", "works like Orbit": what kind of possibility it is. */
  phrase: string;
  claim: string | null;
}

export interface Connection {
  key: string;
  fromPlaceId: string;
  toPlaceId: string;
  /** The other star when the line crosses systems, else null (a link inside this star's system). */
  otherStarId: string | null;
  kind: RelationKind;
  sentence: string;
  support: string | null;
  tension: boolean;
}

export interface StarView {
  placeId: string;
  name: string;
  description: string;
  condition: StarCondition;
  tense: boolean;
  luminous: boolean;
  reasons: StarReason[];
  worlds: StarWorld[];
  possibilities: Possibility[];
  connections: Connection[];
  holdsUp: { placeId: string; name: string }[];
  moreToRead: boolean;
  demand: Place['demand'];
  formedAt: string;
  chronicle: ChronicleEntry[];
}

export interface Constellation {
  key: string;
  fromStarId: string;
  toStarId: string;
  kinds: RelationKind[];
  tension: boolean;
  sentence: string;
}

export type TransformationKind = 'star_ignited' | 'world_formed' | 'question_world' | 'luminous' | 'possibility' | 'quiet_change';

/** One recorded change the sky may draw once (ADR-0049 §4). `starId` is null when the change
 * belongs to a place that is no longer live, so it cannot be placed on a star. */
export interface Transformation {
  id: string;
  kind: TransformationKind;
  starId: string | null;
  placeId: string;
  line: string;
  at: string;
}

export interface UniverseSky {
  stars: StarView[];
  constellations: Constellation[];
  transformations: Transformation[];
  /** Chronicle lines that belong to no live star (a place set aside, a retired sighting). */
  looseChronicle: ChronicleEntry[];
}

const RELATION_PHRASE: Record<RelationKind, string> = {
  prerequisite_for: 'comes before',
  explains: 'explains',
  contradicts: 'is in tension with',
  analogous_in: 'works like',
  applies_to: 'applies to',
  compares_mechanism: 'can be compared with',
};

/** What kind of possibility a sighting is, from its own relation kind. */
const POSSIBILITY_PHRASE: Record<RelationKind, (from: string) => string> = {
  prerequisite_for: from => `comes before ${from}`,
  explains: from => `explains part of ${from}`,
  contradicts: from => `a reading in tension with ${from}`,
  analogous_in: from => `another way of seeing ${from}`,
  applies_to: from => `where ${from} is used`,
  compares_mechanism: from => `a comparison with ${from}`,
};

const ROLE_LABEL: Record<QuestionPosition['role'], string> = {
  reader_of_record: 'Your reading',
  doubter: 'A doubt',
  connector: 'A connection',
};

function quoted(text: string): string {
  return `“${text}”`;
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Follows parent links to the top-level place. Null when a link points at no live place. */
function rootOf(place: Place, byId: Map<string, Place>): { root: Place; depth: number } | null {
  let current = place;
  let depth = 0;
  const seen = new Set<string>();
  while (current.parentPlaceId !== null) {
    if (seen.has(current.placeId)) return null;
    seen.add(current.placeId);
    const parent = byId.get(current.parentPlaceId);
    if (!parent) return null;
    current = parent;
    depth += 1;
  }
  return current.kind === 'planet' ? { root: current, depth } : null;
}

export function deriveSky(atlas: Atlas): UniverseSky {
  const byId = new Map(atlas.places.map(place => [place.placeId, place]));
  const starOf = new Map<string, string>();
  const depthOf = new Map<string, number>();
  for (const place of atlas.places) {
    const found = rootOf(place, byId);
    if (!found) continue;
    starOf.set(place.placeId, found.root.placeId);
    depthOf.set(place.placeId, found.depth);
  }
  const nameOf = (placeId: string) => byId.get(placeId)?.anchor.name ?? '';

  const stars = atlas.places
    .filter(place => place.kind === 'planet' && place.parentPlaceId === null)
    .map(star => buildStar(star, atlas, starOf, depthOf, nameOf));

  const constellations = new Map<string, Constellation>();
  for (const relation of atlas.relations) {
    const a = starOf.get(relation.fromPlaceId);
    const b = starOf.get(relation.toPlaceId);
    if (!a || !b || a === b) continue;
    const [fromStarId, toStarId] = a < b ? [a, b] : [b, a];
    const key = `${fromStarId}:${toStarId}`;
    const existing = constellations.get(key);
    const sentence = `${nameOf(relation.fromPlaceId)} ${RELATION_PHRASE[relation.kind]} ${nameOf(relation.toPlaceId)}.`;
    if (existing) {
      if (!existing.kinds.includes(relation.kind)) existing.kinds.push(relation.kind);
      existing.tension ||= relation.kind === 'contradicts';
    } else {
      constellations.set(key, { key, fromStarId, toStarId, kinds: [relation.kind], tension: relation.kind === 'contradicts', sentence });
    }
  }

  const transformations: Transformation[] = [];
  const looseChronicle: ChronicleEntry[] = [];
  for (const entry of atlas.chronicle) {
    const starId = starOf.get(entry.placeId) ?? (entry.parentPlaceId ? starOf.get(entry.parentPlaceId) ?? null : null);
    if (!starId) looseChronicle.push(entry);
    transformations.push({ id: entry.deltaId, kind: transformationKind(entry, byId), starId, placeId: entry.placeId, line: entry.line, at: entry.at });
  }
  for (const place of atlas.places) {
    const starId = starOf.get(place.placeId);
    if (!starId) continue;
    for (const room of place.rooms) {
      transformations.push({
        id: `room:${room.roomId}`,
        kind: 'question_world',
        starId,
        placeId: place.placeId,
        line: `A question world formed around ${quoted(room.question)}.`,
        at: room.openedAt,
      });
    }
  }
  transformations.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : x.id < y.id ? -1 : 1));

  return { stars: orderStars(stars), constellations: [...constellations.values()], transformations, looseChronicle };
}

function transformationKind(entry: ChronicleEntry, byId: Map<string, Place>): TransformationKind {
  switch (entry.kind) {
    case 'place_formed': {
      const place = byId.get(entry.placeId);
      const topLevel = place ? place.parentPlaceId === null : entry.parentPlaceId === null;
      return topLevel ? 'star_ignited' : 'world_formed';
    }
    case 'foundation_recognised':
      return 'luminous';
    case 'sighting_appeared':
      return 'possibility';
    default:
      return 'quiet_change';
  }
}

function buildStar(
  star: Place,
  atlas: Atlas,
  starOf: Map<string, string>,
  depthOf: Map<string, number>,
  nameOf: (placeId: string) => string,
): StarView {
  const inSystem = (placeId: string) => starOf.get(placeId) === star.placeId;
  const members = atlas.places.filter(place => inSystem(place.placeId));
  const regions = members.filter(place => place.kind === 'region');
  const sightings = members.filter(place => place.kind === 'sighting');
  const hosts = members.filter(place => place.kind !== 'sighting');

  const facetWorlds: FacetWorld[] = regions.map(region => {
    const parentName = region.parentPlaceId ? nameOf(region.parentPlaceId) : star.anchor.name;
    const depth = depthOf.get(region.placeId) ?? 1;
    return {
      kind: 'facet',
      id: region.placeId,
      placeId: region.placeId,
      name: region.anchor.name,
      description: region.anchor.description,
      depth,
      parentName,
      relation: depth > 1
        ? `A narrower part of ${parentName}, inside ${star.anchor.name}. It formed from what you kept, asked or followed there.`
        : `A narrower part of ${star.anchor.name}. It formed from what you kept, asked or followed there.`,
      luminous: region.foundation !== null,
      moreToRead: region.scrolls.total > region.scrolls.seen,
      demand: region.demand,
      formedAt: region.formedAt,
    };
  });

  const questionWorlds: QuestionWorld[] = hosts.flatMap(host => host.rooms.map(room => ({
    kind: 'question' as const,
    id: `room:${room.roomId}`,
    roomId: room.roomId,
    placeId: host.placeId,
    placeName: host.anchor.name,
    question: room.question,
    state: room.state,
    positions: room.inhabitants.map(seat => ({
      role: seat.role,
      label: ROLE_LABEL[seat.role],
      claims: seat.claims.map(claim => ({ key: claim.key, statement: claim.statement, truthState: claim.truthState, supportKind: claim.supportKind })),
    })),
    relation: `A question you carried about ${host.anchor.name} on more than one day. ${room.state === 'arguing' ? 'Two readings are held side by side; neither is marked as the answer.' : 'Positions gather here as sources are found.'}`,
    openedAt: room.openedAt,
  })));

  const possibilities: Possibility[] = sightings.map(sighting => {
    const fromName = sighting.parentPlaceId ? nameOf(sighting.parentPlaceId) : star.anchor.name;
    const kind = sighting.basis?.kind ?? null;
    return {
      placeId: sighting.placeId,
      name: sighting.anchor.name,
      description: sighting.anchor.description,
      fromName,
      relationKind: kind,
      phrase: kind ? POSSIBILITY_PHRASE[kind](fromName) : `near ${fromName}`,
      claim: sighting.basis?.claim?.text ?? sighting.basis?.bridge?.mechanism ?? null,
    };
  });

  // A claim and a bridge for the same connection are one line with its best support (ADR-0037 §1).
  const byConnection = new Map<string, Relation>();
  for (const relation of atlas.relations) {
    if (!inSystem(relation.fromPlaceId) && !inSystem(relation.toPlaceId)) continue;
    const key = `${relation.fromPlaceId}:${relation.toPlaceId}:${relation.kind}`;
    const seen = byConnection.get(key);
    if (!seen || (!seen.claim && relation.claim)) byConnection.set(key, relation);
  }
  const connections: Connection[] = [...byConnection.values()]
    .map(relation => {
      const other = inSystem(relation.fromPlaceId) ? relation.toPlaceId : relation.fromPlaceId;
      const otherStar = starOf.get(other) ?? null;
      return {
        key: `${relation.fromPlaceId}:${relation.toPlaceId}:${relation.kind}`,
        fromPlaceId: relation.fromPlaceId,
        toPlaceId: relation.toPlaceId,
        otherStarId: otherStar === star.placeId ? null : otherStar,
        kind: relation.kind,
        sentence: `${nameOf(relation.fromPlaceId)} ${RELATION_PHRASE[relation.kind]} ${nameOf(relation.toPlaceId)}.`,
        support: relation.claim?.text ?? relation.bridge?.mechanism ?? null,
        tension: relation.kind === 'contradicts',
      };
    });

  const holdsUp = (star.foundation?.holdsUp ?? []).map(placeId => ({ placeId, name: nameOf(placeId) })).filter(item => item.name !== '');
  const luminous = star.foundation !== null;
  const arguing = questionWorlds.filter(world => world.state === 'arguing');
  const tensions = connections.filter(connection => connection.tension);
  const tense = tensions.length > 0 || arguing.length > 0;
  const worlds: StarWorld[] = [...facetWorlds, ...questionWorlds];
  const stirring = worlds.length > 0 || connections.length > 0;
  const condition: StarCondition = luminous ? 'luminous' : tense ? 'tense' : stirring ? 'stirring' : 'quiet';

  const reasons: StarReason[] = [];
  if (luminous) {
    reasons.push({
      kind: 'luminous',
      text: holdsUp.length > 0
        ? `Its light reaches ${listNames(holdsUp.map(item => item.name))}: sourced connections say ${star.anchor.name} holds them up.`
        : `Sourced connections say ${star.anchor.name} holds other places up.`,
    });
  }
  for (const tension of tensions) reasons.push({ kind: 'tension', text: tension.sentence });
  for (const world of arguing) reasons.push({ kind: 'tension', text: `Two readings of ${quoted(world.question)} pull against each other.` });
  for (const world of facetWorlds) reasons.push({ kind: 'world', text: `${world.name} formed inside ${world.depth > 1 ? world.parentName : star.anchor.name}.` });
  for (const world of questionWorlds) reasons.push({ kind: 'question', text: `You carried a question here: ${quoted(world.question)}` });
  for (const connection of connections.filter(item => !item.tension)) reasons.push({ kind: 'connection', text: connection.sentence });
  if (possibilities.length > 0) {
    reasons.push({
      kind: 'possibilities',
      text: possibilities.length === 1
        ? `One possibility at its edge, not met yet: ${possibilities[0]!.name}.`
        : `${possibilities.length} possibilities at its edge, not met yet.`,
    });
  }
  if (condition === 'quiet') {
    reasons.push({ kind: 'quiet', text: 'Quiet: nothing inside it has unfolded yet. It holds its possibilities as they are.' });
  }

  const chronicle = atlas.chronicle.filter(entry => inSystem(entry.placeId) || (entry.parentPlaceId !== null && inSystem(entry.parentPlaceId)));
  const moreToRead = hosts.some(place => place.scrolls.total > place.scrolls.seen);

  return {
    placeId: star.placeId,
    name: star.anchor.name,
    description: star.anchor.description,
    condition,
    tense,
    luminous,
    reasons,
    worlds,
    possibilities,
    connections,
    holdsUp,
    moreToRead,
    demand: star.demand,
    formedAt: star.formedAt,
    chronicle,
  };
}

const CONDITION_ORDER: Record<StarCondition, number> = { luminous: 0, tense: 1, stirring: 2, quiet: 3 };

/** Layout order only: the most developed star takes the centre. Never shown as a rank. */
function orderStars(stars: StarView[]): StarView[] {
  return [...stars].sort((a, b) =>
    CONDITION_ORDER[a.condition] - CONDITION_ORDER[b.condition]
    || b.worlds.length - a.worlds.length
    || (a.formedAt < b.formedAt ? -1 : a.formedAt > b.formedAt ? 1 : 0)
    || (a.placeId < b.placeId ? -1 : 1));
}

export const CONDITION_LABEL: Record<StarCondition, string> = {
  quiet: 'Quiet',
  stirring: 'Taking shape',
  tense: 'Under tension',
  luminous: 'Lights others',
};

/** A short, honest line under a star's name. Words about real things; never a level. */
export function starCaption(star: StarView): string {
  const parts: string[] = [];
  const facets = star.worlds.filter(world => world.kind === 'facet').length;
  const questions = star.worlds.length - facets;
  if (facets > 0) parts.push(facets === 1 ? '1 world' : `${facets} worlds`);
  if (questions > 0) parts.push(questions === 1 ? '1 question' : `${questions} questions`);
  if (star.possibilities.length > 0) parts.push(star.possibilities.length === 1 ? '1 possibility' : `${star.possibilities.length} possibilities`);
  return parts.length > 0 ? parts.join(' · ') : CONDITION_LABEL[star.condition];
}
