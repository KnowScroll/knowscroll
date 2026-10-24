import { NO_TIER0_SOURCE, RETENTION_QUEUES, type OperatorPanels, type Piece, type QueueRow } from '../domain/panels.js';
import type { PanelStore } from './ports.js';

const PROVIDER_WINDOW_HOURS = 24;
const LIST_LIMIT = 12;
const ERROR_LIMIT = 25;
/** The panels never hold more than this many of the API's connections at once. */
const MAX_CONCURRENT_READS = 3;

/** Runs the given reads at most `limit` at a time, in the order they were asked for. */
function limited(limit: number): <T>(read: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(read: () => Promise<T>): Promise<T> => {
    while (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
    try {
      return await read();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };
}

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
    const run = limited(MAX_CONCURRENT_READS);
    const [
      queues,
      providerOutcomes,
      recentErrors,
      runs,
      refusedAnswers,
      reelOrders,
      usage,
      cartographer,
      operations,
      reports,
    ] = await Promise.all([
      run(() => store.queues()),
      run(() => store.providerOutcomes(PROVIDER_WINDOW_HOURS)),
      run(() => store.recentErrors(ERROR_LIMIT)),
      run(() => store.productionRuns(LIST_LIMIT)),
      run(() => store.refusedAnswers(LIST_LIMIT)),
      run(() => store.reelOrders(LIST_LIMIT)),
      run(() => store.usage(PROVIDER_WINDOW_HOURS)),
      run(() => store.cartographer(LIST_LIMIT)),
      run(() => store.privacy(LIST_LIMIT)),
      run(() => store.reports(LIST_LIMIT)),
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
      safety: { reports },
      realtime: { delivery: NO_TIER0_SOURCE },
      privacy: {
        operations,
        retentionJobs: retentionJobsFrom(queues),
        droppedDiagnostics: NO_TIER0_SOURCE,
      },
    };
  };
}
