import { jevSubjectOf } from '../domain/jev-pool.js';
import {
  refKey,
  COMPOSER_POLICY_V0,
  COMPOSER_POLICY_V1,
  type ComposerPolicy,
  type VerticalWeights,
} from '../domain/policy.js';
import type { ComposerDecision, ComposerSnapshot, EncounterSnapshot } from '../domain/types.js';
import { inCurrentSeries, seriesUnitIds, sourceSeriesId } from '../domain/vertical-rules.js';
import { decideValidated, validateSnapshot } from './compose.js';
import { ComposerSnapshotSchema } from './snapshot-schema.js';

/**
 * Replays stored Composer decisions under other policies and counts what changes (D-190). It exists to
 * choose the numbers of a policy from real inputs instead of by argument. The output is aggregate counts
 * and shares only: no person, universe, session, asset, title or text ever leaves this module.
 */

type Candidate = ComposerSnapshot['candidates'][number];

/** One policy to replay under, with the weights that distinguish it. */
export interface ReplayVariant {
  readonly label: string;
  readonly policy: ComposerPolicy;
}

/** A variant of `base` with its vertical Intent weight and recent-topic penalty replaced. */
export function withVerticalWeights(
  base: ComposerPolicy,
  weights: Partial<Pick<VerticalWeights, 'intent' | 'recentTopic'>>,
  label?: string,
): ReplayVariant {
  const vertical = { ...base.vertical, ...weights };
  return {
    label: label ?? `${base.version} intent=${String(vertical.intent)} recentTopic=${String(vertical.recentTopic)}`,
    policy: { ...base, vertical },
  };
}

/** The two policies every report compares. */
export const DEFAULT_VARIANTS: readonly ReplayVariant[] = [
  { label: COMPOSER_POLICY_V0.version, policy: COMPOSER_POLICY_V0 },
  { label: COMPOSER_POLICY_V1.version, policy: COMPOSER_POLICY_V1 },
];

export interface FirstOfferCounts {
  /** The first offer, the one a pull-up lands on, is on a topic the source is on. */
  readonly sameTopic: number;
  /** The first offer is another part of the source's series (or the format twin of one). */
  readonly sameSeries: number;
  /**
   * The first offer is on another Jev subject than the source (language and primary topic). A person who
   * follows it needs a fresh Jev subject; D-058 allows at most one call per subject per ten minutes.
   */
  readonly subjectChanges: number;
}

export interface VariantReport {
  readonly label: string;
  /** Vertical decisions replayed; the same for every variant. */
  readonly decisions: number;
  /** Decisions with no eligible candidate left. */
  readonly exhausted: number;
  readonly firstOffer: FirstOfferCounts;
  /** Every offer of every decision (up to three each), for the same two questions. */
  readonly allOffers: { readonly offers: number; readonly sameTopic: number; readonly sameSeries: number };
  /** Sticky format: `kept` the person's format, `fellBack` because none was eligible, `notAsked` when the input named none. */
  readonly stickyFormat: { readonly kept: number; readonly fellBack: number; readonly notAsked: number };
  /** Shares of `decisions` (first offer) and of `allOffers.offers`, rounded to three decimals. */
  readonly shares: {
    readonly sameTopicFirstOffer: number;
    readonly sameSeriesFirstOffer: number;
    readonly subjectChangeFirstOffer: number;
    readonly sameTopicAllOffers: number;
  };
}

export interface PolicyReplayReport {
  /** Stored decisions given to the replay. */
  readonly read: number;
  readonly replayed: number;
  readonly skipped: {
    readonly notVertical: number;
    readonly sourceNotInCandidates: number;
    readonly unreadable: number;
  };
  /** How many of the stored decisions name each policy label. */
  readonly storedPolicies: Readonly<Record<string, number>>;
  /** What was served (`stored`), then the replay under each variant, on the same normalised inputs. */
  readonly variants: readonly VariantReport[];
}

