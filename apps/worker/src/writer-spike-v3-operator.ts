import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
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
  makeWriterSpikeV3,
  parseSpikeArms,
  parseSpikeTopicsV3,
  REQUEST_BOUND_V3_WRITER,
  runSpikeJobs,
  SPIKE_ID_PATTERN,
  SPIKE_MAX_CONCURRENCY,
  SPIKE_MODEL,
  spikeJobLabel,
  type SpikeJobV3,
  type SpikeResultV3,
} from '@knowscroll/backend/modules/content/nest-providers';

type Print = (result: Record<string, unknown>) => void;

export interface WriterSpikeV3Options {
  readonly topics: string | undefined;
  /** `--arms a,b`: `a` writes the whole Scroll in one reply, `b` the prose and then its staging. */
  readonly arms: string | undefined;
  /** `--raw-dir <absolute dir>`: where every paid reply is kept, under `<spike id>/`. */
  readonly rawDir: string | undefined;
  readonly out: string | undefined;
  readonly concurrency: string | undefined;
  readonly spikeId: string | undefined;
  readonly dispatchedBy: string;
}

/** The most paid requests a job can send: the writer and its two repairs (D-445), and for arm b the stager and its repairs too. */
const requestBound = (job: SpikeJobV3): number => (job.arm === 'a' ? 1 : 2) * REQUEST_BOUND_V3_WRITER;

/** The line written to `--out` for an accepted job: the compiled document and the claims each part cites. */
function documentLine(spikeId: string, result: SpikeResultV3): string | undefined {
  if (result.document === undefined) return undefined;
  const { line, document } = result;
  return `${JSON.stringify({
    key: line.key,
    arm: line.arm,
    spikeId,
    document: document.document,
    citations: document.citations,
  })}\n`;
}

const usageText = `content writer-spike-v3 --topics <recipe key,…> --arms <a,b> [--raw-dir <absolute dir>] [--out <file>] [--concurrency <1-${String(SPIKE_MAX_CONCURRENCY)}>] [--spike-id <id>]`;

/**
 * `content writer-spike-v3 --topics <k1,k2,…> --arms <a,b> [--raw-dir <dir>] [--out <file>] [--concurrency <1-4>] [--spike-id <id>]`:
 * runs the document v3 writer (`scroll-writing-v3.v1`) on the spike's recipes through the production reasoning harness
 * and reports what it cost and what was refused (#771). Each recipe runs in each arm: `a` is one run for the whole
 * Scroll, `b` is two runs, the prose and then its staging. It admits and publishes nothing and creates no table: the only
 * records are the harness's own run, attempts and kept refused answers (`reasoning rejected`).
 *
 * Output: one JSON line on stdout for the start, one for each job (`result: 'job'`) as it finishes, and one for the end
 * (`done` or `stopped`). With `--out`, each accepted job's compiled document is appended to that file as one JSON line
 * (`{ key, arm, spikeId, document, citations }`). With `--raw-dir`, every paid reply is written to
 * `<raw-dir>/<spike id>/<key>.<arm>.<step>.<n>.json`. Both hold the model's own text about public sources: keep them in a
 * folder outside the repository, read them from the operator's own shell and never paste them into an issue.
 *
 * Exit status: 0 when every job was accepted or rejected on its merits, 2 when the command was refused or stopped early
 * (spent budget, unknown attempt, model mismatch, provider failures), 1 on a failure.
 */
export async function writerSpikeV3Command(
  options: WriterSpikeV3Options,
  print: Print,
  logEvent: LogEvent,
): Promise<number> {
  const topics = options.topics === undefined ? undefined : parseSpikeTopicsV3(options.topics);
  const arms = options.arms === undefined ? undefined : parseSpikeArms(options.arms);
  const concurrency = options.concurrency === undefined ? 1 : Number(options.concurrency);
  if (
    topics === undefined ||
    arms === undefined ||
    (options.rawDir !== undefined && !isAbsolute(options.rawDir)) ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > SPIKE_MAX_CONCURRENCY
  ) {
    print({ result: 'usage', usage: usageText });
    return 2;
  }
  const spikeId = options.spikeId ?? randomUUID().slice(0, 8);
  if (!SPIKE_ID_PATTERN.test(spikeId)) {
    print({ result: 'usage', usage: '--spike-id is 2 to 32 lower-case letters, digits and hyphens' });
    return 2;
  }
  const jobs: SpikeJobV3[] = topics.flatMap((key) => arms.map((arm) => ({ key, arm })));
  try {
    const config = readScrollProductionOperatorConfig(process.env);
    const model = configuredModelPort(config.reasoning);
    if (model === undefined || model.model !== SPIKE_MODEL) {
      print({ command: 'content writer-spike-v3', result: 'model_refused', required: SPIKE_MODEL });
      return 2;
    }
    if (options.out !== undefined) {
      try {
        await appendFile(options.out, '');
      } catch {
        print({ command: 'content writer-spike-v3', result: 'out_unwritable' });
        return 2;
      }
    }
    if (options.rawDir !== undefined) {
      try {
        await mkdir(join(options.rawDir, spikeId), { recursive: true, mode: 0o700 });
      } catch {
        print({ command: 'content writer-spike-v3', result: 'raw_dir_unwritable' });
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
      const spike = makeWriterSpikeV3({
        harness,
        withScope,
        authority: { scopeId: 'scroll-supply', generation: config.productionGeneration },
        model: model.model,
        spikeId,
        ...(options.rawDir === undefined ? {} : { rawDir: options.rawDir }),
        newRunId: uuidv7,
        findingsOf: async (attemptId) => {
          const shown = await reasoning.showRejectedAnswer(attemptId);
          return shown.kind === 'found' ? shown.record.issues.map(({ code, path }) => ({ code, path })) : [];
        },
        rejectedTextOf: async (attemptId) => {
          const shown = await reasoning.showRejectedAnswer(attemptId);
          return shown.kind === 'found' ? shown.record.answerText : undefined;
        },
      });
      print({
        command: 'content writer-spike-v3',
        result: 'starting',
        spikeId,
        jobs: jobs.length,
        concurrency,
        model: model.model,
        requestBound: jobs.reduce((total, job) => total + requestBound(job), 0),
        rawDir: options.rawDir === undefined ? null : join(options.rawDir, spikeId),
        out: options.out ?? null,
      });
      const summary = await runSpikeJobs(
        jobs,
        (job) => spike.writeOne(job.key, job.arm, abort.signal),
        async (result) => {
          print({ command: 'content writer-spike-v3', result: 'job', ...result.line });
          const written = options.out === undefined ? undefined : documentLine(spikeId, result);
          if (written !== undefined && options.out !== undefined) await appendFile(options.out, written);
        },
        concurrency,
      );
      print({
        command: 'content writer-spike-v3',
        result: summary.stoppedBy === undefined ? 'done' : 'stopped',
        spikeId,
        requested: summary.requested,
        completed: summary.completed,
        notStarted: summary.notStarted.map(spikeJobLabel),
        ...(summary.stoppedBy === undefined
          ? {}
          : { stoppedBy: { job: spikeJobLabel(summary.stoppedBy.key), outcome: summary.stoppedBy.outcome } }),
      });
      return summary.stoppedBy === undefined ? 0 : 2;
    } finally {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'writer_spike_v3_failed', error });
    return 1;
  }
}
