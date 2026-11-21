import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScrollDocumentV3 } from '@knowscroll/scroll-model';
import type { ProductionRecord } from '@knowscroll/scroll-model/internal';
import type { WrittenProseV3, WrittenScrollV3, WrittenStagingV3 } from '@knowscroll/scroll-model/producer';
import type { ResearchPage } from '../../../../infrastructure/research/public-pages.js';
import { fetchResearchPage, ResearchRefusal } from '../../../../infrastructure/research/public-pages.js';
import type {
  ContextItem,
  ProductionAttemptAccounting,
  ProductionAuthority,
  ProductionReasoningHarness,
  ProposeOutcome,
  ReasoningRole,
  WithProductionScope,
} from '../../../../reasoning/public.js';
import { EvidenceRefusal, evidencePassages, evidenceText, type EvidencePassage } from '../evidence.js';
import { isSentAttempt } from '../publication-topic.js';
import { TOPICS } from '../topics.js';
import {
  compileGeneratedScrollV3,
  compileStagedScrollV3,
  stagerContextItems,
  stagerRoleV3,
  writerContextV3,
  writerRoleV3One,
  writerRoleV3Prose,
  type GeneratedScrollV3,
  type WriterV3Context,
} from '../writer-v3.js';
import type { WriterV3Step } from '../writer-v3-instructions.js';
import {
  classify,
  emptyTokens,
  SPIKE_MODEL,
  tokensOf,
  toSpikeAttempt,
  type SpikeAttempt,
  type SpikeFinding,
  type SpikeOutcome,
} from '../spike-v2/run.js';
import { documentFacts, type SpikeDocumentFacts } from './facts.js';
import { spikePlanV3, type SpikeArm, type SpikeTopicV3 } from './plans.js';

/** The version of the v3 spike's runs in the production ledger. */
export const SPIKE_POLICY_VERSION_V3 = 'scroll-spike.v3';
/** What a spike id may be: it names the folder the raw replies are written to. */
export const SPIKE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/u;

/** Tokens as a line reports them: summed over attempts, with `complete` false when one did not report a count. */
type Tokens = ReturnType<typeof tokensOf>;

/** The raw reply files of a run: the names written and how many could not be. */
interface RawFiles {
  readonly written: string[];
  readonly failed: number;
}

/** One harness run of a spike line: the run, what was paid in it and how it ended. */
export interface SpikeStepLineV3 {
  readonly step: WriterV3Step;
  readonly runId: string;
  readonly roleVersion: string;
  readonly outcome: SpikeOutcome;
  readonly code?: string;
  /** Paid requests sent: 1 for a first take, 2 when a repair was needed. */
  readonly requests: number;
  /** The findings of each refused answer of the run: the repair's reason. */
  readonly findings: readonly SpikeFinding[];
  readonly tokens: Tokens;
  readonly attempts: readonly SpikeAttempt[];
  /** The model the paid attempts report; the transport fails an attempt whose reply names another one. */
  readonly models: readonly string[];
  readonly wallMs: number;
}

/** What the operator prints for one recipe and arm: one JSON line, no text of the Scroll. */
export interface SpikeLineV3 {
  readonly key: SpikeTopicV3;
  readonly spikeId: string;
  readonly arm: SpikeArm;
  readonly outcome: SpikeOutcome;
  readonly code?: string;
  readonly steps: readonly SpikeStepLineV3[];
  /** Totals over every step. */
  readonly requests: number;
  readonly tokens: Tokens;
  readonly wallMs: { readonly research: number; readonly total: number };
  /** What an accepted document holds, in numbers. */
  readonly document: SpikeDocumentFacts | null;
  /** The raw replies written to the raw folder, by file name, and how many could not be written. */
  readonly rawFiles: readonly string[];
  readonly rawFilesFailed: number;
}

export interface SpikeResultV3 {
  readonly line: SpikeLineV3;
  /** The compiled document of an accepted job, with the claims each part cites. */
  readonly document?: {
    readonly document: ScrollDocumentV3;
    readonly citations: Readonly<Record<string, readonly string[]>>;
  };
}

