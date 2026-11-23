import { parseArgs } from 'node:util';
import { ConfigurationError, readContentOperatorConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { CLEANUP_WORLDS, cleanupOldScrolls, type CleanupMode } from './old-scroll-cleanup.js';

type Print = (result: Record<string, unknown>) => void;

export const CLEANUP_USAGE = 'usage: operator.js content cleanup-old-scrolls (--dry-run | --run)';

/**
 * `content cleanup-old-scrolls (--dry-run | --run)` (#791, D-437): removes every `scroll-document.v1` and `scroll-document.v2` Scroll
 * from the database the command runs on, and everything that points at them, and keeps the accounts, the document v3 Scrolls and
 * the Reels. Exactly one of the two flags is required: `--dry-run` prints what `--run` would do and changes nothing; `--run` does it.
 * Both print one JSON summary of counts and ids (never a name, an email or a word of a Scroll). What it clears and removes, in which
 * order, and the steps around it (backup, stop the worker) are in `docs/v2/operations/scroll-cleanup.md`.
 *
 * Runs only in the worlds `local`, `ci` and `dev`. In any other world (`stage`, `production`, an unknown name) it refuses with
 * `world_not_allowed` before it reads the database settings or opens a connection. It refuses while another cleanup runs, and a
 * second `--run` finds nothing to remove and changes nothing.
 *
 * Exit status: 0 done, planned or nothing to do; 2 refused or bad usage; 1 failure.
 */
export async function cleanupOldScrollsCommand(
  argv: readonly string[],
  print: Print,
  logEvent: LogEvent,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: [...argv],
      options: { 'dry-run': { type: 'boolean', default: false }, run: { type: 'boolean', default: false } },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    print({ result: 'usage', usage: CLEANUP_USAGE });
    return 2;
  }
  const dryRun = args.values['dry-run'] === true;
  const run = args.values.run === true;
  if (
    args.positionals.length !== 2 ||
    args.positionals[0] !== 'content' ||
    args.positionals[1] !== 'cleanup-old-scrolls' ||
    dryRun === run
  ) {
    print({ result: 'usage', usage: CLEANUP_USAGE });
    return 2;
  }
  const mode: CleanupMode = run ? 'run' : 'dry_run';
  const world = env['KS_WORLD'] ?? '';
  if (!CLEANUP_WORLDS.includes(world)) {
    print({ command: 'content cleanup-old-scrolls', mode, world, result: 'refused', code: 'world_not_allowed' });
    return 2;
  }
  try {
    const config = readContentOperatorConfig(env);
    const database = createDatabase<Database>(config.database, {
      onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
    });
    try {
      const summary = await cleanupOldScrolls(database.db, { mode, world: config.world });
      print(summary);
      return summary.result === 'refused' ? 2 : summary.result === 'failed' ? 1 : 0;
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'cleanup_old_scrolls_failed', error });
    return 1;
  }
}
