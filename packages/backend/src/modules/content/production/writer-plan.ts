import type { WrittenScrollV3 } from '@knowscroll/scroll-model/producer';
import type { ResearchPage } from '../../../infrastructure/research/public-pages.js';
import type { ReasoningRole } from '../../../reasoning/public.js';
import type { CompileOutcome } from '../application/ports.js';
import type { EvidencePassage } from './evidence.js';
import type { ProductionSubject } from './subject.js';
import { storedScrollV3, type ModelProduction } from './stored-v3.js';
import { parseProductionRecipe } from './topics.js';
import { WRITER_V3_PROMPT_VERSION } from './writer-v3-version.js';
import { writerContextV3, writerRoleV3One } from './writer-v3.js';

/**
 * What the production job asks of the writer: the role the model is asked, and how an accepted answer is compiled into what
 * admission stores. The job's stages, its attempt ledger, its single repair and its publication do not depend on it.
 */
export interface WriterPlan {
  readonly role: ReasoningRole<unknown>;
  /** Names the instructions the answer was written to; recorded in the Scroll's provenance. */
  readonly promptVersion: string;
  /** Compiles an accepted answer, with the identities of the attempts that paid for it. */
  readonly compile: (output: unknown, production: ModelProduction) => CompileOutcome;
}

/** Everything a plan needs about one job. */
export interface WriterPlanInput {
  readonly subject: ProductionSubject;
  readonly revision: number;
  readonly runId: string;
  readonly model: string;
  readonly passages: readonly EvidencePassage[];
  readonly pages: readonly ResearchPage[];
}

/**
 * The writer plan of a job: the document v3 writer for a recipe the library plan marks `scrollV3`: the whole Scroll in one reply
 * (arm (a), `writerRoleV3One`), compiled into a stored document v3. It is the only writer (the v1 and v2 writers are deleted, #815,
 * #818), so a subject that is not a library recipe, or whose plan is not a document v3 one, is refused before any request.
 */
export function writerPlanFor(input: WriterPlanInput): WriterPlan {
  const plan = input.subject.scrollV3;
  if (plan === undefined) throw new Error('SCROLL_V3_PLAN_REQUIRED');
  if (parseProductionRecipe(input.subject.key) === undefined) throw new Error('SCROLL_V3_REQUIRES_LIBRARY_RECIPE');
  const context = writerContextV3(input.subject.identity, input.revision, plan, input.passages, input.pages);
  return {
    role: writerRoleV3One(context),
    promptVersion: WRITER_V3_PROMPT_VERSION,
    compile: (output, production) => storedScrollV3(output as WrittenScrollV3, context, production),
  };
}
