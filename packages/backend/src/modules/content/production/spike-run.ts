import type { ProductionAttemptAccounting, ProposeOutcome } from '../../../reasoning/public.js';

/**
 * What the writer spikes share: the model they accept, the shape of a line's accounting, how a harness result is classified and how a
 * batch of jobs runs. The document v3 spike (`spike-v3/run.ts`) and the support-check replays use it. The v2 spike that first held it
 * is deleted (#815).
 */

/** The only model the spike accepts (D-031): a reply from any other model is an error, never data. */
export const SPIKE_MODEL = 'MiniMax-M3.1-Flash';
/** The most topics that run at once. */
export const SPIKE_MAX_CONCURRENCY = 4;

export type SpikeOutcome =
  | 'accepted_first_take'
  | 'accepted_after_repair'
  /** The writer's answer and its one repair were both refused. */
  | 'rejected'
  | 'research_failed'
  | 'evidence_insufficient'
  | 'provider_failed'
  | 'model_mismatch'
  /** A daily budget or the provider's quota is used up: nothing was sent. */
  | 'paused'
  /** The attempt may have reached the provider: reconcile it, never resend. */
  | 'unknown'
  | 'refused'
  | 'scope_refused';

/** One finding of the validator or the schema on a refused answer: a code and the writer's path, no text. */
export interface SpikeFinding {
  readonly attempt: number;
  readonly code: string;
  readonly path: string;
}

/** The accounting of one paid attempt. */
export interface SpikeAttempt {
  readonly attemptId: string;
  readonly step: string;
  readonly state: string;
  readonly inputTokens: number | null;
  /** Output tokens as the provider reports them, thinking tokens included. */
  readonly outputTokens: number | null;
  readonly thinkingTokens: number | null;
}

/** The tokens of a spike line: summed over its attempts, with `complete` false when one did not report a count. */
export interface SpikeTokens {
  readonly input: number | null;
  readonly output: number | null;
  readonly thinking: number | null;
  readonly complete: boolean;
}

/** The tokens of a line before any attempt was paid. */
export const emptyTokens = { input: null, output: null, thinking: null, complete: false } as const;

/** Sums reported usage; `complete` is false when any attempt did not report a count. */
export function tokensOf(attempts: readonly SpikeAttempt[]): SpikeTokens {
  const paid = attempts;
  const sum = (pick: (attempt: SpikeAttempt) => number | null): number | null =>
    paid.length === 0 ? null : paid.reduce<number>((total, attempt) => total + (pick(attempt) ?? 0), 0);
  return {
    input: sum((attempt) => attempt.inputTokens),
    output: sum((attempt) => attempt.outputTokens),
    thinking: sum((attempt) => attempt.thinkingTokens),
    complete: paid.length > 0 && paid.every((attempt) => attempt.inputTokens !== null && attempt.outputTokens !== null),
  };
}

/** One paid attempt as a spike line reports it. */
export const toSpikeAttempt = (attempt: ProductionAttemptAccounting): SpikeAttempt => ({
  attemptId: attempt.attemptId,
  step: attempt.step,
  state: attempt.state,
  inputTokens: attempt.usage.inputTokens,
  outputTokens: attempt.usage.outputTokens,
  thinkingTokens: attempt.usage.reasoningTokens,
});

/** The outcome a harness result stands for, before the answer is compiled. */
export function classify<T>(result: ProposeOutcome<T>): { outcome: SpikeOutcome; code?: string } {
  switch (result.kind) {
    case 'proposed':
      return { outcome: result.repaired ? 'accepted_after_repair' : 'accepted_first_take' };
    case 'invalid_output':
      return { outcome: 'rejected', code: result.reason };
    case 'unknown':
      return { outcome: 'unknown' };
    case 'failed':
      return { outcome: result.code === 'MODEL_MISMATCH' ? 'model_mismatch' : 'provider_failed', code: result.code };
    case 'budget_exhausted':
      return { outcome: 'paused', code: `budget_${result.dimension}_${result.limit}` };
    case 'quota_unavailable':
      return { outcome: 'paused', code: 'quota_unavailable' };
    case 'refused':
      return { outcome: result.reason === 'scope_refused' ? 'scope_refused' : 'refused', code: result.reason };
  }
}

/** Outcomes after which no further job is started: the cause is not about the next job. */
const STOPS_THE_BATCH: ReadonlySet<SpikeOutcome> = new Set([
  'paused',
  'unknown',
  'refused',
  'scope_refused',
  'model_mismatch',
]);

/** What a batch reports: how many jobs ran, which never started and what stopped it, if anything did. `Job` is what a batch runs: a recipe with an arm, for the v3 spike. */
export interface SpikeBatchSummary<Job> {
  readonly requested: number;
  readonly completed: number;
  /** Jobs never started because an earlier outcome stopped the batch. */
  readonly notStarted: readonly Job[];
  readonly stoppedBy?: { readonly key: Job; readonly outcome: SpikeOutcome };
}

/**
 * Runs jobs through `writeOne`, at most `concurrency` at a time, handing each result to `emit` as
 * soon as it is ready. After an outcome that says the cause is not the job (a spent budget, an
 * unknown attempt, a refused harness, a model mismatch) or two provider failures in a row, no new
 * job starts; those already running finish. A job is any value the caller can run: the v3 spike
 * runs a recipe with an arm.
 */
export async function runSpikeJobs<Job, Result extends { readonly line: { readonly outcome: SpikeOutcome } }>(
  jobs: readonly Job[],
  writeOne: (job: Job) => Promise<Result>,
  emit: (result: Result) => Promise<void>,
  concurrency: number,
): Promise<SpikeBatchSummary<Job>> {
  const queue = [...jobs];
  let completed = 0;
  let consecutiveFailures = 0;
  let stoppedBy: SpikeBatchSummary<Job>['stoppedBy'];
  const worker = async (): Promise<void> => {
    while (stoppedBy === undefined) {
      const job = queue.shift();
      if (job === undefined) return;
      const result = await writeOne(job);
      await emit(result);
      completed += 1;
      consecutiveFailures = result.line.outcome === 'provider_failed' ? consecutiveFailures + 1 : 0;
      if ((STOPS_THE_BATCH.has(result.line.outcome) || consecutiveFailures >= 2) && stoppedBy === undefined)
        stoppedBy = { key: job, outcome: result.line.outcome };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, SPIKE_MAX_CONCURRENCY)) }, worker));
  return { requested: jobs.length, completed, notStarted: queue, ...(stoppedBy === undefined ? {} : { stoppedBy }) };
}