/** What a batch runs: one recipe in one arm. */
export interface SpikeJobV3 {
  readonly key: SpikeTopicV3;
  readonly arm: SpikeArm;
}

/** How a job is named on a line of output and in a batch summary. */
export const spikeJobLabel = (job: SpikeJobV3): string => `${job.key}.${job.arm}`;

export interface WriterSpikeV3Deps {
  readonly harness: ProductionReasoningHarness;
  readonly withScope: WithProductionScope;
  readonly authority: ProductionAuthority;
  /** The model the harness is configured with; the spike refuses to run on any other. */
  readonly model: string;
  readonly research?: (url: string) => Promise<ResearchPage>;
  /** The fixed findings the harness kept for a refused attempt (code and path only). */
  readonly findingsOf?: (attemptId: string) => Promise<readonly { readonly code: string; readonly path: string }[]>;
  /** The text of the refused answer the harness kept for an attempt, if it kept one. */
  readonly rejectedTextOf?: (attemptId: string) => Promise<string | undefined>;
  readonly newRunId: () => string;
  readonly now?: () => number;
  /** Names this spike in every line and names the folder of its raw replies. */
  readonly spikeId: string;
  /** Where the raw replies go: `<rawDir>/<spikeId>/<key>.<arm>.<step>.<n>.json`. Nothing is written without it. */
  readonly rawDir?: string;
}

/** One run's result before the job's outcome is final: the line, and what the next step or the compile needs. */
interface StepRun<T> {
  readonly line: SpikeStepLineV3;
  readonly output: T | undefined;
  /** The paid attempts of the run, oldest first. */
  readonly attemptIds: readonly string[];
  readonly raw: RawFiles;
}

/** What a job has settled before its steps start: the research, the context and the clock. */
interface JobStart {
  readonly key: SpikeTopicV3;
  readonly arm: SpikeArm;
  readonly started: number;
  readonly researched: number;
  readonly context: WriterV3Context;
  readonly signal: AbortSignal;
}

const isAccepted = (outcome: SpikeOutcome): boolean =>
  outcome === 'accepted_first_take' || outcome === 'accepted_after_repair';

/**
 * The writer spike for `scroll-writing-v3.v1` (#771): for a recipe and an arm, fetch the recipe's public research and
 * ask the document v3 writer through the production harness. Arm `a` is one run: the whole Scroll in one reply. Arm
 * `b` is two: the prose, and, once it is accepted, the staging of that prose. Each run allows the harness's one repair.
 * Nothing is admitted, published or stored in a content table: the only records are the harness's own (runs,
 * attempts, kept refused answers), so every paid attempt consults the attempt ledger and an unknown outcome is never resent.
 *
 * With `rawDir`, every paid attempt's reply is written to its own file there, outside the repository: the accepted
 * answer re-serialised, or the refused answer the harness kept. No model call or network wait runs inside a database
 * transaction: research is fetched first, the harness owns its own short transactions, and the scope is entered only to
 * read accounting and to close a run.
 */
