import { CONCEPTS, CONCEPT_CATALOGUE_VERSION } from '../../content/public.js';
import type { PersonalScopeTx, RecordingScopeTx } from '../../identity/public.js';
import type { TrustedCoverageQuery } from '../../personal-context/public.js';
import type {
  GeographyContext,
  GeographyPorts,
  GeographyPreparation,
  GeographyView,
  PreparationRefusal,
} from './ports.js';
import { compactSupports, type WeightedSupport } from '../domain/compaction.js';
import {
  formationEligible,
  semanticKey,
  type Candidate,
  type Concept,
  type FormationFacts,
  type Place,
  type Support,
} from '../domain/policy.js';
/** What freezing a context needs of the geography ports: reads, the clock and ids, never a write or a wake. */
export type PreparationPorts = Pick<GeographyPorts, 'store' | 'readInputs' | 'readTrusted' | 'hash' | 'newId' | 'now'>;
const label = (id: string) => {
  const value = id.split('.').at(-1)!.replaceAll('-', ' ');
  return value[0]!.toUpperCase() + value.slice(1);
};
const TOPICS: ReadonlyMap<string, (typeof CONCEPTS)[number]> = new Map(CONCEPTS.map((topic) => [topic.id, topic]));
const refused = (reason: PreparationRefusal): GeographyPreparation => ({ kind: 'unavailable', reason });

/**
 * The catalogue topics this person has reached, or already holds a place for, with the systems they
 * belong to. A place with no support can never be due (`formationEligible`), so no other concept
 * needs a slot, a catalogue entry or a route in the frozen context. This is what keeps the context
 * from growing with the catalogue (#674).
 */
function relevantTopicIds(supports: readonly Support[], objects: readonly Place[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const support of supports) ids.add(support.topicId);
  // A region's concept is a facet; its planet is an object of its own and is added with the others.
  for (const object of objects) if (object.kind !== 'region') ids.add(object.conceptId);
  for (const id of [...ids]) {
    const parent = TOPICS.get(id)?.parent;
    if (parent) ids.add(parent);
  }
  return ids;
}

/** The catalogue entries of `topicIds`, in catalogue order, as the rules read them. */
const catalogueSlice = (topicIds: ReadonlySet<string>): Concept[] =>
  CONCEPTS.filter((topic) => topicIds.has(topic.id)).map((topic) => ({
    id: topic.id,
    parent: topic.parent,
    facets: topic.facets.map((facet) => facet.id),
  }));
/**
 * Identity slots are allocated once in the frozen context, never invented by the model. A slot is
 * made for each reached or established system, star and planet, and for each region that is
 * supported or established. An identity comes from the stored place, else from `previous` (the
 * context being re-checked at apply), else a new one.
 */
function candidates(
  p: PreparationPorts,
  objects: readonly Place[],
  supports: readonly Support[],
  topicIds: ReadonlySet<string>,
  previous?: readonly Candidate[],
): readonly Candidate[] {
  const slots: Candidate[] = [];
  const stored = new Map(objects.map((object) => [object.key, object]));
  const frozen = new Map((previous ?? []).map((candidate) => [candidate.key, candidate]));
  const supported = new Set(supports.map((support) => `${support.topicId}|${support.facetId}`));
  const established = new Set(
    objects.filter((object) => object.kind === 'region').map((object) => `${object.parentKey}|${object.conceptId}`),
  );
  const add = (kind: Candidate['kind'], conceptId: string, parentKey: string, meaning: string) => {
    const key = semanticKey(kind, conceptId);
    slots.push({
      key,
      id: stored.get(key)?.id ?? frozen.get(key)?.id ?? p.newId(),
      kind,
      conceptId,
      parentKey,
      truthStatus: 'factual',
      labels: [label(conceptId), meaning].filter((x, i, a) => x.length <= 160 && a.indexOf(x) === i),
    });
  };
  for (const topic of CONCEPTS) {
    if (!topicIds.has(topic.id)) continue;
    if (topic.parent === null) {
      add('system', topic.id, 'universe', topic.meaning);
      add('star', topic.id, semanticKey('system', topic.id), topic.meaning);
      continue;
    }
    const planetKey = semanticKey('planet', topic.id);
    add('planet', topic.id, semanticKey('system', topic.parent), topic.meaning);
    for (const facet of topic.facets)
      if (supported.has(`${topic.id}|${facet.id}`) || established.has(`${planetKey}|${facet.id}`))
        add('region', facet.id, planetKey, facet.meaning);
  }
  return slots;
}

