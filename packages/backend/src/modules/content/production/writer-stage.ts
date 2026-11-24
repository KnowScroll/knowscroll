import type {
  ContextItem,
  ProductionAuthority,
  ProductionReasoningHarness,
  ProposeOutcome,
  WithProductionScope,
} from '../../../reasoning/public.js';
import type { ResearchPage } from '../../../infrastructure/research/public-pages.js';
import type { CompileOutcome } from '../application/ports.js';
import { emptyAnswerCheckReceipt } from './answer-check.js';
import { EvidenceRefusal, evidencePassages, evidenceText } from './evidence.js';
import { isSentAttempt } from './publication-topic.js';
import { withAccounting, writerReceipt } from './receipts.js';
import { hasAnswerCheck } from './review-hold.js';
import type { ProductionRow } from './store.js';
import type { ProductionSubject } from './subject.js';
import { productionVersionOf, requestBoundOf } from './topics.js';
import type { ClosingRun, ProduceScrollResult, RoleReceipt } from './types.js';
import { writerPlanFor, type WriterPlan } from './writer-plan.js';

/** What the writer stage needs from the job it runs in: how to end it, how to publish it, and how to report it. */
export interface JobOperations {
  /** The job as it stands now, for a delivery that finds its stage already advanced. */
  readonly replayCurrent: (row: ProductionRow) => Promise<ProduceScrollResult>;
  /** Ends the job at the writer stage in a terminal state, closing the runs it used (none when the outcome is unknown). */
  readonly end: (
    row: ProductionRow,
    state: 'rejected' | 'unknown',
    codes: readonly string[],
    receipts: readonly RoleReceipt[],
    closing: readonly ClosingRun[],
  ) => Promise<ProduceScrollResult>;
  /**
   * Stores the draft's revision and closes the runs, in one transaction. `writerRunId` is the run whose
   * answer is stored; the job names it, and `alsoClose` are the other runs the job used.
   */
  readonly publish: (
    subject: ProductionSubject,
    row: ProductionRow,
    receipts: readonly RoleReceipt[],
    authored: unknown,
    compiled: Extract<CompileOutcome, { kind: 'compiled' }>,
    writerRunId: string,
    alsoClose: readonly ClosingRun[],
  ) => Promise<ProduceScrollResult>;
}

export interface WriterStageDependencies {
  readonly authority: ProductionAuthority;
  readonly withScope: WithProductionScope;
  readonly harness: ProductionReasoningHarness;
  readonly model: string;
}

type Compiled = Extract<CompileOutcome, { kind: 'compiled' }>;
type Proposed = Extract<ProposeOutcome<unknown>, { kind: 'proposed' }>;

/** Everything one run of the stage needs to know about the job and its writer. */
interface Stage {
  readonly subject: ProductionSubject;
  readonly row: ProductionRow;
  readonly plan: WriterPlan;
}

/** One accepted and compiled answer of the writer, with the receipt of the run that wrote it. */
interface Draft {
  readonly runId: string;
  readonly authored: unknown;
  readonly compiled: Compiled;
  readonly receipt: RoleReceipt;
}

const isResult = (value: Draft | ProduceScrollResult): value is ProduceScrollResult => 'outcome' in value;

/**
 * The receipt of the links a document v3's compile left out (D-438): a count and nothing else, because the job's outcomes are
 * kept and read by operators and a link's words are model text. None when every link was placed.
 */
function linksDroppedReceipt(compiled: Compiled): readonly RoleReceipt[] {
  const dropped = compiled.notices?.length ?? 0;
  return dropped === 0 ? [] : [{ role: 'checks', kind: 'links_dropped', dropped }];
}

/**
 * The writer stage of a production job: ask the writer, compile its answer and publish it. The stage sends at most two writer requests
 * (the first draft with the harness's repair) and holds no transaction while a request is out. A document v3 has no calls to check
 * (decision I1 on #756), so its answer check is the empty one (D-198). The support check of the answer to a question, the code's trim and
 * drop of its sentences and the revision they earned went with the v1 writer (#818, D-443).
 */
