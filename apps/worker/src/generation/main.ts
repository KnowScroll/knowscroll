/** ADR-0023 section 6: the generation worker process. Separate from the projection worker and
 * the API; runs `pnpm dev:generation`. Holds no provider credentials — Cutroom's own providers
 * hold theirs — and is given only the engine registry (loopback origins), `KS_MEDIA_ROOT`
 * (KnowScroll's own media store) and the pool from `packages/db/src/index.ts`. No public HTTP
 * route: operator commands live in `scripts/generation.ts`. */
import {pool} from '../../../../packages/db/src/index.ts';
import {createLocalImportPort} from './import-port.ts';
import {runLoop} from './worker.ts';

function setting(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error('invalid_config');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('invalid_config');
  return value;
}

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
  if (devRoot === undefined || devRoot === '' || !devRoot.startsWith('/')) throw new Error('invalid_config');
  return `${devRoot}/media`;
}

async function main(): Promise<void> {
  const service = 'generation-worker';
  const owner = `generation-${process.pid}`;
  let leaseMs: number, pollMs: number, idlePollMs: number, mediaRoot: string;
  try {
    leaseMs = setting('GENERATION_LEASE_MS', 30_000, 1_000, 300_000);
    pollMs = setting('GENERATION_POLL_MS', 500, 50, 60_000);
    idlePollMs = setting('GENERATION_IDLE_POLL_MS', 1_000, 100, 60_000);
    mediaRoot = mediaRootSetting();
  } catch {
    console.error(JSON.stringify({service, event: 'error', code: 'invalid_config'}));
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const stop = new AbortController();
  let stopping = false;
  const requestStop = () => { stopping = true; stop.abort(); };
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);
  pool.on('error', () => {
    console.error(JSON.stringify({service, event: 'error', code: 'pool_error'}));
    requestStop();
  });

  // Test-only crash-injection knob for issue #94 J005 S2 (worker crash between dispatch commit
  // and any recorded outcome): mirrors Cutroom's own `holdAtCall`. Never set in ordinary operation.
  const holdBeforeSubmit = process.env.GENERATION_HOLD_BEFORE_SUBMIT === '1'
    ? async ({jobId}: {jobId: string}) => {
        console.log(JSON.stringify({service, event: 'held_before_submit', jobId}));
        await new Promise<void>(() => {}); // blocks forever; the caller must SIGKILL to proceed.
      }
    : undefined;

  console.log(JSON.stringify({service, event: 'started', owner, leaseMs, pollMs, mediaRoot}));
  try {
    await runLoop({db: pool, owner, leaseMs, pollMs, importPort: createLocalImportPort(mediaRoot), holdBeforeSubmit}, stop.signal, idlePollMs);
  } finally {
    await pool.end();
    console.log(JSON.stringify({service, event: 'stopped'}));
    if (stopping === false) process.exitCode = 1; // runLoop returned without being asked to stop: unexpected.
  }
}

void main();
