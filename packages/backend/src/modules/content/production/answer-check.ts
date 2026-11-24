import { z } from 'zod';
import type { AnswerCheckRecord } from '../domain/answer-check.js';

/**
 * The answer check (D-198) asked a second model whether the answer key of each call of a v2 Scroll agrees with the call's own
 * words, and a flag earned the writer one repair. That model step was reachable only from the v2 production job and is deleted with
 * the v2 writer (#815). What stays is what the review gate, the release policy and `production-status` read: the receipts the
 * jobs that ran it recorded ({@link answerChecksOf}), and the empty check a document v3 job records, since a document v3 has no calls.
 */

/** The receipt of the answer check of a document v3: passed, with no verdict and no request, because there is no call to check. */
export function emptyAnswerCheckReceipt(draft: 1 | 2): {
  readonly role: 'answer_check';
  readonly kind: 'checked';
  readonly draft: 1 | 2;
  readonly verdicts: readonly [];
} {
  return { role: 'answer_check', kind: 'checked', draft, verdicts: [] };
}

const RecordedVerdict = z.object({
  id: z.string(),
  consistent: z.boolean(),
  problem: z.string().optional(),
  call: z
    .object({
      prompt: z.string(),
      options: z.array(z.string()),
      answer: z.number().int(),
      explain: z.string(),
    })
    .optional(),
});
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
