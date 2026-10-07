/** ADR-0023 section 6: the generation worker process. Separate from the projection worker and
 * the API; runs `pnpm dev:generation`. Holds no provider credentials — Cutroom's own providers
 * hold theirs — and is given only the engine registry (loopback origins), `KS_MEDIA_ROOT`
 * (KnowScroll's own media store) and the pool from `packages/db/src/index.ts`. No public HTTP
 * route: operator commands live in `scripts/generation.ts`. */
import { pool } from '@knowscroll/db';
import { createPoolLedger } from '@knowscroll/db/pool/ledger';
import pg from 'pg';
import { logError, logLine } from '../runtime/log.ts';
import { strictIntSetting } from '../runtime/settings.ts';
import { onStopSignal } from '../runtime/stop-signal.ts';
import { createLocalImportPort } from './import-port.ts';
import { runLoop, type SharedPoolOptions } from './worker.ts';

/** `KS_MEDIA_ROOT` is an explicit setting (an absolute path), defaulting under `$KS_DEV_ROOT` when
 * unset. This is KnowScroll's own media store — deployment configuration, never per-attempt data
 * (ADR-0023 section 4) — separate from the engine's own `artifact_root`. */
function mediaRootSetting(): string {
  const raw = process.env.KS_MEDIA_ROOT;
  if (raw !== undefined && raw !== '') {
    if (!raw.startsWith('/')) throw new Error('invalid_config');
    return raw;
  }
  const devRoot = process.env.KS_DEV_ROOT;
  if (devRoot === undefined || devRoot === '' || !devRoot.startsWith('/'))
    throw new Error('invalid_config');
  return `${devRoot}/media`;
}

async function main(): Promise<void> {
  const service = 'generation-worker';
  const owner = `generation-${process.pid}`;
  let leaseMs: number, pollMs: number, idlePollMs: number, mediaRoot: string;
  // #199: the shared Reel pool, when this world takes part in one (KS_POOL_DATABASE_URL + KS_WORLD).
  let poolDb: pg.Pool | null = null;
  let shared: SharedPoolOptions | undefined;
  try {
    leaseMs = strictIntSetting('GENERATION_LEASE_MS', 30_000, 1_000, 300_000);
    pollMs = strictIntSetting('GENERATION_POLL_MS', 500, 50, 60_000);
    idlePollMs = strictIntSetting(
      'GENERATION_IDLE_POLL_MS',
      1_000,
      100,
      60_000,
    );
    mediaRoot = mediaRootSetting();
    const poolUrl = process.env.KS_POOL_DATABASE_URL;
    if (poolUrl !== undefined && poolUrl !== '') {
      const world = process.env.KS_WORLD;
      if (!world || !/^[a-z][a-z0-9_-]{0,31}$/.test(world))
        throw new Error('invalid_config');
      poolDb = new pg.Pool({ connectionString: poolUrl, max: 2 });
      shared = {
        ledger: createPoolLedger(poolDb),
        world,
        syncMs: strictIntSetting(
          'GENERATION_POOL_SYNC_MS',
          60_000,
          1_000,
          3_600_000,
        ),
      };
    }
  } catch {
    logError({ service, event: 'error', code: 'invalid_config' });
    process.exitCode = 1;
    await pool.end();
    await poolDb?.end();
    return;
  }

  const stop = new AbortController();
  let stopping = false;
  const requestStop = () => {
    stopping = true;
    stop.abort();
  };
  onStopSignal(requestStop);
  pool.on('error', () => {
    logError({ service, event: 'error', code: 'pool_error' });
    requestStop();
  });

  // Test-only crash-injection knob for issue #94 J005 S2 (worker crash between dispatch commit
  // and any recorded outcome): mirrors Cutroom's own `holdAtCall`. Never set in ordinary operation.
  const holdBeforeSubmit =
    process.env.GENERATION_HOLD_BEFORE_SUBMIT === '1'
      ? async ({ jobId }: { jobId: string }) => {
          logLine({ service, event: 'held_before_submit', jobId });
          await new Promise<void>(() => {}); // blocks forever; the caller must SIGKILL to proceed.
        }
      : undefined;

  poolDb?.on('error', () => {
    logError({ service, event: 'error', code: 'pool_db_error' });
  });
  logLine({
    service,
    event: 'started',
    owner,
    leaseMs,
    pollMs,
    mediaRoot,
    sharedPool: shared?.world ?? null,
  });
  try {
    await runLoop(
      {
        db: pool,
        owner,
        leaseMs,
        pollMs,
        importPort: createLocalImportPort(mediaRoot),
        holdBeforeSubmit,
        ...(shared === undefined ? {} : { pool: shared }),
      },
      stop.signal,
      idlePollMs,
    );
  } finally {
    await pool.end();
    await poolDb?.end();
    logLine({ service, event: 'stopped' });
    if (stopping === false) process.exitCode = 1; // runLoop returned without being asked to stop: unexpected.
  }
}

void main();