/**
 * Identities for the routes the rules could connect: every pair of planets of one system that are
 * formed or due. A route only ever joins two such planets (`proposalIssue`), so no other pair needs
 * one. An earlier context keeps the identities it allocated.
 */
function routeIdentities(
  facts: FormationFacts,
  previous: GeographyContext['routeIds'] | undefined,
  newId: () => string,
): Record<string, string> {
  const formed = new Set(facts.objects.map((object) => object.key));
  const bySystem = new Map<string, Candidate[]>();
  for (const candidate of facts.candidates) {
    if (candidate.kind !== 'planet' || !(formed.has(candidate.key) || formationEligible(facts, candidate))) continue;
    bySystem.set(candidate.parentKey, [...(bySystem.get(candidate.parentKey) ?? []), candidate]);
  }
  const pairs: Record<string, string> = {};
  for (const planets of bySystem.values())
    for (let i = 0; i < planets.length; i++)
      for (let j = i + 1; j < planets.length; j++) {
        const key = [planets[i]!.key, planets[j]!.key].sort().join('|');
        pairs[key] = previous?.[key] ?? newId();
      }
  return pairs;
}
/** A trusted read takes this many probes; more candidate keys are read in batches. */
const PROBES_PER_READ = 100;
/** What one frozen context holds of support and its proof. */
const SUPPORT_BUDGET = { count: 100, bytes: 360_000 } as const;
type Coverage = Extract<Awaited<ReturnType<GeographyPorts['readTrusted']>>, { availability: 'available' }>;
type CoverageEntry = WeightedSupport & {
  readonly source: Coverage['supports'][number];
  readonly witnesses: Coverage['witnesses'];
  readonly certificates: Coverage['certificates'];
};

type BatchRead =
  | { readonly kind: 'read'; readonly reads: Coverage[] }
  | { readonly kind: 'unavailable'; readonly reason: Extract<PreparationRefusal, `coverage_${string}`> };

/**
 * Reads one batch of probes. A trusted read refuses past its own bounds, so a batch that refuses
 * with `limit` is split and read as two. A batch with nothing observed contributes nothing. One
 * probe always fits: the read returns one witness per support key, never one per re-read.
 */
async function readBatch(
  p: PreparationPorts,
  scope: PersonalScopeTx,
  probes: TrustedCoverageQuery['probes'],
): Promise<BatchRead> {
  const read = await p.readTrusted(scope, { probes });
  if (read.availability === 'available') {
    if (
      read.completeness !== 'not_asserted' ||
      read.supportedFormats.length !== 1 ||
      read.supportedFormats[0] !== 'scroll'
    )
      throw new Error('GEOGRAPHY_COVERAGE_UNSUPPORTED');
    return { kind: 'read', reads: [read] };
  }
  if (read.reason === 'not_observed') return { kind: 'read', reads: [] };
  if (read.reason === 'authority_changed') return { kind: 'unavailable', reason: 'coverage_authority_changed' };
  if (probes.length === 1) return { kind: 'unavailable', reason: 'coverage_limit' };
  const half = Math.ceil(probes.length / 2);
  const first = await readBatch(p, scope, probes.slice(0, half));
  if (first.kind === 'unavailable') return first;
  const second = await readBatch(p, scope, probes.slice(half));
  return second.kind === 'unavailable' ? second : { kind: 'read', reads: [...first.reads, ...second.reads] };
}

/**
 * Reads every candidate through the trusted coverage port, in batches under one root. The batches
 * are disjoint probes, so their union is the whole trusted read; certificates shared by two
 * bindings of one exposure are kept once. Any batch that cannot be read makes the whole read
 * unavailable, as does a read in which nothing was observed (`no_trusted_support`).
 */
