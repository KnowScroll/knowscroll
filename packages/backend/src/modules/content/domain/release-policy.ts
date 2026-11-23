import type { CatalogueSnapshot } from './catalogue/snapshot.js';
import {
  NON_PROSE_KEYS,
  ORDINARY_SYSTEMS,
  RECENT_YEAR_FROM,
  RECENT_YEAR_TO,
  SENSITIVE_CATEGORIES,
  SENSITIVE_KEYWORDS,
  SENSITIVE_SYSTEMS,
  type SensitiveCategory,
} from './release-sensitive-data.js';

/**
 * The release policy of held library Scrolls (#674, D-418). While the library support check is measured, an operator reads every
 * generated Scroll. This is the rule that, once the owner turns it on, lets a worker release a later Scroll of a topic a person has approved,
 * and no other. Everything here is pure: the adapter reads the facts and applies the decision, and nothing here is ever evidence.
 *
 * What a policy release needs, all of it: a new Scroll (nothing is served for the asset yet, or only a document v1 or v2 that a document v3 replaces: D-435, decisions 6 and 9 on #771), a topic a person approved, no sensitive category
 * by the catalogue, the words or a recorded raise, a readable and mapped document, an answer check that passed, and a library support check
 * of the current checker version that passed. Anything else stays held for a person. The same rules judge a document v2 and a document v3 (D-435); "the
 * current checker version" is the one that reads the revision's own document, which the adapter chooses before these facts reach here.
 */

/** The decision's name in `content.revision_reviews.decided_by` (`policy:<name>`). Any change to what the policy requires is a new name. */
export const RELEASE_POLICY = {
  id: 'approved-topic-supported.v2',
  decidedBy: 'policy:approved-topic-supported.v2',
} as const;

/** Every decision this policy makes starts with this; a person's decision starts with `cli:`. The replay of the support check counts `cli:` decisions only. */
export const POLICY_DECIDER_PREFIX = 'policy:';

/** How risky a Scroll is to release unread. A model may only move a Scroll up, never down. */
export type RiskClass = 'ordinary' | 'sensitive';

const RISK_RANK: Readonly<Record<RiskClass, number>> = { ordinary: 0, sensitive: 1 };

/**
 * The class after a proposal: the higher of the two. A proposal that would lower the class changes nothing, so a model's opinion (or a keyword
 * match, or a later rule) can make a Scroll wait for a person but can never let one through.
 */
export function raiseRisk(current: RiskClass, proposed: RiskClass): RiskClass {
  return RISK_RANK[proposed] > RISK_RANK[current] ? proposed : current;
}

/** What put a Scroll in the sensitive class. */
export type RiskReason =
  /** The catalogue: the Scroll's topic belongs to a system the data file names. */
  | 'catalogue'
  /** The Scroll's own words (or a recent year) match the data file. */
  | 'keyword'
  /** A model, or a person, recorded a raise for this revision. */
  | 'proposal'
  /** The topic is not in the catalogue, so nothing says what it is. */
  | 'unknown_topic';

export interface RiskAssessment {
  readonly riskClass: RiskClass;
  /** The categories that apply, in the data file's order; empty for an ordinary Scroll and for an unknown topic. */
  readonly categories: readonly SensitiveCategory[];
  readonly reasons: readonly RiskReason[];
}

/**
 * Whether the id is a topic (a planet) of the release: a system and a facet are not topics, and only a topic may be approved. Exact membership, like
 * every catalogue lookup. A topic a release retired is not one: nothing new is released for it.
 */
export function isCatalogueTopic(catalogue: CatalogueSnapshot, topicId: string): boolean {
  const concept = catalogue.concept(topicId);
  return concept?.kind === 'topic' && !concept.retired;
}

/** The sensitive categories the catalogue puts a topic in, through its system; empty for an ordinary topic and for an id the catalogue does not hold. */
export function categoriesOfTopic(catalogue: CatalogueSnapshot, topicId: string): readonly SensitiveCategory[] {
  const system = catalogue.systemOf(topicId);
  return system === undefined ? [] : (SENSITIVE_SYSTEMS[system] ?? []);
}

/** Whether the owner has decided the topic's system, as sensitive or as ordinary. A system a release added is undecided until the owner decides it. */
export function isSystemDecided(catalogue: CatalogueSnapshot, topicId: string): boolean {
  const system = catalogue.systemOf(topicId);
  return system !== undefined && (system in SENSITIVE_SYSTEMS || ORDINARY_SYSTEMS.includes(system));
}

const escapeRegex = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** One word or phrase as a pattern: spaces match any run of white space, and a trailing `*` accepts any ending of the stem. */
function patternOf(entry: string): string {
  const prefix = entry.endsWith('*');
  const stem = escapeRegex(prefix ? entry.slice(0, -1) : entry).replaceAll(/\s+/gu, String.raw`\s+`);
  return prefix ? `${stem}[\\p{L}]*` : stem;
}

