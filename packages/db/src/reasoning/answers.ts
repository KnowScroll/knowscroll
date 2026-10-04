/**
 * Authorized Scroll Ask answers (ADR-0033, #132). The entry of the answer path; implementation lives in
 * `answers/`. `requestAskAnswer` is the only way from a recorded Ask to execution; the worker then loads
 * the work, sends it through `invokeReasoningOnce`, and finishes with `applyAskAnswer` or `failAskAnswer`.
 * Provider text changes state only through the answer validator (ask-answer-v2).
 */

export { eraseAskAnswers, exportAskAnswers } from './answers/privacy.ts';
export { cancelAskAnswer, readAskAnswer } from './answers/reader.ts';
export {
  giveBackUnsentAnswer,
  settleAbandonedAnswers,
} from './answers/recovery.ts';
export { requestAskAnswer } from './answers/request.ts';
export {
  answerAuthority,
  answerFairnessPolicy,
  installAskAnswerRoute,
  resolveAnswerPolicy,
} from './answers/route.ts';
export type {
  AnswerOutcome,
  AnswerWork,
} from './answers/worker.ts';
export {
  applyAskAnswer,
  failAskAnswer,
  loadAnswerWork,
} from './answers/worker.ts';
