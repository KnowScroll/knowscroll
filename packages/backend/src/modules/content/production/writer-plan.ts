import type { AuthoredScroll, AuthoredScrollV2 } from '@knowscroll/scroll-model/producer';
import type { ResearchPage } from '../../../infrastructure/research/public-pages.js';
import type { ReasoningRole } from '../../../reasoning/public.js';
import type { CompileOutcome } from '../application/ports.js';
import type { AnswerStage } from './ask-answer-shape.js';
import type { EvidencePassage } from './evidence.js';
import type { ProductionSubject } from './subject.js';
import { storedScrollV2, type ModelProduction } from './stored-v2.js';
import { parseScrollTopic } from './topics.js';
import { publicationV2, WRITER_V2_PROMPT_VERSION, writerRoleV2, type WriterV2Context } from './writer-v2.js';
import { compileGeneratedScroll, generatedProvenance, promptVersionOf, writerRole } from './writer.js';

/**
 * What differs between a v1 and a v2 Scroll in the production job: the role the model is asked, and
 * how an accepted answer is compiled into what admission stores. The job's stages, its attempt
 * ledger, its single repair and its publication are the same for both.
 */
export interface WriterPlan {
  readonly role: ReasoningRole<unknown>;
  /**
   * The role for the revision a support check earns, when its validator differs from the first draft's: the answer to a question
   * may then be shorter than the writer's range, since flagged sentences may have been taken out (D-310). Absent when it does not.
   */
  readonly afterCheckRole?: ReasoningRole<unknown>;
  /** Names the instructions the answer was written to; recorded in the Scroll's provenance. */
  readonly promptVersion: string;
  /**
   * Compiles the harness's accepted answer, with the identities of the attempts that paid for it. `stage` is the length rule an
   * answer to a question is held to; it is the draft's unless the answer is a revision or has had flagged sentences taken out.
   */
  readonly compile: (output: unknown, production: ModelProduction, stage?: AnswerStage) => CompileOutcome;
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

function v1Plan(input: WriterPlanInput): WriterPlan {
  const { subject, passages } = input;
  // The validation identity is fixed before dispatch; the final provenance substitutes the actual attempts.
  const provenance = generatedProvenance({
    identity: subject.identity,
    mode: subject.mode,
    revision: input.revision,
    runId: input.runId,
    attemptIds: [input.runId],
    model: input.model,
    passages,
    pages: input.pages,
  });
  return {
    role: writerRole({ provenance, passages, format: subject.format, mode: subject.mode }),
    ...(subject.mode === 'question'
      ? {
          afterCheckRole: writerRole({
            provenance,
            passages,
            format: subject.format,
            mode: subject.mode,
            stage: 'after_check',
          }),
        }
      : {}),
    promptVersion: promptVersionOf(subject.mode),
    compile: (output, production, stage) =>
      compileGeneratedScroll(
        output as AuthoredScroll,
        {
          ...provenance,
          production: {
            kind: 'model',
            runId: production.runId,
            attemptIds: [...production.attemptIds],
            model: production.model,
            promptVersion: promptVersionOf(subject.mode),
          },
        },
        passages,
        subject.format,
        stage,
      ),
  };
}

function v2Plan(input: WriterPlanInput, plan: NonNullable<ProductionSubject['scrollV2']>): WriterPlan {
  const topic = parseScrollTopic(input.subject.key);
  if (topic === undefined) throw new Error('SCROLL_V2_REQUIRES_LIBRARY_RECIPE');
  const context: WriterV2Context = {
    publication: { ...publicationV2(topic), revision: input.revision },
    recipe: input.subject.stageKit === undefined ? plan : { ...plan, kit: input.subject.stageKit },
    passages: input.passages,
    pages: input.pages,
  };
  return {
    role: writerRoleV2(context),
    promptVersion: WRITER_V2_PROMPT_VERSION,
    compile: (output, production) => storedScrollV2(output as AuthoredScrollV2, context, production),
  };
}

/** The writer plan of a job: the v2 writer for a recipe the library plan marks `scrollV2`, the v1 writer for every other. */
export function writerPlanFor(input: WriterPlanInput): WriterPlan {
  return input.subject.scrollV2 === undefined ? v1Plan(input) : v2Plan(input, input.subject.scrollV2);
}
