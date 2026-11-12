import { z } from 'zod';
import { sql } from 'kysely';
import { ClientCapabilities } from '@knowscroll/contracts';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import {
  validateUnseenFirst,
  type ReadRegionEncounterCandidates,
  type LockRegionEncounterCandidates,
  type RegionEncounterQuery,
  type RegionEncounterCandidate,
} from '../public.js';
import type { CatalogueSnapshot } from '../domain/catalogue/snapshot.js';
import { CoverageAuthoritySchema, CoverageRefSchema } from '../domain/coverage.js';
import { readExactEncounter } from './discovery-store.js';
import { lockCurrentEncounters } from './current-encounters.js';
import { readCatalogueIn } from './catalogue-store.js';
import {
  coverageCatalogueOf,
  lockCurrentCoverageAuthorities,
  makeReadAdmittedCoverageMapping,
} from './coverage-store.js';

const Query = z.strictObject({
  topicId: z.string().min(1).max(160),
  facetId: z.string().min(1).max(160),
  truthStatus: z.literal('factual'),
  capabilities: ClientCapabilities,
  expected: CoverageRefSchema.optional(),
});
const SCROLL_SCHEMAS = ['scroll-document.v1', 'scroll-document.v2'];
const supported = (
  q: RegionEncounterQuery & { readonly capabilities: z.infer<typeof ClientCapabilities> },
  catalogue: CatalogueSnapshot,
) =>
  catalogue.meaning(q.topicId, q.facetId) !== undefined &&
  SCROLL_SCHEMAS.some((schema) => q.capabilities.documentSchemas.includes(schema));

/**
 * Whether `reel` is the current admitted Reel twin of the exact covering Scroll revision: the same explanation unit, the
 * Reel's current revision, the other format (#709, D-404). Coverage stays a Scroll fact; a twin only borrows it.
 */
async function isReelTwin(
  scope: Parameters<ReadRegionEncounterCandidates>[0],
  reel: { readonly assetId: string; readonly assetRevision: number },
  scroll: { readonly assetId: string; readonly assetRevision: number },
): Promise<boolean> {
  const row = (
    await sql<{ ok: number }>`select 1 as ok
    from content.asset_revisions covered
    join content.assets covered_asset on covered_asset.id=covered.asset_id and covered_asset.kind='scroll'
    join content.asset_revisions twin on twin.explanation_unit_id=covered.explanation_unit_id
    join content.assets twin_asset on twin_asset.id=twin.asset_id and twin_asset.kind='reel'
      and twin_asset.status='admitted' and twin_asset.revision=twin.revision
    where covered.asset_id=${scroll.assetId}::uuid and covered.revision=${scroll.assetRevision}
      and twin.asset_id=${reel.assetId}::uuid and twin.revision=${reel.assetRevision}
    limit 1`.execute(transactionOf(scope))
  ).rows[0];
  return row !== undefined;
}

/** Derived keys find canonical matches beyond unrelated inventory. The101st key is never
 * hydrated, classified as eligible, or interpreted as catalogue exhaustion. Each covering Scroll is followed by its
 * current Reel twin, when it has one the client can play, under the same coverage (#709, D-404). An expected Reel is
 * found through the Scroll it is the twin of. */
export const readRegionEncounterCandidates: ReadRegionEncounterCandidates = async (scope, input) => {
  const { unseenFirst, ...rest } = input;
  const q = Query.parse(rest);
  const tx = transactionOf(scope);
  // One release for the whole read: the facet exists in it and every mapping is read against it.
  const catalogue = await readCatalogueIn(tx);
  if (!supported(q, catalogue)) return { kind: 'unsupported' };
  const readMapping = makeReadAdmittedCoverageMapping(() => Promise.resolve(coverageCatalogueOf(catalogue)));
  const expected = q.expected
    ? sql`and ((b.asset_id=${q.expected.assetId}::uuid and b.asset_revision=${q.expected.assetRevision})
        or exists(select 1 from content.asset_revisions covered
          join content.asset_revisions twin on twin.explanation_unit_id=covered.explanation_unit_id
          join content.assets twin_asset on twin_asset.id=twin.asset_id and twin_asset.kind='reel'
            and twin_asset.status='admitted' and twin_asset.revision=twin.revision
          where covered.asset_id=b.asset_id and covered.revision=b.asset_revision
            and twin.asset_id=${q.expected.assetId}::uuid and twin.revision=${q.expected.assetRevision}))`
    : sql``;
  // The place's bindings with the explanations the person has not met first, when asked; otherwise by asset id as always.
  const unseenFirstOrder = unseenFirst
    ? sql`case when r.explanation_unit_id <> all(${validateUnseenFirst(unseenFirst)}::text[]) then 0 else 1 end,`
    : sql``;
  const keys = (
    await sql<{ asset_id: string; asset_revision: number; head_revision: number }>`
    select b.asset_id,b.asset_revision,b.head_revision
    from content.region_bindings b join content.assets a on a.id=b.asset_id
    join content.asset_revisions r on r.asset_id=b.asset_id and r.revision=b.asset_revision
    where b.topic_id=${q.topicId} and b.facet_id=${q.facetId}
      and a.status='admitted' and a.kind='scroll' and a.revision=b.asset_revision ${expected}
    order by ${unseenFirstOrder}b.asset_id,b.asset_revision limit 101`.execute(tx)
  ).rows;
  const candidates: RegionEncounterCandidate[] = [];
  for (const key of keys.slice(0, 100)) {
    const ref = { assetId: key.asset_id, assetRevision: key.asset_revision };
    const mapping = await readMapping(scope, ref);
    if (
      mapping.kind !== 'mapped' ||
      mapping.head.authority.headRevision !== key.head_revision ||
      !mapping.head.mapping.bindings.some((b) => b.topicId === q.topicId && b.facetId === q.facetId)
    )
      continue;
    const encounter = await readExactEncounter(scope, { ...ref, capabilities: q.capabilities });
    if (encounter?.kind !== 'scroll') continue;
    candidates.push({ encounter, coverage: mapping.head.authority });
    const sibling = encounter.siblings.find((s) => s.kind === 'reel');
    const twin = sibling
      ? await readExactEncounter(scope, {
          assetId: sibling.assetId,
          assetRevision: sibling.assetRevision,
          capabilities: q.capabilities,
        })
      : undefined;
    // The exact read's siblings already are the current admitted assets of this Scroll revision's explanation unit;
    // the lock rechecks the twin before anything is committed.
    if (twin?.kind === 'reel') candidates.push({ encounter: twin, coverage: mapping.head.authority });
  }
  return { kind: 'read', candidates, hasMore: keys.length > 100 };
};

