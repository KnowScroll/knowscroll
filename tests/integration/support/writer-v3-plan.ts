import { z } from 'zod';
import { compileEditorialSourceV3 } from '../../../packages/backend/src/modules/content/adapters/scroll-compiler-v3.js';
import { WRITER_V3_PROMPT_VERSION } from '../../../packages/backend/src/modules/content/production/writer-v3-version.js';
import type {
  WriterPlan,
  WriterPlanInput,
} from '../../../packages/backend/src/modules/content/production/writer-plan.js';
import { documentV3Source } from './scroll.js';

/** What the labelled fixture model answers with: the plan below ignores it and compiles the hand-written fixture. */
export const V3_FIXTURE_ANSWER = { ci: 'document-v3-fixture' } as const;

/**
 * A test-only writer plan for a recipe planned as document v3. No v3 writer exists yet, so this stands in for it: the role
 * accepts a fixed fixture answer, and `compile` stores scroll-model's hand-written Seasons fixture (labelled, never provider
 * output) under the job's asset, revision and explanation unit, with a `model` production record that names the v3 writer's
 * prompt version, the way the real writer's compile will. Everything after the compile (hold, answer check, publication,
 * lineage, topic attribution and coverage) is the production pipeline as it is.
 */
export function writerV3TestPlan(input: WriterPlanInput): WriterPlan {
  return {
    role: {
      id: 'content.scroll-writer',
      version: WRITER_V3_PROMPT_VERSION,
      instructions: 'CI fixture role for a document v3 recipe. Reply with the fixed fixture answer.',
      outputSchema: z.strictObject({ ci: z.literal(V3_FIXTURE_ANSWER.ci) }),
      maxOutputTokens: 1000,
    },
    promptVersion: WRITER_V3_PROMPT_VERSION,
    prepare: (output) => ({ authored: output, issues: [] }),
    compile: (_output, production) => {
      const compiled = compileEditorialSourceV3(
        {
          ...documentV3Source('seasons'),
          assetId: input.subject.identity.assetId,
          explanationUnitId: input.subject.identity.explanationUnitId,
        },
        input.revision,
      );
      if (compiled.kind !== 'compiled') throw new Error('CI expected the v3 fixture to compile');
      return {
        ...compiled,
        provenance: {
          ...compiled.provenance,
          production: {
            kind: 'model',
            runId: production.runId,
            attemptIds: [...production.attemptIds],
            model: production.model,
            promptVersion: WRITER_V3_PROMPT_VERSION,
          },
        },
      };
    },
  };
}
