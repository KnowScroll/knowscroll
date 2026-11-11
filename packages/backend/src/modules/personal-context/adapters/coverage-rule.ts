import { canonicalSha256 } from '@knowscroll/scroll-model';
import type { CoverageAuthority, CoverageHead } from '../../content/public.js';
import type { ObservedCoverage } from '../../evidence/public.js';

/**
 * Whether a certificate stored at an earlier head still proves reading on the head that is current now.
 *
 * It holds when the head is active, every field of the certificate's mapping identity equals the head's
 * (document, provenance, explanation unit, framing, reading facts and catalogue version), the certificate's
 * facts digest is the head's reading facts, and every binding the certificate claims is still in the head.
 * A binding pins its facet's meaning and locators, so a reworded or removed facet or a corrected binding
 * still excludes the certificate.
 *
 * The catalogue digest and the head naming (head number, mapping digest) are not compared. The digest
 * changes with every edit of the concept plan, and reads do not compare it (D-033, "Catalogue changes").
 * `content readmit-coverage` then appends a new head whose only change is that digest. Comparing either
 * discarded real reading history although nothing that was read had changed (#674). The asset and revision
 * the certificate names still must be the head's.
 */
export function certificateValidOnHead(c: ObservedCoverage, head: CoverageHead): boolean {
  if (!c.mapping || head.status !== 'active') return false;
  const { authority: issuedOn, catalogueSha256: _issuedCatalogue, ...issued } = c.mapping;
  const { version: _version, bindings, catalogueSha256: _currentCatalogue, ...current } = head.mapping;
  return (
    issuedOn.assetId === head.authority.assetId &&
    issuedOn.assetRevision === head.authority.assetRevision &&
    canonicalSha256(issued) === canonicalSha256(current) &&
    c.factsSha256 === current.readingFactsSha256 &&
    c.bindings.every((b) => bindings.some((x) => canonicalSha256(x) === canonicalSha256(b)))
  );
}
/** Whether two authorities name the same stored head: the one that was locked and the one read again. */
export const sameCoverageAuthority = (a: CoverageAuthority, b: CoverageAuthority) =>
  a.assetId === b.assetId &&
  a.assetRevision === b.assetRevision &&
  a.headRevision === b.headRevision &&
  a.mappingSha256 === b.mappingSha256;
