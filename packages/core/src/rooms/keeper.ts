/**
 * #163 — the Keeper v1 (ADR-0045). Pure: the reader's Asks, places and rooms and the substrate's
 * currently supported claims in; the room deltas that should happen out. Every delta carries its
 * cause and evidence; the database applies them and refuses a room change without one. No model is
 * called: an inhabitant speaks only through the claims it holds.
 *
 * - A carried question -- at least two Asks on at least two days, from Scrolls at home in a live
 *   planet or region, that no room of that place holds yet -- opens a room there, in the words of the
 *   latest of them. Beyond a cap it joins the place's most recent live room instead.
 * - Each live room seats the reader of record, the doubter and the connector, each only when it has
 *   evidence to hold: up to four supported claims, in key order, no claim held twice.
 * - The ladder is evidence, not time: a seated doubter means two readings disagree (`arguing`).
 * - A room whose place is no longer live retires; the reader's setting a room aside is final.
 */
import { homeAnchor, type CausalClass, type ConceptNode, type PlaceView, type TypedRelation } from '../atlas/cartographer.ts';

export const KEEPER_V1 = 'keeper-v1';
export const KEEPER_POLICY = KEEPER_V1;
const MIN_ASKS = 2;
const MIN_DAYS = 2;
const MAX_LIVE_ROOMS_PER_PLACE = 3;
const MAX_LIVE_ROOMS = 12;
const MAX_POSITION = 4;

export type RoomRole = 'reader_of_record' | 'doubter' | 'connector';
/** Seating order: the doubter's seat decides the ladder, so it is recorded before the connector's. */
export const ROOM_ROLES: readonly RoomRole[] = ['reader_of_record', 'doubter', 'connector'];
export type RoomState = 'opened' | 'arguing' | 'set_aside' | 'retired';
export type LiveRoomState = Extract<RoomState, 'opened' | 'arguing'>;
/** How a held claim bears on the room's anchor: it supports it, or a source qualifies or contradicts it. */
export type SupportKind = 'supports' | 'qualifies' | 'contradicts';
export interface HeldClaim { claimId: string; supportKind: SupportKind }

/** One of the reader's Asks, with the primary concept of the Scroll it was asked from. */
export interface KeeperAsk { askId: string; atMs: number; assetId: string; concept: string | null }
/** A currently supported claim: the concepts it is about (subject or mechanism role), and whether a
 * current source qualifies or contradicts it. */
export interface KeeperClaim { claimId: string; key: string; about: readonly string[]; doubt: 'qualifies' | 'contradicts' | null }
/** An admitted bridge's cited claims and the claims its proposal recorded as counterevidence. */
export interface KeeperBridge { cites: readonly string[]; counterevidence: readonly string[] }
export type KeeperPlace = Pick<PlaceView, 'placeId' | 'anchor' | 'kind' | 'state'>;
export interface RoomView {
  roomId: string; placeId: string; state: RoomState; openedAtMs: number; askIds: readonly string[];
  /** Seated inhabitants only. */
  seats: Partial<Record<RoomRole, readonly HeldClaim[]>>;
}
export interface KeeperInput {
  concepts: readonly ConceptNode[];
  /** Active substrate relations and admitted shared bridges, as the Cartographer sees them. */
  relations: readonly TypedRelation[];
  bridges: ReadonlyMap<string, KeeperBridge>;
  claims: readonly KeeperClaim[];
  places: readonly KeeperPlace[];
  asks: readonly KeeperAsk[];
  rooms: readonly RoomView[];
}

