import { createHash } from 'node:crypto';
import type { ReasoningRole } from '../../../reasoning/public.js';
import type { SentenceUnderCheck } from '../domain/ask-support.js';
import { askSupportRole, type AskSupportAnswer, type SupportPassage } from './ask-support.js';

/**
 * Candidate instructions for the support checker, for the operator's replay only (D-280). They let the coordinator measure
 * a change to the checker's instructions on the real model before it is built into a version.
 *
 * Nothing in the production job, the Quick answer or any worker consumer imports this file: `ask-support-candidate.test.ts`
 * scans the repository's source and fails if one does. Production reads the instructions from `ask-support.ts` alone.
 */

/** The most bytes of a candidate file. The checker's own instructions are under 8 KB; this leaves room to try longer ones. */
export const CANDIDATE_INSTRUCTIONS_MAX_BYTES = 16 * 1024;

/** Candidate instructions as read from a file, with the hash that labels every line of the replay that used them. */
export interface CandidateCheckerInstructions {
  readonly text: string;
  /** SHA-256 of the file's bytes, in lower-case hexadecimal. */
  readonly sha256: string;
  /** The role version the replay's requests are recorded under in the ledger: it names the candidate by its hash. */
  readonly version: string;
}

/** Why a file is not accepted as candidate instructions. */
export type CandidateRefusal = 'empty' | 'too_large' | 'not_utf8' | 'not_plain_text';

export type CandidateReading =
  | { readonly kind: 'accepted'; readonly candidate: CandidateCheckerInstructions }
  | { readonly kind: 'refused'; readonly code: CandidateRefusal };

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Plain text: letters, numbers, marks, spaces, tabs and line breaks. No other control or invisible formatting character. */
const isPlainText = (text: string): boolean =>
  [...text].every(
    (character) => character === '\n' || character === '\r' || character === '\t' || !/[\p{Cc}\p{Cf}]/u.test(character),
  );

/**
 * Reads the bytes of a candidate file. Accepts at most {@link CANDIDATE_INSTRUCTIONS_MAX_BYTES} bytes of valid UTF-8 plain
 * text that is not blank. A byte-order mark, a control character or an invisible formatting character (a zero-width space,
 * a bidirectional override) is refused, so what the operator reads in an editor is what the model is sent.
 */
export function readCandidateInstructions(bytes: Uint8Array): CandidateReading {
  if (bytes.length > CANDIDATE_INSTRUCTIONS_MAX_BYTES) return { kind: 'refused', code: 'too_large' };
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return { kind: 'refused', code: 'not_utf8' };
  }
  if (text.trim() === '') return { kind: 'refused', code: 'empty' };
  if (!isPlainText(text)) return { kind: 'refused', code: 'not_plain_text' };
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { kind: 'accepted', candidate: { text, sha256, version: `ask-support-check.cand-${sha256.slice(0, 8)}` } };
}

/**
 * The checker's role with the candidate's instructions in place of the production ones: the same id (so the same budget and
 * failure brake), schema, repair hints and ceilings, and a version that names the candidate. Every reply still passes
 * through the production rules of `askSupportSchema`.
 */
export function candidateCheckerRole(
  candidate: CandidateCheckerInstructions,
  sentences: readonly SentenceUnderCheck[],
  passages: readonly SupportPassage[],
): ReasoningRole<AskSupportAnswer> {
  return { ...askSupportRole(sentences, passages), version: candidate.version, instructions: candidate.text };
}
