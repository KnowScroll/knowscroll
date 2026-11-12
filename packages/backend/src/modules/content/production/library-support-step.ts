import { stableUuid } from '../../../infrastructure/ids/index.js';
import type {
  ProductionAuthority,
  ProductionReasoningHarness,
  WithProductionScope,
} from '../../../reasoning/public.js';
import { batchesOf, type SentenceVerdict } from '../domain/ask-support.js';
import {
  LIBRARY_CHECK_RULES,
  resultsOf,
  type LibrarySentence,
  type LibrarySentenceResult,
} from '../domain/library-support.js';
import { pauseCode, uncheckedCode } from './answer-check-step.js';
import type { SupportPassage } from './ask-support.js';
import {
  LIBRARY_SUPPORT_BATCH_SENTENCES,
  LIBRARY_SUPPORT_CHECK_VERSION,
  LIBRARY_SUPPORT_MAX_BATCHES,
  librarySupportContext,
  librarySupportRole,
  underCheck,
} from './library-support.js';
import type { ClosingRun } from './types.js';

/**
 * The run of the checker for one batch of a revision's check, derived from the revision, the checker's version, the batch and how many times that
 * batch has already failed: a redelivery, and a later round that finds the batch answered, meet the same run and ask the ledger for the answer it
 * already holds instead of paying for the question again. A conclusive failure ends its run for good, so the next try of that batch (and only that
 * batch) is a run of its own, one generation on.
 */
export const librarySupportRunId = (assetId: string, revision: number, batch: number, generation: number): string =>
  stableUuid(
    `content.library-support-check:${assetId}:${String(revision)}:${LIBRARY_SUPPORT_CHECK_VERSION}:${String(batch)}:${String(generation)}`,
  );

export interface LibrarySupportStepDependencies {
  readonly authority: ProductionAuthority;
  readonly withScope: WithProductionScope;
  readonly harness: ProductionReasoningHarness;
}

export interface LibrarySupportInput {
  readonly assetId: string;
  readonly revision: number;
  /** How many times each batch (by index) has failed conclusively in earlier rounds; a batch not named has not. */
  readonly failures: Readonly<Record<number, number>>;
  readonly sentences: readonly LibrarySentence[];
  readonly passages: readonly SupportPassage[];
  readonly signal: AbortSignal;
}

/** What asking the checker about a revision came to. `attemptCounts[batch]` is how many paid attempts the ledger holds for each batch asked. */
export type LibrarySupportOutcome =
  /** The checker answered for every batch: a result for each sentence. The runs are finished. */
  | {
      readonly kind: 'checked';
      readonly results: readonly LibrarySentenceResult[];
      readonly batches: number;
      readonly attemptCounts: readonly number[];
      readonly runs: readonly ClosingRun[];
    }
  /**
   * Nothing usable: `code` says why and never holds provider text. `runs` are the runs to close: not the one of an attempt of
   * `outcome_unknown`, which stays open (it may have reached the provider and is never resent). `batches` is how many the revision needed and
   * `failedBatch` the one that gave nothing.
   */
  | {
      readonly kind: 'unchecked';
      readonly code: string;
      readonly batches: number;
      readonly failedBatch?: number;
      readonly attemptCounts: readonly number[];
      readonly runs: readonly ClosingRun[];
    }
  /** A daily budget or the provider's quota is used up, or the role's failure brake for the day is full: nothing more was sent and the check stays open. */
  | { readonly kind: 'paused'; readonly code: string }
  /** A run was already closed: another delivery finished the check. */
  | { readonly kind: 'advanced' };

/** What asking the checker about one batch came to. */
type BatchOutcome =
  | {
      readonly kind: 'verdicts';
      readonly verdicts: readonly SentenceVerdict[];
      readonly quotes: readonly (readonly [number, string])[];
      readonly repaired: boolean;
    }
  | { readonly kind: 'nothing'; readonly code: string }
  | { readonly kind: 'paused'; readonly code: string }
  | { readonly kind: 'advanced' };

/**
 * The model step of the library support check (D-415): asks the checker about a revision's sentences a batch at a time, one request
 * and one run each, in order. It goes through the production harness, so every request has an attempt in the ledger, counts against
 * the production caps and the background share, and is never resent when its outcome is unknown; it holds no transaction. It returns
 * what happened and decides nothing: the use case stores the result and closes the runs.
 *
 * The first batch with no usable reply makes the whole check unusable, and the later batches are not asked, because nothing is known
 * about a Scroll when part of it was not checked. A batch answered in an earlier round is asked again by the same run and answers from the ledger
 * for nothing, so a later round pays only for the batch that failed and those after it. The harness repairs one unusable reply in the whole
 * check, wherever it happens. A revision of more than `LIBRARY_SUPPORT_MAX_BATCHES` batches is not checked.
 */