export interface AskEvidence { askId: string; day: string; assetId: string }
/** `room` is the room's id, or `openingRef(questionAskId)` for a room this same plan opens. */
type Common = { room: string; causalClass: CausalClass; policyVersion: string };
type Seat = Common & { role: RoomRole; state: LiveRoomState };
export type RoomDelta =
  | Common & { kind: 'room_opened'; placeId: string; questionAskId: string; askIds: string[]; evidence: { asks: AskEvidence[] } }
  | Common & { kind: 'question_joined'; askIds: string[]; evidence: { asks: AskEvidence[] } }
  | Seat & { kind: 'inhabitant_seated'; claims: HeldClaim[]; evidence: { claims: HeldClaim[] } }
  | Seat & { kind: 'position_changed'; claims: HeldClaim[]; evidence: { claims: HeldClaim[]; previous: HeldClaim[] } }
  | Seat & { kind: 'inhabitant_unseated'; evidence: { claims: HeldClaim[] } }
  | Common & { kind: 'room_set_aside'; evidence: { clientRequestId: string } }
  | Common & { kind: 'room_retired'; evidence: { placeId: string; placeState: PlaceView['state'] } };

export const openingRef = (questionAskId: string) => `opening:${questionAskId}`;
export const isLiveRoom = (r: { state: RoomState }): boolean => r.state === 'opened' || r.state === 'arguing';
const isLivePlace = (p: KeeperPlace) => p.state === 'live' && (p.kind === 'planet' || p.kind === 'region');
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** UTC calendar days, as attention counts them (`semantic/attention.ts`). */
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const askEvidence = (a: KeeperAsk): AskEvidence => ({ askId: a.askId, day: isoDay(a.atMs), assetId: a.assetId });
const common = (room: string, causalClass: CausalClass) => ({ room, causalClass, policyVersion: KEEPER_POLICY });

export function planRooms(input: KeeperInput): RoomDelta[] {
  const deltas = planRetirements(input.rooms, input.places);
  const retired = new Set(deltas.map(d => d.room));
  const live = new Map(input.places.filter(isLivePlace).map(p => [p.anchor, p]));
  const parentOf = new Map(input.concepts.map(c => [c.code, c.parent]));
  // The rooms as this plan leaves them.
  const rooms: RoomView[] = input.rooms.filter(r => !retired.has(r.roomId)).map(r => ({ ...r }));

  // 1. Carried questions: an Ask belongs to the nearest live planet or region on its Scroll's chain.
  const asksAt = new Map<string, KeeperAsk[]>();
  for (const ask of input.asks) {
    const home = ask.concept === null ? null : homeAnchor(ask.concept, parentOf, a => live.has(a));
    if (home !== null) asksAt.set(live.get(home)!.placeId, [...(asksAt.get(live.get(home)!.placeId) ?? []), ask]);
  }
  let liveRooms = rooms.filter(isLiveRoom).length;
  for (const place of [...live.values()].sort((a, b) => byCode(a.anchor, b.anchor))) {
    const here = rooms.filter(r => r.placeId === place.placeId);
    // Every room of the place holds its Asks, set aside included: what the reader said no to never reopens.
    const held = new Set(here.flatMap(r => r.askIds));
    const carried = (asksAt.get(place.placeId) ?? []).filter(a => !held.has(a.askId)).sort((a, b) => a.atMs - b.atMs || byCode(a.askId, b.askId));
    if (carried.length < MIN_ASKS || new Set(carried.map(a => isoDay(a.atMs))).size < MIN_DAYS) continue;
    const evidence = { asks: carried.map(askEvidence) };
    const liveHere = here.filter(isLiveRoom);
    if (liveHere.length < MAX_LIVE_ROOMS_PER_PLACE && liveRooms < MAX_LIVE_ROOMS) {
      const question = carried[carried.length - 1]!;
      const askIds = carried.map(a => a.askId);
      const ref = openingRef(question.askId);
      deltas.push({ ...common(ref, 'personal_exploration'), kind: 'room_opened', placeId: place.placeId, questionAskId: question.askId, askIds, evidence });
      rooms.push({ roomId: ref, placeId: place.placeId, state: 'opened', openedAtMs: question.atMs, askIds, seats: {} });
      liveRooms += 1;
    } else if (liveHere.length > 0) {
      // Beyond a cap a carried question never opens another room; with no room of its own to join, it waits.
      const recent = [...liveHere].sort((a, b) => b.openedAtMs - a.openedAtMs || byCode(a.roomId, b.roomId))[0]!;
      recent.askIds = [...recent.askIds, ...carried.map(a => a.askId)];
      deltas.push({ ...common(recent.roomId, 'personal_exploration'), kind: 'question_joined', askIds: [...recent.askIds], evidence });
    }
  }

  // 2. Seats, positions and the ladder of every live room, over its place's anchor.
  const placeOf = new Map(input.places.map(p => [p.placeId, p]));
  for (const room of rooms.filter(isLiveRoom)) deltas.push(...planSeats(room, neighbourhood(input, placeOf.get(room.placeId)!.anchor, live)));
  return deltas;
}