async function readTrustedInBatches(
  p: PreparationPorts,
  scope: PersonalScopeTx,
  probes: TrustedCoverageQuery['probes'],
): Promise<
  | { readonly kind: 'read'; readonly coverage: Coverage }
  | { readonly kind: 'unavailable'; readonly reason: PreparationRefusal }
> {
  const reads: Coverage[] = [];
  for (let start = 0; start < probes.length; start += PROBES_PER_READ) {
    const batch = await readBatch(p, scope, probes.slice(start, start + PROBES_PER_READ));
    if (batch.kind === 'unavailable') return batch;
    reads.push(...batch.reads);
  }
  const [first] = reads;
  if (!first) return { kind: 'unavailable', reason: 'no_trusted_support' };
  if (reads.length === 1) return { kind: 'read', coverage: first };
  return {
    kind: 'read',
    coverage: {
      ...first,
      supports: reads.flatMap((read) => read.supports),
      witnesses: reads.flatMap((read) => read.witnesses),
      certificates: [...new Map(reads.flatMap((read) => read.certificates).map((c) => [c.witnessKey, c])).values()],
    },
  };
}

/** Each trusted support with the witnesses and certificates that prove it, checked against the catalogue and truth. */
function supportEntries(p: PreparationPorts, coverage: Coverage): CoverageEntry[] {
  const entries: CoverageEntry[] = [];
  for (const s of coverage.supports) {
    const topic = TOPICS.get(s.topicId),
      facet = topic?.facets.find((f) => f.id === s.facetId);
    // A facet that vanished or changed meaning since the evidence was recorded supports nothing now.
    // The catalogue grows with the library, so this is expected after a plan edit, not an error.
    if (
      !topic ||
      !facet ||
      s.meaningSha256 !==
        p.hash({ topicId: topic.id, topicMeaning: topic.meaning, facetId: facet.id, facetMeaning: facet.meaning })
    )
      continue;
    const witnesses = coverage.witnesses.filter(
      (w) =>
        w.topicId === s.topicId &&
        w.facetId === s.facetId &&
        w.meaningSha256 === s.meaningSha256 &&
        w.explanationUnitId === s.explanationUnitId &&
        w.truthSha256 === s.truthSha256,
    );
    const certificates = witnesses.map((w) => {
      const c = coverage.certificates.find(
        (c) =>
          c.witnessKey === w.witnessKey &&
          c.sourceKind === w.sourceKind &&
          c.recordingGeneration === w.recordingGeneration &&
          c.activityId === w.activityId &&
          c.qualificationId === w.qualificationId &&
          c.certificateSha256 === w.certificateSha256 &&
          c.certificate.exposureId === w.exposureId,
      );
      if (!c) throw new Error('GEOGRAPHY_WITNESS_AUTHORITY');
      return c;
    });
    if (
      !certificates.length ||
      certificates.some(
        ({ certificate: c }) =>
          c.availability !== 'available' ||
          c.mapping?.framing !== 'factual' ||
          c.mapping.catalogueVersion !== CONCEPT_CATALOGUE_VERSION ||
          c.explanationUnitId !== s.explanationUnitId ||
          c.mapping.framingSha256 !== s.truthSha256,
      )
    )
      throw new Error('GEOGRAPHY_TRUTH_AUTHORITY');
    const ref = `support:${p.hash({ support: s, certificates: certificates.map((c) => c.certificateSha256).sort() })}`;
    const support: Support = {
      ref,
      topicId: s.topicId,
      facetId: s.facetId,
      explanationUnitId: s.explanationUnitId,
      truthStatus: 'factual',
      activatedAt: certificates
        .map((c) => c.certificate.activatedAt)
        .sort()
        .at(-1)!,
    };
    entries.push({ support, source: s, witnesses, certificates, bytes: 0 });
  }
  return withShares(entries);
}

