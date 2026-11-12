import { ConfigurationError, readScrollProductionOperatorConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  configuredModelPort,
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
  productionHarnessSettings,
} from '@knowscroll/backend/reasoning/nest-providers';
import {
  LIBRARY_SUPPORT_REPLAY_MAX_REQUESTS,
  LIBRARY_SUPPORT_REPLAY_MAX_REVISIONS,
  makeCheckLibrarySupport,
  makeLibrarySupportReplay,
} from '@knowscroll/backend/modules/content/nest-providers';

type Print = (result: Record<string, unknown>) => void;

export interface SupportCheckReplayOptions {
  /** `--since <ISO date>`: only decisions made at or after it. */
  readonly since: string | undefined;
  /** `--limit <n>`: the newest decided revisions to look at (default 50). */
  readonly limit: string | undefined;
  /** `--max-requests <n>`: the most paid requests this replay may send. Required: a replay is paid for. */
  readonly maxRequests: string | undefined;
  /** `--fail-on-partial`: exit 2 when some decided revisions were skipped for the cap, so a script cannot mistake a partial measure for a whole one. */
  readonly failOnPartial?: boolean;
  readonly dispatchedBy: string;
}

const DEFAULT_LIMIT = 50;
const COMMAND = 'content support-check-replay';
const USAGE = `${COMMAND} [--since <ISO date>] [--limit <1-${String(LIBRARY_SUPPORT_REPLAY_MAX_REVISIONS)}>] --max-requests <0-${String(LIBRARY_SUPPORT_REPLAY_MAX_REQUESTS)}> [--fail-on-partial]`;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/u;

/**
 * The exit status of a replay by how it ended: 0 for `done`, 2 for `stopped`, and for `partial` (some decided revisions were skipped for the request
 * cap, so the agreement covers some of the decisions only) 0, or 2 with `--fail-on-partial` so that a script cannot take a partial measure for a whole one.
 */
export function replayExitCode(status: 'done' | 'partial' | 'stopped', failOnPartial: boolean): 0 | 2 {
  return status === 'stopped' || (status === 'partial' && failOnPartial) ? 2 : 0;
}

/** A whole number in a range from the command line, or `undefined`. */
function wholeNumber(raw: string, min: number, max: number): number | undefined {
  if (!/^\d{1,6}$/u.test(raw)) return undefined;
  const value = Number(raw);
  return value >= min && value <= max ? value : undefined;
}

/**
 * `content support-check-replay [--since <ISO date>] [--limit <n>] --max-requests <n>`: measures the library support check (D-415) against
 * the operator's own decisions. For the newest revisions the operator released or rejected it runs the check over each one that has no
 * result of the current checker version, then prints how the stored results agree with the decisions: for released and rejected
 * revisions, how many the check would have passed and flagged, the rejected ones it would have passed (the dangerous number), the released
 * ones it would have flagged, by recipe family, and the same results under looser limits.
 *
 * It changes no revision, decision or Scroll. The only rows it writes are the check's own results, the same ones the worker's job writes, so
 * running it again sends nothing for a revision already checked, and a check the worker already made is used, not paid for again. It calls
 * the production reasoning harness (`KS_REASONING_PRODUCTION_ENABLED=1`, `KS_MINIMAX_MODEL=MiniMax-M3.1-Flash`; any other model is refused),
 * so every request is an attempt in the ledger and spends the production budget. `--max-requests` bounds it: a revision whose check might
 * pass the cap is skipped, not started, and `--max-requests 0` reads what is stored and sends nothing.
 *
 * Output: one JSON line for each revision with counts and codes only (no sentence, title or reason), then one for the end with the
 * agreement. It holds no body text, so it may be pasted into an issue.
 *
 * The last line says `done`, `partial` or `stopped`. `partial`: some decided revisions were skipped for the cap (`skippedForCap`, by decision), so the
 * agreement covers some of the decisions only. The agreement counts only decisions made with no result in existence and says plainly whether the
 * number of rejected revisions is enough to conclude anything (`conclusion`).
 *
 * Exit status: 0 for `done` and `partial` (2 for `partial` with `--fail-on-partial`), 2 when it was refused or stopped early (a spent budget or quota, an attempt of
 * unknown outcome, a revoked production root, the wrong model, bad usage), 1 on a failure.
 */
export async function supportCheckReplayCommand(
  options: SupportCheckReplayOptions,
  print: Print,
  logEvent: LogEvent,
): Promise<number> {
  const limit =
    options.limit === undefined ? DEFAULT_LIMIT : wholeNumber(options.limit, 1, LIBRARY_SUPPORT_REPLAY_MAX_REVISIONS);
  const maxRequests =
    options.maxRequests === undefined
      ? undefined
      : wholeNumber(options.maxRequests, 0, LIBRARY_SUPPORT_REPLAY_MAX_REQUESTS);
  const since =
    options.since === undefined ? undefined : ISO_DATE.test(options.since) ? new Date(options.since) : undefined;
  if (
    limit === undefined ||
    maxRequests === undefined ||
    (options.since !== undefined && (since === undefined || Number.isNaN(since.getTime())))
  ) {
    print({ result: 'usage', usage: USAGE });
    return 2;
  }
  try {
    const config = readScrollProductionOperatorConfig(process.env);
    const model = configuredModelPort(config.reasoning);
    if (model === undefined) {
      print({ command: COMMAND, result: 'model_unavailable' });
      return 2;
    }
    const database = createDatabase<Database>(config.database, {
      onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
    });
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    try {
      const withScope = makeWithProductionScope(database.db, {
        enabled: config.reasoning.productionEnabled,
        lockTimeoutMs: config.scopeLockTimeoutMs,
      });
      const harness = makeProductionReasoningHarness(
        postgresProductionHarnessPorts({
          db: database.db,
          withProductionScope: withScope,
          enabled: config.reasoning.productionEnabled,
          model,
          logEvent,
          settings: productionHarnessSettings(config.reasoning, options.dispatchedBy),
        }),
      );
      const replay = makeLibrarySupportReplay({
        db: database.db,
        check: makeCheckLibrarySupport({
          db: database.db,
          authority: { scopeId: 'scroll-supply', generation: config.productionGeneration },
          withScope,
          harness,
        }),
        model: model.model,
      });
      print({
        command: COMMAND,
        result: 'starting',
        model: model.model,
        limit,
        maxRequests,
        ...(since === undefined ? {} : { since: since.toISOString() }),
      });
      const summary = await replay({ since, limit, maxRequests }, abort.signal, (line) =>
        print({ command: COMMAND, result: 'revision', ...line }),
      );
      const { status, ...rest } = summary;
      print({ command: COMMAND, result: status, ...rest });
      return replayExitCode(status, options.failOnPartial === true);
    } finally {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'support_check_replay_failed', error });
    return 1;
  }
}
