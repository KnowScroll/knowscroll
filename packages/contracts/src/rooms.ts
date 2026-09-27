/**
 * ADR-0045 — wire contract for Idea Rooms: a place's live rooms on the atlas (`GET /v1/atlas`), one
 * room with its chronicle and evidence (`GET /v1/rooms/:roomId`), one change (`GET
 * /v1/rooms/deltas/:deltaId`) and the reader setting a room aside (`POST /v1/rooms/:roomId/set-aside`).
 * Strict: clients refuse an unexpected shape. No source is ever returned (owner decision,
 * 2026-09-24): a claim is its key, statement and truth state, and how it bears on the room.
 * Imported directly, like `./away.ts`.
 */
import { z } from 'zod';

const id = z.string().uuid();
const epoch = z.number().int().min(0).max(2147483647);
const at = z.string().datetime();

export const ROOM_CHRONICLE_LIMIT = 50;
export const roomRole = z.enum(['reader_of_record', 'doubter', 'connector']);
export const roomState = z.enum(['opened', 'arguing', 'set_aside', 'retired']);
export const roomDeltaKind = z.enum(['room_opened', 'question_joined', 'inhabitant_seated', 'position_changed', 'inhabitant_unseated', 'room_set_aside', 'room_retired']);
const causalClass = z.enum(['personal_exploration', 'substrate_neighbourhood', 'source_correction', 'reader_correction']);

/** A claim an inhabitant holds: its sentence and truth state, and whether it supports the room's
 * anchor or a source qualifies or contradicts it. Never where it came from. */
export const roomClaim = z.object({
  key: z.string().min(1).max(80),
  statement: z.string().min(1).max(400),
  truthState: z.enum(['documented', 'synthesis', 'interpretation', 'disputed', 'modelled', 'counterfactual', 'fictional']),
  supportKind: z.enum(['supports', 'qualifies', 'contradicts']),
}).strict();
export type RoomClaim = z.infer<typeof roomClaim>;

export const roomInhabitant = z.object({ role: roomRole, claims: z.array(roomClaim).min(1).max(4) }).strict();

const inhabitants = z.array(roomInhabitant).max(3).refine(list => new Set(list.map(i => i.role)).size === list.length, { message: 'One seat per role' });
/** The ladder is evidence: a live room argues exactly when its doubter is seated. */
const ladder = (v: { state: string; inhabitants: { role: string }[] }) =>
  v.state === 'set_aside' || v.state === 'retired' ? v.inhabitants.length === 0 : (v.state === 'arguing') === v.inhabitants.some(i => i.role === 'doubter');

/** A live room as the atlas carries it on its place. `question` is the reader's own words. */
export const roomSummary = z.object({
  roomId: id,
  question: z.string().min(1).max(4096),
  state: z.enum(['opened', 'arguing']),
  inhabitants,
  openedAt: at,
}).strict().refine(ladder, { message: 'A live room argues exactly when its doubter is seated' });
export type RoomSummary = z.infer<typeof roomSummary>;

/** A change's evidence: the Asks that carried the question, or the claims a seat holds now and held before. */
export const roomEvidence = z.object({
  asks: z.array(z.object({ askId: id, day: z.string().date() }).strict()),
  claims: z.array(roomClaim).max(4),
  previous: z.array(roomClaim).max(4),
}).strict();

const change = {
  deltaId: id, kind: roomDeltaKind, causalClass, role: roomRole.nullable(), at,
  /** The Keeper's own deterministic line (ADR-0045), never model text. */
  line: z.string().min(1).max(600),
  evidence: roomEvidence,
};

export const roomResponse = z.object({
  roomId: id, placeId: id, placeName: z.string().min(1).max(80),
  question: z.string().min(1).max(4096),
  state: roomState,
  inhabitants,
  openedAt: at,
  /** Newest first. */
  chronicle: z.array(z.object(change).strict()).min(1).max(ROOM_CHRONICLE_LIMIT),
}).strict().refine(ladder, { message: 'The ladder follows the doubter' });
export type RoomResponse = z.infer<typeof roomResponse>;

export const roomDeltaResponse = z.object({ ...change, roomId: id, placeId: id, policyVersion: z.string().min(1) }).strict();
export type RoomDeltaResponse = z.infer<typeof roomDeltaResponse>;

export const roomSetAsideInput = z.object({ clientRequestId: id, expectedPrivacyEpoch: epoch }).strict();
export type RoomSetAsideInput = z.infer<typeof roomSetAsideInput>;
