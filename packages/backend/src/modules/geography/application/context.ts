import { CONCEPT_CATALOGUE_VERSION } from '../../content/public.js';
import type { PersonalScopeTx, RecordingScopeTx } from '../../identity/public.js';
import type { CoverageProbe, TrustedCoverageQuery } from '../../personal-context/public.js';
import type { Catalogue, CatalogueTopic } from '../domain/catalogue.js';
import { EVALUATION } from '../domain/evaluation.js';
import { dueCreations } from '../domain/formation.js';
import { derivedPlaceId, routeKey } from '../domain/ids.js';
import {
  semanticKey,
  type Candidate,
  type Concept,
  type FormationFacts,
  type Place,
  type Route,
  type Support,
} from '../domain/policy.js';
import { pinCatalogue } from './catalogue.js';
import type {
  EvaluationScope,
  GeographyContext,
  GeographyPorts,
  GeographyPreparation,
  PreparationRefusal,
  StoredPlace,
} from './ports.js';

/** What freezing a context needs of the geography ports: reads, the clock and ids, never a write or a wake. */
export type PreparationPorts = Pick<
  GeographyPorts,
  'store' | 'readDirty' | 'readInputs' | 'readTrusted' | 'catalogue' | 'hash' | 'mac' | 'seed' | 'newId' | 'now'
>;
/** The ports an evaluation reads through once it has pinned one release of the catalogue (D-419): every lookup is of that release. */
type ReadPorts = Omit<PreparationPorts, 'catalogue'>;
type PinnedPorts = ReadPorts & { readonly catalogue: Catalogue };

/**
 * The release an evaluation reads, read once: the one a frozen context pinned (the apply re-checks what the run decided on, whatever
 * has been released since), else the one the caller already pinned, else the current release. A context frozen before releases
 * existed pinned none and is read against the current one, which for the seeded catalogue is the same.
 */
export async function pinnedCatalogue(
  p: Pick<PreparationPorts, 'catalogue'>,
  pin: { readonly catalogue?: Catalogue; readonly catalogueRelease?: number } = {},
): Promise<Catalogue> {
  if (pin.catalogue !== undefined) return pin.catalogue;
  if (pin.catalogueRelease !== undefined) {
    const release = await p.catalogue.release(pin.catalogueRelease);
    if (release !== undefined) return pinCatalogue(release);
  }
  return pinCatalogue(await p.catalogue.current());
}

/**
 * What a context evaluates:
 * - `dirty`: the topics whose trusted support changed since the last run (a Cartographer run). `alsoDueBy` adds the topics
 *   of places due to be looked at by then (what the dry run says a settle would see).
 * - `evaluated`: exactly the topics an earlier context evaluated, read again under today's authority (the apply).
 * - `topics`: these topics (the quiet settle).
 */
export type PreparationRequest =
  | { readonly kind: 'dirty'; readonly alsoDueBy?: Date }
  | { readonly kind: 'evaluated'; readonly evaluated: EvaluationScope }
  | { readonly kind: 'topics'; readonly topics: readonly string[] };

/**
 * `readOnly`: the scope cannot write (the dry run), so a universe with no place secret yet gets an unsaved one.
 * `catalogue`: a release the caller pinned already, so one pass reads one catalogue. `catalogueRelease`: the release a frozen context
 * pinned, which the apply reads again (D-419).
 */
export interface PreparationOptions {
  readonly readOnly?: boolean;
  readonly catalogue?: Catalogue;
  readonly catalogueRelease?: number;
}

const label = (id: string) => {
  const value = id.split('.').at(-1)!.replaceAll('-', ' ');
  return value[0]!.toUpperCase() + value.slice(1);
};
const refused = (
  reason: PreparationRefusal,
  attempted?: { readonly topics: readonly string[]; readonly dirtyThrough: number },
): GeographyPreparation => ({ kind: 'unavailable', reason, ...(attempted ? { attempted } : {}) });

/** A trusted read that observed nothing: no support to build on, as the places under these topics read it. */
const emptyCoverage = (): Coverage => ({
  version: 'trusted-coverage-read.v1',
  completeness: 'not_asserted',
  supportedFormats: ['scroll', 'reel'],
  availability: 'available',
  reason: 'current',
  supports: [],
  witnesses: [],
  certificates: [],
});

