import {
  alertsFrom,
  watchdogQueries,
  type WatchdogAlert,
  type WatchdogRule,
  type WatchdogThresholds,
} from '../domain/watchdog.js';
import type { WatchdogStore } from './ports.js';

/** What one pass found: the alerts, and the rules whose read failed (the view missing, or a timeout). */
export interface WatchdogPass {
  readonly alerts: readonly WatchdogAlert[];
  readonly skipped: readonly WatchdogRule[];
}

/** Scheduled consumer of `operator.watchdog`. */
export type RunWatchdog = () => Promise<WatchdogPass>;

export interface RunWatchdogPorts {
  readonly store: WatchdogStore;
  readonly now: () => Date;
  /** Defaults to `WATCHDOG_THRESHOLDS`; a test passes its own. */
  readonly thresholds?: WatchdogThresholds;
}

/**
 * One watchdog pass (D-411): reads each rule's observations through bounded read-only queries and turns
 * them into alerts. A rule whose read fails is skipped and named, so one broken view or one slow query
 * does not hide the other five. It reads code-only observations, writes nothing, repairs nothing and calls
 * no model. Safe to run twice or late: the same pass gives the same alerts for the same data.
 */
export function makeRunWatchdog(p: RunWatchdogPorts): RunWatchdog {
  return async () => {
    const alerts: WatchdogAlert[] = [];
    const skipped: WatchdogRule[] = [];
    for (const query of watchdogQueries(p.now(), p.thresholds)) {
      try {
        alerts.push(...alertsFrom(query.rule, await p.store.groups(query), p.thresholds));
      } catch {
        skipped.push(query.rule);
      }
    }
    return { alerts, skipped };
  };
}
