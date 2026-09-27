/**
 * ADR-0039/0044 — wire contract for Relics: durable, private things the reader deliberately keeps,
 * with a truth state that shows any later correction. Kinds: a `connection` (ADR-0039), a `place`,
 * a `passage` of a Scroll and an `answer` to the reader's own Ask (ADR-0044). The new kinds carry
 * their kept form and state only: no source, and none of the provenance recorded for them.
 * Strict: clients refuse an unexpected shape. Imported directly, like `./inquiries.ts`.
 */
import { z } from 'zod';
import { inquiryFound } from './inquiries.ts';
import { conceptCode, semanticKey } from './semantic.ts';

const id = z.string().uuid();
const epoch = z.number().int().min(0).max(2147483647);
const at = z.string().datetime();
const revision = z.number().int().min(1).max(2147483647);
const title = z.string().min(1).max(300);
const conceptRef = z.object({ code: conceptCode, name: z.string().min(1).max(80) }).strict();

export const RELIC_LIST_LIMIT = 100;

/** A page of the Relic list ends at `keptAt|relicId`, the keep time at the database's microseconds. */
export const RELIC_CURSOR_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const relicPageCursor = z.string().regex(RELIC_CURSOR_PATTERN);

const request = { clientRequestId: id, expectedPrivacyEpoch: epoch };
const answerTarget = { kind: z.literal('answer'), askId: id };

/** One thing to keep (ADR-0044 §2): the server records its provenance. */
export const relicKeepInput = z.discriminatedUnion('kind', [
  z.object({ ...request, kind: z.literal('connection'), bridgeId: id }).strict(),
  z.object({ ...request, kind: z.literal('place'), placeId: id }).strict(),
  /** One claim of a Scroll, at the revision the reader read. */
  z.object({ ...request, kind: z.literal('passage'), assetId: id, revision, claimKey: semanticKey }).strict(),
  z.object({ ...request, ...answerTarget }).strict(),
]);
export type RelicKeepInput = z.infer<typeof relicKeepInput>;

/**
 * The reader's "seems wrong" on a passage (that claim of that Scroll) or an answer (ADR-0044 §4).
 * A place is doubted by setting it aside, a connection through `POST /v1/connections/feedback`.
 */
export const objectionInput = z.discriminatedUnion('kind', [
  z.object({ ...request, kind: z.literal('passage'), assetId: id, claimKey: semanticKey }).strict(),
  z.object({ ...request, ...answerTarget }).strict(),
]);
export type ObjectionInput = z.infer<typeof objectionInput>;

export const objectionResponse = z.object({ privacyEpoch: epoch, objectionId: id }).strict();
export type ObjectionResponse = z.infer<typeof objectionResponse>;

export const relicReleaseInput = z.object({ expectedPrivacyEpoch: epoch }).strict();
export type RelicReleaseInput = z.infer<typeof relicReleaseInput>;

/**
 * `current`: what it rests on still stands. `corrected`: a source correction or a newer revision
 * changed what it rests on after it was kept (the kept form stays readable). `doubted`: the reader
 * said it seems wrong, or set the place aside. Corrected beats doubted.
 */
export const relicState = z.enum(['current', 'corrected', 'doubted']);

const kept = { relicId: id, keptAt: at, state: relicState };

/** A claim, and whether it has since lost its current support (M4), never from which source. */
const passageClaim = z.object({ claimKey: semanticKey, statement: z.string().min(1).max(400), withdrawn: z.boolean() }).strict();

export const relicWire = z.discriminatedUnion('kind', [
  z.object({
    ...kept, kind: z.literal('connection'),
    /** The connection as it reads now, with the evidence it was admitted on. */
    connection: inquiryFound,
    provenance: z.object({
      /** The background inquiry that found it, when it came from one (ADR-0038). */
      inquiryId: id.nullable(),
      validatorVersion: z.string().min(1).max(80),
      citedClaimKeys: z.array(z.string().min(1).max(200)).min(1).max(12),
    }).strict(),
  }).strict(),
  z.object({
    ...kept, kind: z.literal('place'),
    /** The place as kept: its anchor and kind then, and the chronicle's line for how it formed. */
    place: z.object({ placeId: id, kind: z.enum(['planet', 'region', 'sighting']), anchor: conceptRef, formedAt: at, formation: z.string().min(1).max(600) }).strict(),
  }).strict(),
  z.object({
    ...kept, kind: z.literal('passage'),
    /** The Scroll's title at the revision the reader read, and the claim they kept. */
    passage: z.object({ assetId: id, revision, title, claim: passageClaim }).strict(),
  }).strict(),
  z.object({
    ...kept, kind: z.literal('answer'),
    /** The reader's question and the validated answer, with the Scroll it was answered from. */
    answer: z.object({
      askId: id, assetId: id, revision, title, question: z.string().min(1).max(4096), answer: z.string().min(1).max(1200),
      basis: z.array(z.object({ quote: z.string().min(1).max(400) }).strict()).min(1).max(4), limits: z.string().min(1).max(400),
    }).strict(),
  }).strict(),
]).superRefine((v, ctx) => {
  if (v.kind === 'connection' && (v.state === 'corrected') !== (v.connection.bridgeStatus !== 'admitted')) {
    ctx.addIssue({ code: 'custom', path: ['state'], message: 'Corrected exactly when the connection is no longer admitted' });
  }
  if (v.kind === 'passage' && v.passage.claim.withdrawn && v.state !== 'corrected') {
    ctx.addIssue({ code: 'custom', path: ['state'], message: 'A passage whose claim was withdrawn is corrected' });
  }
});
export type RelicWire = z.infer<typeof relicWire>;

export const relicKeepResponse = z.object({ privacyEpoch: epoch, relic: relicWire }).strict();
export type RelicKeepResponse = z.infer<typeof relicKeepResponse>;

/** Newest first. `nextPage` names the next older page, only after a full one (M8). */
export const relicsResponse = z.object({
  privacyEpoch: epoch,
  relics: z.array(relicWire).max(RELIC_LIST_LIMIT),
  nextPage: relicPageCursor.nullable(),
  /** While recording is paused nothing new is kept; letting go still works (ADR-0039 §4). */
  recordingPaused: z.boolean(),
}).strict().superRefine((v, ctx) => {
  if (v.nextPage !== null && v.relics.length < RELIC_LIST_LIMIT) ctx.addIssue({ code: 'custom', path: ['nextPage'], message: 'A next page only after a full one' });
});
export type RelicsResponse = z.infer<typeof relicsResponse>;

export const relicReleaseResponse = z.object({ privacyEpoch: epoch, relicId: id, released: z.literal(true) }).strict();
export type RelicReleaseResponse = z.infer<typeof relicReleaseResponse>;

export const PASSAGE_LIST_LIMIT = 40;

/** `GET /v1/scrolls/:assetId/passages`: the Scroll's claims, each with this reader's own state. */
export const passagesResponse = z.object({
  privacyEpoch: epoch,
  assetId: id,
  /** The Scroll's current revision: a passage is kept only at the revision the reader read. */
  revision,
  recordingPaused: z.boolean(),
  passages: z.array(passageClaim.extend({ kept: z.boolean(), seemsWrong: z.boolean() }).strict()).max(PASSAGE_LIST_LIMIT),
}).strict();
export type PassagesResponse = z.infer<typeof passagesResponse>;
