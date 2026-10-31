import type { z } from 'zod';
import type {
  ScenarioChoiceAcceptanceSchema,
  ScenarioDraftStartedSchema,
  ScenarioDraftViewSchema,
  ScenarioListSchema,
  ScenarioRemovalAcceptanceSchema,
} from '@knowscroll/contracts';
import type { PersonalAuthority } from '../identity/public.js';
import type { Result } from './application/ports.js';

export type { Result as ScenarioResult, ScenarioRefusal } from './application/ports.js';
export type { SuggestStep } from './application/suggest.js';
export type { WriteAnswerStep } from './application/write-answer.js';
export type { ResolveSummary } from './application/resolve.js';
export {
  ResolveBranchesJobSchema,
  SuggestDraftJobSchema,
  WriteAnswerJobSchema,
  resolveBranchesQueue,
  suggestDraftQueue,
  writeAnswerQueue,
  type ResolveBranchesJob,
  type SuggestDraftJob,
  type WriteAnswerJob,
} from './events.js';

/**
 * What if and Another perspective inside a content thread (blueprint §14, §17; D-049). Every method
 * takes the caller's claimed authority and an unparsed body and re-checks authority itself:
 * membership under the thread's lock, the parent's revision and the budget. Only `choose`
 * commissions anything. Nothing here is consumption evidence for anyone.
 */
export interface ScenarioUseCases {
  draft(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof ScenarioDraftStartedSchema>>>;
  readDraft(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof ScenarioDraftViewSchema>>>;
  choose(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof ScenarioChoiceAcceptanceSchema>>>;
  list(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof ScenarioListSchema>>>;
  remove(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof ScenarioRemovalAcceptanceSchema>>>;
}
export const SCENARIO_USE_CASES = Symbol('scenarios.useCases');

/** The worker's planner step, short-answer step and branch resolver (see `application/suggest.ts`, `write-answer.ts` and `resolve.ts`). */
export const SUGGEST_SCENARIO_DRAFT = Symbol('scenarios.suggestDraft');
export const WRITE_SCENARIO_ANSWER = Symbol('scenarios.writeAnswer');
export const RESOLVE_SCENARIO_BRANCHES = Symbol('scenarios.resolveBranches');