/** A live room whose place is no longer a live planet or region retires: the reader set the place aside, or it went for a source's reason. */
export function planRetirements(rooms: readonly RoomView[], places: readonly KeeperPlace[]): RoomDelta[] {
  const placeOf = new Map(places.map(p => [p.placeId, p]));
  return rooms.filter(isLiveRoom).flatMap(r => {
    const place = placeOf.get(r.placeId)!;
    if (isLivePlace(place)) return [];
    return [{ ...common(r.roomId, place.state === 'rejected' ? 'reader_correction' : 'source_correction'), kind: 'room_retired' as const,
      evidence: { placeId: place.placeId, placeState: place.state } }];
  });
}

/** The reader sets a live room aside; its inhabitants are unseated with it, and its Asks never reopen a room. */
export function planSetAside(room: RoomView, clientRequestId: string): RoomDelta {
  if (!isLiveRoom(room)) throw new Error('That is not a live room');
  return { ...common(room.roomId, 'reader_correction'), kind: 'room_set_aside', evidence: { clientRequestId } };
}

interface Neighbourhood {
  /** What each role holds now. */
  held: Record<RoomRole, HeldClaim[]>;
  /** The claims each role could hold whichever places are live: losing one is only ever a source's doing. */
  standing: Record<RoomRole, ReadonlySet<string>>;
  /** The claims each role could hold with the places as they are. */
  reachable: Record<RoomRole, ReadonlySet<string>>;
}

/**
 * What each seat has access to around one anchor. The doubter: supported claims about it that a
 * current source qualifies or contradicts, and the counterevidence recorded against its bridges. The
 * connector: the claims (or a bridge's cited claims) of its relations to another live place. The
 * reader of record: every other supported claim about it. A claim is held by one seat only, in that
 * order of precedence.
 */
function neighbourhood(input: KeeperInput, anchor: string, live: ReadonlyMap<string, KeeperPlace>): Neighbourhood {
  const supported = new Map(input.claims.map(c => [c.claimId, c]));
  const about = input.claims.filter(c => c.about.includes(anchor));
  const doubt = new Map<string, SupportKind>(about.flatMap(c => (c.doubt ? [[c.claimId, c.doubt] as const] : [])));
  const anyTies = new Set<string>(), liveTies = new Set<string>();
  for (const r of input.relations) {
    const other = r.from === anchor ? r.to : r.to === anchor ? r.from : null;
    if (other === null) continue;
    const bridge = 'bridgeId' in r.ref ? input.bridges.get(r.ref.bridgeId) : undefined;
    for (const id of bridge?.counterevidence ?? []) if (supported.has(id) && !doubt.has(id)) doubt.set(id, 'contradicts');
    for (const id of 'claimId' in r.ref ? [r.ref.claimId] : bridge?.cites ?? []) {
      if (!supported.has(id)) continue;
      anyTies.add(id);
      if (live.has(other)) liveTies.add(id);
    }
  }
  const position = (ids: Iterable<string>, kind: (id: string) => SupportKind): HeldClaim[] =>
    [...ids].map(id => supported.get(id)!).sort((a, b) => byCode(a.key, b.key)).slice(0, MAX_POSITION).map(c => ({ claimId: c.claimId, supportKind: kind(c.claimId) }));
  const connecting = [...liveTies].filter(id => !doubt.has(id));
  const aboutIds = new Set(about.map(c => c.claimId));
  return {
    held: {
      doubter: position(doubt.keys(), id => doubt.get(id)!),
      connector: position(connecting, () => 'supports'),
      reader_of_record: position([...aboutIds].filter(id => !doubt.has(id) && !liveTies.has(id)), () => 'supports'),
    },
    standing: { reader_of_record: aboutIds, doubter: new Set(doubt.keys()), connector: anyTies },
    reachable: { reader_of_record: aboutIds, doubter: new Set(doubt.keys()), connector: liveTies },
  };
}

