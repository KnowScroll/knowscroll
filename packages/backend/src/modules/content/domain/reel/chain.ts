/**
 * What Cutroom says about one request, as the domain needs it. A request is one run, or a failed
 * run and the single run Cutroom itself makes to continue it (CF-61); each run reports only its own
 * spend, so the cost of a request is the sum over the chain.
 */
export interface RunStatusFacts {
  readonly runId: string;
  readonly requestId: string;
  readonly state: 'running' | 'finished';
  /** On a run that continues another: that run. */
  readonly resumes?: string | undefined;
  /** On a run that was continued: the run that continued it. */
  readonly resumedBy?: string | undefined;
}

export type RunOutcome = 'completed' | 'refused' | 'stopped' | 'failed' | 'cancelled';

export interface RunResultFacts {
  readonly runId: string;
  readonly requestId: string;
  readonly status: RunOutcome;
  readonly until?: 'plan' | 'stills' | 'video' | undefined;
  readonly costCents: number;
  readonly estimateCents?: number | undefined;
  /** Why a refused or stopped run ended: `budget` or `rule`. */
  readonly reason?: string | undefined;
  /** For a budget answer: which limit, `reel` or `ceiling`. */
  readonly limit?: string | undefined;
  readonly rule?: string | undefined;
  /** The step a rule stopped the run at. */
  readonly step?: string | undefined;
  readonly detail?: string | undefined;
  readonly stills?: readonly { readonly pictureId: string; readonly shotId: string }[] | undefined;
  readonly videoPath?: string | undefined;
  readonly degradations?: readonly { readonly shotId: string; readonly reason: string }[] | undefined;
}

export interface ChainRun {
  readonly status: RunStatusFacts;
  /** Present once the run has finished. */
  readonly result?: RunResultFacts | undefined;
}

/** One request never has more runs than an original and its single automatic continuation. */
export const MAX_CHAIN_RUNS = 2;

export type ChainReport =
  | { readonly kind: 'broken'; readonly code: 'chain_links' | 'chain_request' | 'chain_length' }
  | { readonly kind: 'running'; readonly runIds: readonly string[] }
  | {
      readonly kind: 'finished';
      readonly outcome: RunOutcome;
      readonly runIds: readonly string[];
      readonly finalRunId: string;
      readonly costCents: number;
      readonly tip: RunResultFacts;
    };

function linked(runs: readonly ChainRun[]): boolean {
  if (runs[0]?.status.resumes !== undefined) return false;
  for (let index = 1; index < runs.length; index++) {
    const before = runs[index - 1]!.status;
    const run = runs[index]!.status;
    if (run.resumes !== before.runId || before.resumedBy !== run.runId) return false;
  }
  return new Set(runs.map((run) => run.status.runId)).size === runs.length;
}

/**
 * Folds the runs read for one request, original first. The request is finished only when its last
 * run has finished and nothing continued it. A failed run that Cutroom is still continuing is not
 * the end of the request, whatever its own result says (CF-62: never settle before reading
 * `resumedBy`). Money and publication follow only from a `finished` report.
 */
export function foldChain(requestId: string, runs: readonly ChainRun[]): ChainReport {
  if (runs.length === 0 || runs.length > MAX_CHAIN_RUNS) return { kind: 'broken', code: 'chain_length' };
  const foreign = (run: ChainRun) =>
    run.status.requestId !== requestId ||
    (run.result !== undefined && (run.result.requestId !== requestId || run.result.runId !== run.status.runId));
  if (runs.some(foreign)) return { kind: 'broken', code: 'chain_request' };
  if (!linked(runs)) return { kind: 'broken', code: 'chain_links' };
  const runIds = runs.map((run) => run.status.runId);
  const tip = runs.at(-1)!;
  const open =
    tip.status.state !== 'finished' ||
    tip.status.resumedBy !== undefined ||
    tip.result === undefined ||
    runs.some((run) => run.result === undefined || run.status.state !== 'finished');
  if (open) return { kind: 'running', runIds };
  const results = runs.map((run) => run.result!);
  return {
    kind: 'finished',
    outcome: tip.result.status,
    runIds,
    finalRunId: tip.status.runId,
    costCents: results.reduce((sum, result) => sum + result.costCents, 0),
    tip: tip.result,
  };
}

