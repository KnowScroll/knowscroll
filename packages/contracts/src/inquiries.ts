/**
 * ADR-0038 — wire contract for background bridge inquiries: the reader's standing consent
 * (`PUT /v1/inquiries/consent`) and what was looked for (`GET /v1/inquiries`). Strict: clients
 * refuse an unexpected shape. Imported directly, like `./atlas.ts`.
 */
import { z } from 'zod';
import { bridgeRelationType, conceptCode, evidenceSupports } from './semantic.ts';

const id = z.string().uuid();
const epoch = z.number().int().min(0).max(2147483647);
const at = z.string().datetime();

export const INQUIRY_DAILY_LIMIT = Object.freeze({ default: 3, max: 10 });
export const INQUIRY_LIST_LIMIT = 50;

/** One explicit change from a live session. `dailyLimit` defaults to the current one (3 at first). */
export const inquiryConsentInput = z.object({
  enabled: z.boolean(),
  dailyLimit: z.number().int().min(1).max(INQUIRY_DAILY_LIMIT.max).optional(),
  clientRequestId: id,
  expectedPrivacyEpoch: epoch,
}).strict();
export type InquiryConsentInput = z.infer<typeof inquiryConsentInput>;

export const inquiryConsentView = z.object({
  enabled: z.boolean(),
  dailyLimit: z.number().int().min(1).max(INQUIRY_DAILY_LIMIT.max),
  /** When consent last changed in this epoch; null when the reader never set it. */
  changedAt: at.nullable(),
  /** False when this deployment has no enabled inquiry route: consent is kept, nothing runs. */
  available: z.boolean(),
  /** Inquiries that started a model call today (UTC), against `dailyLimit`. */
  usedToday: z.number().int().min(0),
}).strict();
export type InquiryConsentView = z.infer<typeof inquiryConsentView>;

export const inquiryConsentResponse = z.object({ privacyEpoch: epoch, consent: inquiryConsentView }).strict();
export type InquiryConsentResponse = z.infer<typeof inquiryConsentResponse>;

/**
 * `waiting`: mail is coalescing (or today's limit is reached); `looking`: a Job exists;
 * `found`: the validator admitted a bridge; `nothing_found`: the model said there is none;
 * `did_not_hold_up`: the reply was refused (validator reasons, or `shape`); `nothing_to_ask`: no
 * eligible pair, so nothing was sent; `failed`: the call failed or its context went stale;
 * `withdrawn`: consent off or recording paused before it was sent or applied.
 */
export const inquiryStatus = z.enum(['waiting', 'looking', 'found', 'nothing_found', 'did_not_hold_up', 'nothing_to_ask', 'failed', 'withdrawn']);
export type InquiryStatus = z.infer<typeof inquiryStatus>;

const conceptRef = z.object({ code: conceptCode, name: z.string().min(1).max(80) }).strict();
export const inquiryFound = z.object({
  bridgeId: id,
  /** A later source correction can revoke it; the list still says what was found. */
  bridgeStatus: z.enum(['admitted', 'revoked', 'superseded']),
  relationType: bridgeRelationType,
  fromConcept: conceptRef,
  toConcept: conceptRef,
  /** The bridge's validated mechanism: how the two places connect. */
  sentence: z.string().min(1).max(600),
  evidence: z.array(z.object({
    claimKey: z.string().min(1), statement: z.string().min(1), supports: evidenceSupports, sourceTitle: z.string().min(1), sourceUrl: z.string().url(),
  }).strict()).min(1).max(12),
}).strict();

export const inquiryWire = z.object({
  inquiryId: id,
  status: inquiryStatus,
  requestedAt: at,
  closedAt: at.nullable(),
  pairs: z.array(z.object({ a: conceptRef, b: conceptRef }).strict()).max(3),
  reasons: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)).max(24),
  found: inquiryFound.nullable(),
}).strict().superRefine((v, ctx) => {
  if ((v.status === 'found') !== (v.found !== null)) ctx.addIssue({ code: 'custom', path: ['found'], message: 'Only a found inquiry carries a bridge' });
  if (['did_not_hold_up', 'failed', 'withdrawn', 'nothing_to_ask'].includes(v.status) !== (v.reasons.length > 0)) ctx.addIssue({ code: 'custom', path: ['reasons'], message: 'Reasons belong to refused, failed or withdrawn inquiries' });
  if ((['waiting', 'looking'].includes(v.status)) !== (v.closedAt === null)) ctx.addIssue({ code: 'custom', path: ['closedAt'], message: 'Only an open inquiry has no close time' });
});
export type InquiryWire = z.infer<typeof inquiryWire>;

export const inquiriesResponse = z.object({
  privacyEpoch: epoch,
  consent: inquiryConsentView,
  /** Newest first. */
  inquiries: z.array(inquiryWire).max(INQUIRY_LIST_LIMIT),
}).strict();
export type InquiriesResponse = z.infer<typeof inquiriesResponse>;
