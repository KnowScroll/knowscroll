import type { EncounterRef, SemanticAssessments } from './types.js';

/**
 * How long a prepared buffer may be served. After this the HTTP path ranks deterministically,
 * which is the pre-buffer behaviour, so a short life costs speed, never correctness.
 */
export const BUFFER_LIFETIME_MS = 10 * 60_000;
/** How long a stored Jev assessment may inform a ranking. */
export const ASSESSMENT_LIFETIME_MS = 30 * 60_000;

/** The one thing a buffer is prepared for: the next vertical move from an activated offer. */
export interface BufferKey {
  readonly sessionId: string;
  /** The session's intent revision when the buffer was prepared; a navigation commits revision + 1. */
  readonly intentRevision: number;
  readonly source: { readonly offerId: string; readonly exposureId: string };
}

/** A selected offer and the catalogue watermark its content had when it was ranked. */
export interface BufferedSelection extends EncounterRef {
  readonly catalogWatermark: string;
}

/** A stored buffer. The ranking itself is the Composer decision named by `decisionId`. */
export interface PreparedBuffer extends BufferKey {
  readonly decisionId: string;
  readonly selection: readonly BufferedSelection[];
  readonly preparedAt: string;
  readonly expiresAt: string;
  readonly assessments?: SemanticAssessments;
  /**
   * What its decision said under policy v2: `unseen` (every offer was an explanation the person had not met), `fell_back`
   * (the last resort) or `none`. Absent under v0 and v1. Serving rechecks an `unseen` buffer against what the person has met
   * since it was ranked, so an explanation met on another device in its ten minutes is never offered again.
   */
  readonly unseenOutcome?: 'unseen' | 'fell_back' | 'none';
}

/** Whether the buffer is still within its life. Eligibility is rechecked separately when serving. */
export function bufferIsServable(buffer: PreparedBuffer, now: Date): boolean {
  return Date.parse(buffer.expiresAt) > now.getTime();
}

/** The stored assessments, only while they are within their life. */
export function validAssessments(
  assessments: SemanticAssessments | undefined,
  now: Date,
): SemanticAssessments | undefined {
  return assessments && Date.parse(assessments.expiresAt) > now.getTime() ? assessments : undefined;
}
