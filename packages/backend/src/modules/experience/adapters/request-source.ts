import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { CheckRequestSource } from '../public.js';
/** No inference from "newest exposure": exact own activated lineage and optional latest session. */
export const checkRequestSource: CheckRequestSource = async (scope, source) => {
  const result = await sql`select 1 from experience.exposures e
    where e.universe_id=${scope.authority.universeId}::uuid and e.id=${source.exposureId}::uuid
      and e.privacy_epoch=${scope.authority.privacyEpoch} and e.activated_at is not null
      and e.asset_id=${source.assetId}::uuid and e.asset_revision=${source.assetRevision}
      and (${!source.session} or exists(select 1 from experience.offer_activations a
        join experience.offers o on o.universe_id=a.universe_id and o.id=a.offer_id
        join experience.sessions s on s.universe_id=o.universe_id and s.id=o.session_id
        where a.universe_id=e.universe_id and a.exposure_id=e.id
          and s.privacy_epoch=e.privacy_epoch and s.id=${source.session?.sessionId ?? null}::uuid
          and s.intent_revision=${source.session?.expectedIntentRevision ?? null}))`.execute(transactionOf(scope));
  return result.rows.length === 1;
};
