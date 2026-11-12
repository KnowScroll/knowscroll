import { z } from 'zod';
import { overlapOf, textHasAddress, textHasMarkup, tokensOf } from '../library/recipe-draft.js';
import type { NodeDraft } from './plan-import.js';
import { normalised, type RefusalCode, type ReleaseChange } from './release.js';
import type { CatalogueConcept, CatalogueSnapshot } from './snapshot.js';

/**
 * Topic growth (#674, D-422): new topics grow under the systems that exist, from pages code finds, with a model proposing where a
 * page belongs and which facets it has and code admitting (or refusing) the proposal. Everything here is pure: no clock, no
 * storage, no network, no model. The model's words are checked, never trusted: an id is always derived by code from a label,
 * a system is one code offered, and every facet quotes a passage the page really holds.
 */

/**
 * Every number the step reads, in one place, named by a version that is recorded on each candidate row. Changing any of them is a
 * new version, so an earlier decision is read against the numbers it was made under.
 */
export const TOPIC_GROWTH_POLICY = Object.freeze({
  version: 'topic-growth.v1',
  /** A page gives the writer at least this many evidence passages, or it is a stub (a recipe needs a pool of six). */
  minEvidencePassages: 8,
  /** A page title that shares at least this much of its words with an existing topic's label is that topic again. */
  titleOverlapLimit: 0.6,
  /** A topic has three to five facets (the catalogue accepts two to sixteen). */
  facetsMin: 3,
  facetsMax: 5,
  /** A facet quotes between these many characters of one passage. */
  quoteMin: 40,
  quoteMax: 400,
  /** Failed proposing attempts a candidate may have before it is refused, on different days. */
  attemptsPerCandidate: 2,
  /** Failed reads of a page before it is rejected as unreachable. */
  fetchAttempts: 3,
  /** Links one research page may give, and candidates one page may contribute. */
  linksPerPage: 300,
  candidatesPerSource: 10,
  /** What one scheduled pass reads: research pages for their links, and candidate pages for their text. */
  sourcesPerPass: 2,
  readsPerPass: 5,
  /** Below this many eligible candidates a pass looks for more. */
  eligibleLowWater: 3,
  /** What the model is shown: systems, the topics each already has, the lead of the page. */
  systemsOffered: 12,
  topicsListedPerSystem: 12,
  leadPassages: 8,
  leadPassageChars: 700,
  leadChars: 5000,
});

/** Why a page is not a candidate for a topic. Codes only. A page that could not be read is `page_<code of the fetch>`. */
export const CANDIDATE_REJECTIONS = [
  'not_an_article',
  'disambiguation',
  'list_page',
  'stub',
  'duplicate_topic',
  'duplicate_page',
  'recipe_page',
  'page_unreachable',
] as const;
export type CandidateRejection = (typeof CANDIDATE_REJECTIONS)[number] | `page_${string}`;

const NAMESPACE =
  /^(?:category|template|portal|help|talk|special|file|wikipedia|draft|user|module|mediawiki|book)\s*:/iu;
const LIST_TITLE =
  /^(?:lists?|index|outline|glossary|timeline|comparison|table|catalog(?:ue)?) of\b|\((?:list|lists|index|timeline)\)$/iu;
const DISAMBIGUATION = /\(disambiguation\)|\bdisambiguation\b/iu;
const MAY_REFER = /\b(?:may|can|could) (?:also )?(?:refer|mean)\b/iu;
const IS_A_LIST = /\b(?:is|are) (?:a|an) (?:\w+ ){0,3}list of\b/iu;

/** The title a page's `<title>` names, without the site that follows it ("Heart valve - Wikipedia" is "Heart valve"). */
export function cleanTitle(raw: string): string {
  const text = raw.replace(/\s+/gu, ' ').trim();
  const cut = /^(.{2,}?)\s+[-–—|·]\s+[^-–—|·]{2,40}$/u.exec(text);
  return (cut?.[1] ?? text).trim();
}

