import type { PersonalAuthority } from '../../identity/public.js';
import type { EvidenceDiagnostics, ReadEvidenceDiagnosticsPorts } from './ports.js';

export type ReadEvidenceDiagnosticsResult =
  | { readonly kind: 'read'; readonly diagnostics: EvidenceDiagnostics }
  | { readonly kind: 'refused'; readonly reason: 'universe_unavailable' | 'epoch_changed' };

/**
 * `readEvidenceDiagnostics`: the committed evidence of one exposure for the **dev-only** diagnostics
 * view (`GET /v1/diagnostics/exposures/{id}/evidence`): the intake watermark (observations stored),
 * the latest evidence revision (qualification, q, coverage, dwell, policy version, the input
 * watermark it was computed from) and the universe revision it was read at. An operator surface:
 * the API serves it only in worlds that have operator tools and never in consumer UI.
 *
 * Authority: the caller's account and universe at a privacy epoch, rechecked without a lock (a read
 *   never waits behind commands). Only the caller's own exposure data can be read: every statement is
 *   keyed by the authority's universe.
 * Steps: one authority check and two bounded reads. Nothing is written.
 * Failure/retry: reads are safe to repeat; the view refetches when a hint arrives above the revision
 *   it holds, and on reconnect, so a lost hint costs nothing.
 */
export function makeReadEvidenceDiagnostics(ports: ReadEvidenceDiagnosticsPorts) {
  return function readEvidenceDiagnostics(
    authority: PersonalAuthority,
    exposureId: string,
  ): Promise<ReadEvidenceDiagnosticsResult> {
    return ports.readDiagnostics(authority, exposureId);
  };
}

export type ReadEvidenceDiagnostics = ReturnType<typeof makeReadEvidenceDiagnostics>;
