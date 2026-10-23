import type { LibraryRecipe } from '../domain/library/plan.js';
import { admitRecipeCoverage } from './admit-recipe-coverage.js';
import type { CoverageHeadPorts } from './coverage-ports.js';
import type { AdmissionTx } from './ports.js';

/** A stored revision of a generated Scroll, found by the asset ID of one library recipe. */
export interface GeneratedRevision {
  readonly assetId: string;
  readonly assetRevision: number;
}

export interface ReadmitPorts {
  readonly coverage: CoverageHeadPorts;
  /** Runs `work` in one short Content admission transaction. */
  readonly inAdmission: <T>(work: (tx: AdmissionTx) => Promise<T>) => Promise<T>;
  /** Every stored revision of every asset whose provenance is `generated`. */
  readonly listGeneratedRevisions: () => Promise<readonly GeneratedRevision[]>;
}

export interface ReadmitSummary {
  readonly dryRun: boolean;
  /** Generated revisions that belong to a recipe of the plan. */
  readonly considered: number;
  /** Revisions that got a new head (or would, in a dry run): first coverage or a corrected one. */
  readonly appended: number;
  readonly unchanged: number;
  /** Revisions left alone, by reason: `no_recipe`, or a `not_admitted` code. */
  readonly skipped: Readonly<Record<string, number>>;
}

/**
 * Decides coverage again for every published generated Scroll revision, from the plan as it is now.
 * Run it after the plan changes (a facet added or reworded) so older Scrolls pick up the new
 * catalogue. Each revision goes through `admitRecipeCoverage` in its own short transaction, so the
 * command is idempotent: an unchanged decision appends nothing and a changed one appends a corrected
 * head after the current one. History is kept. With `dryRun` nothing is written.
 *
 * Authority is the operator's: no personal root, no model, no network. A revision whose asset is
 * not in the plan is skipped, as is one that is withdrawn or has too few body blocks.
 */
export async function readmitRecipeCoverage(
  p: ReadmitPorts,
  recipes: readonly LibraryRecipe[],
  options: { readonly dryRun: boolean },
): Promise<ReadmitSummary> {
  const byAsset = new Map(recipes.map((recipe) => [recipe.assetId, recipe]));
  const coverage: CoverageHeadPorts = options.dryRun ? { ...p.coverage, append: () => Promise.resolve() } : p.coverage;
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  let considered = 0;
  let appended = 0;
  let unchanged = 0;
  for (const revision of await p.listGeneratedRevisions()) {
    const recipe = byAsset.get(revision.assetId);
    if (recipe === undefined) {
      skip('no_recipe');
      continue;
    }
    considered++;
    const outcome = await p.inAdmission((tx) => admitRecipeCoverage(coverage, tx, recipe, revision));
    if (outcome.kind === 'not_admitted') skip(outcome.code);
    else if (outcome.change === 'appended') appended++;
    else unchanged++;
  }
  return { dryRun: options.dryRun, considered, appended, unchanged, skipped };
}
