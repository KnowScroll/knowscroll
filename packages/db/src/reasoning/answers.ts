/**
 * Authorized Scroll Ask answers (ADR-0033, #132). The entry of the answer path; implementation lives in
 * `answers/`. `requestAskAnswer` is the only way from a recorded Ask to execution; the worker then loads
 * the work, sends it through `invokeReasoningOnce`, and finishes with `applyAskAnswer` or `failAskAnswer`.
 * Provider text changes state only through the answer validator (ask-answer-v2).
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
