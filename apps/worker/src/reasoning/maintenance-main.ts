import { setTimeout as sleep } from 'node:timers/promises';

import { pool } from '@knowscroll/db';
import { createReasoningMaintenance } from '@knowscroll/db/reasoning/maintenance';

import { logError, logLine } from '../runtime/log.ts';
import { strictIntSetting } from '../runtime/settings.ts';
import { onStopSignal } from '../runtime/stop-signal.ts';

const service = 'reasoning-maintenance';

async function main(): Promise<void> {
  let intervalMs: number, maxProbes: number;
  try {
    intervalMs = strictIntSetting(
      'REASONING_MAINTENANCE_INTERVAL_MS',
      60_000,
      100,
      3_600_000,
    );
    maxProbes = strictIntSetting(
      'REASONING_MAINTENANCE_MAX_PROBES',
      32,
      1,
      128,
    );
  } catch {
    logError({ service, event: 'error', code: 'invalid_config' });
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const stop = new AbortController();
  let stopping = false,
    failed = false,
    poolFailed = false,
    batches = 0;
  const requestStop = () => {
    stopping = true;
    stop.abort();
  };
  onStopSignal(requestStop);
  pool.on('error', () => {
    if (!poolFailed) logError({ service, event: 'error', code: 'pool_error' });
    poolFailed = true;
    failed = true;
    requestStop();
  });

  logLine({ service, event: 'started' });
  const maintenance = createReasoningMaintenance(pool);
  try {
    while (!stopping) {
      try {
        const result = await maintenance.runBatch({
          maxProbes,
          signal: stop.signal,
        });
        batches += 1;
        logLine({ service, event: 'batch', batch: batches, ...result });
      } catch {
        failed = true;
        logError({
          service,
          event: 'error',
          code: 'unexpected_batch_error',
        });
        requestStop();
        continue;
      }
      if (!stopping) {
        try {
          await sleep(intervalMs, undefined, { signal: stop.signal });
        } catch {
          /* A signal requests shutdown after the completed batch. */
        }
      }
    }
  } finally {
    try {
      await pool.end();
    } catch {
      if (!poolFailed)
        logError({ service, event: 'error', code: 'pool_shutdown_error' });
      failed = true;
    }
    logLine({ service, event: 'stopped' });
    if (failed) process.exitCode = 1;
  }
}

void main();
