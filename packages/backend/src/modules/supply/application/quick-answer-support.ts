import type { ContextItem, ProposeOutcome, RecordingReasoningHarness } from '../../../reasoning/public.js';
import type { PersonalAuthority } from '../../identity/public.js';
import {
  ASK_SUPPORT_BATCH_SENTENCES,
  UNSUPPORTED_HINTS,
  askSupportContext,
  askSupportRole,
  splitSentences,
  unsupportedOf,
  verdictsOf,
  type SentenceUnderCheck,
  type UnsupportedVerdict,
} from '../../content/public.js';
import type { CitablePassage, QuickAnswerDraft } from '../domain/quick-answer.js';
import { proposeAtGeneration, purposeOf, type RunOwner, type StartedRun } from './recording-runs.js';

/**
 * The support check of a Quick answer (D-250, D-253). The checker is the one an ask order's answer goes through: a second
 * model reads each sentence of the answer against the passages the answer cites and says which sentences those passages do
 * not support. It has a role of its own here, so its failure brake and its budget never touch the writer's or the ask
 * orders'. It only proposes: code validates its reply (every verdict has a quote that is in a cited passage and is about the
 * sentence, "states no fact" only where code can see it), reads the verdicts and decides. A card is shown only when a check
 * answered and found nothing unsupported: no usable check is no card.
 *
 * What the checker model judges, and code cannot, is whether the quoted words state what the sentence says. That is a model's
 * judgement and not a proof; D-253 says so.
 */

export const QUICK_ANSWER_SUPPORT_ROLE_ID = 'supply.quick-answer-support';
export const QUICK_ANSWER_SUPPORT_POLICY_VERSION = 'supply-quick-answer-support.v1';

/** A paid model run and how it ended, so the step that applies the verdict can close it. */
export type RunEnd = StartedRun;

/** What one check came to. `unchecked` means nothing is known: the checker failed, was refused, or its reply stayed invalid. */
export type SupportFinding =
  | { readonly kind: 'supported' }
  | { readonly kind: 'unsupported'; readonly unsupported: readonly UnsupportedVerdict[] }
  | { readonly kind: 'unchecked' };

export interface SupportCheckInput {
  readonly authority: PersonalAuthority;
  /** The Quick answer's account and the recording generation it was asked at (D-264). */
  readonly owner: RunOwner;
  readonly quickAnswerId: string;
  /** The run of this draft's check, derived from the answer's ID so a redelivery asks the ledger instead of the model. */
  readonly runId: string;
  readonly draft: 1 | 2;
  readonly sentences: readonly SentenceUnderCheck[];
  /** The passages the answer may cite: the read stops up to the reader's. */
  readonly passages: readonly CitablePassage[];
  /** The harness's one repair of an invalid reply; the second draft's check has none. */
  readonly allowRepair: boolean;
  readonly signal: AbortSignal;
}

/**
 * The support check the answering step requires, and fails closed on: a step built without one throws, a check that does not clear an
 * answer shows nothing, and one that throws stores nothing. Tests pass a labelled fixture; the worker passes `makeSupportCheck`.
 */
export type QuickAnswerSupportCheck = (input: SupportCheckInput) => Promise<{
  readonly finding: SupportFinding;
  readonly run: RunEnd;
}>;

/** The sentences of an answer in reading order, each resting on the passages the whole answer cites. */
export function sentencesOf(draft: Pick<QuickAnswerDraft, 'answer' | 'cites'>): readonly SentenceUnderCheck[] {
  return splitSentences(draft.answer).map((text, index) => ({ number: index + 1, text, cites: draft.cites }));
}

/**
 * Reads the harness outcome of a check. Only a `proposed` reply decides. A failure, a refusal, an exhausted budget or an attempt of
 * unknown outcome gives no verdicts: the answer is not shown, and an attempt of unknown outcome is never resent (its run stays open).
 */
export function findingOf(outcome: ProposeOutcome<Parameters<typeof verdictsOf>[0]>): {
  readonly finding: SupportFinding;
  readonly end: RunEnd['end'];
} {
  switch (outcome.kind) {
    case 'proposed': {
      const unsupported = unsupportedOf(verdictsOf(outcome.output));
      return {
        finding: unsupported.length === 0 ? { kind: 'supported' } : { kind: 'unsupported', unsupported },
        end: 'completed',
      };
    }
    case 'invalid_output':
    case 'failed':
      return { finding: { kind: 'unchecked' }, end: 'failed' };
    case 'budget_exhausted':
    case 'quota_unavailable':
      return { finding: { kind: 'unchecked' }, end: 'cancelled' };
    case 'unknown':
    case 'refused':
      return { finding: { kind: 'unchecked' }, end: undefined };
  }
}

/**
 * The checker on the personal reasoning harness. Every attempt has a row in the attempt ledger under the person's own run and counts
 * against the harness's caps; none is made inside a transaction. The run is derived from the answer's ID, one for each draft.
 */
export function makeSupportCheck(harness: RecordingReasoningHarness): QuickAnswerSupportCheck {
  return async (input) => {
    const context = {
      bundleRef: `supply-quick-answer-support:${input.quickAnswerId}:${String(input.draft)}`,
      items: askSupportContext(input.sentences, input.passages),
    };
    // A Quick answer is checked in one request, which bounds its paid attempts (`MAX_PAID_ATTEMPTS`). The writer is told to answer
    // in a few sentences and its draft is refused above one request's worth, so this is a second guard: an answer longer than
    // that is not checked, no run is started, and an unchecked answer is never shown (D-267).
    if (input.sentences.length > ASK_SUPPORT_BATCH_SENTENCES)
      return {
        finding: { kind: 'unchecked' },
        run: {
          runId: input.runId,
          purpose: purposeOf(input.owner, 'quick-answer-support', input.runId, harness.contextDigest(context)),
        },
      };
    const { outcome, purpose } = await proposeAtGeneration(
      harness,
      input.owner,
      {
        run: {
          id: input.runId,
          authority: input.authority,
          ownerModule: 'supply',
          purpose: 'quick-answer-support',
          policyVersion: QUICK_ANSWER_SUPPORT_POLICY_VERSION,
        },
        role: { ...askSupportRole(input.sentences, input.passages), id: QUICK_ANSWER_SUPPORT_ROLE_ID },
        context,
        limits: { allowRepair: input.allowRepair },
      },
      input.signal,
    );
    const { finding, end } = findingOf(outcome);
    return { finding, run: end === undefined ? { runId: input.runId, purpose } : { runId: input.runId, purpose, end } };
  };
}

/**
 * The two items a rewrite adds to the writer's context: the unsupported sentences, each located by its own words with the fixed
 * hint of its kind (never the checker's words), and the draft they refer to.
 */
export function rewriteItems(
  sentences: readonly SentenceUnderCheck[],
  unsupported: readonly UnsupportedVerdict[],
  previous: QuickAnswerDraft,
): readonly ContextItem[] {
  const textOf = new Map(sentences.map((sentence) => [sentence.number, sentence.text]));
  const lines = unsupported.map(
    (verdict) => `Sentence "${textOf.get(verdict.number) ?? ''}": ${UNSUPPORTED_HINTS[verdict.kind]}`,
  );
  return [
    { ref: 'check:problems', kind: 'check_problems', text: lines.join('\n') },
    { ref: 'check:previous-draft', kind: 'previous_draft', text: JSON.stringify(previous) },
  ];
}
