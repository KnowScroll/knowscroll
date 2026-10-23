import { CONCEPTS, CONCEPT_CATALOGUE_VERSION } from '../../content/public.js';
import type { PersonalScopeTx, RecordingScopeTx } from '../../identity/public.js';
import type { TrustedCoverageQuery } from '../../personal-context/public.js';
import type { GeographyContext, GeographyPorts, GeographyView } from './ports.js';
import { compactSupports, type WeightedSupport } from '../domain/compaction.js';
import { semanticKey, type Candidate, type FormationFacts, type Support } from '../domain/policy.js';
const label = (id: string) => {
  const value = id.split('.').at(-1)!.replaceAll('-', ' ');
  return value[0]!.toUpperCase() + value.slice(1);
};
/** Identity slots are allocated once in the frozen context, never invented by the model. */
function candidates(p: GeographyPorts, view: GeographyView, previous?: readonly Candidate[]): readonly Candidate[] {
  const slots: Candidate[] = [];
  const add = (kind: Candidate['kind'], conceptId: string, parentKey: string, meaning: string) => {
    const key = semanticKey(kind, conceptId),
      old = view.objects.find((o) => o.key === key),
      frozen = previous?.find((c) => c.key === key);
    if (previous && !old && !frozen) throw new Error('GEOGRAPHY_CATALOGUE_CHANGED');
    slots.push({
      key,
      id: old?.id ?? frozen?.id ?? p.newId(),
      kind,
      conceptId,
      parentKey,
      truthStatus: 'factual',
      labels: [label(conceptId), meaning].filter((x, i, a) => x.length <= 160 && a.indexOf(x) === i),
    });
  };
  for (const topic of CONCEPTS) {
    if (topic.parent === null) {
      add('system', topic.id, 'universe', topic.meaning);
      add('star', topic.id, semanticKey('system', topic.id), topic.meaning);
    } else {
      add('planet', topic.id, semanticKey('system', topic.parent), topic.meaning);
      for (const facet of topic.facets) add('region', facet.id, semanticKey('planet', topic.id), facet.meaning);
    }
  }
  return slots;
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

/**
 * Reads one batch of probes. A trusted read refuses past its own bounds (raw references, assets, or
 * 128 KiB of output), so a batch that refuses with `limit` is split and read as two. A batch with
 * nothing observed contributes nothing. One probe always fits.
 */
async function readBatch(
  p: GeographyPorts,
  scope: PersonalScopeTx,
  probes: TrustedCoverageQuery['probes'],
): Promise<Coverage[] | undefined> {
  const read = await p.readTrusted(scope, { probes });
  if (read.availability === 'available') {
    if (
      read.completeness !== 'not_asserted' ||
      read.supportedFormats.length !== 1 ||
      read.supportedFormats[0] !== 'scroll'
    )
      throw new Error('GEOGRAPHY_COVERAGE_UNSUPPORTED');
    return [read];
  }
  if (read.reason === 'not_observed') return [];
  if (read.reason !== 'limit' || probes.length === 1) return undefined;
  const half = Math.ceil(probes.length / 2);
  const first = await readBatch(p, scope, probes.slice(0, half));
  const second = first && (await readBatch(p, scope, probes.slice(half)));
  return first && second ? [...first, ...second] : undefined;
}

/**
 * Reads every candidate through the trusted coverage port, in batches under one root. The batches
 * are disjoint probes, so their union is the whole trusted read; certificates shared by two
 * bindings of one exposure are kept once. Any batch that cannot be read makes the whole read
 * unavailable, as does a read in which nothing was observed.
 */
async function readTrustedInBatches(
  p: GeographyPorts,
  scope: PersonalScopeTx,
  probes: TrustedCoverageQuery['probes'],
): Promise<Coverage | undefined> {
  const reads: Coverage[] = [];
  for (let start = 0; start < probes.length; start += PROBES_PER_READ) {
    const batch = await readBatch(p, scope, probes.slice(start, start + PROBES_PER_READ));
    if (!batch) return undefined;
    reads.push(...batch);
  }
  const [first] = reads;
  if (!first || reads.length === 1) return first;
  return {
    ...first,
    supports: reads.flatMap((read) => read.supports),
    witnesses: reads.flatMap((read) => read.witnesses),
    certificates: [...new Map(reads.flatMap((read) => read.certificates).map((c) => [c.witnessKey, c])).values()],
  };
}

/** Each trusted support with the witnesses and certificates that prove it, checked against the catalogue and truth. */
function supportEntries(p: GeographyPorts, coverage: Coverage): CoverageEntry[] {
  const entries: CoverageEntry[] = [];
  for (const s of coverage.supports) {
    const topic = CONCEPTS.find((t) => t.id === s.topicId),
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
 */
export async function prepareGeography(
  p: GeographyPorts,
  cap: RecordingScopeTx,
  view: GeographyView,
  previous?: GeographyContext,
): Promise<GeographyContext | undefined> {
  await p.store.root(cap);
  const scope = cap.personal;
  if (view.objects.length > 1000 || view.routes.length + view.aliases.length > 1000) return undefined;
  const input = await p.readInputs(scope);
  if (input.availability !== 'available' || !input.probes.length) return undefined;
  const trusted = await readTrustedInBatches(p, scope, input.probes);
  if (!trusted) return undefined;
  const all = supportEntries(p, trusted);
  const kept = compactSupports(all, SUPPORT_BUDGET);
  const coverage = coverageOf(trusted, all, kept);
  const supports = kept.map((entry) => entry.support);
  const facts: FormationFacts = {
    catalogue: CONCEPTS.map((t) => ({ id: t.id, parent: t.parent, facets: t.facets.map((f) => f.id) })),
    supports,
    candidates: candidates(p, view, previous?.facts.candidates),
    objects: view.objects,
    routes: view.routes,
    evaluatedAt: p.now().toISOString(),
    completeness: 'not_asserted',
  };
  const pairs: Record<string, string> = {};
  const planets = facts.candidates.filter((c) => c.kind === 'planet');
  for (let i = 0; i < planets.length; i++)
    for (let j = i + 1; j < planets.length; j++) {
      const key = [planets[i]!.key, planets[j]!.key].sort().join('|');
      pairs[key] = previous?.routeIds[key] ?? p.newId();
    }
  const { evaluatedAt: _time, ...authorityFacts } = facts;
  const result: GeographyContext = {
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
    routeIds: pairs,
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 500000) return undefined;
  return result;
}
