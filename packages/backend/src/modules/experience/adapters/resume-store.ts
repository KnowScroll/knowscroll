import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { ResumePorts } from '../application/read-resume.js';

/**
 * The caller's own activated Scroll exposures at their current epoch, newest first. One row per
 * opening, so the same Scroll may appear twice; the use case stops at the first that answers.
 */
export const readRecentExposures: ResumePorts['readRecentExposures'] = async (scope, query) => {
  const since = new Date(Date.now() - query.days * 86_400_000);
  const rows = await transactionOf(scope)
    .selectFrom('experience.exposures')
    .select('id')
    .where('universe_id', '=', scope.authority.universeId)
    .where('privacy_epoch', '=', scope.authority.privacyEpoch)
    .where('kind', '=', 'scroll')
    .where('activated_at', '>=', since)
    .orderBy('activated_at', 'desc')
    .orderBy('id', 'desc')
    .limit(query.limit)
    .execute();
  return rows.map((row) => row.id);
};
