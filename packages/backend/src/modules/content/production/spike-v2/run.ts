import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { readingWords } from '@knowscroll/scroll-model';
import type { ResearchPage } from '../../../../infrastructure/research/public-pages.js';
import { fetchResearchPage, ResearchRefusal } from '../../../../infrastructure/research/public-pages.js';
import type {
  ProductionAttemptAccounting,
  ProductionAuthority,
  ProductionReasoningHarness,
  ProposeOutcome,
  WithProductionScope,
} from '../../../../reasoning/public.js';
import { EvidenceRefusal, evidencePassages, evidenceText, type EvidencePassage } from '../evidence.js';
import { isSentAttempt } from '../publication-topic.js';
import { TOPICS, type ScrollTopic } from '../topics.js';
import {
  compileGeneratedScrollV2,
  publicationV2,
  writerRoleV2,
  WRITER_V2_PROMPT_VERSION,
  type WriterV2Context,
} from '../writer-v2.js';
import { spikeRecipeV2 } from './topics.js';
import type { AuthoredScrollV2 } from '@knowscroll/scroll-model/producer';

/** The only model the spike accepts (D-031): a reply from any other model is an error, never data. */
export const SPIKE_MODEL = 'MiniMax-M3.1-Flash';
/** The version of the spike's runs in the production ledger. */
export const SPIKE_POLICY_VERSION = 'scroll-spike.v2';
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

/** What the operator prints for one topic: one JSON line, no text of the Scroll. */
export interface SpikeLine {
  readonly key: ScrollTopic;
  readonly spikeId: string;
  readonly outcome: SpikeOutcome;
  readonly variant: 'stage' | 'plain';
  readonly misconception: 'myth' | 'none';
  /** True when the table of the spike did not list the recipe and the defaults applied. */
  readonly recipeDefaulted: boolean;
  readonly promptVersion: string;
  /** Paid requests sent: 1 for a first take, 2 when a repair was needed. */
  readonly requests: number;
  readonly findings: readonly SpikeFinding[];
  /** Things a person must settle before a Scroll joins the library (an unreviewed source). */
  readonly notices: readonly string[];
  readonly words: number | null;
  readonly readingMinutes: number | null;
  readonly stops: number | null;
  readonly calls: number | null;
  readonly stageStates: number | null;
  readonly asides: number | null;
  readonly tokens: {
    readonly input: number | null;
    readonly output: number | null;
    readonly thinking: number | null;
    readonly complete: boolean;
  };
  readonly attempts: readonly SpikeAttempt[];
  /** The model the paid attempts report: the transport checks each reply's `model` field and fails the attempt on a mismatch. */
  readonly models: readonly string[];
  readonly code?: string;
  readonly runId: string;
  readonly wallMs: { readonly research: number; readonly writer: number; readonly total: number };
}

export interface SpikeResult {
  readonly line: SpikeLine;
  /** The assembled document of an accepted topic, with the claims each part cites. */
  readonly document?: {
    readonly document: ScrollDocumentV2;
    readonly citations: Readonly<Record<string, readonly string[]>>;
  };
}

export interface WriterSpikeDeps {
  readonly harness: ProductionReasoningHarness;
  readonly withScope: WithProductionScope;
  readonly authority: ProductionAuthority;
  /** The model the harness is configured with; the spike refuses to run on any other. */
  readonly model: string;
  readonly research?: (url: string) => Promise<ResearchPage>;
  /** The fixed findings the harness kept for a refused attempt (code and path only). */
  readonly findingsOf?: (attemptId: string) => Promise<readonly { readonly code: string; readonly path: string }[]>;
  readonly newRunId: () => string;
  readonly now?: () => number;
  /** Names this spike in every line, so a rerun's lines are told apart. */
  readonly spikeId: string;
}

const emptyTokens = { input: null, output: null, thinking: null, complete: false } as const;

