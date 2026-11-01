import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
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
  ASK_SUPPORT_REPLAY_MAX,
  isAssetId,
  makeAskSupportReplay,
  type ReplayTarget,
} from '@knowscroll/backend/modules/content/nest-providers';

type Print = (result: Record<string, unknown>) => void;

export interface AskCheckOptions {
  /** `--asset <uuid,…>`: the asset ids of stored ask answers. */
  readonly asset: string | undefined;
  /** `--recent <n>`: the newest published ask answers. */
  readonly recent: string | undefined;
  /** `--out <file>`: where the detail of each checked answer is appended. Required. */
  readonly out: string | undefined;
  readonly dispatchedBy: string;
}

const USAGE = `content ask-check (--asset <uuid>[,<uuid>…] | --recent <1-${String(ASK_SUPPORT_REPLAY_MAX)}>) --out <file>`;

/** The target the options name, or `undefined` when they name none or more than one. */
function targetOf(options: AskCheckOptions): ReplayTarget | undefined {
  if ((options.asset === undefined) === (options.recent === undefined)) return undefined;
  if (options.asset !== undefined) {
    const assetIds = options.asset.split(',').map((id) => id.trim());
    return assetIds.length >= 1 && assetIds.length <= ASK_SUPPORT_REPLAY_MAX && assetIds.every(isAssetId)
      ? { kind: 'assets', assetIds }
      : undefined;
  }
  const count = Number(options.recent);
  return Number.isInteger(count) && count >= 1 && count <= ASK_SUPPORT_REPLAY_MAX
    ? { kind: 'recent', count }
    : undefined;
}

/**
 * `content ask-check (--asset <uuid,…> | --recent <n>) --out <file>`: runs the support checker (D-250) again over answers
 * that were already made for people, through the production reasoning harness (every request is an attempt in the ledger),
 * and writes what it said about each sentence. It publishes, stores and changes nothing, and it never reads the question
 * a person asked: the check does not use it.
 *
 * Output: one JSON line on stdout for each answer with counts and codes only (no sentence, title or question), and one for
 * the end. With `--out` (required), each checked answer's sentences and the checker's verdicts are appended to that file as
 * one JSON line; it holds the answer's own words, so read it from the server shell and never paste it into an issue.
 *
 * Exit status: 0 when the command ran to the end (an answer it could not replay is named in its line), 2 when it was
 * refused or stopped early (spent budget, unknown attempt, wrong model), 1 on a failure.
 */
export async function askCheckCommand(options: AskCheckOptions, print: Print, logEvent: LogEvent): Promise<number> {
  const target = targetOf(options);
  if (target === undefined || options.out === undefined) {
    print({ result: 'usage', usage: USAGE });
    return 2;
  }
  const out = options.out;
  try {
    const config = readScrollProductionOperatorConfig(process.env);
    const model = configuredModelPort(config.reasoning);
    if (model === undefined) {
      print({ command: 'content ask-check', result: 'model_unavailable' });
      return 2;
    }
    try {
      // The file holds the answers' words: only its owner reads it.
      await appendFile(out, '', { mode: 0o600 });
    } catch {
      print({ command: 'content ask-check', result: 'out_unwritable' });
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
      const replay = makeAskSupportReplay({
        db: database.db,
        harness,
        withScope,
        authority: { scopeId: 'scroll-supply', generation: config.productionGeneration },
        model: model.model,
        newRunKey: randomUUID,
      });
      print({ command: 'content ask-check', result: 'starting', model: model.model, out });
      const summary = await replay(target, abort.signal, async (result) => {
        print({ command: 'content ask-check', result: 'answer', ...result.line });
        if (result.detail !== undefined) await appendFile(out, `${JSON.stringify(result.detail)}\n`);
      });
      print({ command: 'content ask-check', result: summary.stopped ? 'stopped' : 'done', answers: summary.answers });
      return summary.stopped ? 2 : 0;
    } finally {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'ask_check_failed', error });
    return 1;
  }
}
