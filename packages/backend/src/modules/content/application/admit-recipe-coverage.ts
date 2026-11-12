import type { CoverageCatalogue, CoverageCommand, CoverageMapping, CoverageRef } from '../domain/coverage.js';
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
 * revision is safe: an identical decision replays without appending, and a changed one (a facet that
 * means something else now, say) appends a corrected head after the current one, so history is kept. A new
 * catalogue release that changes nothing a binding pins changes only the digest the mapping records, and is not a
 * changed decision: it appends nothing (D-419). Neither is a wording-only revision: a binding decided against an
 * earlier wording the catalogue still accepts stands as it is, so the certificates read against it stay valid.
 *
 * The catalogue is read once and the one release decides everything here, so a release landing while this runs
 * cannot fail the publication it belongs to.
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
  // A Reel's coverage is decided by its own rule (`admitReelCoverage`), never as a Scroll's.
  if (target === undefined || target.format === 'reel') return { kind: 'not_admitted', code: 'target_unavailable' };
  const catalogue = await p.catalogue(tx);
  const plan = planRecipeCoverage(recipe, target, catalogue);
  if (plan.kind === 'refused') return { kind: 'not_admitted', code: plan.code };
  const previous = await p.readHead(tx, ref);
  const decided = (mapping: CoverageMapping) => p.hash({ ...mapping, catalogueSha256: '' });
  if (
    previous?.status === 'active' &&
    decided(previous.mapping) === decided(withStandingMeanings(plan.mapping, previous.mapping, catalogue))
  )
    return { kind: 'admitted', head: previous, change: 'unchanged' };
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

/**
 * The planned mapping with each binding's meaning identity set back to the stored one where the catalogue still
 * accepts it. A binding decided against an earlier wording of the same meaning is the same decision: only the wording
 * changed, and replacing it would give a certificate that quotes the old wording nothing to match on the new head.
 */
export function withStandingMeanings(
  planned: CoverageMapping,
  stored: CoverageMapping,
  catalogue: CoverageCatalogue,
): CoverageMapping {
  return {
    ...planned,
    bindings: planned.bindings.map((binding) => {
      const before = stored.bindings.find((x) => x.topicId === binding.topicId && x.facetId === binding.facetId);
      return before !== undefined && catalogue.acceptsMeaning(binding.topicId, binding.facetId, before.meaningSha256)
        ? { ...binding, meaningSha256: before.meaningSha256 }
        : binding;
    }),
  };
}
