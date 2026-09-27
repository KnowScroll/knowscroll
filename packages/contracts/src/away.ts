/**
 * ADR-0039 — wire contract for the return: what changed while the reader was away
 * (`GET /v1/away`, a page at a time: ADR-0044 M7) and the marker they move when they have seen it
 * (`POST /v1/away/acknowledge`). Strict: clients refuse an unexpected shape. Imported directly,
 * like `./inquiries.ts`.
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

/** Whether this reader marked the connection "seems wrong" (ADR-0031): it is then neither kept nor
 * marked again, even by a client that lost its own record of it (ADR-0044 M5). */
const seemsWrong = z.boolean();

/**
 * Only what the reader did not cause (ADR-0039 §1): a background inquiry's outcome, a change to a
 * place or a room (ADR-0045) from a source correction, a correction to a connection they were
 * shown as found or kept, or a withdrawn Scroll they were waiting for or were shown (ADR-0046).
 * `at` is when it happened; the list is newest first.
 */
export const awayItem = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('connection_found'), at, inquiryId: id, found: inquiryFound, seemsWrong }).strict(),
  z.object({ kind: z.literal('connection_did_not_hold_up'), at, inquiryId: id, pairs, reasons: z.array(reason).min(1).max(24) }).strict(),
  z.object({ kind: z.literal('nothing_found'), at, inquiryId: id, pairs }).strict(),
  z.object({
    kind: z.literal('place_changed'), at, deltaId: id, placeId: id,
    change: z.enum(['place_formed', 'sighting_appeared', 'sighting_promoted', 'sighting_retired', 'place_released', 'foundation_recognised', 'foundation_withdrawn']),
    /** Only a source correction changes a place without the reader: every other cause follows their own reading. */
    cause: z.literal('source_correction'),
    /** The chronicle's own deterministic line for the delta (ADR-0036), never model text. */
    line: z.string().min(1).max(600),
  }).strict(),
  z.object({
    kind: z.literal('room_changed'), at, deltaId: id, roomId: id, placeId: id,
    change: z.enum(['position_changed', 'inhabitant_unseated', 'room_retired']),
    /** ADR-0045: as for places, only a source correction changes a room without the reader. */
    cause: z.literal('source_correction'),
    /** The Keeper's own deterministic line for the delta, never model text. */
    line: z.string().min(1).max(600),
  }).strict(),
  z.object({
    kind: z.literal('connection_corrected'), at, bridgeId: id, status: z.enum(['revoked', 'superseded']),
    fromConcept: conceptRef, toConcept: conceptRef, seemsWrong,
  }).strict(),
  /** ADR-0046 §5: a Scroll bound to the reader's need (shown or awaited) was withdrawn because what it
   * was based on changed. The client words it; no source is named. */
  z.object({ kind: z.literal('scroll_withdrawn'), at, bindingId: id, concept: conceptRef }).strict(),
]);
export type AwayItem = z.infer<typeof awayItem>;

/** Every kind the list carries, so a page may end on any of them. */
export const AWAY_KINDS = awayItem.options.map(option => option.shape.kind.value);

/** A page ends at `at|kind|id`: its last item in the list's one total order (ADR-0044 M7). */
export const AWAY_CURSOR_PATTERN = new RegExp(
  `^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z)\\|(${AWAY_KINDS.join('|')})\\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`);
export const awayPageCursor = z.string().regex(AWAY_CURSOR_PATTERN);

export const awayResponse = z.object({
  privacyEpoch: epoch,
  /** The reader's marker in this epoch; null when they have never acknowledged a return. */
  since: at.nullable(),
  items: z.array(awayItem).max(AWAY_LIST_LIMIT),
  /** Unacknowledged items older than `items`. */
  more: z.number().int().min(0),
  /** The cursor for the next older page (`GET /v1/away?page=`), exactly when `more` is not zero. */
  nextPage: awayPageCursor.nullable(),
  /** While recording is paused the marker cannot move (ADR-0039 §2); the client says so. */
  recordingPaused: z.boolean(),
}).strict().superRefine((v, ctx) => {
  for (let i = 1; i < v.items.length; i += 1) {
    if (v.items[i]!.at > v.items[i - 1]!.at) ctx.addIssue({ code: 'custom', path: ['items', i], message: 'Items are newest first' });
  }
  if (v.since !== null && v.items.some(item => item.at <= v.since!)) ctx.addIssue({ code: 'custom', path: ['items'], message: 'Items are after the marker' });
  if (v.items.length < AWAY_LIST_LIMIT && v.more > 0) ctx.addIssue({ code: 'custom', path: ['more'], message: 'More only when the list is full' });
  if ((v.more > 0) !== (v.nextPage !== null)) ctx.addIssue({ code: 'custom', path: ['nextPage'], message: 'A next page exactly when there is more' });
});
export type AwayResponse = z.infer<typeof awayResponse>;

/** `through` is the newest item the client displayed, so what arrives meanwhile is not swallowed. */
export const awayAcknowledgeInput = z.object({ clientRequestId: id, expectedPrivacyEpoch: epoch, through: at }).strict();
export type AwayAcknowledgeInput = z.infer<typeof awayAcknowledgeInput>;

export const awayAcknowledgeResponse = z.object({ privacyEpoch: epoch, since: at }).strict();
export type AwayAcknowledgeResponse = z.infer<typeof awayAcknowledgeResponse>;
