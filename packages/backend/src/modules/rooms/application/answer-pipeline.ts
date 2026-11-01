import type {
  PersonalRecordingPurpose,
  ProposeOutcome,
  ReasoningContext,
  ReasoningRole,
} from '../../../reasoning/public.js';
import { unsupportedOf, verdictsOf } from '../../content/public.js';
import {
  ANSWER_MAX_SENTENCES,
  ANSWER_SUPPORT_POLICY,
  type AnswerSupportRecord,
  type CitedPassage,
  type GroundPassage,
} from '../domain/answer-support.js';
import type { ContributionKind } from '../domain/contribution.js';
import {
  figureFlags,
  mergeFlags,
  rewriteItems,
  rewriteRole,
  sentencesOf,
  supportContext,
  supportPassagesOf,
  supportRole,
  type AnswerOrigin,
  type FlaggedSentence,
} from './answer-check.js';
import {
  contributionContext,
  unproposedVerdict,
  type ContributionMaterial,
  type FailedVerdict,
  type InhabitantAnswer,
} from './inhabitant-role.js';

/** How a paid run ended, so the path that owns the harness can close it. Absent: it may have reached the provider, and stays open. */
export type RunEnd = 'completed' | 'failed' | 'cancelled';

/** A paid model run and how it ended. `purpose` is the personal recording proof of an asked turn's run; an unprompted run has none. */
export interface ModelRun {
  readonly runId: string;
  readonly purpose?: PersonalRecordingPurpose;
  readonly end?: RunEnd;
}

/** What the pipeline asks of a path's harness: one proposal on a run, outside any transaction. */
export interface ModelCall<T> {
  /** Which kind of step this is: the writer's draft or rewrite, or the support check of one. */
  readonly step: 'write' | 'check';
  readonly runId: string;
  readonly role: ReasoningRole<T>;
  readonly context: ReasoningContext;
  /** The harness's one repair of an invalid reply. */
  readonly allowRepair: boolean;
}

/**
 * One model call on the harness of the path the turn runs on: a member's ask on the recording-aware personal harness (D-270), a
 * resident speaking on its own on the room scope's (D-162). Every call is on a run of its own and has a row in the attempt
 * ledger, so a redelivery asks the ledger and never pays twice.
 */
export type AnswerModel = <T>(
  call: ModelCall<T>,
  signal: AbortSignal,
) => Promise<{ readonly outcome: ProposeOutcome<T>; readonly run: ModelRun }>;

/** How a harness outcome ends the run it was made on. */
export function endOf(outcome: ProposeOutcome<unknown>): RunEnd | undefined {
  return outcome.kind === 'proposed' ? 'completed' : unproposedVerdict(outcome).end;
}

/** What the turn comes to. `post` and `not_covered` are the only verdicts that put words in a room. */
export type AnswerVerdict =
  /** An answer that passed: its figures are the passages' own and the check found every sentence supported. */
  | {
      readonly kind: 'post';
      readonly answer: { readonly kind: ContributionKind; readonly text: string };
      readonly attemptId: string;
    }
  | { readonly kind: 'nothing_to_add' }
  /** The library does not support an answer. A member who asked is told so in code's words; a resident that spoke on its own stays quiet. */
  | { readonly kind: 'not_covered'; readonly attemptId?: string }
  | FailedVerdict;

export interface PipelineResult {
  readonly verdict: AnswerVerdict;
  /** How the answer came out, for the turn's row; none when the turn failed or the resident had nothing to add. */
  readonly support: AnswerSupportRecord | undefined;
  /** Every paid run, the first writer's first: the caller closes them. */
  readonly runs: readonly ModelRun[];
}

export interface PipelineInput {
  readonly origin: AnswerOrigin;
  readonly turnId: string;
  readonly material: ContributionMaterial;
  /** The passages chosen for this answer; never empty (no passage, no model). */
  readonly ground: readonly GroundPassage[];
  /** The writer's role over the handles of `ground`. */
  readonly writer: ReasoningRole<InhabitantAnswer>;
  /** A UUID derived from a name, so a redelivery names the same runs again. */
  readonly idFor: (name: string) => string;
}