/** Whole words only: a letter, digit or underscore on either side means the match is inside a longer word. */
const KEYWORD_PATTERNS: ReadonlyMap<SensitiveCategory, RegExp> = new Map(
  SENSITIVE_CATEGORIES.map((category) => [
    category,
    new RegExp(
      `(?<![\\p{L}\\p{N}_])(?:${SENSITIVE_KEYWORDS[category].map(patternOf).join('|')})(?![\\p{L}\\p{N}_])`,
      'iu',
    ),
  ]),
);

const YEAR = /(?<![\p{L}\p{N}_.,])(\d{4})(?![\p{L}\p{N}_])/gu;

/** Whether the text names a year in the data file's recent range. */
function namesRecentYear(text: string): boolean {
  for (const match of text.matchAll(YEAR)) {
    const year = Number(match[1]);
    if (year >= RECENT_YEAR_FROM && year <= RECENT_YEAR_TO) return true;
  }
  return false;
}

/**
 * Every string of a stored document that is its words, joined by line breaks: the title, kicker and dek, each stop's lines, simpler words, guide, play
 * blocks and calls, the asides, the recap, the Ask suggestions, the picture's descriptions and the misconception. It walks the document's own fields and takes
 * every string except the values under {@link NON_PROSE_KEYS} (identity, versions, measures, the integrity hash, references between parts), so nothing is
 * filtered out of a text by its look and a field added to the format is scanned until the owner says it is not words. A document v3 is read with
 * `NON_PROSE_KEYS_V3` (`nonProseKeys`), which adds the references its parts make to one another; a v1 or v2 document is read with the default, as it always was. Pure.
 */
export function proseOf(value: unknown, nonProseKeys: ReadonlySet<string> = NON_PROSE_KEYS): string {
  const strings: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') strings.push(node);
    else if (Array.isArray(node)) for (const item of node) walk(item);
    else if (typeof node === 'object' && node !== null)
      for (const [key, child] of Object.entries(node)) if (!nonProseKeys.has(key)) walk(child);
  };
  walk(value);
  return strings.join('\n');
}

/** The sensitive categories the words of a Scroll put it in, in the data file's order. The text is whatever a reader (or an operator) reads. */
export function categoriesOfText(text: string): readonly SensitiveCategory[] {
  const found = SENSITIVE_CATEGORIES.filter((category) => KEYWORD_PATTERNS.get(category)?.test(text) === true);
  return namesRecentYear(text) && !found.includes('current_events') ? [...found, 'current_events'] : found;
}

/**
 * The risk of releasing a Scroll unread: ordinary only when the catalogue knows its topic, the topic and the words match nothing in the data
 * file, and nobody recorded a raise. `raised` is what a proposal recorded for this revision (`content.release_risk_raises`); it can only add.
 */
export function assessRisk(input: {
  /** The release of the catalogue the topic is looked up in. */
  readonly catalogue: CatalogueSnapshot;
  /** The primary topic the Scroll is attributed to, or `null` when it has none. */
  readonly topicId: string | null;
  readonly text: string;
  readonly raised: readonly SensitiveCategory[];
}): RiskAssessment {
  const byTopic = input.topicId === null ? [] : categoriesOfTopic(input.catalogue, input.topicId);
  const byText = categoriesOfText(input.text);
  // A topic the catalogue does not hold, or one of a system the owner has not decided yet, says nothing about what it is: it waits for a person.
  const unknownTopic =
    input.topicId !== null &&
    (!isCatalogueTopic(input.catalogue, input.topicId) || !isSystemDecided(input.catalogue, input.topicId));
  const categories = SENSITIVE_CATEGORIES.filter(
    (category) => byTopic.includes(category) || byText.includes(category) || input.raised.includes(category),
  );
  const proposals: readonly (readonly [RiskReason, boolean])[] = [
    ['catalogue', byTopic.length > 0],
    ['keyword', byText.length > 0],
    ['proposal', input.raised.length > 0],
    ['unknown_topic', unknownTopic],
  ];
  const reasons = proposals.flatMap(([reason, applies]) => (applies ? [reason] : []));
  // Each source proposes a class and the highest wins: nothing here can bring a Scroll back down.
  const riskClass = proposals.reduce<RiskClass>(
    (current, [, applies]) => raiseRisk(current, applies ? 'sensitive' : 'ordinary'),
    'ordinary',
  );
  return { riskClass, categories, reasons };
}

/** What the production job's answer check said about the Scroll's calls (D-198). `none`: no check ran for the revision. */
export type AnswerCheckFact = 'passed' | 'repaired' | 'unchecked' | 'flagged' | 'none';

/**
 * What the library support check (D-415) said, for the checker version of this build that reads the revision's document only (a v2's or a v3's, D-435).
 * - `none`: no result at all.
 * - `stale`: results exist, but only for another checker version, which says nothing about the sentences as they are checked now.
 * - `unchecked`: the current version ran and gave nothing usable.
 * - `checked`: the current version gave a verdict, decided by code from every sentence.
 */
export type SupportCheckFact =
  | { readonly kind: 'none' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'unchecked' }
  | { readonly kind: 'checked'; readonly verdict: 'passed' | 'flagged' };

