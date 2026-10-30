import type { CoverageCommand, CoverageRef } from '../domain/coverage.js';
import type { LibraryRecipe } from '../domain/library/plan.js';
import { planRecipeCoverage, type RecipeCoveragePlan } from '../domain/recipe-coverage.js';
import { appendCoverageHead } from './admit-coverage.js';
import type { CoverageHead, CoverageHeadPorts } from './coverage-ports.js';
import type { AdmissionTx } from './ports.js';

export type RecipeCoverageOutcome =
  | { readonly kind: 'admitted'; readonly head: CoverageHead; readonly change: 'appended' | 'unchanged' }
  | {
      readonly kind: 'not_admitted';
      readonly code: 'target_unavailable' | Extract<RecipeCoveragePlan, { kind: 'refused' }>['code'];
    };

type CoverageRecipe = Pick<LibraryRecipe, 'explanationUnitId' | 'topicId' | 'facetId' | 'supportingFacetId'>;

/**
 * Decides and records the coverage of one stored generated Scroll revision from its code-owned
 * recipe. No person or model approves it.
 *
 * Runs inside the caller's admission transaction, so the coverage head commits with the revision it
 * describes or not at all. Takes the Content coverage lock, reads the stored document and provenance,
 * derives the bindings (`planRecipeCoverage`) and appends the next head. Calling it again for the same
 * revision is safe: an identical mapping replays without appending, and a changed one (a catalogue
 * change, say) appends a corrected head after the current one, so history is kept.
 *
 * Returns `not_admitted` when the revision is not an admissible factual Scroll or has too few body
 * blocks to bind. Nothing is written then, and the Scroll stays readable but unmapped.
 */
export async function admitRecipeCoverage(
  p: CoverageHeadPorts,
  tx: AdmissionTx,
  recipe: CoverageRecipe,
  ref: CoverageRef,
): Promise<RecipeCoverageOutcome> {
  const target = await p.lockTarget(tx, ref);
  if (target === undefined) return { kind: 'not_admitted', code: 'target_unavailable' };
  const plan = planRecipeCoverage(recipe, target, p.catalogue);
  if (plan.kind === 'refused') return { kind: 'not_admitted', code: plan.code };
  const previous = await p.readHead(tx, ref);
  if (previous?.status === 'active' && previous.authority.mappingSha256 === p.hash(plan.mapping))
    return { kind: 'admitted', head: previous, change: 'unchanged' };
  const command: CoverageCommand = {
    version: 'content-coverage-command.v1',
    assetId: ref.assetId,
    assetRevision: ref.assetRevision,
    expectedHeadRevision: previous?.authority.headRevision ?? 0,
    semanticReviewReference: `${plan.rule}:${recipe.explanationUnitId}`,
    change: { kind: 'admit', mapping: plan.mapping },
  };
  const head = await appendCoverageHead(p, tx, command, target, previous);
  return { kind: 'admitted', head, change: head === previous ? 'unchanged' : 'appended' };
}