export function makeLibrarySupportStep(deps: LibrarySupportStepDependencies) {
  /** How many paid attempts the ledger holds for a run; none when it cannot say. */
  async function attemptsIn(runId: string): Promise<number> {
    const accounted = await deps.withScope(deps.authority, (scope) =>
      deps.harness.readProductionRunAccounting(scope, runId),
    );
    return accounted.kind === 'entered' && accounted.value.kind === 'accounted' ? accounted.value.attempts.length : 0;
  }

  async function askBatch(
    input: LibrarySupportInput,
    batch: readonly LibrarySentence[],
    index: number,
    runId: string,
    generation: number,
    repairAllowed: boolean,
  ): Promise<BatchOutcome> {
    const shown = underCheck(batch);
    const result = await deps.harness.proposeProduction(
      {
        run: {
          id: runId,
          authority: deps.authority,
          ownerModule: 'content',
          purpose: 'library-support-check',
          policyVersion: LIBRARY_SUPPORT_CHECK_VERSION,
        },
        role: librarySupportRole(shown, input.passages),
        context: {
          bundleRef: `scroll:${input.assetId}:${String(input.revision)}:library-support:${String(generation)}:${String(index)}`,
          items: librarySupportContext(shown, input.passages),
        },
        limits: { allowRepair: repairAllowed },
      },
      input.signal,
    );
    if (result.kind === 'refused' && result.reason === 'run_closed') return { kind: 'advanced' };
    // The role's failure brake (five unresolved or failing runs a day) lifts with the day: like a spent budget it says nothing about the revision.
    if (result.kind === 'refused' && result.reason === 'failure_brake')
      return { kind: 'paused', code: 'failure_brake' };
    if (result.kind === 'budget_exhausted' || result.kind === 'quota_unavailable')
      return { kind: 'paused', code: pauseCode(result) };
    if (result.kind !== 'proposed') return { kind: 'nothing', code: uncheckedCode(result) };
    return {
      kind: 'verdicts',
      verdicts: result.output.sentences,
      quotes: result.output.quotes,
      repaired: result.repaired,
    };
  }

  async function check(input: LibrarySupportInput): Promise<LibrarySupportOutcome> {
    const batches = batchesOf(input.sentences, LIBRARY_SUPPORT_BATCH_SENTENCES);
    if (batches.length > LIBRARY_SUPPORT_MAX_BATCHES)
      return { kind: 'unchecked', code: 'revision_too_long', batches: batches.length, attemptCounts: [], runs: [] };
    const verdicts: SentenceVerdict[] = [];
    const quotes = new Map<number, string>();
    const runs: ClosingRun[] = [];
    const attemptCounts: number[] = [];
    let repairAllowed = true;
    for (const [index, batch] of batches.entries()) {
      const generation = input.failures[index] ?? 0;
      const runId = librarySupportRunId(input.assetId, input.revision, index, generation);
      const outcome = await askBatch(input, batch, index, runId, generation, repairAllowed);
      if (outcome.kind === 'advanced' || outcome.kind === 'paused') return outcome;
      attemptCounts.push(await attemptsIn(runId));
      if (outcome.kind === 'nothing') {
        // An attempt of unknown outcome keeps its run open for reconciliation, so the use case never closes it.
        if (outcome.code !== 'outcome_unknown') runs.push({ runId, state: 'failed' });
        return {
          kind: 'unchecked',
          code: outcome.code,
          batches: batches.length,
          failedBatch: index,
          attemptCounts,
          runs,
        };
      }
      runs.push({ runId, state: 'completed' });
      verdicts.push(...outcome.verdicts);
      for (const [number, quote] of outcome.quotes) quotes.set(number, quote);
      repairAllowed = repairAllowed && !outcome.repaired;
    }
    return {
      kind: 'checked',
      results: resultsOf(input.sentences, verdicts, {
        quotes,
        passageTexts: new Map(input.passages.map((passage) => [passage.handle, passage.text])),
        rules: LIBRARY_CHECK_RULES,
      }),
      batches: batches.length,
      attemptCounts,
      runs,
    };
  }

  return { check };
}