/**
 * True when topics were probed and none of what was found is current trusted support (content withdrawn, a map corrected).
 * The evaluation is still complete: places under those topics keep their activity, and a system whose other topics were read
 * is judged on them.
 */
export const nothingTrusted = (context: Pick<GeographyContext, 'probes' | 'facts'>): boolean =>
  context.probes.length > 0 && context.facts.supports.length === 0;
const conceptOf = (topic: CatalogueTopic): Concept => ({
  id: topic.id,
  parent: topic.parent,
  facets: topic.facets.map((facet) => facet.id),
  ...(topic.policy ? { policy: topic.policy } : {}),
});

/**
 * The topics a context evaluated. A context frozen before incremental evaluation held every topic the person had
 * reached, which is exactly the topics of its supports and its planets.
 */
export function evaluationOf(context: GeographyContext): EvaluationScope {
  if (context.evaluated) return context.evaluated;
  const topics = new Set(context.facts.supports.map((support) => support.topicId));
  for (const place of context.facts.objects) if (place.kind === 'planet') topics.add(place.conceptId);
  return { topics: [...topics].sort(), dirtyThrough: context.scopeRevision, hasMore: false };
}

/**
 * The semantic keys of the stored places an evaluation of `topics` needs: for each, its system and star, its planet and
 * the regions of its facets, which are the places under it and the parents above it. Loaded by key, never by scanning.
 */
function placeKeys(catalogue: Catalogue, topics: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const id of topics) {
    const topic = catalogue.topic(id);
    if (!topic) continue;
    if (topic.parent === null) {
      keys.add(semanticKey('system', id));
      keys.add(semanticKey('star', id));
      continue;
    }
    keys.add(semanticKey('system', topic.parent));
    keys.add(semanticKey('star', topic.parent));
    keys.add(semanticKey('planet', id));
    for (const facet of topic.facets) keys.add(semanticKey('region', facet.id));
  }
  return [...keys];
}

/** The pairs of stored planets of one system that a route could already join: their route keys, sorted pairs. */
function routePairKeys(planets: readonly Place[]): string[] {
  const bySystem = new Map<string, string[]>();
  for (const planet of planets) bySystem.set(planet.parentKey, [...(bySystem.get(planet.parentKey) ?? []), planet.key]);
  const pairs: string[] = [];
  for (const keys of bySystem.values())
    for (let i = 0; i < keys.length; i++)
      for (let j = i + 1; j < keys.length; j++) pairs.push(routeKey(keys[i]!, keys[j]!));
  return pairs;
}

/**
 * The catalogue topics this person has reached among those evaluated, or already holds a place for, with the systems
 * they belong to. A place with no support can never be due (`formationEligible`), so no other concept needs a slot or a
 * catalogue entry in the frozen context (D-409).
 */
function relevantTopics(
  catalogue: Catalogue,
  supports: readonly Support[],
  objects: readonly Place[],
): readonly CatalogueTopic[] {
  const ids = new Set<string>();
  for (const support of supports) ids.add(support.topicId);
  // A region's concept is a facet; its planet is an object of its own and is added with the others.
  for (const object of objects) if (object.kind !== 'region') ids.add(object.conceptId);
  for (const id of [...ids]) {
    const parent = catalogue.topic(id)?.parent;
    if (parent) ids.add(parent);
  }
  // A topic a release retired forms nothing new: it leaves the slice (what is stored for it stays valid, `validView`).
  return [...ids]
    .map((id) => catalogue.topic(id))
    .filter((topic): topic is CatalogueTopic => topic !== undefined && !catalogue.retired(topic.id))
    .sort((a, b) => catalogue.rank(a.id) - catalogue.rank(b.id));
}

/**
 * Identity slots are made once per evaluation, never invented by the model: a candidate for each reached or established
 * system, star and planet, and for each region that is supported or established. A stored place keeps its id; a new
 * one gets the id derived from the universe's place secret and its semantic key (`derivedPlaceId`), so every evaluation
 * of the same facts derives the same id and no table of allocated ids exists.
 */
