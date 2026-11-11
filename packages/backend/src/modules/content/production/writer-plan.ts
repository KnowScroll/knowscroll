import type { AuthoredScroll, AuthoredScrollV2 } from '@knowscroll/scroll-model/producer';
import type { ResearchPage } from '../../../infrastructure/research/public-pages.js';
import type { ReasoningRole } from '../../../reasoning/public.js';
import type { AdmissionIssue, CompileOutcome } from '../application/ports.js';
import { trimAskAnswer, unchanged, type CodeMadeLines, type TrimCounts } from './ask-answer-trim.js';
import type { EvidencePassage } from './evidence.js';
import type { ProductionSubject } from './subject.js';
import { storedScrollV2, type ModelProduction } from './stored-v2.js';
import { parseProductionRecipe } from './topics.js';
import { publicationV2, WRITER_V2_PROMPT_VERSION, writerRoleV2, type WriterV2Context } from './writer-v2.js';
import { askTrimRules, compileGeneratedScroll, generatedProvenance, promptVersionOf, writerRole } from './writer.js';

/**
 * What differs between a v1 and a v2 Scroll in the production job: the role the model is asked, and
 * how an accepted answer is compiled into what admission stores. The job's stages, its attempt
 * ledger, its single repair and its publication are the same for both.
 */
export interface WriterPlan {
  readonly role: ReasoningRole<unknown>;
  /** Names the instructions the answer was written to; recorded in the Scroll's provenance. */
  readonly promptVersion: string;
  /**
   * For the answer to a question: the title and the dek code writes when the writer's cannot be served, whether copied (the
   * trim) or flagged by the support check (the drop) (D-351). Absent for every other Scroll.
   */
  readonly askLines?: CodeMadeLines;
  /**
   * Takes out of the harness's accepted answer what code can take out before the answer is compiled and checked (D-348): the
   * answer to a question loses its sentences that copy a passage and the ones that lean, and has the limits callout code writes put
   * last in place of any the writer sent (D-371). `counts` says how much, as numbers;
   * `issues` are findings only the writer can put right. Every other Scroll is returned as it is.
   */
  readonly prepare: (output: unknown) => PreparedOutput;
  /** Compiles the answer `prepare` returned, with the identities of the attempts that paid for it. */
  readonly compile: (output: unknown, production: ModelProduction) => CompileOutcome;
}

/** An accepted answer after `WriterPlan.prepare`. */
export interface PreparedOutput {
  readonly authored: unknown;
  readonly counts?: TrimCounts;
  readonly issues: readonly AdmissionIssue[];
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
  const trim = subject.mode === 'question' ? askTrimRules(provenance, subject.readingTitle) : undefined;
  return {
    role: writerRole({ provenance, passages, format: subject.format, mode: subject.mode, ...(trim ? { trim } : {}) }),
    ...(trim ? { askLines: trim.lines } : {}),
    promptVersion: promptVersionOf(subject.mode),
    prepare: (output) =>
      trim === undefined ? unchanged(output as AuthoredScroll) : trimAskAnswer(output as AuthoredScroll, trim),
    compile: (output, production) =>
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
      ),
  };
}

function v2Plan(input: WriterPlanInput, plan: NonNullable<ProductionSubject['scrollV2']>): WriterPlan {
  if (parseProductionRecipe(input.subject.key) === undefined) throw new Error('SCROLL_V2_REQUIRES_LIBRARY_RECIPE');
  const context: WriterV2Context = {
    publication: { ...publicationV2(input.subject.identity), revision: input.revision },
    recipe: input.subject.stageKit === undefined ? plan : { ...plan, kit: input.subject.stageKit },
    passages: input.passages,
    pages: input.pages,
  };
  return {
    role: writerRoleV2(context),
    promptVersion: WRITER_V2_PROMPT_VERSION,
    prepare: (output) => ({ authored: output, issues: [] }),
    compile: (output, production) => storedScrollV2(output as AuthoredScrollV2, context, production),
  };
}

/** The writer plan of a job: the v2 writer for a recipe the library plan marks `scrollV2`, the v1 writer for every other. */
export function writerPlanFor(input: WriterPlanInput): WriterPlan {
  return input.subject.scrollV2 === undefined ? v1Plan(input) : v2Plan(input, input.subject.scrollV2);
}