const MAX_DETAIL_CHARS = 500;

/**
 * A short plain account of why a request did not complete, for the operator. Cutroom's free text is
 * about our own script, but a provider response can carry a credential, so URLs and paths never
 * pass (CF-10). `null` when the request completed.
 */
export function describeEnd(result: RunResultFacts): string | null {
  if (result.status === 'completed') return null;
  const parts: string[] = [result.status];
  if (result.reason === 'budget') parts.push(`budget (${result.limit ?? 'unknown'} limit)`);
  if (result.reason === 'rule') parts.push(`rule ${result.rule ?? 'unknown'} at ${result.step ?? 'unknown'}`);
  if (result.detail !== undefined && result.detail.length > 0) parts.push(result.detail);
  return parts
    .join(': ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
    .replace(/(?:\/[\w.@~-]+){2,}/g, '[path]')
    .slice(0, MAX_DETAIL_CHARS);
}

/** What the engine recorded about how a run was made (wire `RunRecord`). */
export interface EngineRecordFacts {
  readonly runId: string;
  readonly pictures: readonly {
    readonly pictureId: string;
    readonly shotId: string;
    readonly chosen: boolean;
    readonly keptFrom?: string | undefined;
    readonly checks: readonly { readonly gate: string; readonly step?: string | undefined; readonly outcome: string }[];
  }[];
  readonly takes: readonly {
    readonly shotId: string;
    readonly used: boolean;
    readonly keptFrom?: string | undefined;
    readonly checks: readonly { readonly gate: string; readonly outcome: string }[];
  }[];
  readonly degradations: readonly { readonly shotId: string; readonly reason: string }[];
}

export type RecordVerdict = 'ok' | 'record_identity' | 'record_picture' | 'record_take' | 'record_shots';

const passes = (checks: readonly { readonly outcome: string }[]) => checks.every((check) => check.outcome !== 'fail');

/**
 * Whether the engine's own record of a completed video run attests what the run claims: every
 * chosen picture passed its four steps, every used take passed its four gates, and each shot with a
 * picture has a used take or a recorded degradation. The label stays "engine-attested, not
 * independent" (CF-64). A piece may be copied from the run this one continues (`keptFrom`), and from
 * no other.
 */
export function checkEngineRecord(
  tip: RunResultFacts,
  record: EngineRecordFacts,
  continuedRunId: string | undefined,
): RecordVerdict {
  if (record.runId !== tip.runId || tip.status !== 'completed' || tip.until !== 'video') return 'record_identity';
  const copiedOk = (keptFrom: string | undefined) => keptFrom === undefined || keptFrom === continuedRunId;
  const chosen = record.pictures.filter((picture) => picture.chosen);
  const used = record.takes.filter((take) => take.used);
  if (chosen.length === 0 || new Set(chosen.map((p) => p.shotId)).size !== chosen.length) return 'record_picture';
  if (used.length === 0 || new Set(used.map((take) => take.shotId)).size !== used.length) return 'record_take';
  for (const picture of chosen) {
    const steps = ['technical', 'text', 'witness', 'reconcile'];
    if (
      !copiedOk(picture.keptFrom) ||
      !passes(picture.checks) ||
      !steps.every((step) => picture.checks.some((c) => c.gate === '1' && c.step === step && c.outcome !== 'fail'))
    )
      return 'record_picture';
  }
  for (const take of used) {
    // A shot may be made from words alone, so a take carries no picture reference (D-027, S-150).
    if (
      !copiedOk(take.keptFrom) ||
      !passes(take.checks) ||
      !['2', '3', '4', '5'].every((gate) => take.checks.some((c) => c.gate === gate && c.outcome !== 'fail'))
    )
      return 'record_take';
  }
  const stills = tip.stills ?? [];
  const shotsCovered = stills.every(
    (still) =>
      chosen.some((picture) => picture.pictureId === still.pictureId && picture.shotId === still.shotId) &&
      (used.some((take) => take.shotId === still.shotId) ||
        record.degradations.some((degradation) => degradation.shotId === still.shotId)),
  );
  const sameDegradations = JSON.stringify(record.degradations) === JSON.stringify(tip.degradations ?? []);
  return stills.length === chosen.length && shotsCovered && sameDegradations ? 'ok' : 'record_shots';
}
