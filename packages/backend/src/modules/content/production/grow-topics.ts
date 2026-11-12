import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { readCatalogueIn } from '../adapters/catalogue-store.js';
import { countEligible, countProposalsSince, readNextToPropose } from '../adapters/topic-candidates.js';
import { TOPIC_GROWTH_POLICY, hasRoom } from '../domain/catalogue/topic-growth.js';
import type { ProposeTopicRequest, ProposeTopicResult } from './propose-topic.js';
import type { SeedResult } from './topic-seeds.js';

/** Keeps two passes from overlapping: `work` runs only while this process holds the pass's session advisory lock; `undefined` when another holds it. */
export interface TopicGrowthLock {
  exclusively<T>(work: () => Promise<T>): Promise<T | undefined>;
}

export interface GrowTopicsPorts {
  /** `KS_SUPPLY_GROWTH_ENABLED` and `KS_TOPIC_GROWTH_ENABLED` and the production grant. Off: the pass does nothing and reads nothing. */
  readonly enabled: boolean;
  /** `KS_SUPPLY_GROWTH_DAILY_CAP`: the one growth number. 0 turns growth off. */
  readonly growthDailyCap: number;
  /** `KS_TOPIC_GROWTH_MAX_PER_SYSTEM`. */
  readonly maxTopicsPerSystem: number;
  readonly db: Kysely<Database>;
  readonly lock: TopicGrowthLock;
  readonly seed: (signal: AbortSignal) => Promise<SeedResult>;
  readonly propose: (request: ProposeTopicRequest, signal: AbortSignal) => Promise<ProposeTopicResult>;
  readonly now: () => Date;
}

/** Why a pass that was on did not look for a topic. */
export type GrowTopicsIdle =
  /** Today's proposals have reached the growth cap. */
  | 'cap_reached'
  /** As many topics wait for supply as the growth cap allows a day: more would only dilute the Scrolls the cap pays for. */
  | 'waiting_topics'
  /** Every system is at the size limit. */
  | 'no_room'
  /** No candidate is eligible, and seeding found none. */
  | 'no_candidate';

/** What one pass did. */
export type GrowTopicsResult =
  | { readonly kind: 'disabled' }
  /** Another pass holds the lock: this one did nothing. */
  | { readonly kind: 'busy' }
  | {
      readonly kind: 'done';
      readonly idle?: GrowTopicsIdle;
      readonly seeded?: SeedResult;
      /** The proposals this pass made, as their results say. */
      readonly proposals: readonly ProposeTopicResult['kind'][];
      /** Whether a budget (the cap or the provider's) ended the pass early. */
      readonly paused: boolean;
    };

export type GrowTopics = (signal: AbortSignal) => Promise<GrowTopicsResult>;

/** At most this many candidates that turn out to be an existing topic again (free, nothing paid) are passed over in one pass. */
const FREE_REFUSALS_PER_PASS = 5;

const startOfUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/**
 * One pass of the scheduled topic growth step (#674, D-422, `content.grow-topics`, background class), part of the gap loop's switch and
 * its own: it does nothing unless both `KS_SUPPLY_GROWTH_ENABLED` and `KS_TOPIC_GROWTH_ENABLED` are on and the production grant is
 * held. Within the growth cap that already bounds new Scrolls a day:
 * - a proposing run is not started once today's runs have reached the cap, nor while as many topics wait for their supply as the cap allows
 *   (a topic is servable only with three released explanations over two facets, so more waiting topics only dilute the Scrolls a day the cap
 *   pays for), nor when no system has room under the size limit;
 * - when fewer than {@link TOPIC_GROWTH_POLICY.eligibleLowWater} candidates are eligible, code looks for more (`seed`: links of research pages
 *   already accepted for recipes, read and filtered by code);
 * - then at most one candidate is proposed for: a run still in flight first (resumed on the very same request), else the oldest eligible.
 *   The model places it and names its facets; code admits it, or not. An admitted topic is a catalogue release that is not servable: the gap
 *   scan sees it as a `thin_planet` hole and the brief job proposes its recipes, held for review like every generated Scroll.
 *
 * A stopped worker or a redelivery repeats a pass without harm: every request has an identity, and an attempt of unknown outcome is never
 * resent. Two passes never overlap (a session advisory lock). No model call or network wait holds a transaction.
 */
export function makeGrowTopics(p: GrowTopicsPorts): GrowTopics {
  const pass = async (signal: AbortSignal): Promise<GrowTopicsResult> => {
    const catalogue = await readCatalogueIn(p.db);
    const proposedToday = await countProposalsSince(p.db, startOfUtcDay(p.now()));
    const waiting = catalogue.allTopics().filter((topic) => !topic.servable).length;
    const idle: GrowTopicsIdle | undefined =
      proposedToday >= p.growthDailyCap
        ? 'cap_reached'
        : waiting >= p.growthDailyCap
          ? 'waiting_topics'
          : hasRoom(catalogue, p.maxTopicsPerSystem)
            ? undefined
            : 'no_room';
    if (idle !== undefined) return { kind: 'done', idle, proposals: [], paused: false };

    const seeded =
      (await countEligible(p.db)) < TOPIC_GROWTH_POLICY.eligibleLowWater ? await p.seed(signal) : undefined;
    const proposals: ProposeTopicResult['kind'][] = [];
    let paused = false;
    for (let freeRefusals = 0; freeRefusals <= FREE_REFUSALS_PER_PASS && !signal.aborted; freeRefusals += 1) {
      const next = await readNextToPropose(p.db);
      if (next === undefined) break;
      const result = await p.propose({ pageUrl: next.pageUrl, dryRun: false }, signal);
      proposals.push(result.kind);
      paused = result.kind === 'paused';
      // A page that turned out to be an existing topic again cost nothing: the next candidate is tried. Anything else ends the pass.
      if (!(result.kind === 'refused' && result.reason === 'duplicate_topic')) break;
    }
    return {
      kind: 'done',
      ...(proposals.length === 0 ? { idle: 'no_candidate' as const } : {}),
      ...(seeded === undefined ? {} : { seeded }),
      proposals,
      paused,
    };
  };
  return async (signal) => {
    if (!p.enabled || p.growthDailyCap <= 0) return { kind: 'disabled' };
    // One pass at a time: a second one (another process, a redelivery that outlived its claim) finds the lock held and does nothing.
    return (await p.lock.exclusively(() => pass(signal))) ?? { kind: 'busy' };
  };
}
