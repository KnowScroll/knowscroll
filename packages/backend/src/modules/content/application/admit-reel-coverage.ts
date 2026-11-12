import type { CoverageCommand, CoverageRef } from '../domain/coverage.js';
import type { LibraryRecipe } from '../domain/library/plan.js';
import { planReelCoverage, type ReelCoveragePlan } from '../domain/reel-coverage.js';
import { appendCoverageHead } from './admit-coverage.js';
import { withStandingMeanings } from './admit-recipe-coverage.js';
import type { CoverageHead, CoverageHeadPorts } from './coverage-ports.js';
import type { AdmissionTx } from './ports.js';

export type ReelCoverageOutcome =
  | { readonly kind: 'admitted'; readonly head: CoverageHead; readonly change: 'appended' | 'unchanged' }
  | {
      readonly kind: 'not_admitted';
      readonly code:
        | 'target_unavailable'
        | 'not_a_reel'
        | 'recipe_mismatch'
        | 'retracted'
        | Extract<ReelCoveragePlan, { kind: 'refused' }>['code'];
    };

const withoutDigest = (mapping: CoverageHead['mapping']) => ({ ...mapping, catalogueSha256: '' });

type CoverageRecipe = Pick<LibraryRecipe, 'explanationUnitId' | 'topicId' | 'facetId' | 'supportingFacetId'>;

/**
 * Decides and records the coverage of one stored Reel revision from its code-owned recipe (#674, slice 5.1).
 * No person or model approves it.
 *
 * Runs inside the caller's admission transaction, so the coverage head commits with the Reel it describes or
 * not at all. Takes the Content coverage lock, reads the stored document and provenance, derives the bindings
 * (`planReelCoverage`) and appends the next head. Calling it again for the same revision is safe: an identical
 * mapping replays without appending, and a changed one (a facet that means something else now, say) appends a corrected head after
 * the current one, so history is kept. A new catalogue release that changes nothing a binding pins is not a changed decision (D-419).
 *
 * Returns `not_admitted` when the revision is not a Reel published from an approved script, names a different
 * twin or unit than the recipe, has too few supported segments to bind, or has a head an operator retracted for the
 * same decision (`retracted`). Nothing is written then, and the Reel stays watchable but unmapped.
 */
export async function admitReelCoverage(
  p: CoverageHeadPorts,
  tx: AdmissionTx,
  recipe: CoverageRecipe,
  ref: CoverageRef,
): Promise<ReelCoverageOutcome> {
  const target = await p.lockTarget(tx, ref);
  if (target === undefined) return { kind: 'not_admitted', code: 'target_unavailable' };
  if (target.format !== 'reel') return { kind: 'not_admitted', code: 'not_a_reel' };
  if (target.explanationUnitId !== recipe.explanationUnitId) return { kind: 'not_admitted', code: 'recipe_mismatch' };
  // The catalogue is read once: the one release decides everything here (D-419).
  const catalogue = await p.catalogue(tx);
  const plan = planReelCoverage(recipe, target, catalogue);
  if (plan.kind === 'refused') return { kind: 'not_admitted', code: plan.code };
  const previous = await p.readHead(tx, ref);
  // A new catalogue release alone is not a new decision, and nor is a rewording the catalogue still accepts as the same meaning:
  // only a different reading (another document, script, facet, window or meaning) is.
  const standing =
    previous === undefined ? plan.mapping : withStandingMeanings(plan.mapping, previous.mapping, catalogue);
  const sameDecision = (head: CoverageHead) => p.hash(withoutDigest(head.mapping)) === p.hash(withoutDigest(standing));
  if (previous?.status === 'active' && sameDecision(previous))
    return { kind: 'admitted', head: previous, change: 'unchanged' };
  // A head an operator retracted stays retracted while the decision is what it was; only a different reading appends a head after it.
  if (previous?.status === 'retracted' && sameDecision(previous)) return { kind: 'not_admitted', code: 'retracted' };
  const command: CoverageCommand = {
    version: 'content-coverage-command.v1',
    assetId: ref.assetId,
    assetRevision: ref.assetRevision,
    expectedHeadRevision: previous?.authority.headRevision ?? 0,
    semanticReviewReference: `${plan.rule}:${recipe.explanationUnitId}`,
    change: { kind: 'admit', mapping: plan.mapping },
  };
  const head = await appendCoverageHead(p, tx, command, target, previous, catalogue);
  return { kind: 'admitted', head, change: head === previous ? 'unchanged' : 'appended' };
}
