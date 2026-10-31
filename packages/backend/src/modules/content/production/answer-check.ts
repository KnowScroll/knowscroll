import { z } from 'zod';
import { parseDocumentV2, type ScrollDocumentV2 } from '@knowscroll/scroll-model';
import type { ContextItem, ReasoningRole } from '../../../reasoning/public.js';
import type { AnswerCheckRecord, CallVerdict } from '../domain/answer-check.js';

/**
 * The answer check (D-198): a second model role that reads the calls of a Scroll the writer's answer has
 * already passed the validator for, and says for each whether its answer key agrees with the call's own
 * words. The validator cannot see that: a call whose marked answer contradicts its explanation is
 * well-formed. The checker only proposes. Code reads its verdicts and decides what happens (the writer
 * repairs once, the job ends, or the Scroll is held with no verdict); it never edits a Scroll.
 */
export const ANSWER_CHECK_VERSION = 'scroll-answer-check.v1';

/** The role id of the checker. A role of its own, so its failure brake and its budget never touch the writer's. */
export const ANSWER_CHECK_ROLE_ID = 'content.scroll-answer-check';

const MAX_PROBLEM_CHARS = 300;
const MIN_PROBLEM_CHARS = 8;
/** Thinking counts against the ceiling; the answer itself is a few hundred tokens. */
const CHECK_MAX_OUTPUT_TOKENS = 12_000;

/** What the checker is shown about one call: what a reader sees when the call is answered, and the stop before it. */
export interface CallUnderCheck {
  readonly id: string;
  readonly kind: 'call_it' | 'final_call';
  /** The text of the nearest read stop before the call; empty when the call has none before it. */
  readonly stopBefore: string;
  readonly prompt: string;
  readonly options: readonly string[];
  /** Index of the option the answer key marks as correct. */
  readonly answer: number;
  readonly explain: string;
  readonly twist: string;
}

function readText(stop: Extract<ScrollDocumentV2['stops'][number], { kind: 'read' }>): string {
  return stop.blocks.map((block) => block.text).join(' ');
}

/** Every call of a stored v2 document (the Final call included), in reading order. Pure. */
export function callsUnderCheck(document: ScrollDocumentV2): readonly CallUnderCheck[] {
  const calls: CallUnderCheck[] = [];
  let stopBefore = '';
  for (const stop of document.stops) {
    if (stop.kind === 'read') {
      stopBefore = readText(stop);
      continue;
    }
    calls.push({
      id: stop.id,
      kind: stop.kind,
      stopBefore,
      prompt: stop.prompt,
      options: stop.options,
      answer: stop.answer,
      explain: stop.explain,
      twist: stop.twist,
    });
  }
  return calls;
}

/** The calls of a document as stored JSON (`compiled.document`), or none when it does not parse as v2. */
export function callsOfStoredDocument(document: unknown): readonly CallUnderCheck[] {
  const parsed = parseDocumentV2(document);
  return parsed.kind === 'valid' ? callsUnderCheck(parsed.document) : [];
}

const optionLetter = (index: number): string => String.fromCharCode(65 + index);

/** One context item per call: the call as data, with its options lettered and the marked answer named. */
export function answerCheckContext(calls: readonly CallUnderCheck[]): readonly ContextItem[] {
  return calls.map((call) => ({
    ref: `answer-check:${call.id}`,
    kind: 'call_to_check',
    text: JSON.stringify({
      id: call.id,
      stopBefore: call.stopBefore,
      prompt: call.prompt,
      options: call.options.map((option, index) => `${optionLetter(index)}. ${option}`),
      markedAnswer: optionLetter(call.answer),
      explanation: call.explain,
      twist: call.twist,
    }),
  }));
}

/** The checker's instructions. Facts it cannot see (the sources) are not its business; agreement is. */
export const ANSWER_CHECK_INSTRUCTIONS = [
  'You check one thing in a short explainer Scroll: that the answer key of each question agrees with the question’s own words. The context lists the Scroll’s calls, one per item, as data.',
  'Each call gives: "stopBefore" (the text the reader has just read), "prompt" (the question), "options" (lettered), "markedAnswer" (the letter the key says is correct), "explanation" (shown to everyone after they answer) and "twist" (shown only to someone who picked another option).',
  '',
  'A call is consistent when all of these hold:',
  '1. The marked option is the one the explanation says is right.',
  '2. No other option is also right, and the marked option is not plainly false.',
  '3. The twist does not call the marked option wrong, does not call another option right, and does not blame the reader.',
  '4. The stop before does not say anything that contradicts the marked option.',
  '',
  'Flag a call only for a real contradiction or a plainly false key. Never flag wording, style, length, or a fact you cannot judge. Judge each call on its own.',
  'When you flag a call, "problem" says in one or two plain sentences what disagrees with what. Quote the few words involved, and never refer to an option by its letter.',
  '',
  'Reply with one JSON object: {"calls": [{"id": "<the call’s id>", "consistent": true}, {"id": "<the call’s id>", "consistent": false, "problem": "<what disagrees>"}]}.',
  'Give exactly one entry for every call, in the order given. Leave "problem" out when "consistent" is true. Write nothing else.',
].join('\n');

const VerdictShape = z.strictObject({
  id: z.string().min(1).max(40),
  consistent: z.boolean(),
  problem: z.string().min(MIN_PROBLEM_CHARS).max(MAX_PROBLEM_CHARS).optional(),
});

