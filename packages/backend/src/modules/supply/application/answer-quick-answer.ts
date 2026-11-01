import type { ReasoningHarness } from '../../../reasoning/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { handleOf, type CitablePassage, type QuickAnswerAsk } from '../domain/quick-answer.js';
import { answerAndCheck, type PipelineResult } from './quick-answer-pipeline.js';
import { quickAnswerContext } from './quick-answer-role.js';
import type { QuickAnswerSupportCheck, RunEnd } from './quick-answer-support.js';
import { QUICK_ANSWER_WAIT_LIMIT_MS } from './quick-answers.js';
import type {
  AnswerQuickAnswerUseCase,
  QuickAnswerPorts,
  QuickAnswerRow,
  QuickAnswerSettlement,
} from './quick-answer-ports.js';

/** The harness refuses with this fixed message when a run can no longer be closed legitimately. */
const HARNESS_REFUSAL = 'PERSONAL_REASONING_AUTHORITY_REFUSED';

type Prepared =
  /** Nothing to do: the answer is gone, dismissed or settled, or belongs to another scope. */
  | { readonly kind: 'skip' }
  /**
   * No model is asked and the card closes as unavailable, its words cleared: the Scroll can no longer be read for it
   * (withdrawn or held), or the job came too late (the wait limit or the day is over), so nobody is waiting for it.
   */
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'ready';
      readonly ask: QuickAnswerAsk;
      readonly passages: readonly CitablePassage[];
      readonly title: string;
      /** When the person asked: their wait ends a fixed time after it. */
      readonly createdAt: Date;
    };

/**
 * The step that writes one Quick answer (D-253); the worker's consumer calls it. The Scroll's title, the words the person selected,
 * their question if they typed one, and the passages of the Scroll up to their stop go to the writer, a role on the personal
 * reasoning harness. What it proposes passes code's rules (`quickAnswerRefusals`) and then a support check, a second model
 * that reads each sentence against the passages the answer cites (`quick-answer-support.ts`); only an answer the check cleared is
 * shown, and the card of a question the passages do not cover shows a sentence code owns. It never reads a later stop, never
 * writes evidence and never touches the Universe.
 *
 * `support` is required and the step fails closed: a worker built without one is refused at construction, a check that gave no
 * usable answer shows nothing, and an exception from it stores nothing and leaves the delivery to be retried.
 *
 * Authority: a `system` actor for the person's universe and epoch, rechecked under the personal lock in both transactions. Steps:
 * (1) one transaction reads the still-waiting row and the passages; (2) outside any transaction the harness makes the writer's
 * call, the check, and at most one rewrite and its check, all on runs named from the answer's ID; (3) one transaction closes
 * the runs, rechecks the row is still waiting and inside its wait limit, and settles it. A card dismissed, erased or given up on
 * meanwhile gets nothing stored: the late answer is dropped.
 * Failure/retry: a redelivery answers every step from the ledger and never pays twice, and an attempt of unknown outcome is
 * never resent: the card ends as unavailable and its run stays open for an operator. A job that comes after the wait is over
 * settles the card as unavailable and clears the words, asking no model.
 */
export function makeAnswerQuickAnswer(
  p: QuickAnswerPorts,
  harness: ReasoningHarness,
  support: QuickAnswerSupportCheck,
): AnswerQuickAnswerUseCase {
  if (typeof support !== 'function') throw new Error('QUICK_ANSWER_SUPPORT_CHECK_REQUIRED');

  async function prepare(scope: PersonalScopeTx, row: QuickAnswerRow | undefined): Promise<Prepared> {
    if (!(await p.ownerActive(scope))) return { kind: 'skip' };
    const now = p.now();
    if (row?.state !== 'waiting' || row.passage === undefined) return { kind: 'skip' };
    // A job that arrives after the person's wait is over (a stopped worker, a queue that was behind) settles the card and
    // clears the words now: left waiting they would stay up to a day and hold one of the person's places.
    if (row.expiresAt <= now || now.getTime() - row.createdAt.getTime() > QUICK_ANSWER_WAIT_LIMIT_MS)
      return { kind: 'unavailable' };
    const facts = await p.readFacts(scope, { assetId: row.assetId, assetRevision: row.assetRevision }, row.stopId);
    if (facts === undefined) return { kind: 'unavailable' };
    // The plainer words of the reader's own stop are the Scroll's too (D-085): the reader may have selected inside them.
    const offered = [...facts.passages, { stopId: row.stopId, text: facts.anchorSimple }];
    const passages = offered.map((passage, index): CitablePassage => ({ handle: handleOf(index), ...passage }));
    return {
      kind: 'ready',
      ask: { passage: row.passage, question: row.question },
      passages,
      title: facts.title,
      createdAt: row.createdAt,
    };
  }

  /**
   * Closes one run that ended conclusively; a run whose attempt may have reached the provider (`end` absent) stays open for an
   * operator. The harness takes the person's account gate once in a scope, so a scope closes one run.
   */
  async function closeRun(scope: PersonalScopeTx, run: RunEnd | undefined): Promise<void> {
    if (run?.end === undefined) return;
    try {
      await harness.closeRun(scope, { runId: run.runId, state: run.end });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== HARNESS_REFUSAL) throw error;
    }
  }

  /**
   * Settles the answer if it still waits and is inside its limit, closing the writer's run in the same transaction (the
   * harness's applier rule). True when the person's card changed.
   */
  async function apply(scope: PersonalScopeTx, id: string, result: PipelineResult): Promise<boolean> {
    await closeRun(scope, result.runs[0]);
    if (!(await p.ownerActive(scope))) return false;
    const row = await p.store.read(scope, id);
    const now = p.now();
    if (row?.state !== 'waiting') return false;
    const late = now.getTime() - row.createdAt.getTime() > QUICK_ANSWER_WAIT_LIMIT_MS;
    const settlement: QuickAnswerSettlement =
      result.kind === 'shown' && !late ? { kind: 'answered', ...result.shown } : { kind: 'unavailable' };
    const settled = await p.store.settle(scope, id, settlement, now);
    if (settled) await p.notify(scope, await p.advance(scope), id);
    return settled;
  }

  return async (job, signal) => {
    const authority = {
      universeId: job.universeId,
      privacyEpoch: job.privacyEpoch,
      actor: { kind: 'system', purpose: 'supply.quick-answer' },
    } as const;
    const prepared = await p.withScope(authority, async (scope) =>
      prepare(scope, await p.store.read(scope, job.quickAnswerId)),
    );
    if (prepared.kind !== 'entered' || prepared.value.kind === 'skip') return;
    const { value } = prepared;
    const result: PipelineResult =
      value.kind === 'unavailable'
        ? { kind: 'unavailable', runs: [] }
        : await answerAndCheck(
            { harness, support, idFor: p.idFor, now: p.now },
            {
              authority,
              quickAnswerId: job.quickAnswerId,
              ask: value.ask,
              passages: value.passages,
              context: quickAnswerContext({
                quickAnswerId: job.quickAnswerId,
                title: value.title,
                ask: value.ask,
                passages: value.passages,
              }),
              waitEndsAt: new Date(value.createdAt.getTime() + QUICK_ANSWER_WAIT_LIMIT_MS),
              signal,
            },
          );
    await p.withScope(authority, (scope) => apply(scope, job.quickAnswerId, result));
    // The checks and the rewrite each close in a scope of their own. One that is not closed here (a stop between the two) is
    // closed by the harness's idle sweep: the answer is stored, and a redelivery finds it settled and asks nothing.
    for (const run of result.runs.slice(1)) await p.withScope(authority, (scope) => closeRun(scope, run));
  };
}
