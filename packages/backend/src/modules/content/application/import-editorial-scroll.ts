import type { AdmissionIssue, ImportEditorialScrollPorts } from './ports.js';

/** Whether admission made a new asset, a new revision of one, or found the same revision already there. */
export type ImportOutcome = 'created' | 'revised' | 'unchanged';

export type ImportRefusal =
  /** The file is not an editorial Scroll source (wrong envelope). */
  | 'source_invalid'
  /** scroll-model refused the draft at a stage (`stage`, `issues`). */
  | 'compile_refused'
  /** The asset ID already names something that is not a Scroll. */
  | 'asset_is_not_a_scroll'
  /** The asset was withdrawn; admission does not bring it back. */
  | 'asset_withdrawn';

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
 * idempotently, from its source (`editorial-scroll.v1`: publication facts, the authored draft and
 * its claims). The operator command `dist/operator.js content import-editorial --file <path>` is
 * its only caller today.
 *
 * Authority: an operator in an allow-listed world (`dev`, `stage`, `ci`, `local`); the command
 *   refuses elsewhere before it reaches this use case. No person's data is read or written:
 *   content is shared, not personal, and has no erasure.
 * Steps (one transaction, serialised per asset): lock the asset; compile the source at the asset's
 *   current revision and compare the integrity hash with the stored revision's: equal means the
 *   same file (or the same compiled result), so nothing is written (`unchanged`); otherwise compile
 *   at the next revision number, and store the revision, its internal provenance and the asset's
 *   new current revision together (`created` for the first revision, `revised` after). Compilation
 *   is scroll-model's admission path: staged draft checks, the honesty rules, code-set measures
 *   and the integrity hash, then `admitDocument` on exactly the bytes stored.
 * Side effects: `content.assets`, `content.asset_revisions`, `content.asset_provenance`. No job, no
 *   network call, no notice.
 * Failure/retry: any exception rolls everything back and retrying is safe; refusals write nothing
 *   and carry stable codes and paths, never source text.
 * Invariants: a revision is immutable; the same source compiled twice is byte-identical, so a
 *   repeated import is a no-op; a changed source can never rewrite an earlier revision.
 */
export function makeImportEditorialScroll(ports: ImportEditorialScrollPorts) {
  return async function importEditorialScroll(raw: unknown): Promise<ImportEditorialScrollResult> {
    const parsed = ports.parseSource(raw);
    if (parsed.kind === 'invalid') return { kind: 'refused', reason: 'source_invalid', issues: parsed.issues };
    return ports.inAdmission(async (tx): Promise<ImportEditorialScrollResult> => {
      const asset = await ports.lockAsset(tx, parsed.assetId);
      if (asset.kind === 'present' && asset.assetKind !== 'scroll')
        return { kind: 'refused', reason: 'asset_is_not_a_scroll', issues: [] };
      if (asset.kind === 'present' && asset.status === 'withdrawn')
        return { kind: 'refused', reason: 'asset_withdrawn', issues: [] };
      const current = asset.kind === 'present' ? asset.revision : 0;
      if (asset.kind === 'present' && asset.documentSha256 !== undefined) {
        const same = ports.compile(parsed.source, current);
        if (same.kind === 'refused')
          return { kind: 'refused', reason: 'compile_refused', stage: same.stage, issues: same.issues };
        if (same.documentSha256 === asset.documentSha256) {
          return {
            kind: 'imported',
            outcome: 'unchanged',
            assetId: parsed.assetId,
            revision: current,
            documentSha256: same.documentSha256,
            title: same.title,
          };
        }
      }
      const next = current + 1;
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
      return {
        kind: 'imported',
        outcome: asset.kind === 'absent' ? 'created' : 'revised',
        assetId: parsed.assetId,
        revision: next,
        documentSha256: compiled.documentSha256,
        title: compiled.title,
      };
    });
  };
}

export type ImportEditorialScroll = ReturnType<typeof makeImportEditorialScroll>;
