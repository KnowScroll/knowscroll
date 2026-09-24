/**
 * ADR-0039 — wire contract for Relics: durable, private things the reader deliberately keeps,
 * with provenance and a truth state that shows any later correction. First kind: `connection`.
 * Strict: clients refuse an unexpected shape. Imported directly, like `./inquiries.ts`.
 */
import { z } from 'zod';
import { inquiryFound } from './inquiries.ts';

const id = z.string().uuid();
const epoch = z.number().int().min(0).max(2147483647);
const at = z.string().datetime();

export const RELIC_LIST_LIMIT = 100;

export const relicKeepInput = z.object({
  clientRequestId: id,
  expectedPrivacyEpoch: epoch,
  kind: z.literal('connection'),
  bridgeId: id,
}).strict();
export type RelicKeepInput = z.infer<typeof relicKeepInput>;

export const relicReleaseInput = z.object({ expectedPrivacyEpoch: epoch }).strict();
export type RelicReleaseInput = z.infer<typeof relicReleaseInput>;

/**
 * `current`: the connection still stands. `corrected`: a source correction revoked or superseded
 * it after it was kept (the kept form stays readable). `doubted`: the reader marked it "seems
 * wrong" after keeping it.
 */
export const relicState = z.enum(['current', 'corrected', 'doubted']);

export const relicWire = z.object({
  relicId: id,
  kind: z.literal('connection'),
  keptAt: at,
  state: relicState,
  /** The connection as it reads now, with the evidence it was admitted on. */
  connection: inquiryFound,
  provenance: z.object({
    /** The background inquiry that found it, when it came from one (ADR-0038). */
    inquiryId: id.nullable(),
    validatorVersion: z.string().min(1).max(80),
    citedClaimKeys: z.array(z.string().min(1).max(200)).min(1).max(12),
  }).strict(),
}).strict().superRefine((v, ctx) => {
  if ((v.state === 'corrected') !== (v.connection.bridgeStatus !== 'admitted')) {
    ctx.addIssue({ code: 'custom', path: ['state'], message: 'Corrected exactly when the connection is no longer admitted' });
  }
});
export type RelicWire = z.infer<typeof relicWire>;

export const relicKeepResponse = z.object({ privacyEpoch: epoch, relic: relicWire }).strict();
export type RelicKeepResponse = z.infer<typeof relicKeepResponse>;

export const relicsResponse = z.object({ privacyEpoch: epoch, relics: z.array(relicWire).max(RELIC_LIST_LIMIT) }).strict();
export type RelicsResponse = z.infer<typeof relicsResponse>;

export const relicReleaseResponse = z.object({ privacyEpoch: epoch, relicId: id, released: z.literal(true) }).strict();
export type RelicReleaseResponse = z.infer<typeof relicReleaseResponse>;