export function makeWriterSpikeV3(deps: WriterSpikeV3Deps) {
  const now = deps.now ?? Date.now;
  const research = deps.research ?? fetchResearchPage;
  if (deps.rawDir !== undefined && !SPIKE_ID_PATTERN.test(deps.spikeId))
    throw new Error('A spike that writes raw replies needs a spike id of lower-case letters, digits and hyphens.');

  /** Fetches the recipe's public pages (no lock held). */
  async function fetchPages(key: SpikeTopicV3): Promise<readonly ResearchPage[] | { readonly code: string }> {
    try {
      return await Promise.all(TOPICS[key].pages.map((url) => research(url)));
    } catch (error) {
      return { code: error instanceof ResearchRefusal ? error.code : 'research_failed' };
    }
  }

  /** The run's attempts as the ledger holds them (a short scope; nothing is held open). */
  async function readAccounting(runId: string): Promise<readonly ProductionAttemptAccounting[] | undefined> {
    const read = await deps.withScope(deps.authority, async (scope) => {
      const accounting = await deps.harness.readProductionRunAccounting(scope, runId);
      return accounting.kind === 'accounted' ? accounting.attempts : undefined;
    });
    return read.kind === 'entered' ? read.value : undefined;
  }

  /** Closes a run once its outcome is final. An unknown attempt keeps its run open for reconciliation. */
  async function closeRun(runId: string, outcome: SpikeOutcome): Promise<void> {
    if (outcome === 'unknown') return;
    const state = isAccepted(outcome) ? 'completed' : 'cancelled';
    await deps.withScope(deps.authority, (scope) => deps.harness.closeProductionRun(scope, { runId, state }));
  }

  async function findingsFor(attempts: readonly SpikeAttempt[]): Promise<SpikeFinding[]> {
    if (deps.findingsOf === undefined) return [];
    const found: SpikeFinding[] = [];
    for (const [index, attempt] of attempts.entries())
      for (const finding of await deps.findingsOf(attempt.attemptId))
        found.push({ attempt: index + 1, code: finding.code, path: finding.path });
    return found;
  }

  /** The text kept for a refused attempt, or `null` when the harness kept none or could not be asked. */
  async function refusedText(attemptId: string): Promise<string | null> {
    try {
      return (await deps.rejectedTextOf?.(attemptId)) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Writes one file for each paid attempt of a run under `<rawDir>/<spikeId>/`. A file that cannot be written is
   * counted, never fatal: the paid answer is already in the ledger's kept answers and the line says what was lost.
   */
  async function writeRawReplies(input: {
    readonly key: SpikeTopicV3;
    readonly arm: SpikeArm;
    readonly step: WriterV3Step;
    readonly sent: readonly ProductionAttemptAccounting[];
    readonly proposed: ProposeOutcome<unknown>;
  }): Promise<RawFiles> {
    const written: string[] = [];
    if (deps.rawDir === undefined) return { written, failed: 0 };
    const folder = join(deps.rawDir, deps.spikeId);
    let failed = 0;
    for (const [index, attempt] of input.sent.entries()) {
      const { proposed } = input;
      const text =
        proposed.kind === 'proposed' && proposed.attemptId === attempt.attemptId
          ? JSON.stringify(proposed.output)
          : await refusedText(attempt.attemptId);
      const name = `${input.key}.${input.arm}.${input.step}.${String(index + 1)}.json`;
      const reply = {
        key: input.key,
        arm: input.arm,
        step: input.step,
        attempt: index + 1,
        attemptId: attempt.attemptId,
        state: attempt.state,
        model: attempt.model,
        text,
      };
      try {
        await mkdir(folder, { recursive: true, mode: 0o700 });
        await writeFile(join(folder, name), `${JSON.stringify(reply)}\n`, { mode: 0o600 });
        written.push(name);
      } catch {
        failed += 1;
      }
    }
    return { written, failed };
  }

  /**
   * One harness run: proposes, reads what the ledger accounts, checks the model of each attempt, keeps the raw replies and
   * the findings. The run is left open: the caller closes it once the job's outcome is final.
   */
  async function runStep<T>(input: {
    readonly key: SpikeTopicV3;
    readonly arm: SpikeArm;
    readonly step: WriterV3Step;
    readonly role: ReasoningRole<T>;
    readonly items: readonly ContextItem[];
    readonly signal: AbortSignal;
  }): Promise<StepRun<T>> {
    const started = now();
    const runId = deps.newRunId();
    const proposed = await deps.harness.proposeProduction(
      {
        run: {
          id: runId,
          authority: deps.authority,
          ownerModule: 'content',
          purpose: 'scroll-writer-spike',
          policyVersion: SPIKE_POLICY_VERSION_V3,
        },
        role: input.role,
        context: { bundleRef: `scroll-spike:${runId}:${input.step}`, items: input.items },
        limits: { allowRepair: true },
      },
      input.signal,
    );
    let { outcome, code } = classify(proposed);
    const accounted = await readAccounting(runId);
    const sent = (accounted ?? []).filter(isSentAttempt);
    const paid = sent.map(toSpikeAttempt);
    const models = [...new Set(sent.map((attempt) => attempt.model))];
    // An attempt that reached another model than the one allowed is no data, whatever it said (D-031).
    if (outcome !== 'unknown' && models.some((model) => model !== SPIKE_MODEL))
      ({ outcome, code } = { outcome: 'model_mismatch', code: 'attempt_model_differs' });
    const raw = await writeRawReplies({ key: input.key, arm: input.arm, step: input.step, sent, proposed });
    const findings = await findingsFor(paid);
    if (accounted === undefined && code === undefined) code = 'accounting_unavailable';
    return {
      line: {
        step: input.step,
        runId,
        roleVersion: input.role.version,
        outcome,
        ...(code === undefined ? {} : { code }),
        requests: paid.length,
        findings,
        tokens: tokensOf(paid),
        attempts: paid,
        models,
        wallMs: now() - started,
      },
      output: proposed.kind === 'proposed' ? proposed.output : undefined,
      attemptIds: sent.map((attempt) => attempt.attemptId),
      raw,
    };
  }

  const totals = (steps: readonly SpikeStepLineV3[]): Tokens => tokensOf(steps.flatMap((step) => step.attempts));

  const baseLine = (key: SpikeTopicV3, arm: SpikeArm, started: number): SpikeLineV3 => ({
    key,
    spikeId: deps.spikeId,
    arm,
    outcome: 'refused',
    steps: [],
    requests: 0,
    tokens: emptyTokens,
    wallMs: { research: 0, total: now() - started },
    document: null,
    rawFiles: [],
    rawFilesFailed: 0,
  });

  /** The brief and the passages: what the whole-Scroll and the prose requests carry. */
  const writerItems = (key: SpikeTopicV3, passages: readonly EvidencePassage[]): ContextItem[] => [
    { ref: `brief:${key}`, kind: 'production_brief', text: TOPICS[key].brief },
    { ref: `evidence:${key}`, kind: 'public_research_passages', text: evidenceText(passages) },
  ];

  /** The production record of a compiled document: the last run and the paid attempts that made its answer. */
  const productionOf = (last: StepRun<unknown>): ProductionRecord => ({
    kind: 'model',
    runId: last.line.runId,
    // The provenance records at most the primary attempt and its repair.
    attemptIds: last.attemptIds.slice(-2),
    model: SPIKE_MODEL,
    promptVersion: last.line.roleVersion,
  });

  /**
   * Settles a job: compiles what its last step answered with the same checks that accepted it (a disagreement is a
   * defect, not data), fixes the outcome, closes the last run and builds the line and the document.
   */
  async function conclude(input: {
    readonly job: JobStart;
    readonly earlier: readonly StepRun<unknown>[];
    readonly last: StepRun<unknown>;
    readonly compile: (production: ProductionRecord) => GeneratedScrollV3 | undefined;
  }): Promise<SpikeResultV3> {
    const { job, last } = input;
    let { outcome, code } = last.line;
    let generated: GeneratedScrollV3 | undefined;
    if (isAccepted(outcome)) {
      generated = input.compile(productionOf(last));
      if (generated?.kind !== 'compiled') ({ outcome, code } = { outcome: 'rejected', code: 'compile_disagrees' });
      else if (
        outcome === 'accepted_first_take' &&
        input.earlier.some((step) => step.line.outcome === 'accepted_after_repair')
      )
        outcome = 'accepted_after_repair';
    }
    await closeRun(last.line.runId, outcome);
    const document = generated?.kind === 'compiled' && isAccepted(outcome) ? generated : undefined;
    const steps = [
      ...input.earlier.map((step) => step.line),
      { ...last.line, outcome, ...(code === undefined ? {} : { code }) },
    ];
    return {
      line: {
        ...baseLine(job.key, job.arm, job.started),
        outcome,
        ...(code === undefined ? {} : { code }),
        steps,
        requests: steps.reduce((total, step) => total + step.requests, 0),
        tokens: totals(steps),
        wallMs: { research: job.researched - job.started, total: now() - job.started },
        document:
          document === undefined
            ? null
            : documentFacts(
                document.document,
                job.context.plan.pictures?.map((picture) => picture.kind),
              ),
        rawFiles: [...input.earlier, last].flatMap((step) => step.raw.written),
        rawFilesFailed: [...input.earlier, last].reduce((total, step) => total + step.raw.failed, 0),
      },
      ...(document === undefined ? {} : { document: { document: document.document, citations: document.citations } }),
    };
  }

  /** Arm a: the whole Scroll in one run. */
  async function armA(job: JobStart, passages: readonly EvidencePassage[]): Promise<SpikeResultV3> {
    const run = await runStep<WrittenScrollV3>({
      key: job.key,
      arm: 'a',
      step: 'one',
      role: writerRoleV3One(job.context),
      items: writerItems(job.key, passages),
      signal: job.signal,
    });
    return conclude({
      job,
      earlier: [],
      last: run,
      compile: (production) =>
        run.output === undefined ? undefined : compileGeneratedScrollV3(run.output, job.context, production),
    });
  }

  /** Arm b: the prose in one run and, once it is accepted, its staging in another. */
  async function armB(job: JobStart, passages: readonly EvidencePassage[]): Promise<SpikeResultV3> {
    const prose = await runStep<WrittenProseV3>({
      key: job.key,
      arm: 'b',
      step: 'prose',
      role: writerRoleV3Prose(job.context),
      items: writerItems(job.key, passages),
      signal: job.signal,
    });
    if (!isAccepted(prose.line.outcome) || prose.output === undefined)
      return conclude({ job, earlier: [], last: prose, compile: () => undefined });
    // The prose is final once accepted: its run is complete whatever the staging does.
    await closeRun(prose.line.runId, prose.line.outcome);
    const acceptedProse = prose.output;
    const staging = await runStep<WrittenStagingV3>({
      key: job.key,
      arm: 'b',
      step: 'staging',
      role: stagerRoleV3(job.context, acceptedProse),
      items: stagerContextItems(job.context, acceptedProse, job.key),
      signal: job.signal,
    });
    return conclude({
      job,
      earlier: [prose],
      last: staging,
      compile: (production) =>
        staging.output === undefined
          ? undefined
          : compileStagedScrollV3(acceptedProse, staging.output, job.context, production),
    });
  }

  /** Writes one recipe in one arm. Never throws on a refused or failed attempt: the outcome says what happened. */
  async function writeOne(key: SpikeTopicV3, arm: SpikeArm, signal: AbortSignal): Promise<SpikeResultV3> {
    const started = now();
    const line = baseLine(key, arm, started);
    if (deps.model !== SPIKE_MODEL)
      return { line: { ...line, outcome: 'model_mismatch', code: 'configured_model_not_allowed' } };
    const pages = await fetchPages(key);
    const researched = now();
    const beforeWriter = { research: researched - started, total: researched - started };
    if ('code' in pages)
      return { line: { ...line, outcome: 'research_failed', code: pages.code, wallMs: beforeWriter } };
    let passages: readonly EvidencePassage[];
    try {
      passages = evidencePassages(pages);
    } catch (error) {
      const code = error instanceof EvidenceRefusal ? error.code : 'evidence_failed';
      return { line: { ...line, outcome: 'evidence_insufficient', code, wallMs: beforeWriter } };
    }
    const context = writerContextV3(TOPICS[key], spikePlanV3(key), passages, pages);
    const job: JobStart = { key, arm, started, researched, context, signal };
    return arm === 'a' ? armA(job, passages) : armB(job, passages);
  }

  return { writeOne };
}
