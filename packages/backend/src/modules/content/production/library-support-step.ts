import { stableUuid } from '../../../infrastructure/ids/index.js';
import type {
  ProductionAttemptAccounting,
  ProductionAuthority,
  ProductionReasoningHarness,
  WithProductionScope,
} from '../../../reasoning/public.js';
import { batchesOf, type SentenceVerdict } from '../domain/ask-support.js';
import { resultsOf, type LibrarySentence, type LibrarySentenceResult } from '../domain/library-support.js';
import { pauseCode, uncheckedCode } from './answer-check-step.js';
import { verdictsOf, type SupportPassage } from './ask-support.js';
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
 * The run of the checker for one batch of one round of a revision's check, derived from the revision and the checker's version: a
 * redelivery of the same job asks the ledger for the answer it already holds instead of paying for the question again. A new round (the
 * revision's check ended on a provider failure and is tried again) is a new run, because a conclusive failure ends its run for good.
 */
export const librarySupportRunId = (assetId: string, revision: number, round: number, batch: number): string =>
  stableUuid(
    `content.library-support-check:${assetId}:${String(revision)}:${LIBRARY_SUPPORT_CHECK_VERSION}:${String(round)}:${String(batch)}`,
  );

export interface LibrarySupportStepDependencies {
  readonly authority: ProductionAuthority;
  readonly withScope: WithProductionScope;
  readonly harness: ProductionReasoningHarness;
}

export interface LibrarySupportInput {
  readonly assetId: string;
  readonly revision: number;
  /** 1 for the first check of the revision; one more for each earlier round that ended on a provider failure. */
  readonly round: number;
  readonly sentences: readonly LibrarySentence[];
  readonly passages: readonly SupportPassage[];
  readonly signal: AbortSignal;
}

/** What asking the checker about a revision came to. */
export type LibrarySupportOutcome =
  /** The checker answered for every batch: a result for each sentence. The runs are finished. */
  | {
      readonly kind: 'checked';
      readonly results: readonly LibrarySentenceResult[];
      readonly batches: number;
      readonly attempts: readonly ProductionAttemptAccounting[];
      readonly runs: readonly ClosingRun[];
    }
  /**
   * Nothing usable: `code` says why and never holds provider text. `runs` are the runs to close: not the one of an attempt of
   * `outcome_unknown`, which stays open (it may have reached the provider and is never resent). `batches` is how many the revision needed.
   */
  | {
      readonly kind: 'unchecked';
      readonly code: string;
      readonly batches: number;
      readonly attempts: readonly ProductionAttemptAccounting[];
      readonly runs: readonly ClosingRun[];
    }
  /** A daily budget or the provider's quota is used up, or the role's failure brake for the day is full: nothing more was sent and the check stays open. */
  | { readonly kind: 'paused'; readonly code: string }
  /** A run was already closed: another delivery finished the check. */
  | { readonly kind: 'advanced' };

/** What asking the checker about one batch came to. */
type BatchOutcome =
  | { readonly kind: 'verdicts'; readonly verdicts: readonly SentenceVerdict[]; readonly repaired: boolean }
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
 * about a Scroll when part of it was not checked. The harness repairs one unusable reply in the whole check, wherever it happens, so a
 * revision costs its batches plus one at most. A revision of more than `LIBRARY_SUPPORT_MAX_BATCHES` batches is not checked.
 */
export function makeLibrarySupportStep(deps: LibrarySupportStepDependencies) {
  /** Every paid attempt of a run with its usage; none when the ledger cannot say. */
  async function attemptsOf(runId: string): Promise<readonly ProductionAttemptAccounting[]> {
    const accounted = await deps.withScope(deps.authority, (scope) =>
      deps.harness.readProductionRunAccounting(scope, runId),
    );
    return accounted.kind === 'entered' && accounted.value.kind === 'accounted' ? accounted.value.attempts : [];
  }

  async function askBatch(
    input: LibrarySupportInput,
    batch: readonly LibrarySentence[],
    index: number,
    repairAllowed: boolean,
  ): Promise<BatchOutcome> {
    const answer = underCheck(input.sentences);
    const result = await deps.harness.proposeProduction(
      {
        run: {
          id: librarySupportRunId(input.assetId, input.revision, input.round, index),
          authority: deps.authority,
          ownerModule: 'content',
          purpose: 'library-support-check',
          policyVersion: LIBRARY_SUPPORT_CHECK_VERSION,
        },
        role: librarySupportRole(underCheck(batch), input.passages, answer),
        context: {
          bundleRef: `scroll:${input.assetId}:${String(input.revision)}:library-support:${String(input.round)}:${String(index)}`,
          items: librarySupportContext(underCheck(batch), input.passages, answer),
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
    return { kind: 'verdicts', verdicts: verdictsOf(result.output), repaired: result.repaired };
  }

  async function check(input: LibrarySupportInput): Promise<LibrarySupportOutcome> {
    const batches = batchesOf(input.sentences, LIBRARY_SUPPORT_BATCH_SENTENCES);
    if (batches.length > LIBRARY_SUPPORT_MAX_BATCHES)
      return { kind: 'unchecked', code: 'revision_too_long', batches: batches.length, attempts: [], runs: [] };
    const verdicts: SentenceVerdict[] = [];
    const runs: ClosingRun[] = [];
    const attempts: ProductionAttemptAccounting[] = [];
    let repairAllowed = true;
    for (const [index, batch] of batches.entries()) {
      const outcome = await askBatch(input, batch, index, repairAllowed);
      if (outcome.kind === 'advanced' || outcome.kind === 'paused') return outcome;
      const runId = librarySupportRunId(input.assetId, input.revision, input.round, index);
      attempts.push(...(await attemptsOf(runId)));
      if (outcome.kind === 'nothing') {
        // An attempt of unknown outcome keeps its run open for reconciliation, so the use case never closes it.
        if (outcome.code !== 'outcome_unknown') runs.push({ runId, state: 'failed' });
        return { kind: 'unchecked', code: outcome.code, batches: batches.length, attempts, runs };
      }
      runs.push({ runId, state: 'completed' });
      verdicts.push(...outcome.verdicts);
      repairAllowed = repairAllowed && !outcome.repaired;
    }
    return {
      kind: 'checked',
      results: resultsOf(input.sentences, verdicts),
      batches: batches.length,
      attempts,
      runs,
    };
  }

  return { check };
}
