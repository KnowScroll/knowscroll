import { describe, expect, it } from 'vitest';
import type { WatchdogGroup, WatchdogQuery } from '../domain/watchdog.js';
import { makeRunWatchdog } from './run-watchdog.js';
import type { WatchdogStore } from './ports.js';

const NOW = new Date('2026-11-11T12:00:00.000Z');

/** A store answering from a table of groups by rule; a rule named in `failing` throws as an unreadable view does. */
function store(groups: Partial<Record<string, readonly WatchdogGroup[]>>, failing: readonly string[] = []) {
  const asked: WatchdogQuery[] = [];
  const port: WatchdogStore = {
    groups: (query) => {
      asked.push(query);
      if (failing.includes(query.rule)) return Promise.reject(new Error('view missing'));
      return Promise.resolve(groups[query.rule] ?? []);
    },
  };
  return { port, asked };
}

describe('one watchdog pass (D-411)', () => {
  it('reads every rule once and raises nothing when nothing is wrong', async () => {
    const { port, asked } = store({});
    const pass = await makeRunWatchdog({ store: port, now: () => NOW })();
    expect(pass).toEqual({ alerts: [], skipped: [] });
    expect(asked).toHaveLength(6);
  });

  it('turns what the store found into alerts', async () => {
    const { port } = store({
      dead_letter: [{ subject: 'planner.run.dead', detail: null, count: 2 }],
      run_held: [{ subject: 'geography', detail: 'queued', count: 1 }],
    });
    const pass = await makeRunWatchdog({ store: port, now: () => NOW })();
    expect(pass.alerts.map((alert) => alert.code)).toEqual(['dead_lettered_jobs', 'personal_runs_held']);
    expect(pass.skipped).toEqual([]);
  });

  it('skips a rule it cannot read, names it, and still evaluates the others', async () => {
    const { port } = store({ dead_letter: [{ subject: 'planner.run.dead', detail: null, count: 1 }] }, [
      'composer_repeat',
      'job_failed',
    ]);
    const pass = await makeRunWatchdog({ store: port, now: () => NOW })();
    expect(pass.skipped).toEqual(['job_failed', 'composer_repeat']);
    expect(pass.alerts).toHaveLength(1);
  });

  it('is the same for the same data, run twice', async () => {
    const { port } = store({ attempt_unknown: [{ subject: 'personal', detail: null, count: 3 }] });
    const run = makeRunWatchdog({ store: port, now: () => NOW });
    expect(await run()).toEqual(await run());
  });
});