/** Sizes each entry by its own part plus an equal share of each certificate it uses with others. */
function withShares(entries: readonly CoverageEntry[]): CoverageEntry[] {
  const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const sharers = new Map<string, number>();
  for (const entry of entries)
    for (const key of new Set(entry.certificates.map((c) => c.witnessKey)))
      sharers.set(key, (sharers.get(key) ?? 0) + 1);
  return entries.map((entry) => ({
    ...entry,
    bytes:
      size({ support: entry.support, witnesses: entry.witnesses }) +
      entry.certificates.reduce((sum, c) => sum + size(c) / (sharers.get(c.witnessKey) ?? 1), 0),
  }));
}

/** The proof the frozen context keeps: exactly the retained supports', when some were left out. */
function coverageOf(coverage: Coverage, all: readonly CoverageEntry[], kept: readonly CoverageEntry[]): Coverage {
  if (kept.length === all.length) return coverage;
  return {
    ...coverage,
    supports: kept.map((entry) => entry.source),
    witnesses: kept.flatMap((entry) => entry.witnesses),
    certificates: [...new Map(kept.flatMap((entry) => entry.certificates).map((c) => [c.witnessKey, c])).values()],
  };
}

/**
 * Revalidates indexed candidate probes through current PC/Evidence/Content authority in this root.
 * The rules read all trusted coverage; when it is more than one frozen context can hold, the context
 * keeps the supports they need (`compactSupports`), so a heavy reader's cartography degrades
 * instead of stopping.
 *
 * The context holds only what the person has reached: candidates, catalogue entries and route
 * identities for concepts with support or an established place, and for their systems. `previous`,
 * the context being re-checked at apply, gives identities to places it already allocated; a concept
 * it did not hold (reading reached it since) is simply new, and never a refusal.
 *
 * Returns why no context was prepared as a typed refusal, so the caller can record a distinct outcome.
 * A reader with no coverage references yet is refused before any coverage is read or any identity
 * allocated.
 */
export async function prepareGeography(
  p: PreparationPorts,
  cap: RecordingScopeTx,
  view: GeographyView,
  previous?: GeographyContext,
): Promise<GeographyPreparation> {
  await p.store.root(cap);
  const scope = cap.personal;
  if (view.objects.length > 1000 || view.routes.length + view.aliases.length > 1000) return refused('structure_limit');
  const input = await p.readInputs(scope);
  if (input.availability !== 'available') return refused('discovery_limit');
  if (!input.probes.length) return refused('no_support_yet');
  const read = await readTrustedInBatches(p, scope, input.probes);
  if (read.kind === 'unavailable') return refused(read.reason);
  const trusted = read.coverage;
  const all = supportEntries(p, trusted);
  const kept = compactSupports(all, SUPPORT_BUDGET);
  const coverage = coverageOf(trusted, all, kept);
  const supports = kept.map((entry) => entry.support);
  const topicIds = relevantTopicIds(supports, view.objects);
  const facts: FormationFacts = {
    catalogue: catalogueSlice(topicIds),
    supports,
    candidates: candidates(p, view.objects, supports, topicIds, previous?.facts.candidates),
    objects: view.objects,
    routes: view.routes,
    evaluatedAt: p.now().toISOString(),
    completeness: 'not_asserted',
  };
  const { evaluatedAt: _time, ...authorityFacts } = facts;
  const context: GeographyContext = {
    version: 'cartographer-context.v1',
    universeId: scope.authority.universeId,
    privacyEpoch: scope.authority.privacyEpoch,
    transitionId: previous?.transitionId ?? p.newId(),
    desiredRevision: view.state.desiredRevision,
    pcRevision: input.revision,
    scopeRevision: scope.revisionAtEntry,
    probes: input.probes,
    facts,
    factsSha256: p.hash({ facts: authorityFacts, coverage }),
    coverage,
    base: {
      revision: view.state.revision,
      structureRevision: view.state.structureRevision,
      activityRevision: view.state.activityRevision,
    },
    routeIds: routeIdentities(facts, previous?.routeIds, p.newId),
  };
  if (new TextEncoder().encode(JSON.stringify(context)).byteLength > 500000) return refused('context_too_large');
  return { kind: 'prepared', context, supportKeys: all.length };
}
