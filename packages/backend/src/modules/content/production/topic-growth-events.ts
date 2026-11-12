import { z } from 'zod';
import { MINIMAX_REQUEST_TIMEOUT_MAX_MS } from '../../../infrastructure/config/index.js';
import { defineQueue } from '../../../infrastructure/jobs/queues.js';
import { TOPIC_GROWTH_POLICY } from '../domain/catalogue/topic-growth.js';

/** Payload of the scheduled job: a schema version only. It names no person, no page and no candidate; it finds its own work. */
export const GrowTopicsPayloadSchema = z.strictObject({ v: z.literal(1) });
export type GrowTopicsPayload = z.infer<typeof GrowTopicsPayloadSchema>;

/** Per paid attempt: the quota preflight and the production scope's lock waits, as the reasoning README counts them. */
const ATTEMPT_OVERHEAD_SECONDS = 20;
/** One research read at its worst: DNS (10 s), up to four hops of a request (20 s each) and the extraction. */
const READ_SECONDS = 100;
/** What a pass needs beyond its reads and its one proposal: the catalogue read, the release and the settling. */
const PASS_MARGIN_SECONDS = 120;

/**
 * The seconds a pass may hold its claim: every research page it reads at the worst case, one after another, one proposal of one request
 * and one repair at the largest deadline the provider adapter allows plus the waits around them, and a margin (reasoning README,
 * "Queue settings for a job that calls `propose`"). Below it pg-boss would expire a pass still waiting on the provider, and the next
 * delivery would find the attempt `dispatched` and write it off as unknown.
 */
export const GROW_TOPICS_CLAIM_SECONDS =
  (TOPIC_GROWTH_POLICY.sourcesPerPass + TOPIC_GROWTH_POLICY.readsPerPass) * READ_SECONDS +
  2 * (MINIMAX_REQUEST_TIMEOUT_MAX_MS / 1000 + ATTEMPT_OVERHEAD_SECONDS) +
  PASS_MARGIN_SECONDS;

/**
 * The background job that grows the topic catalogue (#674, D-422): twice an hour it looks for candidate pages by following the links of
 * research pages already accepted for recipes (code only), and then proposes a place for at most one candidate through the production
 * harness; code admits it as a topic that is not servable until the library has released supply for it. Within the growth cap, under every
 * system's size limit, background class. A delivery repeated by a crash or a retry reaches the same request (the candidate pins the UTC day
 * of the attempt), so it never pays twice, and an attempt of unknown outcome is never resent. One worker process runs it, one pass at a
 * time. It does nothing unless `KS_SUPPLY_GROWTH_ENABLED` and `KS_TOPIC_GROWTH_ENABLED` are both on.
 */
export const growTopicsQueue = defineQueue({
  name: 'content.grow-topics',
  purpose:
    'Find candidate pages from the links of research pages already accepted for recipes, and propose a place for one as a new topic under an existing system: code admits it, not servable until the library has supply for it.',
  payload: GrowTopicsPayloadSchema,
  policy: {
    expireInSeconds: GROW_TOPICS_CLAIM_SECONDS,
    retryLimit: 1,
    retryDelaySeconds: 120,
    retryBackoff: false,
    retentionSeconds: 3600,
    deleteAfterSeconds: 86_400,
    deadLetter: true,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 60 },
  schedule: { cron: '24,54 * * * *', payload: { v: 1 } },
});
