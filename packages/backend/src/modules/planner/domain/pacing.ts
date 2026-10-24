/**
 * How often one person's Planner may start (D-052). When a run settles, the next one waits this
 * long, so reading that keeps arriving becomes one pending run with a delayed wake instead of a
 * model call per encounter. The delayed run freezes its context when it starts, so it plans from
 * everything that arrived while it waited.
 */
const RUN_INTERVAL_MS = 5 * 60 * 1000;

/** The earliest the run after one that settles at `settledAt` may start. */
export function nextRunNotBefore(settledAt: Date): string {
  return new Date(settledAt.getTime() + RUN_INTERVAL_MS).toISOString();
}

/** When to start a new run's wake: at `notBefore` if that is still ahead, otherwise at once. */
export function wakeAt(notBefore: string | undefined, now: Date): Date | undefined {
  return notBefore !== undefined && Date.parse(notBefore) > now.getTime() ? new Date(notBefore) : undefined;
}
