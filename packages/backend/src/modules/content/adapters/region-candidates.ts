import { z } from 'zod';
import { sql } from 'kysely';
import { ClientCapabilities } from '@knowscroll/contracts';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type {
  ReadRegionEncounterCandidates,
  LockRegionEncounterCandidates,
  RegionEncounterQuery,
  RegionEncounterCandidate,
} from '../public.js';
import { conceptMeaning } from '../domain/concepts.js';
import { CoverageAuthoritySchema, CoverageRefSchema } from '../domain/coverage.js';
import { readExactEncounter } from './discovery-store.js';
import { lockCurrentEncounters } from './current-encounters.js';
import { readAdmittedCoverageMapping, lockCurrentCoverageAuthorities } from './coverage-store.js';

const Query = z.strictObject({
  topicId: z.string().min(1).max(160),
  facetId: z.string().min(1).max(160),
  truthStatus: z.literal('factual'),
  capabilities: ClientCapabilities,
  expected: CoverageRefSchema.optional(),
});
const supported = (q: RegionEncounterQuery & { readonly capabilities: z.infer<typeof ClientCapabilities> }) =>
  !!conceptMeaning(q.topicId, q.facetId) && q.capabilities.documentSchemas.includes('scroll-document.v1');

/** Derived keys find canonical matches beyond unrelated inventory. The101st key is never
 * hydrated, classified as eligible, or interpreted as catalogue exhaustion. */
export const readRegionEncounterCandidates: ReadRegionEncounterCandidates = async (scope, input) => {
  const q = Query.parse(input);
  const tx = transactionOf(scope);
  if (!supported(q)) return { kind: 'unsupported' };
  const expected = q.expected
    ? sql`and b.asset_id=${q.expected.assetId}::uuid and b.asset_revision=${q.expected.assetRevision}`
    : sql``;
  const keys = (
    await sql<{ asset_id: string; asset_revision: number; head_revision: number }>`
    select b.asset_id,b.asset_revision,b.head_revision
    from content.region_bindings b join content.assets a on a.id=b.asset_id
    where b.topic_id=${q.topicId} and b.facet_id=${q.facetId}
      and a.status='admitted' and a.kind='scroll' and a.revision=b.asset_revision ${expected}
    order by b.asset_id,b.asset_revision limit 101`.execute(tx)
  ).rows;
  const candidates: RegionEncounterCandidate[] = [];
  for (const key of keys.slice(0, 100)) {
    const ref = { assetId: key.asset_id, assetRevision: key.asset_revision };
    const mapping = await readAdmittedCoverageMapping(scope, ref);
    if (
      mapping.kind !== 'mapped' ||
      mapping.head.authority.headRevision !== key.head_revision ||
      !mapping.head.mapping.bindings.some((b) => b.topicId === q.topicId && b.facetId === q.facetId)
    )
      continue;
    const encounter = await readExactEncounter(scope, { ...ref, capabilities: q.capabilities });
    if (encounter?.kind === 'scroll') candidates.push({ encounter, coverage: mapping.head.authority });
  }
  return { kind: 'read', candidates, hasMore: keys.length > 100 };
};

const LockQuery = Query.omit({ expected: true }).extend({
  candidates: z.array(z.strictObject({ ref: CoverageRefSchema, coverage: CoverageAuthoritySchema })).max(3),
});
/** Personal root -> UUID-ordered assets -> mapping heads. Both current head and exact
 * canonical binding survive to commit; a corrected/withdrawn/retracted target never wins. */
export const lockRegionEncounterCandidates: LockRegionEncounterCandidates = async (scope, input) => {
  const q = LockQuery.parse(input);
  transactionOf(scope);
  if (
    !supported(q) ||
    new Set(q.candidates.map((c) => c.ref.assetId)).size !== q.candidates.length ||
    q.candidates.some((c) => c.ref.assetId !== c.coverage.assetId || c.ref.assetRevision !== c.coverage.assetRevision)
  )
    return false;
  if (!q.candidates.length) return true;
  const current = await lockCurrentEncounters(scope, {
    refs: q.candidates.map((c) => c.ref),
    capabilities: q.capabilities,
  });
  if (current.length !== q.candidates.length || current.some((c) => !c.encounter)) return false;
  if (
    !(await lockCurrentCoverageAuthorities(
      scope,
      q.candidates.map((c) => c.coverage),
    ))
  )
    return false;
  for (const candidate of q.candidates) {
    const mapping = await readAdmittedCoverageMapping(scope, candidate.ref);
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