function candidates(
  p: Pick<PreparationPorts, 'mac'>,
  secret: string,
  stored: ReadonlyMap<string, Place>,
  supports: readonly Support[],
  topics: readonly CatalogueTopic[],
): readonly Candidate[] {
  const slots: Candidate[] = [];
  const supported = new Set(supports.map((support) => `${support.topicId}|${support.facetId}`));
  const established = new Set(
    [...stored.values()]
      .filter((object) => object.kind === 'region')
      .map((object) => `${object.parentKey}|${object.conceptId}`),
  );
  const add = (kind: Candidate['kind'], conceptId: string, parentKey: string, name: string, meaning: string) => {
    const key = semanticKey(kind, conceptId);
    slots.push({
      key,
      id: stored.get(key)?.id ?? derivedPlaceId(p.mac, secret, key),
      kind,
      conceptId,
      parentKey,
      truthStatus: 'factual',
      labels: [name, meaning].filter((x, i, a) => x.length <= 160 && a.indexOf(x) === i),
    });
  };
  for (const topic of topics) {
    if (topic.parent === null) {
      add('system', topic.id, 'universe', topic.label ?? label(topic.id), topic.meaning);
      add('star', topic.id, semanticKey('system', topic.id), topic.label ?? label(topic.id), topic.meaning);
      continue;
    }
    const planetKey = semanticKey('planet', topic.id);
    add('planet', topic.id, semanticKey('system', topic.parent), topic.label ?? label(topic.id), topic.meaning);
    for (const facet of topic.facets)
      if (supported.has(`${topic.id}|${facet.id}`) || established.has(`${planetKey}|${facet.id}`))
        add('region', facet.id, planetKey, facet.label ?? label(facet.id), facet.meaning);
  }
  return slots;
}

