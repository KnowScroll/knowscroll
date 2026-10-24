import { NO_TIER0_SOURCE, RETENTION_QUEUES, type OperatorPanels, type Piece, type QueueRow } from '../domain/panels.js';
import type { PanelStore } from './ports.js';

const PROVIDER_WINDOW_HOURS = 24;
const LIST_LIMIT = 12;
const ERROR_LIMIT = 25;

/**
 * Use case: the six panels of the Operator screen, read at one moment.
 *
 * Authority: the caller has already decided that the person may inspect. Each piece comes from an
 * `ops` view; a piece whose view is missing or fails is reported `unavailable` and the rest still
 * answer. Pieces Tier 0 has no source for (service health, request latency, media disk, realtime
 * delivery, dropped diagnostics) are always `unavailable`, never estimated.
 * Side effects: none.
 */
export type ReadOperatorPanels = () => Promise<OperatorPanels>;

function retentionJobsFrom(queues: Piece<readonly QueueRow[]>): Piece<readonly QueueRow[]> {
  if (queues.status === 'unavailable') return queues;
  return { status: 'available', data: queues.data.filter((row) => RETENTION_QUEUES.includes(row.queue)) };
}

export function makeReadOperatorPanels(deps: {
  readonly store: PanelStore;
  readonly now: () => Date;
}): ReadOperatorPanels {
  const { store } = deps;
  return async () => {
    const [queues, providerOutcomes, recentErrors, runs, refusedAnswers, reelOrders, usage, cartographer, operations] =
      await Promise.all([
        store.queues(),
        store.providerOutcomes(PROVIDER_WINDOW_HOURS),
        store.recentErrors(ERROR_LIMIT),
        store.productionRuns(LIST_LIMIT),
        store.refusedAnswers(LIST_LIMIT),
        store.reelOrders(LIST_LIMIT),
        store.usage(PROVIDER_WINDOW_HOURS),
        store.cartographer(LIST_LIMIT),
        store.privacy(LIST_LIMIT),
      ]);
    return {
      generatedAt: deps.now(),
      overview: {
        queues,
        providerOutcomes,
        recentErrors,
        serviceHealth: NO_TIER0_SOURCE,
        requestLatency: NO_TIER0_SOURCE,
        mediaDisk: NO_TIER0_SOURCE,
      },
      production: { runs, refusedAnswers, reelOrders, usage },
      universeChange: { cartographer },
      realtime: { delivery: NO_TIER0_SOURCE },
      privacy: {
        operations,
        retentionJobs: retentionJobsFrom(queues),
        droppedDiagnostics: NO_TIER0_SOURCE,
      },
    };
  };
}