export function makeWriterStage(deps: WriterStageDependencies, ops: JobOperations) {
  const paused = (row: ProductionRow, code: string): ProduceScrollResult => ({
    outcome: 'paused',
    requestBound: requestBoundOf(row.topic),
    runId: row.id,
    codes: [code],
  });

  async function attemptsOf(runId: string) {
    const accounting = await deps.withScope(deps.authority, (scope) =>
      deps.harness.readProductionRunAccounting(scope, runId),
    );
    return accounting.kind === 'entered' && accounting.value.kind === 'accounted'
      ? accounting.value.attempts
      : undefined;
  }

  /**
   * The harness has accepted a writer answer: read the paid attempts, compile the answer with their
   * real identities, or end the job with the findings.
   */
  async function acceptDraft(stage: Stage, runId: string, writer: Proposed): Promise<Draft | ProduceScrollResult> {
    const { row } = stage;
    const receipt = writerReceipt(writer);
    const closing = [{ runId, state: 'failed' as const }];
    const refuse = (codes: readonly string[], recorded: RoleReceipt) =>
      ops.end(row, 'rejected', codes, [recorded], closing);
    const attempts = await attemptsOf(runId);
    if (attempts === undefined) return refuse(['accounting_unavailable'], receipt);
    const paidAttemptIds = attempts.filter(isSentAttempt).map((attempt) => attempt.attemptId);
    // The writer's one request and the harness's one repair of it.
    if (paidAttemptIds.length < 1 || paidAttemptIds.length > 2) return refuse(['attempt_bound_exceeded'], receipt);
    const recorded = withAccounting(receipt, attempts);
    const compiled = stage.plan.compile(writer.output, { runId, attemptIds: paidAttemptIds, model: deps.model });
    if (compiled.kind === 'refused')
      return refuse(
        compiled.issues.map((issue) => issue.code),
        recorded,
      );
    return { runId, authored: writer.output, compiled, receipt: recorded };
  }

  /**
   * A document v3 has no calls to check (decision I1 on #756), so its answer check is the empty one: recorded as passed with no
   * request, and its one draft is published here, with the count of links its compile left out.
   */
  function checkDraft(stage: Stage, draft: Draft): Promise<ProduceScrollResult> {
    const receipts = [draft.receipt, ...linksDroppedReceipt(draft.compiled), emptyAnswerCheckReceipt(1)];
    return ops.publish(stage.subject, stage.row, receipts, draft.authored, draft.compiled, draft.runId, []);
  }

  /** The first draft is in: a library Scroll's answer check is recorded as passed, any other is published as it is. */
  async function settleFirstDraft(stage: Stage, writer: Proposed): Promise<ProduceScrollResult> {
    const draft = await acceptDraft(stage, stage.row.writer_run_id, writer);
    if (isResult(draft)) return draft;
    if (hasAnswerCheck(stage.subject)) return checkDraft(stage, draft);
    return ops.publish(stage.subject, stage.row, [draft.receipt], draft.authored, draft.compiled, draft.runId, []);
  }

  /** The writer stage: ask once (the harness allows one repair), then settle the answer. */
  return async function writeAndPublish(
    subject: ProductionSubject,
    row: ProductionRow,
    pages: readonly ResearchPage[],
    signal: AbortSignal,
  ): Promise<ProduceScrollResult> {
    let passages;
    try {
      passages = evidencePassages(pages);
    } catch (error) {
      return ops.end(row, 'rejected', [error instanceof EvidenceRefusal ? error.code : 'evidence_failed'], [], []);
    }
    const plan = writerPlanFor({
      subject,
      revision: row.target_revision,
      runId: row.writer_run_id,
      model: deps.model,
      passages,
      pages,
    });
    const items: readonly ContextItem[] = [
      { ref: `brief:${subject.key}`, kind: 'production_brief', text: subject.brief },
      { ref: `evidence:${row.id}`, kind: 'public_research_passages', text: evidenceText(passages) },
    ];
    const writer = await deps.harness.proposeProduction(
      {
        run: {
          id: row.writer_run_id,
          authority: deps.authority,
          ownerModule: 'content',
          purpose: 'scroll-writer',
          policyVersion: productionVersionOf(subject.key),
        },
        role: plan.role,
        context: { bundleRef: `scroll:${row.id}:research`, items },
        limits: { allowRepair: true },
      },
      signal,
    );
    if (writer.kind === 'refused' && writer.reason === 'run_closed') return ops.replayCurrent(row);
    // A spent budget or quota stops the run before anything is sent: the job stays open to resume.
    if (writer.kind === 'budget_exhausted' || writer.kind === 'quota_unavailable')
      return paused(
        row,
        writer.kind === 'budget_exhausted' ? `budget_${writer.dimension}_${writer.limit}` : writer.kind,
      );
    if (writer.kind !== 'proposed') {
      const attempts = await attemptsOf(row.writer_run_id);
      const receipt = attempts === undefined ? writerReceipt(writer) : withAccounting(writerReceipt(writer), attempts);
      return ops.end(
        row,
        writer.kind === 'unknown' ? 'unknown' : 'rejected',
        [writer.kind],
        [receipt],
        [{ runId: row.writer_run_id, state: 'failed' }],
      );
    }
    return settleFirstDraft({ subject, row, plan }, writer);
  };
}