/** Sums reported usage; `complete` is false when any attempt did not report a count. */
function tokensOf(attempts: readonly SpikeAttempt[]): SpikeLine['tokens'] {
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

const toSpikeAttempt = (attempt: ProductionAttemptAccounting): SpikeAttempt => ({
  attemptId: attempt.attemptId,
  step: attempt.step,
  state: attempt.state,
  inputTokens: attempt.usage.inputTokens,
  outputTokens: attempt.usage.outputTokens,
  thinkingTokens: attempt.usage.reasoningTokens,
});

/** The outcome a harness result stands for, before the answer is compiled. */
function classify(result: ProposeOutcome<AuthoredScrollV2>): { outcome: SpikeOutcome; code?: string } {
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

/**
 * The writer spike for `scroll-authoring.v2` (S-0, D-120): for each library recipe, fetch its public
 * research, ask the v14 writer once (the harness allows one repair), validate and assemble the
 * answer, and report what it cost and what was refused. Nothing is admitted, published or stored in
 * a content table: the only records are the harness's own (run, attempts, kept refused answers), so
 * every paid attempt consults the attempt ledger and an unknown outcome is never resent.
 *
 * No model call or network wait runs inside a database transaction: research is fetched first, the
 * harness owns its own short transactions, and the scope is entered only to read accounting and to
 * close the run afterwards.
 */
export function makeWriterSpikeV2(deps: WriterSpikeDeps) {
  const now = deps.now ?? Date.now;
  const research = deps.research ?? fetchResearchPage;

  const baseLine = (key: ScrollTopic, runId: string, started: number): SpikeLine => {
    const recipe = spikeRecipeV2(key);
    return {
      key,
      spikeId: deps.spikeId,
      outcome: 'refused',
      variant: recipe.variant,
      misconception: recipe.misconception.kind,
      recipeDefaulted: recipe.defaulted,
      promptVersion: WRITER_V2_PROMPT_VERSION,
      requests: 0,
      findings: [],
      notices: [],
      words: null,
      readingMinutes: null,
      stops: null,
      calls: null,
      stageStates: null,
      asides: null,
      tokens: emptyTokens,
      attempts: [],
      models: [],
      runId,
      wallMs: { research: 0, writer: 0, total: now() - started },
    };
  };

  /** Fetches the recipe's public pages (no lock held). */
  async function fetchPages(key: ScrollTopic): Promise<readonly ResearchPage[] | { readonly code: string }> {
    try {
      return await Promise.all(TOPICS[key].pages.map((url) => research(url)));
    } catch (error) {
      return { code: error instanceof ResearchRefusal ? error.code : 'research_failed' };
    }
  }

  /** The paid attempts of a run and the run closed behind them, in one short scope. */
  async function settleRun(
    runId: string,
    outcome: SpikeOutcome,
  ): Promise<readonly ProductionAttemptAccounting[] | undefined> {
    const settled = await deps.withScope(deps.authority, async (scope) => {
      const accounting = await deps.harness.readProductionRunAccounting(scope, runId);
      // An unknown attempt stays open for reconciliation; every other run is finished here.
      if (outcome !== 'unknown')
        await deps.harness.closeProductionRun(scope, {
          runId,
          state: outcome === 'accepted_first_take' || outcome === 'accepted_after_repair' ? 'completed' : 'cancelled',
        });
      return accounting.kind === 'accounted' ? accounting.attempts : undefined;
    });
    return settled.kind === 'entered' ? settled.value : undefined;
  }

  async function findingsFor(attempts: readonly SpikeAttempt[]): Promise<SpikeFinding[]> {
    if (deps.findingsOf === undefined) return [];
    const found: SpikeFinding[] = [];
    for (const [index, attempt] of attempts.entries())
      for (const finding of await deps.findingsOf(attempt.attemptId))
        found.push({ attempt: index + 1, code: finding.code, path: finding.path });
    return found;
  }

  async function writeOne(key: ScrollTopic, signal: AbortSignal): Promise<SpikeResult> {
    const started = now();
    const runId = deps.newRunId();
    const line = baseLine(key, runId, started);
    if (deps.model !== SPIKE_MODEL)
      return { line: { ...line, outcome: 'model_mismatch', code: 'configured_model_not_allowed' } };
    const pages = await fetchPages(key);
    const researched = now();
    if ('code' in pages)
      return {
        line: {
          ...line,
          outcome: 'research_failed',
          code: pages.code,
          wallMs: { research: researched - started, writer: 0, total: researched - started },
        },
      };
    let passages: readonly EvidencePassage[];
    try {
      passages = evidencePassages(pages);
    } catch (error) {
      const code = error instanceof EvidenceRefusal ? error.code : 'evidence_failed';
      return {
        line: {
          ...line,
          outcome: 'evidence_insufficient',
          code,
          wallMs: { research: researched - started, writer: 0, total: researched - started },
        },
      };
    }
    const recipe = spikeRecipeV2(key);
    const context: WriterV2Context = { publication: publicationV2(key), recipe, passages, pages };
    const proposed = await deps.harness.proposeProduction(
      {
        run: {
          id: runId,
          authority: deps.authority,
          ownerModule: 'content',
          purpose: 'scroll-writer-spike',
          policyVersion: SPIKE_POLICY_VERSION,
        },
        role: writerRoleV2(context),
        context: {
          bundleRef: `scroll-spike:${runId}:research`,
          items: [
            { ref: `brief:${key}`, kind: 'production_brief', text: TOPICS[key].brief },
            { ref: `evidence:${runId}`, kind: 'public_research_passages', text: evidenceText(passages) },
          ],
        },
        limits: { allowRepair: true },
      },
      signal,
    );
    const written = now();
    return report({ line, key, started, researched, written, proposed, context });
  }

  /** Reads the accounting, closes the run and builds the line (and the document, when accepted). */
  async function report(input: {
    readonly line: SpikeLine;
    readonly key: ScrollTopic;
    readonly started: number;
    readonly researched: number;
    readonly written: number;
    readonly proposed: ProposeOutcome<AuthoredScrollV2>;
    readonly context: WriterV2Context;
  }): Promise<SpikeResult> {
    const { line, proposed, context } = input;
    let { outcome, code } = classify(proposed);
    const accounted = await settleRun(line.runId, outcome);
    const paid = (accounted ?? []).filter(isSentAttempt).map(toSpikeAttempt);
    const models = [...new Set((accounted ?? []).filter(isSentAttempt).map((attempt) => attempt.model))];
    let compiled: ReturnType<typeof compileGeneratedScrollV2> | undefined;
    if (proposed.kind === 'proposed') {
      compiled = compileGeneratedScrollV2(proposed.output, context);
      // The harness validated this answer with the same compile; a disagreement is a defect, not data.
      if (compiled.kind !== 'compiled') ({ outcome, code } = { outcome: 'rejected', code: 'compile_disagrees' });
      else if (models.some((model) => model !== SPIKE_MODEL))
        ({ outcome, code } = { outcome: 'model_mismatch', code: 'attempt_model_differs' });
    }
    const document = compiled?.kind === 'compiled' && outcome.startsWith('accepted') ? compiled : undefined;
    const measured = document?.document;
    // A repaired Scroll's first answer was refused too: its findings are the repair's reason.
    const refused = await findingsFor(paid);
    if (accounted === undefined && code === undefined) code = 'accounting_unavailable';
    return {
      line: {
        ...line,
        outcome,
        ...(code === undefined ? {} : { code }),
        requests: paid.length,
        findings: refused,
        notices: document?.notices.map((notice) => notice.code) ?? [],
        words: measured === undefined ? null : readingWords(measured),
        readingMinutes: measured?.measures.readingMinutes ?? null,
        stops: measured?.stops.length ?? null,
        calls: measured === undefined ? null : measured.stops.filter((stop) => stop.kind !== 'read').length,
        stageStates: measured === undefined ? null : (measured.stage?.states.length ?? 0),
        asides: measured?.asides.length ?? null,
        tokens: tokensOf(paid),
        attempts: paid,
        models,
        wallMs: {
          research: input.researched - input.started,
          writer: input.written - input.researched,
          total: now() - input.started,
        },
      },
      ...(document === undefined ? {} : { document: { document: document.document, citations: document.citations } }),
    };
  }

  return { writeOne };
}

/** Outcomes after which no further topic is started: the cause is not about the next topic. */
const STOPS_THE_BATCH: ReadonlySet<SpikeOutcome> = new Set([
  'paused',
  'unknown',
  'refused',
  'scope_refused',
  'model_mismatch',
]);

export interface SpikeBatchSummary {
  readonly requested: number;
  readonly completed: number;
  /** Topics never started because an earlier outcome stopped the batch. */
  readonly notStarted: readonly ScrollTopic[];
  readonly stoppedBy?: { readonly key: ScrollTopic; readonly outcome: SpikeOutcome };
}

/**
 * Runs topics through `writeOne`, at most `concurrency` at a time, handing each result to `emit` as
 * soon as it is ready. After an outcome that says the cause is not the topic (a spent budget, an
 * unknown attempt, a refused harness, a model mismatch) or two provider failures in a row, no new
 * topic starts; those already running finish.
 */
export async function runSpikeBatch(
  keys: readonly ScrollTopic[],
  writeOne: (key: ScrollTopic) => Promise<SpikeResult>,
  emit: (result: SpikeResult) => Promise<void>,
  concurrency: number,
): Promise<SpikeBatchSummary> {
  const queue = [...keys];
  let completed = 0;
  let consecutiveFailures = 0;
  let stoppedBy: SpikeBatchSummary['stoppedBy'];
  const worker = async (): Promise<void> => {
    while (stoppedBy === undefined) {
      const key = queue.shift();
      if (key === undefined) return;
      const result = await writeOne(key);
      await emit(result);
      completed += 1;
      consecutiveFailures = result.line.outcome === 'provider_failed' ? consecutiveFailures + 1 : 0;
      if ((STOPS_THE_BATCH.has(result.line.outcome) || consecutiveFailures >= 2) && stoppedBy === undefined)
        stoppedBy = { key, outcome: result.line.outcome };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, SPIKE_MAX_CONCURRENCY)) }, worker));
  return { requested: keys.length, completed, notStarted: queue, ...(stoppedBy === undefined ? {} : { stoppedBy }) };
}
