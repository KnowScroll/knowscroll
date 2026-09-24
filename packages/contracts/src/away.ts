/**
 * ADR-0039 — wire contract for the return: what changed while the reader was away
 * (`GET /v1/away`) and the marker they move when they have seen it (`POST /v1/away/acknowledge`).
 * Strict: clients refuse an unexpected shape. Imported directly, like `./inquiries.ts`.
 */
import { z } from 'zod';
import { inquiryFound } from './inquiries.ts';
import { conceptCode } from './semantic.ts';

const id = z.string().uuid();
const epoch = z.number().int().min(0).max(2147483647);
const at = z.string().datetime();
const reason = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);
const conceptRef = z.object({ code: conceptCode, name: z.string().min(1).max(80) }).strict();
const pairs = z.array(z.object({ a: conceptRef, b: conceptRef }).strict()).min(1).max(3);

export const AWAY_LIST_LIMIT = 10;

/**
 * Only what the reader did not cause (ADR-0039 §1): a background inquiry's outcome, a change to a
 * place from a source correction, or a correction to a connection they were shown as found or kept. `at` is when it happened; the list is newest first.
 */
export const awayItem = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('connection_found'), at, inquiryId: id, found: inquiryFound }).strict(),
  z.object({ kind: z.literal('connection_did_not_hold_up'), at, inquiryId: id, pairs, reasons: z.array(reason).min(1).max(24) }).strict(),
  z.object({ kind: z.literal('nothing_found'), at, inquiryId: id, pairs }).strict(),
  z.object({
    kind: z.literal('place_changed'), at, deltaId: id, placeId: id,
    change: z.enum(['place_formed', 'sighting_appeared', 'sighting_promoted', 'sighting_retired', 'place_released', 'foundation_recognised', 'foundation_withdrawn']),
    /** Only a source correction changes a place without the reader: every other cause follows their own reading. */
    cause: z.literal('source_correction'),
    /** The chronicle's own deterministic line for the delta (ADR-0036), never model text. */
    line: z.string().min(1).max(300),
  }).strict(),
  z.object({
    kind: z.literal('connection_corrected'), at, bridgeId: id, status: z.enum(['revoked', 'superseded']),
    fromConcept: conceptRef, toConcept: conceptRef,
  }).strict(),
]);
export type AwayItem = z.infer<typeof awayItem>;

export const awayResponse = z.object({
  privacyEpoch: epoch,
  /** The reader's marker in this epoch; null when they have never acknowledged a return. */
  since: at.nullable(),
  items: z.array(awayItem).max(AWAY_LIST_LIMIT),
  /** Unacknowledged items beyond `items`. */
  more: z.number().int().min(0),
  /** While recording is paused the marker cannot move (ADR-0039 §2); the client says so. */
  recordingPaused: z.boolean(),
}).strict().superRefine((v, ctx) => {
  for (let i = 1; i < v.items.length; i += 1) {
    if (v.items[i]!.at > v.items[i - 1]!.at) ctx.addIssue({ code: 'custom', path: ['items', i], message: 'Items are newest first' });
  }
  if (v.since !== null && v.items.some(item => item.at <= v.since!)) ctx.addIssue({ code: 'custom', path: ['items'], message: 'Items are after the marker' });
  if (v.items.length < AWAY_LIST_LIMIT && v.more > 0) ctx.addIssue({ code: 'custom', path: ['more'], message: 'More only when the list is full' });
});
export type AwayResponse = z.infer<typeof awayResponse>;

/** `through` is the newest item the client displayed, so what arrives meanwhile is not swallowed. */
export const awayAcknowledgeInput = z.object({ clientRequestId: id, expectedPrivacyEpoch: epoch, through: at }).strict();
export type AwayAcknowledgeInput = z.infer<typeof awayAcknowledgeInput>;

export const awayAcknowledgeResponse = z.object({ privacyEpoch: epoch, since: at }).strict();
export type AwayAcknowledgeResponse = z.infer<typeof awayAcknowledgeResponse>;