/** The title an address names, for the pages that name it in the last part of their path (`/wiki/Heart_valve`); `undefined` where none does. */
export function urlTitleOf(url: string): string | undefined {
  const last = /^https:\/\/[^/]+\/(?:wiki\/)?([^/?#]+)$/u.exec(url)?.[1];
  if (last === undefined) return undefined;
  try {
    return decodeURIComponent(last).replaceAll('_', ' ');
  } catch {
    return undefined;
  }
}

/** What a title alone shows a page is not: an ordinary article of one subject. */
export function titleVerdict(title: string): 'not_an_article' | 'disambiguation' | 'list_page' | undefined {
  if (NAMESPACE.test(title)) return 'not_an_article';
  if (DISAMBIGUATION.test(title)) return 'disambiguation';
  if (LIST_TITLE.test(title)) return 'list_page';
  return undefined;
}

/** Whether a title is an existing topic's label said again: the same words, or at least the policy's share of them. */
export function duplicatesTopic(title: string, labels: readonly string[]): boolean {
  const wanted = tokensOf(title);
  if (wanted.size === 0) return false;
  return labels.some((label) => {
    const own = tokensOf(label);
    if (own.size === 0) return false;
    const same = own.size === wanted.size && [...own].every((token) => wanted.has(token));
    return same || overlapOf(title, label) >= TOPIC_GROWTH_POLICY.titleOverlapLimit;
  });
}

/** What a page that has been read shows of it. */
export interface PageFacts {
  readonly title: string;
  /** The page's first paragraph. */
  readonly lead: string;
  /** How many evidence passages the page gives a writer (`evidencePassageCount`). */
  readonly evidencePassages: number;
}

/**
 * Decides whether a page that has been read may be proposed for: an ordinary article (not a namespace page, a disambiguation or a
 * list), long enough to give a writer its passages, and not an existing topic again. The first filter that fails names the code.
 */
export function candidateVerdict(
  page: PageFacts,
  topicLabels: readonly string[],
): { readonly kind: 'eligible' } | { readonly kind: 'rejected'; readonly code: CandidateRejection } {
  const title = titleVerdict(page.title);
  if (title !== undefined) return { kind: 'rejected', code: title };
  if (MAY_REFER.test(page.lead)) return { kind: 'rejected', code: 'disambiguation' };
  if (IS_A_LIST.test(page.lead)) return { kind: 'rejected', code: 'list_page' };
  if (page.evidencePassages < TOPIC_GROWTH_POLICY.minEvidencePassages) return { kind: 'rejected', code: 'stub' };
  if (duplicatesTopic(page.title, topicLabels)) return { kind: 'rejected', code: 'duplicate_topic' };
  return { kind: 'eligible' };
}

/** The address of a link is worth reading only if its title does not already show it is no article. */
export function seedLinkVerdict(url: string): 'ok' | 'not_an_article' | 'disambiguation' | 'list_page' {
  const title = urlTitleOf(url);
  return (title === undefined ? undefined : titleVerdict(title)) ?? 'ok';
}

/** A slug of a label for an id: lower-case ASCII words joined by hyphens, starting with a letter; `undefined` when the label makes none. */
export function slugOfLabel(label: string): string | undefined {
  const slug = label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(slug) && slug.length <= 60 ? slug : undefined;
}

/** What the model is told of a system it may place a topic under. All of it is built by code from the catalogue. */
export interface OfferedSystem {
  readonly id: string;
  readonly label: string;
  readonly meaning: string;
  /** How many topics (servable or not) the system has. */
  readonly topics: number;
  /** The labels of some of them, so the model does not propose one again. */
  readonly topicLabels: readonly string[];
}

const topicsOfSystem = (snapshot: CatalogueSnapshot, systemId: string): readonly CatalogueConcept[] =>
  snapshot.allTopics().filter((topic) => topic.parent === systemId);

/**
 * The systems a model is offered for a page: the active systems that have room under the size limit (a system with `maxTopics`
 * topics, servable or not, has none), all of them while there are no more than the policy shows, otherwise the ones whose
 * label, meaning, topics and facets share the most key words with the page, best first, and none that share no word. Pure and
 * bounded however large the catalogue grows. A system outside the list cannot be named.
 */
export function offeredSystems(
  snapshot: CatalogueSnapshot,
  pageText: string,
  maxTopics: number,
  limit: number = TOPIC_GROWTH_POLICY.systemsOffered,
): readonly OfferedSystem[] {
  const wanted = tokensOf(pageText);
  const withRoom = snapshot
    .all()
    .filter((concept) => concept.kind === 'system' && !concept.retired)
    .flatMap((system, at) => {
      const topics = topicsOfSystem(snapshot, system.id);
      if (topics.length >= maxTopics) return [];
      const own = tokensOf(
        [system.label, system.meaning, ...topics.flatMap((topic) => [topic.label, topic.meaning])].join(' '),
      );
      let shared = 0;
      for (const token of own) if (wanted.has(token)) shared += 1;
      return [{ system, topics, shared, at }];
    });
  const chosen =
    withRoom.length <= limit
      ? withRoom
      : withRoom
          .filter((entry) => entry.shared > 0)
          .sort((a, b) => b.shared - a.shared || a.at - b.at)
          .slice(0, limit);
  return chosen.map((entry) => ({
    id: entry.system.id,
    label: entry.system.label,
    meaning: entry.system.meaning,
    topics: entry.topics.length,
    topicLabels: entry.topics.slice(0, TOPIC_GROWTH_POLICY.topicsListedPerSystem).map((topic) => topic.label),
  }));
}

/** Whether any active system still has room under the size limit: when none does, no page can be proposed a place. */
export function hasRoom(snapshot: CatalogueSnapshot, maxTopics: number): boolean {
  return snapshot
    .all()
    .some(
      (concept) =>
        concept.kind === 'system' && !concept.retired && topicsOfSystem(snapshot, concept.id).length < maxTopics,
    );
}

/** The passages a model reads of a page: the first ones, each cut at a word, within the policy's budget. */
export function leadPassages(passages: readonly string[]): readonly string[] {
  const lead: string[] = [];
  let characters = 0;
  for (const passage of passages.slice(0, TOPIC_GROWTH_POLICY.leadPassages)) {
    const cut =
      passage.length <= TOPIC_GROWTH_POLICY.leadPassageChars
        ? passage
        : `${passage.slice(0, TOPIC_GROWTH_POLICY.leadPassageChars).replace(/\s+\S*$/u, '')}`;
    if (characters + cut.length > TOPIC_GROWTH_POLICY.leadChars) break;
    lead.push(cut);
    characters += cut.length;
  }
  return lead;
}

const FacetSchema = z.strictObject({
  label: z.string().trim().min(2).max(80),
  meaning: z.string().trim().min(16).max(300),
  quote: z.string().trim().min(TOPIC_GROWTH_POLICY.quoteMin).max(TOPIC_GROWTH_POLICY.quoteMax),
});
const TopicSchema = z.strictObject({
  systemId: z.string().min(1).max(160),
  label: z.string().trim().min(2).max(80),
  meaning: z.string().trim().min(16).max(300),
  facets: z.array(FacetSchema).min(TOPIC_GROWTH_POLICY.facetsMin).max(TOPIC_GROWTH_POLICY.facetsMax),
});

/** What the proposal role returns: one topic, or none when the page fits no system it was offered. */
export const TopicProposalOutputSchema = z.strictObject({ topics: z.array(TopicSchema).max(1) });
export type TopicProposalOutput = z.infer<typeof TopicProposalOutputSchema>;

/** Why code did not admit a proposal. Codes only: nothing the model wrote is kept. A refusal of the catalogue's own admission is `catalogue_<code>`. */
export const TOPIC_REFUSALS = [
  'system_unknown',
  'system_not_offered',
  'system_full',
  'text_has_address',
  'text_has_markup',
  'label_unsluggable',
  'label_collision',
  'id_collision',
  'duplicate_topic',
  'facet_label_unsluggable',
  'facet_duplicate',
  'facets_too_few',
  'quote_not_in_page',
  'quote_repeated',
] as const;
export type TopicRefusal = (typeof TOPIC_REFUSALS)[number] | `catalogue_${RefusalCode}`;

export type TopicVerdict =
  /** The page fits no system it was offered: the model said so. Not an error, and nothing is stored. */
  | { readonly kind: 'declined' }
  | {
      readonly kind: 'admitted';
      readonly systemId: string;
      readonly topicId: string;
      readonly facetIds: readonly string[];
      /** The changes of the release: the topic and its facets, none of them servable yet. */
      readonly changes: readonly ReleaseChange[];
    }
  | { readonly kind: 'refused'; readonly code: TopicRefusal };

/** What admission reads, all of it by code. */
export interface TopicAdmissionContext {
  readonly snapshot: CatalogueSnapshot;
  /** The system ids the model was offered: the only ones it may name. */
  readonly offered: readonly string[];
  /** The size limit of a system (`KS_TOPIC_GROWTH_MAX_PER_SYSTEM`). */
  readonly maxTopicsPerSystem: number;
  /** The paragraphs of the candidate page, as the research fetch froze them. */
  readonly passages: readonly string[];
}

const squash = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/**
 * Decides one proposal. The proposal is the model's; every other input is code's. The first check it fails names its refusal.
 * It must name a system code offered, which still exists and has room; carry no address or markup; make a label that gives an id
 * of the plan's shape that no node (of any status) already has, and that no existing topic's label equals or nearly equals; have
 * at least three facets with distinct labels, each quoting a stretch of the page, no two quoting the same one. What passes is the
 * topic and its facets as `add` changes, which the catalogue's own admission (`planRelease`) then checks again: the topic is not
 * servable until the library has released supply for it.
 */
export function admitTopicProposal(output: TopicProposalOutput, context: TopicAdmissionContext): TopicVerdict {
  const refuse = (code: TopicRefusal): TopicVerdict => ({ kind: 'refused', code });
  const [proposal] = output.topics;
  if (proposal === undefined) return { kind: 'declined' };
  const { snapshot } = context;
  const system = snapshot.concept(proposal.systemId);
  if (system === undefined || system.kind !== 'system' || system.retired) return refuse('system_unknown');
  if (!context.offered.includes(system.id)) return refuse('system_not_offered');
  if (topicsOfSystem(snapshot, system.id).length >= context.maxTopicsPerSystem) return refuse('system_full');

  const texts = [proposal.label, proposal.meaning, ...proposal.facets.flatMap((facet) => [facet.label, facet.meaning])];
  if (texts.some(textHasAddress)) return refuse('text_has_address');
  if (texts.some(textHasMarkup)) return refuse('text_has_markup');

  const slug = slugOfLabel(proposal.label);
  if (slug === undefined) return refuse('label_unsluggable');
  const topicId = `${system.id}.${slug}`;
  if (snapshot.has(topicId)) return refuse('id_collision');
  const labels = snapshot.allTopics().map((topic) => topic.label);
  if (labels.some((label) => normalised(label) === normalised(proposal.label))) return refuse('label_collision');
  if (duplicatesTopic(proposal.label, labels)) return refuse('duplicate_topic');

  const facetSlugs: string[] = [];
  for (const facet of proposal.facets) {
    const facetSlug = slugOfLabel(facet.label);
    if (facetSlug === undefined) return refuse('facet_label_unsluggable');
    if (facetSlugs.includes(facetSlug)) return refuse('facet_duplicate');
    facetSlugs.push(facetSlug);
  }
  if (proposal.facets.length < TOPIC_GROWTH_POLICY.facetsMin) return refuse('facets_too_few');

  const page = context.passages.map(squash);
  const quotes = proposal.facets.map((facet) => squash(facet.quote));
  if (quotes.some((quote) => !page.some((passage) => passage.includes(quote)))) return refuse('quote_not_in_page');
  if (quotes.some((quote, at) => quotes.some((other, to) => at !== to && quote.includes(other))))
    return refuse('quote_repeated');

  const topic: NodeDraft = {
    id: topicId,
    kind: 'topic',
    parentId: system.id,
    label: proposal.label,
    meaning: proposal.meaning,
    sceneFamily: null,
    haze: null,
    sameMeaningAs: [],
  };
  const facetIds = facetSlugs.map((facetSlug) => `${topicId}.${facetSlug}`);
  const facets = proposal.facets.map((facet, at): NodeDraft => ({
    id: facetIds[at]!,
    kind: 'facet',
    parentId: topicId,
    label: facet.label,
    meaning: facet.meaning,
    sceneFamily: null,
    haze: null,
    sameMeaningAs: [],
  }));
  return {
    kind: 'admitted',
    systemId: system.id,
    topicId,
    facetIds,
    changes: [topic, ...facets].map((draft) => ({ kind: 'add' as const, draft })),
  };
}
