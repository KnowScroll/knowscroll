import {
  applyActionEvidenceQueue,
  projectEncounterActivityQueue,
  projectScrollReadingQueue,
} from '@knowscroll/backend/modules/evidence';
import { prepareBufferQueue } from '@knowscroll/backend/modules/composer';
import { cartographyQueue, publishDeltaQueue } from '@knowscroll/backend/modules/geography';
import { plannerQueue } from '@knowscroll/backend/modules/planner';
import { projectSceneQueue } from '@knowscroll/backend/modules/scenes';

/**
 * The worker queues the lab drains: every consumer on the path a reader's activity takes. A reading is projected, the
 * activity wakes the Planner and Geography, a formed place is published and projected into a scene (and the visit copy
 * refreshed, as the worker does), and each activation prepares the Composer's next buffer.
 *
 * `simulationWorld` builds one consumer per entry, in this order, and refuses to start if its consumers differ from this
 * list. `gate/wiring.test.ts` checks that every queue the release declares is either here or in `NOT_DRAINED`.
 */
export const DRAINED_QUEUES = [
  projectScrollReadingQueue,
  applyActionEvidenceQueue,
  projectEncounterActivityQueue,
  prepareBufferQueue,
  plannerQueue,
  cartographyQueue,
  publishDeltaQueue,
  projectSceneQueue,
] as const;

/**
 * Every other queue of the release, and why the lab does not drain it. A queue that matters to a reader's activity and
 * is missing from both lists fails `gate/wiring.test.ts`, and a job that reaches one of these during a run is reported by
 * the world-level I3 check as unfinished work.
 */
export const NOT_DRAINED: Readonly<Record<string, string>> = {
  'supply.resolve-request': "waits on Create's model production; a Planner demand that starts it is counted, not run",
  'content.produce-scroll': 'model production; no provider is called and no money is spent',
  'content.produce-answer': 'model production',
  'supply.answer-quick-answer': "a quick answer is a person's own ask, not reading activity",
  'supply.purge-quick-answers': 'maintenance sweep on a timer',
  'geography.sweep-quiet': 'scheduled: places go quiet after 30 days, which the lab does not wait for',
  'geography.settle-quiet': 'scheduled: places go quiet after 30 days, which the lab does not wait for',
  'scenes.backfill-looks': 'one-off backfill after a deploy',
  'scenes.expire-formation': 'formation presentations are made by a person opening the map, not by reading',
  'scenes.recover-formation': 'formation presentations are made by a person opening the map, not by reading',
  'scenarios.suggest-draft': "scenarios are a person's own what-if asks",
  'scenarios.write-answer': "scenarios are a person's own what-if asks",
  'scenarios.resolve-branches': "scenarios are a person's own what-if asks",
  'rooms.contribute': 'rooms and their residents are driven by room activity',
  'rooms.cast-due': 'rooms and their residents are driven by room activity',
  'rooms.cast-pass': 'rooms and their residents are driven by room activity',
  'rooms.launch-settle': 'rooms and their residents are driven by room activity',
  'rooms.summarise': 'rooms and their residents are driven by room activity',
  'rooms.nightly-rituals': 'scheduled nightly room work',
  'rooms.feed-heartbeat': 'scheduled room work',
  'rooms.scout-heartbeat': 'scheduled room work',
  'composer.prune-decisions': 'maintenance sweep on a timer (every 30 minutes): stored decisions past their expiry',
  'operator.watchdog': "hourly read-only health check (D-411): reads ops views, writes nothing, on no reader's path",
  'content.sweep-release-policy':
    'sweep that applies the release policy to held library Scrolls (D-418); the lab runs no production or review',
  'content.check-library-support':
    'support check of a held library Scroll (D-415); the lab runs no production or review',
  'content.sweep-library-support':
    'sweep that checks held library Scrolls (D-415); the lab runs no production or review',
  'supply.scan-gaps': 'scheduled gap scan (D-414); off unless KS_SUPPLY_GROWTH_ENABLED=1; no reader activity',
  'supply.brief-gap':
    'scheduled gap briefing and commissioning (D-414); off unless KS_SUPPLY_GROWTH_ENABLED=1; calls a model; the lab runs no production',
  'identity.clear-exploration': 'account lifecycle: privacy reset',
  'identity.recover-clear-operations': 'account lifecycle: privacy reset recovery',
  'identity.delete-account': 'account lifecycle: deletion',
  'identity.recover-account-deletions': 'account lifecycle: deletion recovery',
  'identity.build-export': 'account lifecycle: data export',
  'identity.sweep-sign-in-records': 'maintenance sweep on a timer',
  'reasoning.purge-expired-requests': 'maintenance sweep on a timer',
  'reasoning.sweep-dispatched-attempts': 'maintenance sweep on a timer',
  'feedback.purge-reports': 'maintenance sweep on a timer',
};