/** The checker's answer: one verdict per call, no more and no fewer, and a problem exactly where a call is flagged. */
export function answerCheckSchema(callIds: readonly string[]) {
  return z.strictObject({ calls: z.array(VerdictShape).min(1).max(callIds.length) }).superRefine((answer, ctx) => {
    const ids = answer.calls.map((verdict) => verdict.id);
    if (ids.length !== callIds.length || ids.some((id, index) => id !== callIds[index]))
      ctx.addIssue({
        code: 'custom',
        path: ['calls'],
        message: 'Checker answer does not name each call once, in order.',
      });
    answer.calls.forEach((verdict, index) => {
      if (verdict.consistent !== (verdict.problem === undefined))
        ctx.addIssue({
          code: 'custom',
          path: ['calls', index, 'problem'],
          message: 'A problem is given exactly when the call is flagged.',
        });
    });
  });
}
export type AnswerCheckAnswer = z.infer<ReturnType<typeof answerCheckSchema>>;

/** The checker role for a document with these calls. Interactive budget class: a production job waits on it. */
export function answerCheckRole(callIds: readonly string[]): ReasoningRole<AnswerCheckAnswer> {
  return {
    id: ANSWER_CHECK_ROLE_ID,
    version: ANSWER_CHECK_VERSION,
    instructions: ANSWER_CHECK_INSTRUCTIONS,
    outputSchema: answerCheckSchema(callIds),
    maxOutputTokens: CHECK_MAX_OUTPUT_TOKENS,
    effort: 'medium',
  };
}

/** The verdicts of an accepted answer, as the job records them. */
export function verdictsOf(answer: AnswerCheckAnswer): readonly CallVerdict[] {
  return answer.calls.map((verdict) => ({
    id: verdict.id,
    consistent: verdict.consistent,
    ...(verdict.problem === undefined ? {} : { problem: verdict.problem }),
  }));
}

/** The record of a check that gave verdicts. */
export function checkedRecord(draft: 1 | 2, verdicts: readonly CallVerdict[]): AnswerCheckRecord {
  return { draft, kind: 'checked', verdicts };
}

/** The record of a check that gave no usable answer; `code` says why and never holds provider text. */
export function uncheckedRecord(draft: 1 | 2, code: string): AnswerCheckRecord {
  return { draft, kind: 'unchecked', code };
}

/** Instructions added to the writer's own when it repairs a draft whose answer key the checker flagged. */
const CHECK_REPAIR_INSTRUCTIONS = [
  'REVISION AFTER AN ANSWER CHECK. A reader of your previous draft would find that some calls disagree with their own answer key. The context has two more items, both data: "check-problems" lists each flagged call by its question and says what disagrees, and "previous-draft" is the complete draft you wrote.',
  'Return the complete corrected Scroll in the same shape. Keep every stop, call, aside and sentence that is not named, exactly as it was. For each flagged call, correct whatever is wrong (the options, the first option that is the correct one, the explanation or the twist), using only what the passages support, so that the question, the correct option, the explanation and the twist agree. All the other rules above still hold.',
].join('\n');

/** The version a check-repair writer is recorded under: the writer's own, marked as a revision. */
function checkRepairVersion(version: string): string {
  return `${version}.fix`.slice(0, 32);
}

/** The writer's role for the one repair a flagged answer key earns. The harness gives it no repair of its own. */
export function checkRepairRole<T>(writer: ReasoningRole<T>): ReasoningRole<T> {
  return {
    ...writer,
    version: checkRepairVersion(writer.version),
    instructions: `${writer.instructions}\n\n${CHECK_REPAIR_INSTRUCTIONS}`,
  };
}

/**
 * The two items the check repair adds to the writer's context: the flagged calls (each located by its
 * question, because the writer's draft has no ids) and the draft they refer to.
 */
export function checkRepairItems(
  calls: readonly CallUnderCheck[],
  flagged: readonly CallVerdict[],
  previousDraft: unknown,
): readonly ContextItem[] {
  const promptOf = new Map(calls.map((call) => [call.id, call.prompt]));
  const lines = flagged.map(
    (verdict) =>
      `Call "${promptOf.get(verdict.id) ?? verdict.id}": ${verdict.problem ?? 'The answer key disagrees with the call.'}`,
  );
  return [
    { ref: 'check:problems', kind: 'check_problems', text: lines.join('\n') },
    { ref: 'check:previous-draft', kind: 'previous_draft', text: JSON.stringify(previousDraft) },
  ];
}

const RecordedVerdict = z.object({ id: z.string(), consistent: z.boolean(), problem: z.string().optional() });
const RecordedCheck = z.object({
  role: z.literal('answer_check'),
  kind: z.enum(['checked', 'unchecked']),
  draft: z.union([z.literal(1), z.literal(2)]),
  verdicts: z.array(RecordedVerdict).optional(),
  code: z.string().optional(),
});

/** The answer checks recorded among a job's outcomes (receipts), in draft order. Tolerant of every other receipt. */
export function answerChecksOf(outcomes: unknown): readonly AnswerCheckRecord[] {
  if (!Array.isArray(outcomes)) return [];
  return outcomes
    .flatMap((receipt) => {
      const parsed = RecordedCheck.safeParse(receipt);
      return parsed.success
        ? [
            {
              draft: parsed.data.draft,
              kind: parsed.data.kind,
              ...(parsed.data.verdicts === undefined ? {} : { verdicts: parsed.data.verdicts }),
              ...(parsed.data.code === undefined ? {} : { code: parsed.data.code }),
            } satisfies AnswerCheckRecord,
          ]
        : [];
    })
    .sort((a, b) => a.draft - b.draft);
}
