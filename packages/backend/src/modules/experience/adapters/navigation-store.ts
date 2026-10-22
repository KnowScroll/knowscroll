import type { EnsureActivityLineage, ReadActivityReconcilePage } from '../public.js';
import { sql } from 'kysely';
import { EncounterOfferSchema } from '@knowscroll/contracts';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { EncounterAttribution } from '../../content/public.js';
import type { ComposerSession, StoredOffer, NavigationPorts } from '../application/navigation-ports.js';
import { OfferRegionConstraintSchema } from '../application/navigation-ports.js';
import { consumeRegionActivationPermit } from '../application/navigation.js';
import type { ReadActivityLineage, ReadRoutingHistory } from '../public.js';
import { readExposure } from './postgres-store.js';
const own = (scope: PersonalScopeTx) => ({
  u: scope.authority.universeId,
  e: scope.authority.privacyEpoch,
  db: transactionOf(scope),
});
export const readSession: NavigationPorts['readSession'] = async (scope, id) => {
  const { u, e, db } = own(scope);
  const rows = await sql<{
    id: string;
    intent_revision: number;
    capabilities: ComposerSession['capabilities'];
    privacy_epoch: number;
  }>`select id,intent_revision,capabilities,privacy_epoch from experience.sessions where universe_id=${u}::uuid and id=${id}::uuid and privacy_epoch=${e}`.execute(
    db,
  );
  const r = rows.rows[0];
  return r
    ? { id: r.id, intentRevision: r.intent_revision, capabilities: r.capabilities, privacyEpoch: r.privacy_epoch }
    : undefined;
};
export const writeSession: NavigationPorts['writeSession'] = async (scope, s, intent, creates) => {
  const { u, e, db } = own(scope);
  if (creates)
    await sql`insert into experience.sessions(universe_id,id,privacy_epoch,intent_revision,capabilities,intent) values(${u}::uuid,${s.id}::uuid,${e},${s.intentRevision},${JSON.stringify(s.capabilities)}::jsonb,${JSON.stringify(intent)}::jsonb)`.execute(
      db,
    );
  else {
    const changed =
      await sql`update experience.sessions set intent_revision=${s.intentRevision},capabilities=${JSON.stringify(s.capabilities)}::jsonb,intent=${JSON.stringify(intent)}::jsonb where universe_id=${u}::uuid and id=${s.id}::uuid and privacy_epoch=${e} and intent_revision=${s.intentRevision - 1} returning id`.execute(
        db,
      );
    if (!changed.rows.length) throw new Error('SESSION_INTENT_CONFLICT');
  }
};
type OfferRow = {
  policy_version: 'offer.v0';
  id: string;
  session_id: string;
  intent_revision: number;
  privacy_epoch: number;
  descriptor: unknown;
  mode: StoredOffer['mode'];
  source_offer_id: string | null;
  source_exposure_id: string | null;
  continuity_link_id: string | null;
  continuity_link_revision: number | null;
  expires_at: Date | string;
  constraint_payload?: unknown;
};
function offerOf(r: OfferRow): StoredOffer {
  const descriptor = EncounterOfferSchema.parse(r.descriptor);
  const regionConstraint =
    r.constraint_payload === null || r.constraint_payload === undefined
      ? undefined
      : OfferRegionConstraintSchema.parse(r.constraint_payload);
  if (
    regionConstraint &&
    (r.mode !== 'vertical' ||
      descriptor.relation.kind !== 'discovery' ||
      regionConstraint.coverage.assetId !== descriptor.assetId ||
      regionConstraint.coverage.assetRevision !== descriptor.assetRevision)
  )
    throw new Error('REGION_CONSTRAINT_IDENTITY');
  return {
    policyVersion: r.policy_version,
    id: r.id,
    sessionId: r.session_id,
    intentRevision: r.intent_revision,
    privacyEpoch: r.privacy_epoch,
    descriptor,
    ...(regionConstraint ? { regionConstraint } : {}),
    mode: r.mode,
    ...(r.source_offer_id && r.source_exposure_id
      ? { source: { offerId: r.source_offer_id, exposureId: r.source_exposure_id } }
      : {}),
    ...(r.continuity_link_id && r.continuity_link_revision
      ? { link: { linkId: r.continuity_link_id, revision: r.continuity_link_revision } }
      : {}),
    expiresAt: new Date(r.expires_at).toISOString(),
  };
}
export const readOffer: NavigationPorts['readOffer'] = async (scope, id) => {
  const { u, e, db } = own(scope);
  const rows = await sql<OfferRow>`select o.*,r.constraint_payload from experience.offers o
      left join experience.offer_region_constraints r on r.universe_id=o.universe_id and r.privacy_epoch=o.privacy_epoch and r.offer_id=o.id
      where o.universe_id=${u}::uuid and o.id=${id}::uuid and o.privacy_epoch=${e}`.execute(db);
  return rows.rows[0] ? offerOf(rows.rows[0]) : undefined;
};
/** Receipt replay reads only immutable descriptors named by that own receipt, in recorded order. */
export const readOwnedOffers: NavigationPorts['readOwnedOffers'] = async (scope, ids) => {
  if (ids.length > 3 || new Set(ids).size !== ids.length) throw new Error('RECEIPT_OFFER_REFS_INVALID');
  if (!ids.length) return [];
  const { u, e, db } = own(scope);
  const result = await sql<OfferRow>`select o.*,r.constraint_payload from experience.offers o
      left join experience.offer_region_constraints r on r.universe_id=o.universe_id and r.privacy_epoch=o.privacy_epoch and r.offer_id=o.id
      where o.universe_id=${u}::uuid and o.privacy_epoch=${e} and o.id=any(${ids}::uuid[])`.execute(db);
  return ids.flatMap((id) => {
    const row = result.rows.find((r) => r.id === id);
    return row ? [offerOf(row)] : [];
  });
};
export const readMember: NavigationPorts['readMember'] = async (scope, sessionId, offerId, exposureId) => {
  const { u, e, db } = own(scope);
  const rows = await sql<
    OfferRow & { exposure_id: string; activated_at: Date }
  >`select o.*,r.constraint_payload,a.exposure_id,x.activated_at from experience.offers o
  left join experience.offer_region_constraints r on r.universe_id=o.universe_id and r.privacy_epoch=o.privacy_epoch and r.offer_id=o.id
  join experience.offer_activations a on a.universe_id=o.universe_id and a.offer_id=o.id and a.privacy_epoch=o.privacy_epoch join experience.exposures x on x.universe_id=a.universe_id and x.id=a.exposure_id and x.privacy_epoch=a.privacy_epoch where o.universe_id=${u}::uuid and o.privacy_epoch=${e} and o.session_id=${sessionId}::uuid and o.id=${offerId}::uuid and x.activated_at is not null ${exposureId ? sql`and x.id=${exposureId}::uuid` : sql``}`.execute(
    db,
  );
  const r = rows.rows[0];
  return r
    ? { offer: offerOf(r), exposureId: r.exposure_id, activatedAt: new Date(r.activated_at).toISOString() }
    : undefined;
};
export const insertOffers: NavigationPorts['insertOffers'] = async (scope, offers) => {
  if (offers.length > 3) throw new Error('OFFER_LIMIT');
  const { u, e, db } = own(scope);
  for (const o of offers) {
    await sql`insert into experience.offers(universe_id,id,privacy_epoch,session_id,intent_revision,policy_version,decision_id,asset_id,asset_revision,descriptor,source_offer_id,source_exposure_id,mode,continuity_link_id,continuity_link_revision,expires_at) values(${u}::uuid,${o.id}::uuid,${e},${o.sessionId}::uuid,${o.intentRevision},${o.policyVersion},${o.descriptor.decisionId}::uuid,${o.descriptor.assetId}::uuid,${o.descriptor.assetRevision},${JSON.stringify(o.descriptor)}::jsonb,${o.source?.offerId ?? null}::uuid,${o.source?.exposureId ?? null}::uuid,${o.mode},${o.link?.linkId ?? null}::uuid,${o.link?.revision ?? null},${o.expiresAt}::timestamptz)`.execute(
      db,
    );
    if (o.regionConstraint) {
      const constraint = OfferRegionConstraintSchema.parse(o.regionConstraint);
      await sql`insert into experience.offer_region_constraints(universe_id,privacy_epoch,offer_id,asset_id,asset_revision,coverage_head_revision,mapping_sha256,constraint_payload)
        values(${u}::uuid,${e},${o.id}::uuid,${constraint.coverage.assetId}::uuid,${constraint.coverage.assetRevision},${constraint.coverage.headRevision},${constraint.coverage.mappingSha256},${JSON.stringify(constraint)}::jsonb)`.execute(
        db,
      );
    }
  }
};
export const bindOffer: NavigationPorts['bindOffer'] = async (scope, offerId, exposureId, regionPermit) => {
  const { u, e, db } = own(scope);
  if (regionPermit) {
    if (!consumeRegionActivationPermit(scope, offerId, regionPermit))
      throw new Error('REGION_ACTIVATION_PERMIT_INVALID');
    // Transaction-local compatibility marker, never HTTP input or a reusable authorization.
    // Old binaries do not emit it and0037 rejects their fresh regional activation atomically.
    await sql`select set_config('knowscroll.region_activation_v1',${offerId},true)`.execute(db);
  }
  await sql`insert into experience.offer_activations(universe_id,privacy_epoch,offer_id,exposure_id) values(${u}::uuid,${e},${offerId}::uuid,${exposureId}::uuid)`.execute(
    db,
  );
};
export const readHidden: NavigationPorts['readHidden'] = async (scope, ids) => {
  if (ids.length > 100 || new Set(ids).size !== ids.length) throw new Error('HIDE_QUERY_INVALID');
  if (!ids.length) return [];
  const { u, e, db } = own(scope);
  const r = await sql<{
    asset_id: string;
  }>`select asset_id from experience.action_state where universe_id=${u}::uuid and privacy_epoch=${e} and hidden and asset_id=any(${ids}::uuid[])`.execute(
    db,
  );
  return r.rows.map((x) => x.asset_id);
};
export async function recordActivation(
  scope: PersonalScopeTx,
  id: string,
  metadata: EncounterAttribution,
  offer?: StoredOffer,
): Promise<void> {
  const { u, e, db } = own(scope);
  const exposure = await readExposure(scope, id);
  if (!exposure?.activatedAt || exposure.privacyEpoch !== e) throw new Error('ACTIVATION_LINEAGE_INVALID');
  const at = exposure.activatedAt;
  const prior = await sql<{
    activated_at: Date;
  }>`select activated_at from experience.encounter_lineage where universe_id=${u}::uuid and privacy_epoch=${e} and explanation_unit_id=${metadata.explanationUnitId} and exposure_id<>${id}::uuid and activated_at<=${at} order by activated_at desc,exposure_id limit 1`.execute(
    db,
  );
  const returned =
    offer?.mode === 'return' &&
    prior.rows[0] !== undefined &&
    at.getTime() - new Date(prior.rows[0].activated_at).getTime() >= 30 * 60000;
  await sql`insert into experience.encounter_lineage(universe_id,privacy_epoch,exposure_id,asset_id,asset_revision,kind,explanation_unit_id,facets,activated_at) values(${u}::uuid,${e},${id}::uuid,${exposure.assetId}::uuid,${exposure.assetRevision},${exposure.kind},${metadata.explanationUnitId},${metadata.facets}::text[],${at}) on conflict(universe_id,exposure_id) do nothing`.execute(
    db,
  );
  await sql`insert into experience.encounter_activity_inputs(universe_id,privacy_epoch,exposure_id,returned,navigation_revision) values(${u}::uuid,${e},${id}::uuid,${returned},${returned ? 1 : 0}) on conflict(universe_id,exposure_id) do nothing`.execute(
    db,
  );
  if (offer) {
    const horizontal = (offer.mode === 'series' || offer.mode === 'related') && offer.source !== undefined;
    await sql`insert into experience.navigation_transitions(universe_id,privacy_epoch,target_exposure_id,source_exposure_id,offer_id,session_id,mode,horizontal,returned,policy_version) values(${u}::uuid,${e},${id}::uuid,${offer.source?.exposureId ?? null}::uuid,${offer.id}::uuid,${offer.sessionId}::uuid,${offer.mode},${horizontal},${returned},'activity.v0') on conflict(universe_id,target_exposure_id) do nothing`.execute(
      db,
    );
    if (horizontal && offer.source)
      await sql`update experience.encounter_activity_inputs set horizontal=true,navigation_revision=navigation_revision+1 where universe_id=${u}::uuid and privacy_epoch=${e} and exposure_id=${offer.source.exposureId}::uuid and not horizontal`.execute(
        db,
      );
  }
}
export const readActivityLineage: ReadActivityLineage = async (scope, id) => {
  const { u, e, db } = own(scope);
  const rows = await sql<{
    exposure_id: string;
    asset_id: string;
    asset_revision: number;
    kind: 'reel' | 'scroll';
    activated_at: Date;
    explanation_unit_id: string;
    facets: string[];
    liked: boolean;
    saved: boolean;
    horizontal: boolean;
    returned: boolean;
    action_revision: number;
    navigation_revision: number;
  }>`select l.*,i.liked,i.saved,i.horizontal,i.returned,i.action_revision,i.navigation_revision from experience.encounter_lineage l join experience.encounter_activity_inputs i on i.universe_id=l.universe_id and i.exposure_id=l.exposure_id and i.privacy_epoch=l.privacy_epoch join experience.exposures x on x.universe_id=l.universe_id and x.id=l.exposure_id and x.privacy_epoch=l.privacy_epoch and x.activated_at is not null where l.universe_id=${u}::uuid and l.privacy_epoch=${e} and l.exposure_id=${id}::uuid`.execute(
    db,
  );
  const r = rows.rows[0];
  return r
    ? {
        exposureId: r.exposure_id,
        assetId: r.asset_id,
        assetRevision: r.asset_revision,
        kind: r.kind,
        activatedAt: new Date(r.activated_at).toISOString(),
        explanationUnitId: r.explanation_unit_id,
        facets: r.facets,
        liked: r.liked,
        saved: r.saved,
        horizontal: r.horizontal,
        returned: r.returned,
        actionRevision: r.action_revision,
        navigationRevision: r.navigation_revision,
      }
    : undefined;
};
export async function refreshAttribution(
  scope: PersonalScopeTx,
  id: string,
  metadata: EncounterAttribution,
): Promise<void> {
  const { u, e, db } = own(scope);
  await sql`update experience.encounter_lineage set facets=${metadata.facets}::text[] where universe_id=${u}::uuid and privacy_epoch=${e} and exposure_id=${id}::uuid and explanation_unit_id=${metadata.explanationUnitId}`.execute(
    db,
  );
}
export const readRoutingHistory: ReadRoutingHistory = async (scope, q) => {
  const { u, e, db } = own(scope);
  const recent = await sql<{
    exposureId: string;
    activatedAt: Date;
    explanationUnitId: string;
    facets: string[];
  }>`select exposure_id as "exposureId",activated_at as "activatedAt",explanation_unit_id as "explanationUnitId",facets from experience.encounter_lineage where universe_id=${u}::uuid and privacy_epoch=${e} and activated_at<=${q.evaluatedAt}::timestamptz and activated_at>=${q.evaluatedAt}::timestamptz-interval '24 hours' order by activated_at desc,exposure_id limit 20`.execute(
    db,
  );
  const established = await sql<{
    explanationUnitId: string;
    encountered: boolean;
    facets: readonly { facetId: string; encountered: boolean }[];
  }>`select c."explanationUnitId",exists(select 1 from experience.encounter_lineage l where l.universe_id=${u}::uuid and l.privacy_epoch=${e} and l.explanation_unit_id=c."explanationUnitId" and l.activated_at<=${q.evaluatedAt}::timestamptz) as encountered,
  coalesce((select jsonb_agg(jsonb_build_object('facetId',f.value,'encountered',exists(select 1 from experience.encounter_lineage l where l.universe_id=${u}::uuid and l.privacy_epoch=${e} and l.facets@>array[f.value] and l.activated_at<=${q.evaluatedAt}::timestamptz)) order by f.value) from jsonb_array_elements_text(c.facets) f),'[]') as facets
  from jsonb_to_recordset(${JSON.stringify(q.candidates)}::jsonb) c("explanationUnitId" text,facets jsonb)`.execute(db);
  return {
    recent: recent.rows.map((r) => ({ ...r, activatedAt: new Date(r.activatedAt).toISOString() })),
    established: established.rows,
    hiddenAssetIds: await readHidden(scope, q.candidateAssetIds),
  };
};
export const readContextBase: NavigationPorts['readContextBase'] = async (scope, id) => {
  const { u, e, db } = own(scope);
  const r = await sql<{
    asset_id: string;
    asset_revision: number;
    capabilities: ComposerSession['capabilities'];
    session_id: string | null;
    intent_revision: number | null;
    saved: boolean;
    liked: boolean;
    hidden: boolean;
  }>`select x.asset_id,x.asset_revision,x.capabilities,s.id as session_id,s.intent_revision,
 exists(select 1 from experience.saved_items b where b.universe_id=x.universe_id and b.asset_id=x.asset_id) as saved,coalesce(a.liked,false) as liked,coalesce(a.hidden,false) as hidden
 from experience.exposures x left join experience.offer_activations v on v.universe_id=x.universe_id and v.exposure_id=x.id and v.privacy_epoch=x.privacy_epoch left join experience.offers o on o.universe_id=v.universe_id and o.id=v.offer_id left join experience.sessions s on s.universe_id=o.universe_id and s.id=o.session_id and s.privacy_epoch=x.privacy_epoch left join experience.action_state a on a.universe_id=x.universe_id and a.asset_id=x.asset_id and a.privacy_epoch=x.privacy_epoch
 where x.universe_id=${u}::uuid and x.privacy_epoch=${e} and x.id=${id}::uuid and x.activated_at is not null`.execute(
    db,
  );
  const row = r.rows[0];
  return row
    ? {
        ref: { assetId: row.asset_id, assetRevision: row.asset_revision },
        capabilities: row.capabilities,
        ...(row.session_id !== null && row.intent_revision !== null
          ? { session: { sessionId: row.session_id, intentRevision: row.intent_revision } }
          : {}),
        actions: { saved: row.saved, liked: row.liked, hidden: row.hidden },
      }
    : undefined;
};

export const ensureActivityLineage: EnsureActivityLineage = async (scope, id, metadata) => {
  await recordActivation(scope, id, metadata);
  await refreshAttribution(scope, id, metadata);
};
export const readActivityReconcilePage: ReadActivityReconcilePage = async (scope, q) => {
  if (q.limit < 1 || q.limit > 100 || !Number.isSafeInteger(q.limit)) throw new Error('ACTIVITY_RECONCILE_LIMIT');
  const { u, e, db } = own(scope);
  const rows = await sql<{
    id: string;
  }>`select id from experience.exposures where universe_id=${u}::uuid and privacy_epoch=${e} and activated_at is not null ${q.after ? sql`and id>${q.after}::uuid` : sql``} order by id limit ${q.limit}`.execute(
    db,
  );
  return rows.rows.map((r) => r.id);
};
