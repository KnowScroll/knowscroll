import { READING_FACTS_V4_VERSION } from '../domain/reading-facts.js';
import type { AdmissionIssue, ImportEditorialScrollPorts, SourceParse } from './ports.js';

/** Whether admission made a new asset, a new revision of one, or found the same revision already there. */
export type ImportOutcome = 'created' | 'revised' | 'unchanged' | 'facts_refreshed';

export type ImportRefusal =
  /** The file is not an editorial Scroll source (wrong envelope). */
  | 'source_invalid'
  /** scroll-model refused the draft at a stage (`stage`, `issues`). */
  | 'compile_refused'
  /** The asset ID already names something that is not a Scroll. */
  | 'asset_is_not_a_scroll'
  /** The asset was withdrawn; admission does not bring it back. */
  | 'asset_withdrawn'
  /** The asset's first revision is held by the review gate (D-138); an editorial import does not pass it. */
  | 'asset_under_review'
  /**
   * A document v3 Scroll would form nothing in the Universe without the coverage of its beats, so none is admitted
   * without it (#759, decision G1): its recipe is unknown, its topic conflicts, or the beat rule cannot bind it. The
   * issue's code says which; nothing is written.
   */
  | 'coverage_missing';

export type ImportEditorialScrollResult =
  | {
      readonly kind: 'imported';
      readonly outcome: ImportOutcome;
      readonly assetId: string;
      readonly revision: number;
      readonly documentSha256: string;
      readonly title: string;
    }
  | {
      readonly kind: 'refused';
      readonly reason: ImportRefusal;
      readonly stage?: string;
      readonly issues: readonly AdmissionIssue[];
    };

/**
 * `importEditorialScroll`: admits an authored editorial Scroll (D-005) into the inventory,
 * idempotently, from its source: `editorial-scroll.v1` (publication facts, the authored v1 draft and
 * its claims) or `editorial-scroll-v3.v1` (a hand-written document v3, its recipe and its passages).
 * The operator command `dist/operator.js content import-editorial --file <path>` is its only caller
 * today. A document v3 is admitted only with its recipe's planet as its topic and its beat coverage
 * (`scroll-recipe-coverage.v3`), in the same transaction, or not at all (`coverage_missing`).
 *
 * Authority: an operator in an allow-listed world (`dev`, `stage`, `ci`, `local`); the command
 *   refuses elsewhere before it reaches this use case. No person's data is read or written:
 *   content is shared, not personal, and has no erasure.
 * Steps (one transaction, serialised per asset): lock the asset; compile the source at the asset's
 *   current revision and compare the integrity hash with the stored revision's: equal means the
 *   same file (or the same compiled result), so only outdated derived facts may be refreshed (`facts_refreshed`; otherwise `unchanged`); otherwise compile
 *   at the next revision number, and store the revision, its internal provenance and the asset's
 *   new current revision together (`created` for the first revision, `revised` after). Compilation
 *   is scroll-model's admission path: staged draft checks, the honesty rules, code-set measures
 *   and the integrity hash, then `admitDocument` on exactly the bytes stored.
 * Side effects: `content.assets`, `content.asset_revisions`, `content.asset_provenance`, and for a
 *   document v3 its topic (`content.encounter_topics`, discovery facets) and coverage head. No job, no
 *   network call, no notice.
 * Failure/retry: any exception rolls everything back and retrying is safe; refusals write nothing
 *   and carry stable codes and paths, never source text.
 * Invariants: a revision is immutable; the same source compiled twice is byte-identical, so a
 *   repeated import is a no-op; a changed source can never rewrite an earlier revision.
 */
/**
 * A refusal found after the revision was written in the admission transaction: thrown so the transaction rolls back,
 * and turned back into the refusal it carries outside it.
 */
class RefusedInAdmission extends Error {
  constructor(readonly result: ImportEditorialScrollResult) {
    super('REFUSED_IN_ADMISSION');
  }
}

export function makeImportEditorialScroll(ports: ImportEditorialScrollPorts) {
  return async function importEditorialScroll(raw: unknown): Promise<ImportEditorialScrollResult> {
    const parsed = ports.parseSource(raw);
    if (parsed.kind === 'invalid') return { kind: 'refused', reason: 'source_invalid', issues: parsed.issues };
    try {
      return await admit(parsed);
    } catch (error) {
      if (error instanceof RefusedInAdmission) return error.result;
      throw error;
    }
  };

  async function admit(parsed: Extract<SourceParse, { kind: 'source' }>): Promise<ImportEditorialScrollResult> {
    return ports.inAdmission(async (tx): Promise<ImportEditorialScrollResult> => {
      const asset = await ports.lockAsset(tx, parsed.assetId);
      if (asset.kind === 'present' && asset.assetKind !== 'scroll')
        return { kind: 'refused', reason: 'asset_is_not_a_scroll', issues: [] };
      if (asset.kind === 'present' && asset.status === 'withdrawn')
        return { kind: 'refused', reason: 'asset_withdrawn', issues: [] };
      if (asset.kind === 'present' && asset.status === 'held')
        return { kind: 'refused', reason: 'asset_under_review', issues: [] };
      const current = asset.kind === 'present' ? asset.revision : 0;
      if (asset.kind === 'present' && asset.documentSha256 !== undefined) {
        const same = ports.compile(parsed.source, current);
        if (same.kind === 'refused')
          return { kind: 'refused', reason: 'compile_refused', stage: same.stage, issues: same.issues };
        if (same.documentSha256 === asset.documentSha256) {
          const refreshed = await ports.refreshReadingFacts(tx, parsed.assetId, current, same.readingFacts);
          return {
            kind: 'imported',
            outcome: refreshed ? 'facts_refreshed' : 'unchanged',
            assetId: parsed.assetId,
            revision: current,
            documentSha256: same.documentSha256,
            title: same.title,
          };
        }
      }
      const next = (asset.kind === 'present' ? asset.latestRevision : 0) + 1;
      const compiled = ports.compile(parsed.source, next);
      if (compiled.kind === 'refused')
        return { kind: 'refused', reason: 'compile_refused', stage: compiled.stage, issues: compiled.issues };
      await ports.storeRevision(tx, {
        assetId: parsed.assetId,
        revision: next,
        provenanceKind: 'authored_editorial',
        compiled,
        createsAsset: asset.kind === 'absent',
      });
      // Facts v4 are a document v3's: it is admitted with its topic and beat coverage, or the whole admission rolls back.
      if (compiled.readingFacts.v === READING_FACTS_V4_VERSION) {
        const recipe = ports.recipeOf(parsed.source);
        const covered =
          recipe === undefined
            ? ({ kind: 'not_admitted', code: 'recipe_unknown' } as const)
            : await ports.admitCoverage(
                tx,
                { assetId: parsed.assetId, revision: next, explanationUnitId: compiled.explanationUnitId },
                recipe,
              );
        if (covered.kind === 'not_admitted')
          throw new RefusedInAdmission({
            kind: 'refused',
            reason: 'coverage_missing',
            issues: [{ code: covered.code, path: 'recipe' }],
          });
      }
      return {
        kind: 'imported',
        outcome: asset.kind === 'absent' ? 'created' : 'revised',
        assetId: parsed.assetId,
        revision: next,
        documentSha256: compiled.documentSha256,
        title: compiled.title,
      };
    });
  }
}

export type ImportEditorialScroll = ReturnType<typeof makeImportEditorialScroll>;
