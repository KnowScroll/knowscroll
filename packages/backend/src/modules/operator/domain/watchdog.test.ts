import { describe, expect, it } from 'vitest';
import { WATCHDOG_THRESHOLDS, alertsFrom, watchdogQueries, type WatchdogGroup, type WatchdogRule } from './watchdog.js';

const NOW = new Date('2026-11-11T12:00:00.000Z');
const group = (count: number, subject = 'queue.one', detail: string | null = null): WatchdogGroup => ({
  subject,
  detail,
  count,
});

describe('the watchdog queries (D-411)', () => {
  const queries = watchdogQueries(NOW);
  const queryOf = (rule: WatchdogRule) => queries.find((query) => query.rule === rule)!;

  it('asks for the six rules once each, counting inside a window or older than an age', () => {
    expect(queries.map((query) => query.rule).sort()).toEqual([
      'attempt_unknown',
      'composer_repeat',
      'dead_letter',
      'geography_unavailable_repeat',
      'job_failed',
      'run_held',
    ]);
    expect(queryOf('dead_letter').newerThan).toEqual(new Date(NOW.getTime() - 3 * 3600_000));
    expect(queryOf('job_failed').newerThan).toEqual(new Date(NOW.getTime() - 6 * 3600_000));
    expect(queryOf('composer_repeat').newerThan).toEqual(new Date(NOW.getTime() - 24 * 3600_000));
    // A held run and an unknown attempt are a matter of age, not of a window.
    expect(queryOf('run_held')).toEqual({ rule: 'run_held', olderThan: new Date(NOW.getTime() - 3600_000) });
    expect(queryOf('attempt_unknown')).toEqual({
      rule: 'attempt_unknown',
      olderThan: new Date(NOW.getTime() - 6 * 3600_000),
    });
    expect(queryOf('geography_unavailable_repeat')).toEqual({
      rule: 'geography_unavailable_repeat',
      newerThan: new Date(NOW.getTime() - 7 * 86_400_000),
      minMagnitude: 3,
    });
  });

  it('takes every number from the one thresholds object', () => {
    const custom = {
      ...WATCHDOG_THRESHOLDS,
      deadLetters: { windowSeconds: 60, alertAtCount: 2 },
      geographyUnavailable: { runs: 5, lookbackSeconds: 120, alertAtCount: 1 },
    };
    const changed = watchdogQueries(NOW, custom);
    expect(changed.find((query) => query.rule === 'dead_letter')!.newerThan).toEqual(new Date(NOW.getTime() - 60_000));
    expect(changed.find((query) => query.rule === 'geography_unavailable_repeat')).toMatchObject({ minMagnitude: 5 });
  });
});

describe('the watchdog rules fire on their condition and never otherwise (D-411)', () => {
  it('dead letters: one alert per queue with at least one dead letter in the window', () => {
    expect(alertsFrom('dead_letter', [])).toEqual([]);
    expect(alertsFrom('dead_letter', [group(3, 'planner.run.dead'), group(1, 'geography.cartograph.dead')])).toEqual([
      { code: 'dead_lettered_jobs', count: 3, windowSeconds: 10_800, queue: 'planner.run.dead' },
      { code: 'dead_lettered_jobs', count: 1, windowSeconds: 10_800, queue: 'geography.cartograph.dead' },
    ]);
    expect(alertsFrom('dead_letter', [group(0)])).toEqual([]);
    expect(
      alertsFrom('dead_letter', [group(1)], {
        ...WATCHDOG_THRESHOLDS,
        deadLetters: { windowSeconds: 1, alertAtCount: 2 },
      }),
    ).toEqual([]);
  });

  it('failed jobs: fires only from five with the same code, and names the queue and the code', () => {
    expect(alertsFrom('job_failed', [group(4, 'planner.run', 'PG_TIMEOUT')])).toEqual([]);
    expect(alertsFrom('job_failed', [group(5, 'planner.run', 'PG_TIMEOUT'), group(2, 'planner.run', 'OTHER')])).toEqual(
      [{ code: 'failed_jobs_repeating', count: 5, windowSeconds: 21_600, queue: 'planner.run', outcome: 'PG_TIMEOUT' }],
    );
  });

  it('held runs: fires per module and status once a run has been held past the age', () => {
    expect(alertsFrom('run_held', [])).toEqual([]);
    expect(alertsFrom('run_held', [group(2, 'planner', 'queued'), group(1, 'geography', 'prepared')])).toEqual([
      { code: 'personal_runs_held', count: 2, windowSeconds: 3600, context: 'planner', outcome: 'queued' },
      { code: 'personal_runs_held', count: 1, windowSeconds: 3600, context: 'geography', outcome: 'prepared' },
    ]);
  });

  it('geography: counts the universes with the streak and names only the reason', () => {
    expect(alertsFrom('geography_unavailable_repeat', [])).toEqual([]);
    expect(alertsFrom('geography_unavailable_repeat', [group(7, 'coverage_unavailable')])).toEqual([
      { code: 'geography_unavailable_repeating', count: 7, windowSeconds: 604_800, outcome: 'coverage_unavailable' },
    ]);
  });

  it('composer: fires on a repeat offered while an unseen candidate was recorded, naming only the policy', () => {
    expect(alertsFrom('composer_repeat', [])).toEqual([]);
    expect(alertsFrom('composer_repeat', [group(4, 'composer-policy.v2')])).toEqual([
      { code: 'composer_repeat_offered', count: 4, windowSeconds: 86_400, outcome: 'composer-policy.v2' },
    ]);
  });

  it('unknown attempts: fires per scope once an unknown outcome is old enough', () => {
    expect(alertsFrom('attempt_unknown', [])).toEqual([]);
    expect(alertsFrom('attempt_unknown', [group(1, 'personal')])).toEqual([
      { code: 'unknown_attempts_old', count: 1, windowSeconds: 21_600, context: 'personal' },
    ]);
  });

  it('never carries anything but a code, a count, a window and a queue, module or outcome code', () => {
    const everything = [
      ...alertsFrom('dead_letter', [group(1, 'q.dead')]),
      ...alertsFrom('job_failed', [group(9, 'q', 'CODE')]),
      ...alertsFrom('run_held', [group(1, 'planner', 'queued')]),
      ...alertsFrom('geography_unavailable_repeat', [group(1, 'context_limit')]),
      ...alertsFrom('composer_repeat', [group(1, 'composer-policy.v2')]),
      ...alertsFrom('attempt_unknown', [group(1, 'production')]),
    ];
    expect(everything).toHaveLength(6);
    for (const alert of everything)
      expect(
        Object.keys(alert).every((key) =>
          ['code', 'count', 'windowSeconds', 'queue', 'context', 'outcome'].includes(key),
        ),
      ).toBe(true);
  });
});
