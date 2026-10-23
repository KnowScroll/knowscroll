import { CONCEPTS, CONCEPT_CATALOGUE_VERSION } from '../../content/public.js';
import type { RecordingScopeTx } from '../../identity/public.js';
import type { GeographyContext, GeographyPorts, GeographyView } from './ports.js';
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
/** Revalidates indexed candidate probes through current PC/Evidence/Content authority in this root. */
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
  const coverage = await p.readTrusted(scope, { probes: input.probes });
  if (coverage.availability !== 'available') return undefined;
  if (
    coverage.completeness !== 'not_asserted' ||
    coverage.supportedFormats.length !== 1 ||
    coverage.supportedFormats[0] !== 'scroll'
  )
    throw new Error('GEOGRAPHY_COVERAGE_UNSUPPORTED');
  const supports: Support[] = [];
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
    supports.push({
      ref,
      topicId: s.topicId,
      facetId: s.facetId,
      explanationUnitId: s.explanationUnitId,
      truthStatus: 'factual',
      activatedAt: certificates
        .map((c) => c.certificate.activatedAt)
        .sort()
        .at(-1)!,
    });
  }
  if (supports.length > 100) return undefined;
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
