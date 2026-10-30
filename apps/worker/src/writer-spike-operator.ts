import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { ConfigurationError, readScrollProductionOperatorConfig } from '@knowscroll/backend/infrastructure/config';
import { uuidv7 } from '@knowscroll/backend/infrastructure/ids';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  configuredModelPort,
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
  productionHarnessSettings,
  reasoningOperatorFor,
} from '@knowscroll/backend/reasoning/nest-providers';
import {
  makeWriterSpikeV2,
  parseSpikeTopics,
  runSpikeBatch,
  SPIKE_MAX_CONCURRENCY,
  SPIKE_MODEL,
  type SpikeResult,
} from '@knowscroll/backend/modules/content/nest-providers';

type Print = (result: Record<string, unknown>) => void;

export interface WriterSpikeOptions {
  readonly topics: string | undefined;
  readonly out: string | undefined;
  readonly concurrency: string | undefined;
  readonly spikeId: string | undefined;
  readonly dispatchedBy: string;
}

/** The line written to `--out` for an accepted topic: the assembled document and the claims each part cites. */
function documentLine(spikeId: string, result: SpikeResult): string | undefined {
  if (result.document === undefined) return undefined;
  const { line, document } = result;
  return `${JSON.stringify({
    key: line.key,
    spikeId,
    runId: line.runId,
    outcome: line.outcome,
    notices: line.notices,
    document: document.document,
    citations: document.citations,
  })}\n`;
}

/**
 * `content writer-spike-v2 --topics <k1,k2,…> [--out <file>] [--concurrency <1-4>] [--spike-id <id>]`:
 * runs the v15 writer (`scroll-authoring.v2`) on real library recipes through the production
 * reasoning harness and reports what it cost and what was refused (S-0, D-120). It admits and
 * publishes nothing and creates no table: the only records are the harness's own run, attempts and
 * kept refused answers (`reasoning rejected`).
 *
 * Output: one JSON line on stdout for the start, one for each topic (`result: 'topic'`) as it
 * finishes, and one for the end (`done` or `stopped`). With `--out`, each accepted topic's assembled
 * document is appended to that file as one JSON line; it holds the model's own text about public
 * sources, so read it from the server shell and never paste it into an issue.
 *
 * Exit status: 0 when every topic was accepted or rejected on its merits, 2 when the command was
 * refused or stopped early (spent budget, unknown attempt, model mismatch, provider failures), 1 on
 * a failure.
 */
export async function writerSpikeCommand(
  options: WriterSpikeOptions,
  print: Print,
  logEvent: LogEvent,
): Promise<number> {
  const topics = options.topics === undefined ? undefined : parseSpikeTopics(options.topics);
  const concurrency = options.concurrency === undefined ? 1 : Number(options.concurrency);
  if (
    topics === undefined ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > SPIKE_MAX_CONCURRENCY
  ) {
    print({
      result: 'usage',
      usage: `content writer-spike-v2 --topics <recipe key,…> [--out <file>] [--concurrency <1-${SPIKE_MAX_CONCURRENCY}>] [--spike-id <id>]`,
    });
    return 2;
  }
  const spikeId = options.spikeId ?? randomUUID().slice(0, 8);
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/u.test(spikeId)) {
    print({ result: 'usage', usage: '--spike-id is 2 to 32 lower-case letters, digits and hyphens' });
    return 2;
  }
  try {
    const config = readScrollProductionOperatorConfig(process.env);
    const model = configuredModelPort(config.reasoning);
    if (model === undefined || model.model !== SPIKE_MODEL) {
      print({ command: 'content writer-spike-v2', result: 'model_refused', required: SPIKE_MODEL });
      return 2;
    }
    if (options.out !== undefined) {
      try {
        await appendFile(options.out, '');
      } catch {
        print({ command: 'content writer-spike-v2', result: 'out_unwritable' });
        return 2;
      }
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
      const reasoning = reasoningOperatorFor(database.db, logEvent);
      const spike = makeWriterSpikeV2({
        harness,
        withScope,
        authority: { scopeId: 'scroll-supply', generation: config.productionGeneration },
        model: model.model,
        spikeId,
        newRunId: uuidv7,
        findingsOf: async (attemptId) => {
          const shown = await reasoning.showRejectedAnswer(attemptId);
          return shown.kind === 'found' ? shown.record.issues.map(({ code, path }) => ({ code, path })) : [];
        },
      });
      print({
        command: 'content writer-spike-v2',
        result: 'starting',
        spikeId,
        topics: topics.length,
        concurrency,
        model: model.model,
        requestBoundPerTopic: 2,
        out: options.out ?? null,
      });
      const summary = await runSpikeBatch(
        topics,
        (key) => spike.writeOne(key, abort.signal),
        async (result) => {
          print({ command: 'content writer-spike-v2', result: 'topic', ...result.line });
          const written = options.out === undefined ? undefined : documentLine(spikeId, result);
          if (written !== undefined && options.out !== undefined) await appendFile(options.out, written);
        },
        concurrency,
      );
      print({
        command: 'content writer-spike-v2',
        result: summary.stoppedBy === undefined ? 'done' : 'stopped',
        spikeId,
        ...summary,
      });
      return summary.stoppedBy === undefined ? 0 : 2;
    } finally {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'writer_spike_failed', error });
    return 1;
  }
}
