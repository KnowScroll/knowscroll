import { parseArgs } from 'node:util';
import {
  ConfigurationError,
  readReelOperatorConfig,
  type ReelOperatorConfig,
} from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { checkShippedReelScript, composeReelOperator } from '@knowscroll/backend/modules/content/nest-providers';

type Print = (result: Record<string, unknown>) => void;

const usage =
  'usage: operator.js reel check --script <name> | reel order --script <name> --until plan|video --ceiling <cents> [--retake] | reel follow --script <name> --until plan|video [--wait-seconds <n>] | reel receive --script <name> | reel status | reel write-off --attempt <uuid> --reason <text> [--release-claim] | reel settle --script <name> --until video --reason <text>';

const POLL_SECONDS = 20;
const MAX_WAIT_SECONDS = 3600;

const sleep = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

/** Who ran the command, for a write-off's reason: the user behind `sudo`, else the login user. */
function operatorName(env: NodeJS.ProcessEnv): string {
  const candidate = env['SUDO_USER'] ?? env['USER'] ?? env['LOGNAME'] ?? 'unknown';
  return /^[a-z_][a-z0-9_.-]{0,31}$/.test(candidate) ? candidate : 'unknown';
}

/** Exit 0 when the command did what was asked or the work is under way; 2 when it refused or must wait. */
function exitCodeOf(result: { readonly kind: string }): number {
  return ['refused', 'held', 'unknown', 'idle', 'reel_refused'].includes(result.kind) ? 2 : 0;
}

type Reel = ReturnType<typeof composeReelOperator>;

async function run(command: string, values: Record<string, string | boolean | undefined>, reel: Reel, print: Print) {
  const script = typeof values['script'] === 'string' ? values['script'] : '';
  const until = values['until'] === 'plan' || values['until'] === 'video' ? values['until'] : undefined;
  switch (command) {
    case 'order': {
      const ceiling = Number(values['ceiling']);
      if (script === '' || until === undefined || !Number.isInteger(ceiling)) return undefined;
      return reel.order({ scriptName: script, until, ceilingCents: ceiling, retake: values['retake'] === true });
    }
    case 'follow': {
      if (script === '' || until === undefined) return undefined;
      const waitSeconds = Math.min(Number(values['wait-seconds'] ?? 0), MAX_WAIT_SECONDS);
      const deadline = Date.now() + waitSeconds * 1000;
      for (;;) {
        const result = await reel.follow({ scriptName: script, until });
        if (result.kind !== 'running' || Date.now() + POLL_SECONDS * 1000 > deadline) return result;
        print({ command: 'reel follow', ...result });
        await sleep(POLL_SECONDS);
      }
    }
    case 'receive':
      return script === '' ? undefined : reel.receive({ scriptName: script });
    case 'status':
      return reel.status();
    case 'write-off': {
      const attempt = values['attempt'];
      const reason = values['reason'];
      if (typeof attempt !== 'string' || typeof reason !== 'string' || reason.trim() === '') return undefined;
      return reel.writeOff({
        attemptId: attempt,
        reason: `cli:${operatorName(process.env)}: ${reason.trim()}`,
        releaseClaim: values['release-claim'] === true,
      });
    }
    case 'settle': {
      const reason = values['reason'];
      if (script === '' || until !== 'video' || typeof reason !== 'string' || reason.trim() === '') return undefined;
      const result = await reel.settleUnpublished({ scriptName: script, until });
      return { ...result, reason: `cli:${operatorName(process.env)}: ${reason.trim()}` };
    }
    default:
      return undefined;
  }
}

/**
 * `node dist/operator.js reel <command> [options]`: the Reel commands of the worker release (#240,
 * `docs/v2/operations/cutroom-and-spend.md`). Results are one JSON line on stdout, never prompts,
 * request bytes or credentials. Exit 0 done or under way, 2 refused or not ready yet, 1 failure.
 * Only `order --until video` can spend money, and only through a claim in the shared pool.
 */
export async function reelCommand(argv: readonly string[], print: Print, logEvent: LogEvent): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        script: { type: 'string' },
        until: { type: 'string' },
        ceiling: { type: 'string' },
        retake: { type: 'boolean', default: false },
        'wait-seconds': { type: 'string' },
        attempt: { type: 'string' },
        reason: { type: 'string' },
        'release-claim': { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    print({ result: 'usage', usage });
    return 2;
  }
  const [command] = parsed.positionals;
  if (command === 'check' && parsed.positionals.length === 1 && parsed.values.script !== undefined) {
    const result = checkShippedReelScript({ scriptName: parsed.values.script });
    print({ command: 'reel check', ...result });
    return result.kind === 'ok' ? 0 : 2;
  }
  let config: ReelOperatorConfig;
  try {
    config = readReelOperatorConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.start_failed', { reasonCode: 'config_failed', error });
    return 1;
  }
  const onIdleClientError = (error: Error) => logEvent('database.idle_client_error', { error });
  const world = createDatabase<Database>(config.database, { onIdleClientError });
  const pool = createDatabase<never>(
    { ...config.database, url: config.poolUrl, applicationName: `knowscroll-reel-pool-${config.world}`, poolMax: 2 },
    { onIdleClientError },
  );
  try {
    const reel = composeReelOperator(world.db, pool.pool, {
      world: config.world,
      cutroomOrigin: config.cutroomOrigin,
      cutroomArtifactRoot: config.cutroomArtifactRoot,
      mediaRoot: config.mediaRoot,
      ffprobePath: config.ffprobePath,
    });
    const result = parsed.positionals.length === 1 ? await run(command ?? '', parsed.values, reel, print) : undefined;
    if (result === undefined) {
      print({ result: 'usage', usage });
      return 2;
    }
    print({ command: `reel ${command}`, ...result });
    return 'kind' in result ? exitCodeOf(result) : 0;
  } catch (error) {
    logEvent('process.crashed', { reasonCode: 'reel_command_failed', error });
    print({ command: `reel ${command}`, result: 'failed' });
    return 1;
  } finally {
    await world.close();
    await pool.close();
  }
}