/** A stored decision as the store hands it over: its label and its payload, not yet trusted. */
export interface StoredDecision {
  readonly policyVersion: string;
  readonly payload: unknown;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

const relevantTopicIds = (encounter: Pick<EncounterSnapshot, 'topics'>): readonly string[] =>
  encounter.topics.filter((topic) => topic.role !== 'incidental').map((topic) => topic.topicId);

/**
 * A stored input as today's assembly would build it for the same move: the series the person is in and
 * the format they are in are named, and each recent encounter carries its topics, all derived from
 * candidates the input already holds. Inputs stored before policy v1 lack these fields, and without them
 * a replay could not tell the rules of D-131 and D-132 or the recent-topic penalty from the weights.
 * Fields the input already has are kept.
 */
export function normaliseForReplay(input: ComposerSnapshot, source: Candidate): ComposerSnapshot {
  const unit = input.intent.explanationUnitId ?? source.encounter.explanationUnitId;
  const seriesId =
    input.intent.currentSeriesId ??
    sourceSeriesId(
      { series: source.encounter.series, explanationUnitId: unit },
      input.candidates.map((c) => c.encounter),
    );
  const topicsOfUnit = (explanationUnitId: string): readonly string[] | undefined => {
    const holders = input.candidates.filter((c) => c.encounter.explanationUnitId === explanationUnitId);
    return holders.length === 0 ? undefined : [...new Set(holders.flatMap((c) => relevantTopicIds(c.encounter)))];
  };
  const { evidence } = input;
  return {
    ...input,
    intent: {
      ...input.intent,
      ...(seriesId !== undefined ? { currentSeriesId: seriesId } : {}),
      ...(input.intent.stickyFormat === undefined ? { stickyFormat: source.encounter.kind } : {}),
    },
    ...(evidence
      ? {
          evidence: {
            ...evidence,
            recent: evidence.recent.map((entry) => {
              const topicIds = entry.topicIds ?? topicsOfUnit(entry.explanationUnitId);
              return topicIds === undefined ? entry : { ...entry, topicIds };
            }),
          },
        }
      : {}),
  };
}

interface Tally {
  decisions: number;
  exhausted: number;
  first: { sameTopic: number; sameSeries: number; subjectChanges: number };
  all: { offers: number; sameTopic: number; sameSeries: number };
  sticky: { kept: number; fellBack: number; notAsked: number };
}

const emptyTally = (): Tally => ({
  decisions: 0,
  exhausted: 0,
  first: { sameTopic: 0, sameSeries: 0, subjectChanges: 0 },
  all: { offers: 0, sameTopic: 0, sameSeries: 0 },
  sticky: { kept: 0, fellBack: 0, notAsked: 0 },
});

/** Counts one decision's offers against the move's source, with the same definitions for every variant. */
function tally(
  into: Tally,
  input: ComposerSnapshot,
  source: Candidate,
  offers: readonly { readonly assetId: string; readonly assetRevision: number }[],
  sticky: ComposerDecision['stickyFormat'],
): void {
  const byKey = new Map(input.candidates.map((c) => [refKey(c.encounter), c]));
  const sourceTopics = relevantTopicIds(source.encounter);
  const seriesUnits = seriesUnitIds(input);
  const subject = jevSubjectOf(source.encounter);
  into.decisions += 1;
  if (offers.length === 0) into.exhausted += 1;
  if (sticky === undefined) into.sticky.notAsked += 1;
  else into.sticky[sticky.outcome === 'kept' ? 'kept' : 'fellBack'] += 1;
  offers.forEach((offer, index) => {
    const candidate = byKey.get(refKey(offer));
    if (candidate === undefined) return;
    const sameTopic = relevantTopicIds(candidate.encounter).some((id) => sourceTopics.includes(id));
    const sameSeries = inCurrentSeries(input, candidate, seriesUnits);
    into.all.offers += 1;
    if (sameTopic) into.all.sameTopic += 1;
    if (sameSeries) into.all.sameSeries += 1;
    if (index !== 0) return;
    if (sameTopic) into.first.sameTopic += 1;
    if (sameSeries) into.first.sameSeries += 1;
    if (jevSubjectOf(candidate.encounter) !== subject) into.first.subjectChanges += 1;
  });
}

const share = (part: number, whole: number): number => (whole === 0 ? 0 : round3(part / whole));

function reportOf(label: string, t: Tally): VariantReport {
  return {
    label,
    decisions: t.decisions,
    exhausted: t.exhausted,
    firstOffer: { ...t.first },
    allOffers: { ...t.all },
    stickyFormat: { ...t.sticky },
    shares: {
      sameTopicFirstOffer: share(t.first.sameTopic, t.decisions),
      sameSeriesFirstOffer: share(t.first.sameSeries, t.decisions),
      subjectChangeFirstOffer: share(t.first.subjectChanges, t.decisions),
      sameTopicAllOffers: share(t.all.sameTopic, t.all.offers),
    },
  };
}

/** What the stored payload must hold for a replay; anything else is `unreadable`, never guessed at. */
function readStored(stored: StoredDecision): { input: ComposerSnapshot; decision: ComposerDecision } | undefined {
  const payload = stored.payload as Partial<ComposerDecision> | null;
  if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.selection)) return undefined;
  const parsed = ComposerSnapshotSchema.safeParse(payload.input);
  return parsed.success ? { input: parsed.data, decision: payload as ComposerDecision } : undefined;
}

/**
 * Accumulates the replay of stored decisions, one at a time, so a caller can stream a large window and
 * hold one decision in memory. Each decision is replayed only when it is a vertical move whose source is
 * among its candidates, because only then can "the same topic as the source" be told.
 */
export function startPolicyReplay(variants: readonly ReplayVariant[]) {
  const stored = emptyTally();
  const replayed = variants.map(() => emptyTally());
  const counts = { read: 0, replayed: 0, notVertical: 0, sourceNotInCandidates: 0, unreadable: 0 };
  const storedPolicies: Record<string, number> = {};
  return {
    add(decision: StoredDecision): void {
      counts.read += 1;
      storedPolicies[decision.policyVersion] = (storedPolicies[decision.policyVersion] ?? 0) + 1;
      const read = readStored(decision);
      if (read === undefined) {
        counts.unreadable += 1;
        return;
      }
      if (read.input.mode !== 'vertical') {
        counts.notVertical += 1;
        return;
      }
      const source = read.input.source
        ? read.input.candidates.find((c) => refKey(c.encounter) === refKey(read.input.source!))
        : undefined;
      if (source === undefined) {
        counts.sourceNotInCandidates += 1;
        return;
      }
      const input = normaliseForReplay(read.input, source);
      try {
        validateSnapshot(input);
      } catch {
        counts.unreadable += 1;
        return;
      }
      counts.replayed += 1;
      tally(stored, input, source, read.decision.selection, read.decision.stickyFormat);
      variants.forEach(({ policy }, index) => {
        const made = decideValidated(input, policy);
        tally(replayed[index]!, input, source, made.selection, made.stickyFormat);
      });
    },
    report(): PolicyReplayReport {
      return {
        read: counts.read,
        replayed: counts.replayed,
        skipped: {
          notVertical: counts.notVertical,
          sourceNotInCandidates: counts.sourceNotInCandidates,
          unreadable: counts.unreadable,
        },
        storedPolicies: { ...storedPolicies },
        variants: [
          reportOf('stored (as served)', stored),
          ...variants.map(({ label }, index) => reportOf(label, replayed[index]!)),
        ],
      };
    },
  };
}