const samePosition = (a: readonly HeldClaim[], b: readonly HeldClaim[]) =>
  a.length === b.length && a.every((c, i) => c.claimId === b[i]!.claimId && c.supportKind === b[i]!.supportKind);

function planSeats(room: RoomView, n: Neighbourhood): RoomDelta[] {
  const deltas: RoomDelta[] = [];
  let state = room.state as LiveRoomState;
  for (const role of ROOM_ROLES) {
    const before = [...(room.seats[role] ?? [])];
    const after = n.held[role];
    if (samePosition(before, after)) continue;
    if (role === 'doubter') state = after.length > 0 ? 'arguing' : 'opened';
    // Why a held claim went: the substrate only loses one by a correction; a connected place only
    // goes when the reader sets it aside; anything else (a seat taken, a claim displaced) is the
    // neighbourhood moving on.
    const dropped = before.filter(c => !after.some(a => a.claimId === c.claimId));
    const cause: CausalClass = dropped.some(c => !n.standing[role].has(c.claimId)) ? 'source_correction'
      : dropped.some(c => !n.reachable[role].has(c.claimId)) ? 'reader_correction' : 'substrate_neighbourhood';
    const seat = { ...common(room.roomId, cause), role, state };
    if (before.length === 0) deltas.push({ ...seat, kind: 'inhabitant_seated', claims: after, evidence: { claims: after } });
    else if (after.length === 0) deltas.push({ ...seat, kind: 'inhabitant_unseated', evidence: { claims: before } });
    else deltas.push({ ...seat, kind: 'position_changed', claims: after, evidence: { claims: after, previous: before } });
  }
  return deltas;
}

const WHO: Record<RoomRole, string> = { reader_of_record: 'The reader of record', doubter: 'The doubter', connector: 'The connector' };

/** One quiet line per room change, in the Keeper's own words (like the atlas chronicle, ADR-0036):
 * it says what happened and why, never where a claim came from. */
export function roomChronicleLine(d: { kind: string; causalClass: string; role: RoomRole | null; placeName: string }): string {
  const who = d.role ? WHO[d.role] : 'This room';
  switch (d.kind) {
    case 'room_opened':
      return `A question you keep asking opened a room on ${d.placeName}.`;
    case 'question_joined':
      return `Another of your questions about ${d.placeName} joined this room.`;
    case 'inhabitant_seated':
      if (d.role === 'doubter') return `${who} took a seat: two readings of ${d.placeName} disagree.`;
      if (d.role === 'connector') return `${who} took a seat with what ties ${d.placeName} to your other places.`;
      return `${who} took a seat with what is known about ${d.placeName}.`;
    case 'position_changed':
      if (d.causalClass === 'source_correction') return `${who} changed position: what a claim was based on changed.`;
      if (d.causalClass === 'reader_correction') return `${who} changed position after you set a place aside.`;
      return `${who} took up a new position.`;
    case 'inhabitant_unseated':
      if (d.causalClass === 'source_correction') return `${who} left: what its claims were based on changed.`;
      if (d.causalClass === 'reader_correction') return `${who} left after you set a place aside.`;
      return `${who} left.`;
    case 'room_set_aside':
      return 'You set this room aside.';
    case 'room_retired':
      return d.causalClass === 'reader_correction' ? `This room closed: you set ${d.placeName} aside.` : `This room closed: what ${d.placeName} was based on changed.`;
    default:
      return `${who} changed.`;
  }
}
