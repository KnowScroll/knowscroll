import type { ReasoningContext, ReasoningHarness } from '../../../reasoning/public.js';
import type { PersonalAuthority } from '../../identity/public.js';
import { shownOf, type CitablePassage, type QuickAnswerAsk, type ShownAnswer } from '../domain/quick-answer.js';
import {
  QUICK_ANSWER_POLICY_VERSION,
  quickAnswerRewriteRole,
  quickAnswerRole,
  quickAnswerVerdict,
  type QuickAnswerVerdict,
} from './quick-answer-role.js';
import { rewriteItems, sentencesOf, type QuickAnswerSupportCheck, type RunEnd } from './quick-answer-support.js';

/** What the model steps of one Quick answer came to, and the runs to close in the transaction that stores it. */
export type PipelineResult =
  /** An answer a check cleared, or one that says the passages do not cover the question (no model text in it). */
  | { readonly kind: 'shown'; readonly shown: ShownAnswer; readonly runs: readonly RunEnd[] }
  /** Nothing is shown: a step failed, or the check did not clear the answer. */
  | { readonly kind: 'unavailable'; readonly runs: readonly RunEnd[] };

export interface PipelineDeps {
  readonly harness: ReasoningHarness;
  readonly support: QuickAnswerSupportCheck;
  /** A UUID derived from a name, so a redelivery names the same runs again. */
  readonly idFor: (name: string) => string;
  readonly now: () => Date;
}

export interface PipelineInput {
  readonly authority: PersonalAuthority;
  readonly quickAnswerId: string;
  readonly ask: QuickAnswerAsk;
  readonly passages: readonly CitablePassage[];
  readonly context: ReasoningContext;
  /** The instant after which nobody is waiting: an answer that comes later is dropped, so no paid step starts after it. */
  readonly waitEndsAt: Date;
  readonly signal: AbortSignal;
}

/**
 * The model steps of one Quick answer, outside any transaction, at most `MAX_PAID_ATTEMPTS` paid attempts in all:
 * the writer (its run is the answer's ID), the support check of its answer, and, when a sentence is not supported, the one rewrite
 * and the check of it. An answer that says the passages do not cover the question is not checked: none of its words is shown.
 * An answer is shown only when a check answered and found nothing unsupported; a check that gave nothing usable, or a second
 * finding of unsupported sentences, shows nothing. Every run is named from the answer's ID, so a redelivery asks the ledger for
 * the replies it already holds and never pays twice. No paid step starts after the person's wait is over (`waitEndsAt`): the answer
 * would be dropped when it arrived, so the answer is unavailable and the steps already paid are closed.
 */
export async function answerAndCheck(deps: PipelineDeps, input: PipelineInput): Promise<PipelineResult> {
  const written = await write(
    deps,
    input,
    quickAnswerRole(input.passages, input.ask),
    input.quickAnswerId,
    input.context,
    true,
  );
  if (written.verdict.kind !== 'ready') return { kind: 'unavailable', runs: [written.run] };
  const draft = written.verdict.draft;
  if (!draft.covered) return { kind: 'shown', shown: shownOf(draft, input.ask), runs: [written.run] };

  if (isLate(deps, input)) return { kind: 'unavailable', runs: [written.run] };
  const sentences = sentencesOf(draft);
  const first = await check(deps, input, 1, sentences, true);
  if (first.finding.kind === 'supported')
    return { kind: 'shown', shown: shownOf(draft, input.ask), runs: [written.run, first.run] };
  if (first.finding.kind === 'unchecked' || isLate(deps, input))
    return { kind: 'unavailable', runs: [written.run, first.run] };

  const context: ReasoningContext = {
    ...input.context,
    items: [...input.context.items, ...rewriteItems(sentences, first.finding.unsupported, draft)],
  };
  const rewritten = await write(
    deps,
    input,
    quickAnswerRewriteRole(quickAnswerRole(input.passages, input.ask)),
    deps.idFor(`supply.quick-answer:${input.quickAnswerId}:rewrite`),
    context,
    false,
  );
  const runs = [written.run, first.run, rewritten.run];
  if (rewritten.verdict.kind !== 'ready') return { kind: 'unavailable', runs };
  const second = rewritten.verdict.draft;
  if (!second.covered) return { kind: 'shown', shown: shownOf(second, input.ask), runs };
  if (isLate(deps, input)) return { kind: 'unavailable', runs };
  const last = await check(deps, input, 2, sentencesOf(second), false);
  return last.finding.kind === 'supported'
    ? { kind: 'shown', shown: shownOf(second, input.ask), runs: [...runs, last.run] }
    : { kind: 'unavailable', runs: [...runs, last.run] };
}

/** Whether the person's wait is over, so that a paid step would be for an answer nobody will see. */
const isLate = (deps: PipelineDeps, input: PipelineInput): boolean => deps.now() > input.waitEndsAt;

async function write(
  deps: PipelineDeps,
  input: PipelineInput,
  role: ReturnType<typeof quickAnswerRole>,
  runId: string,
  context: ReasoningContext,
  allowRepair: boolean,
): Promise<{ readonly verdict: QuickAnswerVerdict; readonly run: RunEnd }> {
  const outcome = await deps.harness.propose(
    {
      run: {
        id: runId,
        authority: input.authority,
        ownerModule: 'supply',
        purpose: 'quick-answer',
        policyVersion: QUICK_ANSWER_POLICY_VERSION,
      },
      role,
      context,
      limits: { allowRepair },
    },
    input.signal,
  );
  const verdict = quickAnswerVerdict(outcome);
  return { verdict, run: verdict.end === undefined ? { runId } : { runId, end: verdict.end } };
}

function check(
  deps: PipelineDeps,
  input: PipelineInput,
  draft: 1 | 2,
  sentences: ReturnType<typeof sentencesOf>,
  allowRepair: boolean,
) {
  // Each sentence is judged against the passages the answer cites, as for an ask order's answer: the checker is shown those, so
  // a sentence that rests on a passage the answer does not cite is not supported, and the rewrite is where it gets the citation.
  return deps.support({
    authority: input.authority,
    quickAnswerId: input.quickAnswerId,
    runId: deps.idFor(`supply.quick-answer:${input.quickAnswerId}:check:${String(draft)}`),
    draft,
    sentences,
    passages: input.passages,
    allowRepair,
    signal: input.signal,
  });
}