type Drafted =
  | {
      readonly kind: 'draft';
      readonly answer: InhabitantAnswer & { readonly kind: ContributionKind };
      readonly attemptId: string;
    }
  | { readonly kind: 'nothing_to_add' }
  | { readonly kind: 'not_covered'; readonly attemptId: string }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'failed'; readonly verdict: FailedVerdict };

/** What looking at a draft came to. `unchecked` means nothing is known about it: the checker gave no usable reply. */
type Examined =
  | { readonly kind: 'cleared' }
  | { readonly kind: 'flagged'; readonly flagged: readonly FlaggedSentence[] }
  | { readonly kind: 'unchecked' };

const citedOf = (ground: readonly GroundPassage[], handles: readonly string[]): readonly CitedPassage[] =>
  ground
    .filter((passage) => handles.includes(passage.handle))
    .map(({ assetId, assetRevision, blockId }) => ({ assetId, assetRevision, blockId }));

const recordOf = (
  result: AnswerSupportRecord['result'],
  cited: readonly CitedPassage[],
  flagged: readonly number[],
): AnswerSupportRecord => ({ policy: ANSWER_SUPPORT_POLICY, result, cited, flagged });

/**
 * The model steps of one resident's answer, outside any transaction, at most `ANSWER_PAID_ATTEMPTS` paid attempts in all (D-298,
 * D-300): the writer's draft, the support check of it, and, when a sentence is flagged, the one rewrite and the check of that.
 *
 * A draft is posted only when it cleared both code's and the checker's judgement: every figure in a sentence is one a passage it
 * cites writes the same way (D-208, D-299), and the shared support check (D-250) found every sentence supported by the passages
 * the answer cites. A flagged sentence earns one rewrite, told which sentence and what to do by fixed hints, never the checker's
 * words. A draft that is still flagged, a writer that says the passages do not cover the question and a rewrite that has nothing
 * supported left to say all end `not_covered`. A step that failed, was refused or ran out of budget, or a checker that gave no
 * usable reply, ends the turn `failed`: nothing unchecked is ever posted, and an attempt of unknown outcome is never resent.
 */
export async function answerAndCheck(
  model: AnswerModel,
  input: PipelineInput,
  signal: AbortSignal,
): Promise<PipelineResult> {
  const runs: ModelRun[] = [];
  const context = contributionContext(input.material, input.ground);
  const first = await draftOf(
    model,
    { step: 'write', runId: input.turnId, role: input.writer, context, allowRepair: true },
    runs,
    signal,
  );
  if (first.kind !== 'draft') return endedWithout(first, runs, []);

  const firstLook = await examine(model, input, first.answer, 1, true, runs, signal);
  if (firstLook.kind === 'unchecked') return failedClosed(runs);
  if (firstLook.kind === 'cleared') return posted(first, input.ground, 'cleared', [0], runs);

  const sentences = sentencesOf(first.answer);
  const rewriteContext: ReasoningContext = {
    ...context,
    items: [...context.items, ...rewriteItems(sentences, firstLook.flagged, first.answer)],
  };
  const second = await draftOf(
    model,
    {
      step: 'write',
      runId: input.idFor(`rooms-answer:${input.turnId}:rewrite`),
      role: rewriteRole(input.writer),
      context: rewriteContext,
      allowRepair: false,
    },
    runs,
    signal,
  );
  const flaggedFirst = firstLook.flagged.length;
  // A rewrite that is no usable answer, or that says nothing supported is left, leaves the library without an answer.
  if (second.kind === 'nothing_to_add' || second.kind === 'invalid')
    return notCovered(runs, [flaggedFirst], first.attemptId);
  if (second.kind !== 'draft') return endedWithout(second, runs, [flaggedFirst]);

  const secondLook = await examine(model, input, second.answer, 2, false, runs, signal);
  if (secondLook.kind === 'unchecked') return failedClosed(runs);
  if (secondLook.kind === 'flagged')
    return notCovered(runs, [flaggedFirst, secondLook.flagged.length], second.attemptId);
  return posted(second, input.ground, 'cleared_after_rewrite', [flaggedFirst, 0], runs);
}

