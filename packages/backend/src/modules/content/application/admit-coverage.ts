import {
  CoverageCommandSchema,
  validateCoverageMapping,
  type CoverageCommand,
  type CoverageTarget,
} from '../domain/coverage.js';
import type { AdmissionTx } from './ports.js';
import type { AdmitCoverage, CoverageAdmissionPorts, CoverageHead, CoverageHeadPorts } from './coverage-ports.js';

/**
 * Appends the next coverage head for one exact asset revision, inside an admission transaction the
 * caller holds with the target and current head already read under their locks.
 *
 * Returns the current head unchanged when the identical command was already applied. Refuses a stale
 * expected head, a retraction with nothing to retract, and any mapping that does not match the stored
 * target. Writes one immutable revision and moves the head; history is never rewritten.
 */
export async function appendCoverageHead(
  p: Pick<CoverageHeadPorts, 'hash' | 'catalogue' | 'append'>,
  tx: AdmissionTx,
  command: CoverageCommand,
  target: CoverageTarget | undefined,
  previous: CoverageHead | undefined,
): Promise<CoverageHead> {
  const digest = p.hash(command);
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
}

/**
 * Standalone Content admission of a reviewed command: no personal root, provider, network or
 * inferred semantics. Generated Scrolls do not use this path; their coverage is decided by code at
 * publication (`admitRecipeCoverage`).
 */
export function makeAdmitCoverage(p: CoverageAdmissionPorts): AdmitCoverage {
  return async (input) => {
    const command = CoverageCommandSchema.parse(input);
    if (p.bytes(command) > 32768) throw new Error('CONTENT_COVERAGE_LIMIT');
    if (!p.reviewed(p.hash(command), command.semanticReviewReference))
      throw new Error('CONTENT_COVERAGE_REVIEW_REQUIRED');
    return p.inAdmission(async (tx) => {
      const target = await p.lockTarget(tx, command);
      const previous = await p.readHead(tx, command);
      return appendCoverageHead(p, tx, command, target, previous);
    });
  };
}
