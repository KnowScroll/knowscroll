/**
 * #133 — Composer v3 wire shapes (ADR-0032 §4–§5). Imported directly, like the other contract
 * modules. The feed response itself is unchanged (web-bootstrap.ts): a v3 item carries the same
 * fields and a rendered `reason`; the recorded family, terms and evidence path are read on demand.
 */
import { z } from 'zod';

export const encounterFeedbackKind = z.enum(['less_like_this', 'wrong_connection']);
export type EncounterFeedbackKind = z.infer<typeof encounterFeedbackKind>;

export const encounterFeedbackInput = z.object({
  clientFeedbackId: z.string().uuid(),
  decisionId: z.string().uuid(),
  assetId: z.string().uuid(),
  kind: encounterFeedbackKind,
  expectedPrivacyEpoch: z.number().int().min(0).max(2147483647),
}).strict();
export type EncounterFeedbackInput = z.infer<typeof encounterFeedbackInput>;

export type EvidenceStepWire =
  | { kind: 'mark'; markKind: 'keep' | 'branch' | 'ask'; assetId: string; title: string; at: string; eventId: string }
  | { kind: 'bridge'; bridgeId: string; sentence: string }
  | { kind: 'question'; concept: string }
  | { kind: 'outside'; domain: string };

/** `GET /v1/decisions/:decisionId/why?assetId=` */
export interface WhyResponseWire {
  decisionId: string;
  assetId: string;
  policyVersion: string;
  family: 'continue' | 'deepen' | 'bridge' | 'challenge' | 'revisit' | 'frontier' | 'seed' | 'fallback';
  reason: string;
  evidence: EvidenceStepWire[];
  terms: Record<string, number>;
  quotas: string[];
  /** The corrections this encounter supports; an unmapped fallback supports none. */
  corrections: EncounterFeedbackKind[];
  /** Corrections this reader already made here; a client does not offer them again. */
  corrected: EncounterFeedbackKind[];
}

/** `POST /v1/encounters/feedback` → 201 */
export interface EncounterFeedbackReceipt {
  feedbackId: string;
  kind: EncounterFeedbackKind;
  suppressed: { family: string; concept: string | null; bridgeId: string | null; until: string };
}

/** Days a "less like this" route stays suppressed for the reader (`feedback-v1`). */
export const ENCOUNTER_SUPPRESSION_DAYS = 14;
