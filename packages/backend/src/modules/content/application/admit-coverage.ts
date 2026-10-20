import { CoverageCommandSchema, validateCoverageMapping } from '../domain/coverage.js';
import type { AdmitCoverage, CoverageAdmissionPorts, CoverageHead } from './coverage-ports.js';

/** Standalone Content admission only: no personal root, provider, network or inferred semantics. */
export function makeAdmitCoverage(p: CoverageAdmissionPorts): AdmitCoverage {
  return async (input) => {
    const command = CoverageCommandSchema.parse(input);
    if (p.bytes(command) > 32768) throw new Error('CONTENT_COVERAGE_LIMIT');
    const digest = p.hash(command);
    if (!p.reviewed(digest, command.semanticReviewReference)) throw new Error('CONTENT_COVERAGE_REVIEW_REQUIRED');
    return p.inAdmission(async (tx) => {
      const target = await p.lockTarget(tx, command);
      const previous = await p.readHead(tx, command);
      if (!target && command.change.kind === 'admit') throw new Error('CONTENT_COVERAGE_TARGET_UNAVAILABLE');
      if (previous?.commandSha256 === digest) return previous;
      if ((previous?.authority.headRevision ?? 0) !== command.expectedHeadRevision)
        throw new Error('CONTENT_COVERAGE_HEAD_STALE');
      if (command.change.kind === 'retract' && !previous) throw new Error('CONTENT_COVERAGE_NOT_MAPPED');
      const mapping = command.change.kind === 'admit' ? command.change.mapping : previous!.mapping;
      if (command.change.kind === 'admit') validateCoverageMapping(mapping, target!, p.catalogue);
      const head: CoverageHead = {
        authority: {
          assetId: command.assetId,
          assetRevision: command.assetRevision,
          headRevision: command.expectedHeadRevision + 1,
          mappingSha256: p.hash(mapping),
        },
        status: command.change.kind === 'admit' ? 'active' : 'retracted',
        mapping,
        commandSha256: digest,
        semanticReviewReference: command.semanticReviewReference,
      };
      await p.append(tx, command, head);
      return head;
    });
  };
}