/** A trusted read takes this many probes; more candidate keys are read in batches. */
const PROBES_PER_READ = 100;
type Coverage = Extract<Awaited<ReturnType<GeographyPorts['readTrusted']>>, { availability: 'available' }>;
type CoverageEntry = {
  readonly support: Support;
  readonly source: Coverage['supports'][number];
  readonly witnesses: Coverage['witnesses'];
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
  p: ReadPorts,
  scope: PersonalScopeTx,
  probes: TrustedCoverageQuery['probes'],
): Promise<BatchRead> {
  const read = await p.readTrusted(scope, { probes });
  if (read.availability === 'available') {
    if (
      read.completeness !== 'not_asserted' ||
      read.supportedFormats.length !== 2 ||
      read.supportedFormats[0] !== 'scroll' ||
      read.supportedFormats[1] !== 'reel'
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
 * Reads every probe through the trusted coverage port, in batches under one root. The batches are disjoint, so their
 * union is the whole trusted read. Any batch that cannot be read makes the whole read unavailable; a read in which nothing
 * was observed is a complete answer with no support (`nothingTrusted`).
 */
async function readTrustedInBatches(
  p: ReadPorts,
  scope: PersonalScopeTx,
  probes: readonly CoverageProbe[],
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
  return { kind: 'read', coverage: mergeCoverage(reads) };
}

/** The union of disjoint trusted reads; none is a read in which nothing was observed. */
function mergeCoverage(reads: readonly Coverage[]): Coverage {
  const [first] = reads;
  if (!first) return emptyCoverage();
  if (reads.length === 1) return first;
  return {
    ...first,
    supports: reads.flatMap((read) => read.supports),
    witnesses: reads.flatMap((read) => read.witnesses),
    // A certificate shared by two bindings of one exposure is kept once.
    certificates: [...new Map(reads.flatMap((read) => read.certificates).map((c) => [c.witnessKey, c])).values()],
  };
}

/** Each trusted support with the witnesses and certificates that prove it, checked against the catalogue and truth. */
function supportEntries(p: PinnedPorts, coverage: Coverage): CoverageEntry[] {
  const entries: CoverageEntry[] = [];
  for (const s of coverage.supports) {
    // A facet that vanished or changed meaning since the evidence was recorded supports nothing now. A wording a release
    // declared the same meaning still stands (D-419). The catalogue grows, so this is expected after a release, not an error.
    if (!p.catalogue.acceptsMeaning(s.topicId, s.facetId, s.meaningSha256)) continue;
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
    entries.push({ support, source: s, witnesses });
  }
  return entries.sort(
    (a, b) =>
      a.support.topicId.localeCompare(b.support.topicId) ||
      a.support.facetId.localeCompare(b.support.facetId) ||
      a.support.explanationUnitId.localeCompare(b.support.explanationUnitId) ||
      a.support.ref.localeCompare(b.support.ref),
  );
}

/**
 * How many newest keys of each facet an evaluation of `topicIds` reads (D-419). A planet needs `planetUnits` units and its system
 * `systemUnits`: a facet holding that many keys already holds enough, so reading that many of each facet changes no place the
 * rules form. For a catalogue that never changed a threshold this is `EVALUATION.keysPerFacet`, exactly as before.
 */
function keysFor(catalogue: Catalogue, topicIds: readonly string[]): number {
  let keys: number = EVALUATION.keysPerFacet;
  for (const id of topicIds) {
    const topic = catalogue.topic(id);
    const system = topic?.parent == null ? undefined : catalogue.topic(topic.parent);
    keys = Math.max(keys, topic?.policy?.planetUnits ?? 0, topic?.policy?.systemUnits ?? 0, system?.policy?.systemUnits ?? 0);
  }
  return keys;
}

/** How many keys of each facet of the other topics of a system are read: one, unless the system asks for more units than that to form. */
function neighbourKeys(catalogue: Catalogue, systemId: string): number {
  return Math.max(1, catalogue.topic(systemId)?.policy?.systemUnits ?? 0);
}

/** The topics a person's due places are read through (the quiet settle and the dry run). */
export async function topicsOfPlaces(
  p: Pick<PreparationPorts, 'readInputs' | 'catalogue'>,
  scope: PersonalScopeTx,
  places: readonly Pick<Place, 'kind' | 'conceptId' | 'parentKey'>[],
  pinned?: Catalogue,
): Promise<string[]> {
  return topicsOfPlacesIn(p, await pinnedCatalogue(p, { catalogue: pinned }), scope, places);
}

async function topicsOfPlacesIn(
  p: Pick<ReadPorts, 'readInputs'>,
  catalogue: Catalogue,
  scope: PersonalScopeTx,
  places: readonly Pick<Place, 'kind' | 'conceptId' | 'parentKey'>[],
): Promise<string[]> {
  const topics = new Set<string>();
  const systems = new Set<string>();
  for (const place of places) {
    if (place.kind === 'planet') topics.add(place.conceptId);
    else if (place.kind === 'region') {
      const planet = /^planet:(.+):factual$/.exec(place.parentKey)?.[1];
      if (planet) topics.add(planet);
    } else systems.add(place.conceptId);
  }
  for (const systemId of systems) {
    const children = catalogue.childrenOf(systemId).map((topic) => topic.id);
    const read = await p.readInputs(scope, {
      topicIds: children,
      perFacet: neighbourKeys(catalogue, systemId),
      maxTopics: EVALUATION.neighbourTopics,
    });
    for (const id of read.topics) topics.add(id);
  }
  return [...topics].sort((a, b) => catalogue.rank(a) - catalogue.rank(b));
}

/** The topics to evaluate for a request, and what the dirty set said about the person. */
async function chooseTopics(
  p: PinnedPorts,
  scope: PersonalScopeTx,
  request: PreparationRequest,
): Promise<
  | { readonly kind: 'none' }
  | {
      readonly kind: 'topics';
      readonly topics: readonly string[];
      readonly dirtyThrough: number;
      readonly hasMore: boolean;
    }
> {
  if (request.kind === 'evaluated')
    return {
      kind: 'topics',
      topics: request.evaluated.topics,
      dirtyThrough: request.evaluated.dirtyThrough,
      hasMore: request.evaluated.hasMore,
    };
  if (request.kind === 'topics')
    return { kind: 'topics', topics: request.topics, dirtyThrough: scope.revisionAtEntry, hasMore: false };
  const dirty = await p.readDirty(scope, { limit: EVALUATION.topicsPerRun });
  if (!dirty.anySupport) return { kind: 'none' };
  const topics = new Set(dirty.topics);
  if (request.alsoDueBy) {
    const due = await p.store.duePlaces(scope, request.alsoDueBy, 100);
    for (const id of await topicsOfPlacesIn(p, p.catalogue, scope, due)) topics.add(id);
  }
  return {
    kind: 'topics',
    topics: [...topics].sort((a, b) => p.catalogue.rank(a) - p.catalogue.rank(b)),
    dirtyThrough: scope.revisionAtEntry,
    hasMore: dirty.hasMore,
  };
}

interface Evaluation {
  /** The systems whose last support comes from what was read, not from what was stored. */
  readonly systemsRead: readonly string[];
  /** Topics read beside the evaluated ones, one key of each facet. */
  readonly neighbours: readonly string[];
  readonly facts: FormationFacts;
  readonly probes: readonly CoverageProbe[];
  readonly coverage: Coverage;
  readonly supportKeys: number;
  /** The topics evaluated in full. */
  readonly topics: readonly string[];
  /** The evaluated topics that have keys and no trusted support. */
  readonly untrusted: readonly string[];
  readonly pcRevision: number;
}

/**
 * The systems that need more than the touched topics to be judged, with how many other supported topics of each to read:
 * - A system that is not formed (or has no star yet) is judged on the units under it, and a place created now takes its
 *   last support from them, so the other supported topics under it are read, up to `neighbourTopics`.
 * - A planet that is due beside a formed system can be routed to the planets already formed there: the same.
 * - A formed system whose stored last support is newer than anything read under it is one whose support was just
 *   lowered (a retraction, withdrawn content): its true last support is in the other topics under it, so the most recently
 *   supported of them are read and the stored value is not trusted.
 * - A formed system or star with no stored last support has nothing to carry (it was formed before places stored one): the
 *   same, so a partial reading never judges it older than the topics beside it.
 * A formed system with nothing due beside it and nothing lowered needs no neighbour: reading one of its topics changes
 * that topic's places only, and the system's last support is the newest of what was read and what was stored.
 */
function systemsNeedingNeighbours(
  catalogue: Catalogue,
  facts: FormationFacts,
  topics: readonly string[],
): ReadonlyMap<string, number> {
  const stored = new Set(facts.objects.map((object) => object.key));
  const due = dueCreations(facts);
  const readLatest = new Map<string, number>();
  for (const support of facts.supports) {
    const systemId = catalogue.topic(support.topicId)?.parent;
    if (systemId)
      readLatest.set(
        systemId,
        Math.max(readLatest.get(systemId) ?? Number.NEGATIVE_INFINITY, Date.parse(support.activatedAt)),
      );
  }
  const wanted = new Map<string, number>();
  for (const id of topics) {
    const systemId = catalogue.topic(id)?.parent;
    if (!systemId || wanted.has(systemId)) continue;
    const systemKey = semanticKey('system', systemId);
    const formed = stored.has(systemKey) && stored.has(semanticKey('star', systemId));
    const planetDue =
      formed &&
      due.some(
        (operation) =>
          operation.kind === 'form_planet' &&
          facts.candidates.find((candidate) => candidate.key === operation.key)?.parentKey === systemKey,
      );
    const carried = facts.carriedSupportAt?.[systemKey];
    const lowered =
      formed && carried !== undefined && Date.parse(carried) > (readLatest.get(systemId) ?? Number.NEGATIVE_INFINITY);
    // A formed system or star with no stored last support (made before places stored it, or one that had no support) has
    // nothing to carry: what was read under it may be older than what is beside it, so the topics beside it are read.
    const unknown =
      formed && (carried === undefined || facts.carriedSupportAt?.[semanticKey('star', systemId)] === undefined);
    if (lowered || unknown || !formed || planetDue) wanted.set(systemId, EVALUATION.neighbourTopics);
  }
  return wanted;
}

/** How far one facet's keys have been read: `perFacet` keys a page, the page last read, and whether that page was full. */
interface FacetRead {
  readonly topicId: string;
  readonly facetId: string;
  readonly perFacet: number;
  readonly page: number;
  readonly full: boolean;
}

/** Records the keys one page returned for each facet; a facet with a full page may have more. */
function noteFacets(facets: Map<string, FacetRead>, found: readonly CoverageProbe[], perFacet: number, page: number) {
  const counts = new Map<string, { topicId: string; facetId: string; count: number }>();
  for (const probe of found) {
    const slot = JSON.stringify([probe.topicId, probe.facetId]);
    const entry = counts.get(slot) ?? { topicId: probe.topicId, facetId: probe.facetId, count: 0 };
    entry.count++;
    counts.set(slot, entry);
  }
  for (const [slot, entry] of counts)
    facets.set(slot, { topicId: entry.topicId, facetId: entry.facetId, perFacet, page, full: entry.count >= perFacet });
}

/**
 * The next page of keys of every facet that holds fewer trusted keys than it was asked for while its last page was full. Updates
 * `facets` to the pages it read. Empty when no facet needs more.
 */
async function nextKeyPage(
  p: ReadPorts,
  scope: PersonalScopeTx,
  facets: Map<string, FacetRead>,
  entries: readonly CoverageEntry[],
): Promise<CoverageProbe[]> {
  const trusted = new Map<string, number>();
  for (const { support } of entries) {
    const slot = JSON.stringify([support.topicId, support.facetId]);
    trusted.set(slot, (trusted.get(slot) ?? 0) + 1);
  }
  const wanted = new Map<string, { perFacet: number; page: number; facets: FacetRead[] }>();
  for (const [slot, read] of facets) {
    if (!read.full || (trusted.get(slot) ?? 0) >= read.perFacet) continue;
    const group = `${String(read.perFacet)}|${String(read.page + 1)}`;
    const entry = wanted.get(group) ?? { perFacet: read.perFacet, page: read.page + 1, facets: [] };
    entry.facets.push(read);
    wanted.set(group, entry);
  }
  const found: CoverageProbe[] = [];
  for (const { perFacet, page, facets: asked } of wanted.values()) {
    const read = await p.readInputs(scope, {
      topicIds: [...new Set(asked.map((facet) => facet.topicId))],
      onlyFacets: asked.map(({ topicId, facetId }) => ({ topicId, facetId })),
      perFacet,
      page,
    });
    found.push(...read.probes);
    noteFacets(facets, read.probes, perFacet, page);
    // A facet that returned nothing has no further keys.
    const returned = new Set(read.probes.map((probe) => JSON.stringify([probe.topicId, probe.facetId])));
    for (const facet of asked)
      if (!returned.has(JSON.stringify([facet.topicId, facet.facetId])))
        facets.set(JSON.stringify([facet.topicId, facet.facetId]), { ...facet, page, full: false });
  }
  return found;
}

/**
 * Reads the support of `base` topics (and, when asked, the other supported topics of `neighbourSystems`) through the
 * trusted read, and builds the facts of exactly those topics: their catalogue entries and their systems', the stored
 * places among them found by key, the routes already joining those planets, and the candidates the rules may form.
 */
async function evaluateTopics(
  p: PinnedPorts,
  scope: PersonalScopeTx,
  secret: string,
  base: readonly string[],
  given: readonly string[],
  expansions: ReadonlyMap<string, number>,
  systemsRead: ReadonlySet<string>,
): Promise<
  | { readonly kind: 'evaluated'; readonly evaluation: Evaluation }
  | { readonly kind: 'unavailable'; readonly reason: PreparationRefusal }
> {
  const evaluated = new Set(base);
  const mainKeys = keysFor(p.catalogue, base);
  const main = await p.readInputs(scope, { topicIds: base, perFacet: mainKeys });
  const probes: CoverageProbe[] = [...main.probes];
  // What each facet was read to, so a facet whose newest keys are not trusted is read further (below).
  const facets = new Map<string, FacetRead>();
  noteFacets(facets, main.probes, mainKeys, 0);
  const near = new Set<string>();
  // The neighbours an earlier evaluation read are read again as it read them: by the keys of each facet their system asks for.
  const givenBySystem = new Map<number, string[]>();
  for (const id of given) {
    const keys = neighbourKeys(p.catalogue, p.catalogue.topic(id)?.parent ?? id);
    givenBySystem.set(keys, [...(givenBySystem.get(keys) ?? []), id]);
  }
  for (const [keys, topicIds] of givenBySystem) {
    const earlier = await p.readInputs(scope, { topicIds, perFacet: keys });
    probes.push(...earlier.probes);
    noteFacets(facets, earlier.probes, keys, 0);
    for (const id of earlier.topics) near.add(id);
  }
  for (const [systemId, maxTopics] of expansions) {
    const children = p.catalogue
      .childrenOf(systemId)
      .map((topic) => topic.id)
      .filter((id) => !evaluated.has(id) && !near.has(id));
    const keys = neighbourKeys(p.catalogue, systemId);
    const found = await p.readInputs(scope, { topicIds: children, perFacet: keys, maxTopics });
    probes.push(...found.probes);
    noteFacets(facets, found.probes, keys, 0);
    for (const id of found.topics) near.add(id);
  }
  const topics = [...evaluated].sort((a, b) => p.catalogue.rank(a) - p.catalogue.rank(b));
  const neighbours = [...near].sort((a, b) => p.catalogue.rank(a) - p.catalogue.rank(b));
  const parts: Coverage[] = [];
  let entries: CoverageEntry[] = [];
  let newProbes: readonly CoverageProbe[] = probes;
  for (let page = 0; ; page++) {
    if (newProbes.length) {
      const read = await readTrustedInBatches(p, scope, newProbes);
      if (read.kind === 'unavailable') return read;
      parts.push(read.coverage);
      entries = supportEntries(p, mergeCoverage(parts));
    }
    // A key that is not trusted (withdrawn content) must not hide an older one that is: a facet that holds fewer trusted keys
    // than it was asked for, and may hold more, is read a page further, so the evaluation equals the whole catalogue's.
    if (page >= EVALUATION.maxKeyPages) break;
    const further = await nextKeyPage(p, scope, facets, entries);
    if (!further.length) break;
    probes.push(...further);
    newProbes = further;
  }
  const coverage = mergeCoverage(parts);
  const supports = entries.map((entry) => entry.support);
  const stored = await p.store.places(scope, placeKeys(p.catalogue, [...topics, ...neighbours]));
  const objects = stored.map((entry) => entry.place);
  const routes: readonly Route[] = await p.store.routes(
    scope,
    routePairKeys(objects.filter((object) => object.kind === 'planet')),
  );
  // A system whose other topics were read has its last support from what was read; any other keeps what it was last seen with.
  const carried = Object.fromEntries(
    stored.flatMap((entry: StoredPlace) =>
      (entry.place.kind === 'system' || entry.place.kind === 'star') &&
      entry.lastSupportAt &&
      !systemsRead.has(entry.place.conceptId)
        ? [[entry.place.key, entry.lastSupportAt]]
        : [],
    ),
  );
  const supported = new Set(supports.map((support) => support.topicId));
  const probed = new Set(probes.map((probe) => probe.topicId));
  const untrusted = topics.filter((id) => probed.has(id) && !supported.has(id));
  const relevant = relevantTopics(p.catalogue, supports, objects);
  // Planets and regions of the neighbours were read as a sample: they may join a route, but their activity is their own topic's to decide.
  const own = new Set(placeKeys(p.catalogue, topics));
  const sampled = placeKeys(p.catalogue, neighbours).filter(
    (key) => !own.has(key) && objects.some((object) => object.key === key),
  );
  const facts: FormationFacts = {
    catalogue: relevant.map(conceptOf),
    supports,
    candidates: candidates(p, secret, new Map(objects.map((object) => [object.key, object])), supports, relevant),
    objects,
    routes,
    evaluatedAt: p.now().toISOString(),
    completeness: 'not_asserted',
    ...(Object.keys(carried).length ? { carriedSupportAt: carried } : {}),
    ...(sampled.length ? { contextOnly: sampled } : {}),
  };
  // The frozen proof keeps each support's witnesses (their digests name the certificates); the certificates stay in
  // Personal Context, so a context holds a few hundred bytes of proof per support, not a certificate each.
  const kept: Coverage = {
    ...coverage,
    supports: entries.map((entry) => entry.source),
    witnesses: entries.flatMap((entry) => entry.witnesses),
    certificates: [],
  };
  return {
    kind: 'evaluated',
    evaluation: {
      systemsRead: [...systemsRead].sort(),
      neighbours,
      facts,
      probes,
      coverage: kept,
      supportKeys: entries.length,
      topics,
      untrusted,
      pcRevision: main.revision,
    },
  };
}

/**
 * Whether the reader's other recent topics hold trusted support, for a run whose evaluated topics held none. Only the
 * answer is used: the sample is read through the same trusted read and checks, but never enters the facts, so it changes no
 * place. A reader with trusted support elsewhere is healthy (`no_changes`); one with none anywhere is `no_trusted_support`.
 */
async function sampledTrusted(
  p: PinnedPorts,
  scope: PersonalScopeTx,
  exclude: readonly string[],
): Promise<boolean> {
  const found = await p.readInputs(scope, { recent: { limit: EVALUATION.sampleTopics, exclude }, perFacet: 1 });
  if (!found.probes.length) return false;
  const read = await readTrustedInBatches(p, scope, found.probes);
  return read.kind === 'read' && supportEntries(p, read.coverage).length > 0;
}

/**
 * Freezes what one evaluation reads: the facts of the topics it evaluates and the trusted support behind them. Pure
 * function of the pinned catalogue, the exact trusted supports of those topics and the stored places; the model never
 * sees or names anything else, so formation costs what changed, never the catalogue or the person's history (D-416).
 *
 * A Cartographer run (`dirty`) takes the newest dirty topics. When a place of one of their systems could be created now
 * (the system is not formed, or a planet is due beside planets already formed), or the system's last support was just
 * lowered, it also reads other supported topics of that system (`systemsNeedingNeighbours`), so the rules judge it on what is
 * under it. The apply
 * (`evaluated`) reads exactly the topics the context froze, so its facts are the same facts under today's authority.
 *
 * Returns why no context was prepared as a typed refusal, so the caller can record a distinct outcome. A reader with no
 * coverage reference yet is refused before any coverage is read or any identity made.
 */
export async function prepareGeography(
  ports: PreparationPorts,
  cap: RecordingScopeTx,
  request: PreparationRequest,
  options: PreparationOptions = {},
): Promise<GeographyPreparation> {
  // One release of the catalogue for the whole evaluation, read before anything else (D-419): the context pins it.
  const p: PinnedPorts = { ...ports, catalogue: await pinnedCatalogue(ports, options) };
  await p.store.root(cap);
  const scope = cap.personal;
  const structure = await p.store.structure(scope);
  if (structure.objects > 1000 || structure.relations > 1000) return refused('structure_limit');
  const chosen = await chooseTopics(p, scope, request);
  if (chosen.kind === 'none') return refused('no_support_yet');
  const state = await p.store.state(scope);
  const secret = (await p.store.placeSecret(scope, options.readOnly !== true)) ?? p.seed();
  const incremental = request.kind === 'dirty';
  const reread = new Set(request.kind === 'evaluated' ? (request.evaluated.systemsRead ?? []) : []);
  const earlier = request.kind === 'evaluated' ? (request.evaluated.neighbours ?? []) : [];
  let base = chosen.topics;
  let hasMore = chosen.hasMore;
  for (;;) {
    let result = await evaluateTopics(p, scope, secret, base, earlier, new Map(), reread);
    if (result.kind === 'evaluated' && incremental) {
      const expansions = systemsNeedingNeighbours(p.catalogue, result.evaluation.facts, result.evaluation.topics);
      if (expansions.size)
        result = await evaluateTopics(p, scope, secret, base, [], expansions, new Set(expansions.keys()));
    }
    if (result.kind === 'unavailable')
      return refused(result.reason, incremental ? { topics: base, dirtyThrough: chosen.dirtyThrough } : undefined);
    const { evaluation } = result;
    const otherTrusted =
      incremental && evaluation.probes.length > 0 && evaluation.supportKeys === 0
        ? await sampledTrusted(p, scope, [...evaluation.topics, ...evaluation.neighbours])
        : false;
    const { evaluatedAt: _time, ...authorityFacts } = evaluation.facts;
    const context: GeographyContext = {
      version: 'cartographer-context.v1',
      catalogueRelease: p.catalogue.releaseId,
      universeId: scope.authority.universeId,
      privacyEpoch: scope.authority.privacyEpoch,
      transitionId: p.newId(),
      desiredRevision: state.desiredRevision,
      pcRevision: evaluation.pcRevision,
      scopeRevision: scope.revisionAtEntry,
      probes: evaluation.probes,
      facts: evaluation.facts,
      factsSha256: p.hash({ facts: authorityFacts, coverage: evaluation.coverage }),
      coverage: evaluation.coverage,
      base: {
        revision: state.revision,
        structureRevision: state.structureRevision,
        activityRevision: state.activityRevision,
      },
      evaluated: {
        topics: evaluation.topics,
        dirtyThrough: chosen.dirtyThrough,
        hasMore,
        ...(evaluation.neighbours.length ? { neighbours: evaluation.neighbours } : {}),
        ...(evaluation.systemsRead.length ? { systemsRead: evaluation.systemsRead } : {}),
        ...(evaluation.untrusted.length ? { untrusted: evaluation.untrusted } : {}),
        ...(otherTrusted ? { otherTrusted: true as const } : {}),
      },
    };
    if (new TextEncoder().encode(JSON.stringify(context)).byteLength <= EVALUATION.contextBytes)
      return { kind: 'prepared', context, supportKeys: evaluation.supportKeys, structure };
    // Too much for one frozen context: take fewer of the dirty topics and leave the rest for the next run.
    if (!incremental || base.length <= 1)
      return refused(
        'context_too_large',
        incremental ? { topics: base, dirtyThrough: chosen.dirtyThrough } : undefined,
      );
    base = base.slice(0, Math.ceil(base.length / 2));
    hasMore = true;
  }
}
