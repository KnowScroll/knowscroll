import { z } from 'zod';
import { MINIMAX_REQUEST_TIMEOUT_MAX_MS } from '../../infrastructure/config/index.js';
import { defineQueue } from '../../infrastructure/jobs/queues.js';
import { GAPS_PER_PASS } from './domain/gaps.js';

/** Payload of both scheduled jobs: a schema version only. They name no person and no gap; they find their own work. */
export const GapJobPayloadSchema = z.strictObject({ v: z.literal(1) });
export type GapJobPayload = z.infer<typeof GapJobPayloadSchema>;

/**
 * The scheduled scan of the library for holes and of the readers' signals (#674, D-414). Every fifteen minutes, SQL only, no model:
 * it counts the readers' marks into the daily counters, finds the planets that are thin, the facets with nothing and the planets
 * below the depth target, and merges them with the counted signals into `supply.gaps`, one gap for each key. Safe to run late, twice
 * or at the same time as itself: one scan holds an advisory lock and a second simply does not run. It does nothing where
 * `KS_SUPPLY_GROWTH_ENABLED` is off.
 */
export const scanGapsQueue = defineQueue({
  name: 'supply.scan-gaps',
  purpose:
    'Find the holes in the library and merge the readers’ counted signals into the gaps table: SQL only, one gap for each key.',
  payload: GapJobPayloadSchema,
  policy: {
    expireInSeconds: 300,
    retryLimit: 1,
    retryDelaySeconds: 60,
    retryBackoff: false,
    retentionSeconds: 3600,
    deleteAfterSeconds: 86_400,
    deadLetter: false,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 60 },
  schedule: { cron: '3,18,33,48 * * * *', payload: { v: 1 } },
});

/** Per paid attempt: the quota preflight and the production scope's lock waits, as the reasoning README counts them. */
const ATTEMPT_OVERHEAD_SECONDS = 20;
/** What a pass needs beyond its proposing attempts: the reads, the commissioning and the settling. */
const PASS_MARGIN_SECONDS = 120;

/**
 * The seconds a pass may hold its claim: every gap it works on may send one request and one repair at the largest deadline the
 * provider adapter allows, plus the waits around them and a margin (reasoning README, "Queue settings for a job that calls
 * `propose`"). Below it pg-boss would expire a pass still waiting on the provider, and the next delivery would find the attempt
 * `dispatched` and write it off as unknown.
 */
export const BRIEF_GAP_CLAIM_SECONDS =
  GAPS_PER_PASS * 2 * (MINIMAX_REQUEST_TIMEOUT_MAX_MS / 1000 + ATTEMPT_OVERHEAD_SECONDS) + PASS_MARGIN_SECONDS;

/**
 * The background job that briefs the most pressing gaps (#674, D-414): within the growth cap, it asks the brief role for recipes
 * through the path `content propose-recipes` uses and commissions production of what code accepts. Twice an hour; every Scroll
 * it makes is held by the operator's review gate. A delivery repeated by a crash or a retry reaches the same request (the gap
 * pins the UTC day of the attempt), so it never pays twice, and an attempt of unknown outcome is never resent. One worker process
 * runs it, one pass at a time. It does nothing where `KS_SUPPLY_GROWTH_ENABLED` is off.
 */
export const briefGapQueue = defineQueue({
  name: 'supply.brief-gap',
  purpose:
    'Brief the most pressing gaps of the library within the growth cap: ask for recipes, check them in code and commission production, held for review.',
  payload: GapJobPayloadSchema,
  policy: {
    expireInSeconds: BRIEF_GAP_CLAIM_SECONDS,
    retryLimit: 1,
    retryDelaySeconds: 120,
    retryBackoff: false,
    retentionSeconds: 3600,
    deleteAfterSeconds: 86_400,
    deadLetter: true,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 60 },
  schedule: { cron: '9,39 * * * *', payload: { v: 1 } },
});
