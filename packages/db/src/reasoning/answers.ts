/**
 * #132 — authorized Scroll Ask answers (ADR-0033), on top of the existing reasoning primitives.
 *
 * `requestAskAnswer` is the only path from a recorded Ask to execution: one explicit request, from
 * the Ask's original live session, creates the direct Job, compiles the sealed Ask context
 * (ADR-0017), creates the Step, derives the exact request bytes and enqueues fairly — in the
 * caller's authenticated transaction. The worker then calls `loadAnswerWork` (rebuilds the bytes
 * and proves the reserved hash), sends them through `invokeReasoningOnce`, and finishes with
 * `applyAskAnswer` or `failAskAnswer`. Provider text changes state only through the answer validator (ask-answer-v2).
 */

export { AskAnswerError } from './answers/shared.ts';
export { askAnswerRequestInput, requestAskAnswer } from './answers/request.ts';
export type { AnswerRequestReceipt } from './answers/request.ts';
export {
  answerFairnessPolicy,
  installAskAnswerRoute,
  resolveAnswerPolicy,
  answerAuthority,
} from './answers/route.ts';
export {
  loadAnswerWork,
  applyAskAnswer,
  failAskAnswer,
} from './answers/worker.ts';
export type {
  AnswerWork,
  AnswerOutcome,
  AnswerFailure,
} from './answers/worker.ts';
export {
  giveBackUnsentAnswer,
  settleAbandonedAnswers,
} from './answers/recovery.ts';
export { readAskAnswer, cancelAskAnswer } from './answers/reader.ts';
export type { AskAnswerView } from './answers/reader.ts';
export { eraseAskAnswers, exportAskAnswers } from './answers/privacy.ts';
