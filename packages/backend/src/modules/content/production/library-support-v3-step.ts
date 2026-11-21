import { stableUuid } from '../../../infrastructure/ids/index.js';
import { batchesOf, type SentenceVerdict } from '../domain/ask-support.js';
import { LIBRARY_CHECK_RULES, resultsOf, type LibrarySentence } from '../domain/library-support.js';
import { pauseCode, uncheckedCode } from './answer-check-step.js';
import { LIBRARY_SUPPORT_MAX_BATCHES, librarySupportContext, underCheck } from './library-support.js';
import type {
  LibrarySupportInput,
  LibrarySupportOutcome,
  LibrarySupportStepDependencies,
} from './library-support-step.js';
import {
  LIBRARY_SUPPORT_V3_BATCH_SENTENCES,
  LIBRARY_SUPPORT_V3_CHECK_VERSION,
  librarySupportRoleV3,
} from './library-support-v3.js';
import type { ClosingRun } from './types.js';

/**
 * The model step of the support check of a document v3 Scroll (D-435): `makeLibrarySupportStep` (`library-support-step.ts`) with the v3 checker's
 * version in the run of each batch, the policy of the run and the checker role. It is a copy because the v2 step is one of the modules whose source
 * is the v2 version (`CHECK_SOURCE_MODULES`): an edit to make it take a version would make every stored v2 result stale. The two are kept alike on
 * purpose; the model's task, the batches, the repair and what is stored are the same.
 */

/**
 * The run of the v3 checker for one batch of a revision's check, derived from the revision, the v3 version, the batch and how many times that batch
 * has already failed, so that a redelivery and a later round meet the same run and ask the ledger for the answer it holds. The version is in the id, so
 * it never meets a v2 check's run.
 */
export const librarySupportRunIdV3 = (assetId: string, revision: number, batch: number, generation: number): string =>
  stableUuid(
    `content.library-support-check:${assetId}:${String(revision)}:${LIBRARY_SUPPORT_V3_CHECK_VERSION}:${String(batch)}:${String(generation)}`,
  );

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
 * Asks the v3 checker about a revision's sentences a batch at a time, one request and one run each, in order, through the production harness. Its
 * contract is the v2 step's (`makeLibrarySupportStep`): the first batch with no usable reply makes the check unusable, a batch answered in an
 * earlier round answers from the ledger for nothing, the harness repairs one unusable reply in the whole check, and a revision of more than
 * `LIBRARY_SUPPORT_MAX_BATCHES` batches is not checked. Its batches hold `LIBRARY_SUPPORT_V3_BATCH_SENTENCES` sentences, not the v2 check's ten. It decides nothing: the use case stores the result and closes the runs.
 */
export function makeLibrarySupportStepV3(deps: LibrarySupportStepDependencies) {
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
          policyVersion: LIBRARY_SUPPORT_V3_CHECK_VERSION,
        },
        role: librarySupportRoleV3(shown, input.passages),
        context: {
          // The same shape as the v2 check's, so the tools that read a check's request by its bundle read a v3's; a revision is only ever one of the two.
          bundleRef: `scroll:${input.assetId}:${String(input.revision)}:library-support:${String(generation)}:${String(index)}`,
          items: librarySupportContext(shown, input.passages),
        },
        limits: { allowRepair: repairAllowed },
      },
      input.signal,
    );
    if (result.kind === 'refused' && result.reason === 'run_closed') return { kind: 'advanced' };
    // The role's failure brake lifts with the day: like a spent budget it says nothing about the revision.
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
    const batches = batchesOf(input.sentences, LIBRARY_SUPPORT_V3_BATCH_SENTENCES);
    if (batches.length > LIBRARY_SUPPORT_MAX_BATCHES)
      return { kind: 'unchecked', code: 'revision_too_long', batches: batches.length, attemptCounts: [], runs: [] };
    const verdicts: SentenceVerdict[] = [];
    const quotes = new Map<number, string>();
    const runs: ClosingRun[] = [];
    const attemptCounts: number[] = [];
    let repairAllowed = true;
    for (const [index, batch] of batches.entries()) {
      const generation = input.failures[index] ?? 0;
      const runId = librarySupportRunIdV3(input.assetId, input.revision, index, generation);
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
