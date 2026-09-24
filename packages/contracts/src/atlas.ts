/**
 * ADR-0036 — wire contract for the reader's places (`GET /v1/atlas`, `POST …/reject`) and one
 * change's evidence (`GET /v1/atlas/deltas/:deltaId`). Strict: clients refuse an unexpected shape.
 * Imported directly, like `./worlds.ts`.
 */
import { z } from 'zod';
import { roomSummary } from './rooms.ts';

const id = z.string().uuid();
const relationKind = z.enum(['prerequisite_for', 'explains', 'contradicts', 'analogous_in', 'applies_to', 'compares_mechanism']);
const support = {
  claim: z.object({ text: z.string().min(1), sourceTitle: z.string().min(1) }).strict().nullable(),
  bridge: z.object({ mechanism: z.string().min(1) }).strict().nullable(),
};

export const atlasPlaceSchema = z.object({
  placeId: id,
  kind: z.enum(['planet', 'region', 'sighting']),
  parentPlaceId: id.nullable(),
  anchor: z.object({ code: z.string().min(1), name: z.string().min(1), description: z.string().min(1) }).strict(),
  basis: z.object({ kind: relationKind, from: z.string().min(1), to: z.string().min(1), ...support }).strict().nullable(),
  attention: z.object({ state: z.enum(['seen', 'anchored', 'dormant']), episodes: z.number().int().min(0), daysActive: z.number().int().min(0), sourceFamilies: z.number().int().min(0) }).strict().nullable(),
  scrolls: z.object({ total: z.number().int().min(0), seen: z.number().int().min(0) }).strict(),
  formedAt: z.string().datetime(),
  formedBy: z.string().min(1),
  foundation: z.object({
    holdsUp: z.array(id).min(1),
    relations: z.array(z.object({ kind: relationKind, from: z.string().min(1), to: z.string().min(1), ...support }).strict()).min(1),
  }).strict().nullable(),
  /** ADR-0045: the reader's live Idea Rooms on this place, oldest first. */
  rooms: z.array(roomSummary).max(3),
}).strict().refine(p => p.kind !== 'sighting' || (p.attention === null && p.foundation === null && p.rooms.length === 0), { message: 'A sighting is not yet met: it carries no attention, holds nothing up and has no room' });

export const atlasResponseSchema = z.object({
  policyVersion: z.string().min(1),
  places: z.array(atlasPlaceSchema),
  relations: z.array(z.object({ fromPlaceId: id, toPlaceId: id, kind: relationKind, ...support }).strict()),
  chronicle: z.array(z.object({
    deltaId: id, placeId: id, parentPlaceId: id.nullable(),
    kind: z.enum(['place_formed', 'sighting_appeared', 'sighting_retired', 'place_rejected', 'place_released', 'foundation_recognised', 'foundation_withdrawn']),
    causalClass: z.enum(['personal_exploration', 'substrate_neighbourhood', 'source_correction', 'reader_correction']),
    at: z.string().datetime(), line: z.string().min(1),
  }).strict()).max(20),
}).strict();
export type AtlasResponse = z.infer<typeof atlasResponseSchema>;

export const atlasDeltaSchema = z.object({
  deltaId: id, placeId: id, kind: z.string().min(1), causalClass: z.string().min(1), policyVersion: z.string().min(1),
  at: z.string().datetime(), anchor: z.object({ code: z.string().min(1), name: z.string().min(1) }).strict(),
  before: z.record(z.string(), z.unknown()).nullable(), after: z.record(z.string(), z.unknown()),
  evidence: z.record(z.string(), z.unknown()),
}).strict();
export type AtlasDelta = z.infer<typeof atlasDeltaSchema>;