/** One writer call, and what the reply is. A reply the schema refused twice (`invalid`) is not a failure of the provider. */
async function draftOf(
  model: AnswerModel,
  call: ModelCall<InhabitantAnswer>,
  runs: ModelRun[],
  signal: AbortSignal,
): Promise<Drafted> {
  const { outcome, run } = await model(call, signal);
  runs.push(run);
  if (outcome.kind === 'invalid_output') return { kind: 'invalid' };
  if (outcome.kind !== 'proposed') return { kind: 'failed', verdict: unproposedVerdict(outcome) };
  const { kind, text, cites } = outcome.output;
  if (kind === 'nothing_to_add') return { kind: 'nothing_to_add' };
  if (kind === 'not_covered') return { kind: 'not_covered', attemptId: outcome.attemptId };
  return { kind: 'draft', answer: { kind, text: text.trim(), cites }, attemptId: outcome.attemptId };
}

/**
 * Looks at one draft: the figure rule (code) and the support check (a model, one request, since an answer has at most ten
 * sentences). A draft code already flagged is not sent to the checker when no rewrite could follow, because it cannot clear. An
 * unusable reply from the checker leaves a draft code flagged flagged, and any other draft unchecked.
 */
async function examine(
  model: AnswerModel,
  input: PipelineInput,
  draft: InhabitantAnswer,
  number: 1 | 2,
  allowRepair: boolean,
  runs: ModelRun[],
  signal: AbortSignal,
): Promise<Examined> {
  const sentences = sentencesOf(draft);
  const passages = supportPassagesOf(input.ground);
  const byCode = figureFlags(sentences, passages);
  const unfit = sentences.length === 0 || sentences.length > ANSWER_MAX_SENTENCES;
  if (unfit) return { kind: 'unchecked' };
  if (byCode.length > 0 && number === 2) return { kind: 'flagged', flagged: byCode };
  const { outcome, run } = await model<CheckReply>(
    {
      step: 'check',
      runId: input.idFor(`rooms-answer:${input.turnId}:check:${String(number)}`),
      role: supportRole(input.origin, sentences, passages),
      context: supportContext(input.turnId, number, sentences, passages),
      allowRepair,
    },
    signal,
  );
  runs.push(run);
  if (outcome.kind !== 'proposed')
    return byCode.length > 0 ? { kind: 'flagged', flagged: byCode } : { kind: 'unchecked' };
  const flagged = mergeFlags(byCode, unsupportedOf(verdictsOf(outcome.output)));
  return flagged.length === 0 ? { kind: 'cleared' } : { kind: 'flagged', flagged };
}

type CheckReply = Parameters<typeof verdictsOf>[0];

function posted(
  drafted: Extract<Drafted, { kind: 'draft' }>,
  ground: readonly GroundPassage[],
  result: 'cleared' | 'cleared_after_rewrite',
  flagged: readonly number[],
  runs: readonly ModelRun[],
): PipelineResult {
  return {
    verdict: {
      kind: 'post',
      answer: { kind: drafted.answer.kind, text: drafted.answer.text },
      attemptId: drafted.attemptId,
    },
    support: recordOf(result, citedOf(ground, drafted.answer.cites), flagged),
    runs,
  };
}

const notCovered = (runs: readonly ModelRun[], flagged: readonly number[], attemptId: string): PipelineResult => ({
  verdict: { kind: 'not_covered', attemptId },
  support: recordOf('not_covered', [], flagged),
  runs,
});

/** A turn that fails closed because a step could not say whether the draft is supported: nothing is posted, the call was made. */
const failedClosed = (runs: readonly ModelRun[]): PipelineResult => ({
  verdict: { kind: 'failed', dispatched: true },
  support: undefined,
  runs,
});

/** The pipeline ends before a draft is looked at (or after a rewrite that is not a draft): the writer's own verdict is the turn's. */
function endedWithout(
  drafted: Exclude<Drafted, { kind: 'draft' }>,
  runs: readonly ModelRun[],
  flagged: readonly number[],
): PipelineResult {
  switch (drafted.kind) {
    case 'nothing_to_add':
      return { verdict: { kind: 'nothing_to_add' }, support: undefined, runs };
    case 'not_covered':
      return notCovered(runs, flagged, drafted.attemptId);
    case 'invalid':
      return { verdict: { kind: 'failed', dispatched: true, end: 'failed' }, support: undefined, runs };
    case 'failed':
      return { verdict: drafted.verdict, support: undefined, runs };
  }
}