/** The facts a policy release is decided from, all read from stored rows. */
export interface AutoReleaseFacts {
  /**
   * The asset's status: a new asset (`held`, nothing served yet) is eligible. A replacement of a served Scroll is a person's call, except
   * for a document v3 over a served document v1 or v2 (`mayReplaceServed`).
   */
  readonly assetStatus: 'held' | 'admitted' | 'withdrawn';
  /** The schema of the revision judged (`scroll-document.v2` or `.v3`). */
  readonly documentVersion: string;
  /** The schema of the revision the asset serves now, or `null` when it serves none (a new asset, or a withdrawn one). */
  readonly servedDocumentVersion: string | null;
  readonly topicId: string | null;
  /** A person approved this topic and has not revoked it. */
  readonly topicApproved: boolean;
  readonly risk: RiskAssessment;
  readonly documentReadable: boolean;
  /** An active coverage mapping is at the head for the revision (what formation needs). */
  readonly coverageMapped: boolean;
  readonly answerCheck: AnswerCheckFact;
  readonly supportCheck: SupportCheckFact;
}

/** Why a held Scroll stays held, as a code. Never a sentence of the Scroll. */
export const AUTO_RELEASE_HOLDS = [
  'replaces_served',
  'no_topic',
  'sensitive',
  'topic_not_approved',
  'unreadable',
  'unmapped',
  'answer_check_not_passed',
  'no_support_check',
  'stale_support_check',
  'support_unchecked',
  'support_flagged',
] as const;
export type AutoReleaseHold = (typeof AUTO_RELEASE_HOLDS)[number];

/**
 * What stops a release inside the transaction that would make it: a hold the facts give when they are read there, the day's cap, or a revision that is
 * no longer held (`not_held`, which the review gate's own checks make unreachable and which is kept so that a guard never has to guess).
 */
export type AutoReleaseRefusal = AutoReleaseHold | 'daily_cap_reached' | 'not_held';

/**
 * The holds nothing but a person or a new version of the rules can change: the Scroll's words, its document, its answer check, its attribution and a verdict of
 * the current checker version are all fixed once stored, so the sweep does not read such a revision again under the rules it was judged by. Every other hold
 * (a topic without an approval, a missing check) can pass later.
 */
export const PERMANENT_HOLDS: readonly AutoReleaseHold[] = [
  'no_topic',
  'sensitive',
  'unreadable',
  'answer_check_not_passed',
  'support_flagged',
];

export type AutoReleaseDecision =
  { readonly kind: 'release' } | { readonly kind: 'hold'; readonly reason: AutoReleaseHold };

const hold = (reason: AutoReleaseHold): AutoReleaseDecision => ({ kind: 'hold', reason });

// The domain is pure (no import of scroll-model), so the document versions are named here, as `traits.ts` names them; the
// release policy's tests pin them to scroll-model's constants.
const DOCUMENT_V3 = 'scroll-document.v3';
const OLDER_DOCUMENTS: readonly string[] = ['scroll-document.v1', 'scroll-document.v2'];

/**
 * Whether a revision may take the place of the one a reader is served without a person (decisions 6 and 9 on #771, D-435): a document v3 over a served
 * document v1 or v2, which its release then retires. A v2 over a served revision, a v3 over a served v3 (no decision covers releasing one again) and anything
 * over a withdrawn asset still wait for a person.
 */
export function mayReplaceServed(
  facts: Pick<AutoReleaseFacts, 'assetStatus' | 'documentVersion' | 'servedDocumentVersion'>,
): boolean {
  return (
    facts.assetStatus === 'admitted' &&
    facts.documentVersion === DOCUMENT_V3 &&
    facts.servedDocumentVersion !== null &&
    OLDER_DOCUMENTS.includes(facts.servedDocumentVersion)
  );
}

/**
 * Whether the policy may release the Scroll now. The first failing rule is the reason, strictest first: what is sensitive is named before what
 * is merely not approved, so a count of holds never hides a sensitive topic behind a missing approval.
 */
export function decideAutoRelease(facts: AutoReleaseFacts): AutoReleaseDecision {
  if (facts.assetStatus !== 'held' && !mayReplaceServed(facts)) return hold('replaces_served');
  if (facts.topicId === null) return hold('no_topic');
  if (facts.risk.riskClass === 'sensitive') return hold('sensitive');
  if (!facts.topicApproved) return hold('topic_not_approved');
  if (!facts.documentReadable) return hold('unreadable');
  if (!facts.coverageMapped) return hold('unmapped');
  // `repaired` waits for a person: the first draft had a call that disagreed with its answer key, and the repair is read by an operator today.
  if (facts.answerCheck !== 'passed') return hold('answer_check_not_passed');
  switch (facts.supportCheck.kind) {
    case 'none':
      return hold('no_support_check');
    case 'stale':
      return hold('stale_support_check');
    case 'unchecked':
      return hold('support_unchecked');
    case 'checked':
      return facts.supportCheck.verdict === 'passed' ? { kind: 'release' } : hold('support_flagged');
  }
}

/** How many more Scrolls the policy may release today. Never negative. */
export function releasesLeftToday(dailyCap: number, releasedToday: number): number {
  return Math.max(0, dailyCap - releasedToday);
}