const LockQuery = Query.omit({ expected: true }).extend({
  candidates: z.array(z.strictObject({ ref: CoverageRefSchema, coverage: CoverageAuthoritySchema })).max(3),
});
/** Personal root -> UUID-ordered assets -> mapping heads. Both current head and exact
 * canonical binding survive to commit; a corrected/withdrawn/retracted target never wins. A candidate is its covering
 * Scroll, or that Scroll's current Reel twin under the Scroll's coverage (#709, D-404). */
export const lockRegionEncounterCandidates: LockRegionEncounterCandidates = async (scope, input) => {
  const q = LockQuery.parse(input);
  const catalogue = await readCatalogueIn(transactionOf(scope));
  if (!supported(q, catalogue) || new Set(q.candidates.map((c) => c.ref.assetId)).size !== q.candidates.length)
    return false;
  if (!q.candidates.length) return true;
  // Personal root -> every asset the selection touches (the candidates and the Scrolls whose coverage they use), in one
  // UUID order, so a Reel and its covering Scroll are never locked in opposite orders by two transactions.
  const touched = [...new Set(q.candidates.flatMap((c) => [c.ref.assetId, c.coverage.assetId]))].sort();
  for (const assetId of touched)
    await sql`select id from content.assets where id=${assetId}::uuid for share`.execute(transactionOf(scope));
  const current = await lockCurrentEncounters(scope, {
    refs: q.candidates.map((c) => c.ref),
    capabilities: q.capabilities,
  });
  if (current.length !== q.candidates.length || current.some((c) => !c.encounter)) return false;
  // A Scroll and its Reel twin share one coverage: each authority is locked once. Two different authorities for one
  // Scroll revision cannot both be current, so such a selection is refused rather than half locked.
  const coverages = [
    ...new Map(
      q.candidates.map((c) => [
        `${c.coverage.assetId}@${String(c.coverage.assetRevision)}#${String(c.coverage.headRevision)}:${c.coverage.mappingSha256}`,
        c.coverage,
      ]),
    ).values(),
  ];
  if (new Set(coverages.map((c) => `${c.assetId}@${String(c.assetRevision)}`)).size !== coverages.length) return false;
  if (!(await lockCurrentCoverageAuthorities(scope, coverages))) return false;
  const readMapping = makeReadAdmittedCoverageMapping(() => Promise.resolve(coverageCatalogueOf(catalogue)));
  for (const candidate of q.candidates) {
    const covering = { assetId: candidate.coverage.assetId, assetRevision: candidate.coverage.assetRevision };
    const own = candidate.ref.assetId === covering.assetId && candidate.ref.assetRevision === covering.assetRevision;
    if (!own && !(await isReelTwin(scope, candidate.ref, covering))) return false;
    const mapping = await readMapping(scope, covering);
    if (
      mapping.kind !== 'mapped' ||
      !mapping.head.mapping.bindings.some((b) => b.topicId === q.topicId && b.facetId === q.facetId)
    )
      return false;
  }
  return true;
};

/** Concrete shared row inventory. No account/universe/private-history dependency exists. */
export const contentRegionStores = [
  {
    table: 'content.region_bindings',
    owner: 'Content',
    lifecycle: 'shared current canonical mapping projection',
    correction: 'same-transaction coverage-head trigger replaces exact bindings',
    personalErasure: 'preserve',
    queryBound: '100 candidates plus one key-only lookahead',
  },
] as const;
