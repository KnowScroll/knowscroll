import { makeCommissionPublication } from '../production/commission-publication.js';
import type { CommissionPublicationPorts } from '../production/commission-publication-ports.js';
import { postgresCommissionPublication } from './postgres-commission-publication.js';
import { makeCommissionMedia } from './cutroom/commission-media.js';

/** Separate from0014's fixed three legacy approvals. This factory cannot receive another
 * world's output: a separately bound cross-world provenance handoff is not implemented. */
export function makeCommissionedReelImporter(
  dependencies: Omit<CommissionPublicationPorts, 'store' | 'media'>,
  settings: {
    readonly origin: string;
    readonly artifactRoot: string;
    readonly mediaRoot: string;
    readonly ffprobePath?: string;
    readonly fixture?: boolean;
  },
) {
  return makeCommissionPublication({
    ...dependencies,
    store: postgresCommissionPublication({ fixture: settings.fixture }),
    media: makeCommissionMedia({ ...settings, enabled: dependencies.enabled }),
  });
}
