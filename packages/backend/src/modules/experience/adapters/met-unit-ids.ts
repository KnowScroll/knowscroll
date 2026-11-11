import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { ReadMetUnitIds } from '../../composer/public.js';

/** The largest `limit` a read may ask for; a caller asking for more is refused (`MET_UNITS_LIMIT`). */
export const MET_UNIT_IDS_MAX_LIMIT = 5000;

type MetRow = { readonly unitId: string; readonly sortAt: string };

/**
 * The explanation units the person has met, newest first, bounded (policy v2, D-408).
 *
 * Met is the notion `readRoutingHistory` reports as `encountered`: an activated exposure of the unit in either format, in the
 * person's own lineage or in a recording segment with a first eligible activation, at or before now. A Reel and its Scroll twin
 * share one unit, so they are one id. Each source is read newest first by its own person-scoped time index
 * (`lineage_recent_idx`, `recording_routing_recent`), at most `limit + 1` raw rows each; the two merge, the newest activation of
 * each unit wins, and the newest `limit` units are returned. `truncated` says the bound cut the read: a source holds more than
 * `limit` rows, or more than `limit` distinct units were found. Older met units may then be missing, which only means retrieval
 * may order them as unseen; Composer's own `encountered` exclusion still filters the final pick.
 */
export const readMetUnitIds: ReadMetUnitIds = async (scope, query) => {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > MET_UNIT_IDS_MAX_LIMIT)
    throw new Error('MET_UNITS_LIMIT');
  const universeId = scope.authority.universeId;
  const epoch = scope.authority.privacyEpoch;
  const db = transactionOf(scope);
  const raw = query.limit + 1;
  const legacy = await sql<MetRow>`select explanation_unit_id as "unitId",
    to_char(activated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "sortAt"
    from experience.encounter_lineage where universe_id=${universeId}::uuid and privacy_epoch=${epoch} and activated_at<=now()
    order by activated_at desc,exposure_id limit ${raw}`.execute(db);
  const recording = await sql<MetRow>`select explanation_unit_id as "unitId",
    to_char(first_eligible_activation_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "sortAt"
    from experience.recording_segments where universe_id=${universeId}::uuid and privacy_epoch=${epoch}
    and first_eligible_activation_at is not null and first_eligible_activation_at<=now()
    order by first_eligible_activation_at desc,exposure_id,recording_generation limit ${raw}`.execute(db);
  const newest = new Map<string, string>();
  for (const row of [...legacy.rows, ...recording.rows]) {
    const seen = newest.get(row.unitId);
    if (seen === undefined || row.sortAt > seen) newest.set(row.unitId, row.sortAt);
  }
  const ordered = [...newest]
    .sort(([unitA, at1], [unitB, at2]) => (at1 === at2 ? (unitA < unitB ? -1 : 1) : at1 > at2 ? -1 : 1))
    .map(([unitId]) => unitId);
  return {
    unitIds: ordered.slice(0, query.limit),
    truncated: legacy.rows.length > query.limit || recording.rows.length > query.limit || ordered.length > query.limit,
  };
};
