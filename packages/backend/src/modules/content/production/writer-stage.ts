import type {
  ContextItem,
  ProductionAuthority,
  ProductionReasoningHarness,
  ProposeOutcome,
  WithProductionScope,
} from '../../../reasoning/public.js';
import type { AuthoredScroll } from '@knowscroll/scroll-model/producer';
import type { ResearchPage } from '../../../infrastructure/research/public-pages.js';
import type { CompileOutcome } from '../application/ports.js';
import { flaggedCalls, type CallVerdict } from '../domain/answer-check.js';
import {
  passes,
  unsupportedOf,
  type SentenceUnderCheck,
  type SentenceVerdict,
  type UnsupportedVerdict,
} from '../domain/ask-support.js';
import { callsOfStoredDocument, type CallUnderCheck } from './answer-check.js';
import { makeAnswerCheckStep } from './answer-check-step.js';
import { dropFlagged } from './ask-support-drop.js';
import { hasSupportCheck, sentencesOfAnswer } from './ask-support.js';
import { makeAskSupportStep } from './ask-support-step.js';
import { EvidenceRefusal, evidencePassages, evidenceText, type EvidencePassage } from './evidence.js';
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
  /** The writer's own context: the brief and the evidence. */
  readonly items: readonly ContextItem[];
  /** The passages the writer was offered, by handle: what an ask order's support check reads the answer against. */
  readonly passages: readonly EvidencePassage[];
  readonly signal: AbortSignal;
}

/** One accepted and compiled answer of the writer, with the receipt of the run that wrote it. */
interface Draft {
  readonly number: 1 | 2;
  readonly runId: string;
  readonly authored: unknown;
  readonly compiled: Compiled;
  /** The identities of the paid attempts that wrote it, which a compile of the same answer without some sentences keeps. */
  readonly attemptIds: readonly string[];
  readonly receipt: RoleReceipt;
  /** The harness already repaired this answer for the validator, so no repair is left to give a flagged one. */
  readonly repaired: boolean;
}

/** What earlier drafts of the job leave behind: their receipts, and the runs to close with the job. */
interface History {
  readonly receipts: readonly RoleReceipt[];
  readonly closing: readonly ClosingRun[];
}
const NO_HISTORY: History = { receipts: [], closing: [] };

const isResult = (value: Draft | ProduceScrollResult): value is ProduceScrollResult => 'outcome' in value;

/**
 * The writer stage of a production job: ask the writer, compile its answer and publish it. For a v2
 * library recipe the answer check sits between the two (D-198), and for the answer to a person's question
 * the support check does (D-250). The stage sends at most two writer requests (the first draft with the
 * harness's repair, or with the one repair a flag earns) and at most two checks (one for each draft), and
 * holds no transaction while a request is out. The answer to a question may send four: the first draft and its
 * repair, then the revision a support check earns and its repair for a copied passage (D-297).
 */
export function makeWriterStage(deps: WriterStageDependencies, ops: JobOperations) {
  const answerCheck = makeAnswerCheckStep(deps);
  const supportCheck = makeAskSupportStep(deps);

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
  async function acceptDraft(
    stage: Stage,
    runId: string,
    number: 1 | 2,
    writer: Proposed,
    history: History,
  ): Promise<Draft | ProduceScrollResult> {
    const { row } = stage;
    const receipt = writerReceipt(writer);
    const closing = [...history.closing, { runId, state: 'failed' as const }];
    const refuse = (codes: readonly string[], recorded: RoleReceipt) =>
      ops.end(row, 'rejected', codes, [...history.receipts, recorded], closing);
    const attempts = await attemptsOf(runId);
    if (attempts === undefined) return refuse(['accounting_unavailable'], receipt);
    const paidAttemptIds = attempts.filter(isSentAttempt).map((attempt) => attempt.attemptId);
    // The first draft has the harness's repair. The second is the repair a flag earned and has none of its own, except
    // the revision after a support check, which has one for a copied passage (D-297).
    const mostPaidAttempts = number === 1 || hasSupportCheck(stage.subject) ? 2 : 1;
    if (paidAttemptIds.length < 1 || paidAttemptIds.length > mostPaidAttempts)
      return refuse(['attempt_bound_exceeded'], receipt);
    const recorded = withAccounting(receipt, attempts);
    // The first draft has the writer's whole range of length; the revision a support check earned may have lost sentences (D-310).
    const compiled = stage.plan.compile(
      writer.output,
      { runId, attemptIds: paidAttemptIds, model: deps.model },
      number === 1 ? 'draft' : 'after_check',
    );
    if (compiled.kind === 'refused')
      return refuse(
        compiled.issues.map((issue) => issue.code),
        recorded,
      );
    return {
      number,
      runId,
      authored: writer.output,
      compiled,
      attemptIds: paidAttemptIds,
      receipt: recorded,
      repaired: writer.repaired,
    };
  }

  /**
   * Asks the checker about a draft and acts on the verdicts. All consistent, or no usable answer: the
   * Scroll is published held, the second case with no verdict at all. A flag earns the writer one repair
   * if it has not used it; a flag that stands after that ends the job (D-198).
   */
  async function checkDraft(stage: Stage, draft: Draft, history: History): Promise<ProduceScrollResult> {
    const { row } = stage;
    const calls = callsOfStoredDocument(draft.compiled.document);
    const checked = await answerCheck.check({
      jobId: row.id,
      policyVersion: productionVersionOf(stage.subject.key),
      draft: draft.number,
      calls,
      signal: stage.signal,
    });
    if (checked.kind === 'advanced') return ops.replayCurrent(row);
    if (checked.kind === 'paused') return paused(row, checked.code);

    const checkRun: ClosingRun = {
      runId: checked.runId,
      state: checked.record.kind === 'checked' ? 'completed' : 'failed',
    };
    const flagged = flaggedCalls(checked.record.verdicts ?? []);
    const receipts = [draft.receipt, ...history.receipts, checked.receipt];
    if (flagged.length === 0)
      return ops.publish(stage.subject, row, receipts, draft.authored, draft.compiled, draft.runId, [
        ...history.closing,
        checkRun,
      ]);
    if (draft.number === 1 && !draft.repaired) {
      // The flagged first draft is superseded: its writer receipt is kept as history, not as the Scroll's writer.
      const earlier: History = {
        receipts: [
          ...history.receipts,
          { ...draft.receipt, role: 'checks', kind: 'draft_flagged', runId: draft.runId },
          checked.receipt,
        ],
        closing: [...history.closing, { runId: draft.runId, state: 'failed' }, checkRun],
      };
      return repairFlagged(stage, draft, calls, flagged, earlier);
    }
    return ops.end(row, 'rejected', ['answer_check_flagged'], receipts, [
      ...history.closing,
      { runId: draft.runId, state: 'failed' },
      checkRun,
    ]);
  }

  /** The one repair a flagged first draft earns: the writer sees the problems and its draft, and the new draft is checked in turn. */
  async function repairFlagged(
    stage: Stage,
    draft: Draft,
    calls: readonly CallUnderCheck[],
    flagged: readonly CallVerdict[],
    history: History,
  ): Promise<ProduceScrollResult> {
    const { row } = stage;
    const repaired = await answerCheck.repair({
      jobId: row.id,
      policyVersion: productionVersionOf(stage.subject.key),
      writer: stage.plan.role,
      writerItems: stage.items,
      calls,
      flagged,
      previousDraft: draft.authored,
      signal: stage.signal,
    });
    if (repaired.kind === 'advanced') return ops.replayCurrent(row);
    if (repaired.kind === 'paused') return paused(row, repaired.code);
    if (repaired.kind === 'ended')
      return ops.end(
        row,
        repaired.state,
        [repaired.code],
        [...history.receipts, repaired.receipt],
        [...history.closing, { runId: repaired.runId, state: 'failed' }],
      );
    const second = await acceptDraft(stage, repaired.runId, 2, repaired.writer, history);
    return isResult(second) ? second : checkDraft(stage, second, history);
  }

  /**
   * Asks the support checker about the answer to a question and acts on the verdicts (D-250). Nothing unsupported:
   * the Scroll is published. An unsupported sentence in the first draft earns the writer one revision, whether or not the
   * validator had repaired that draft. A sentence still unsupported after the revision is taken out and the rest is served, if
   * enough of it is left (D-310); otherwise the job ends. A check that gave no usable answer ends the job: nobody reads an ask
   * order before the person who asked, so it is never served unchecked.
   */
  async function supportCheckDraft(stage: Stage, draft: Draft, history: History): Promise<ProduceScrollResult> {
    const { row } = stage;
    const sentences = sentencesOfAnswer(draft.authored as AuthoredScroll);
    const checked = await supportCheck.check({
      jobId: row.id,
      policyVersion: productionVersionOf(stage.subject.key),
      draft: draft.number,
      sentences,
      passages: stage.passages,
      signal: stage.signal,
    });
    if (checked.kind === 'advanced') return ops.replayCurrent(row);
    if (checked.kind === 'paused') return paused(row, checked.code);

    const receipts = [draft.receipt, ...history.receipts, checked.receipt];
    const closing = [...history.closing, { runId: draft.runId, state: 'failed' as const }, ...checked.runs];
    if (checked.record.kind === 'unchecked') {
      const code = `support_check_${checked.record.code ?? 'unchecked'}`;
      return ops.end(
        row,
        checked.record.code === 'outcome_unknown' ? 'unknown' : 'rejected',
        [code],
        receipts,
        closing,
      );
    }
    if (passes(checked.record))
      return ops.publish(stage.subject, row, receipts, draft.authored, draft.compiled, draft.runId, [
        ...history.closing,
        ...checked.runs,
      ]);
    if (draft.number === 2)
      return publishWithoutFlagged(stage, draft, checked.verdicts, receipts, history, checked.runs);
    // The unsupported first draft is superseded: its writer receipt is kept as history, not as the Scroll's writer.
    // It earns the revision even when the validator already repaired it, since that repair was for another finding (D-297).
    const earlier: History = {
      receipts: [
        ...history.receipts,
        { ...draft.receipt, role: 'checks', kind: 'draft_unsupported', runId: draft.runId },
        checked.receipt,
      ],
      closing,
    };
    return repairUnsupported(stage, draft, sentences, unsupportedOf(checked.verdicts), earlier);
  }

  /**
   * Serves the revision without the sentences its check still found unsupported, when what is left is enough (D-310), and ends the
   * job when it is not. The sentences left each have the verdict they were checked with; nothing is checked again. The answer stored
   * and compiled is the one served, and the receipts say how many sentences were taken out, never which.
   */
  async function publishWithoutFlagged(
    stage: Stage,
    draft: Draft,
    verdicts: readonly SentenceVerdict[],
    receipts: readonly RoleReceipt[],
    history: History,
    checkRuns: readonly ClosingRun[],
  ): Promise<ProduceScrollResult> {
    const { row } = stage;
    const fail = (...why: readonly string[]) =>
      ops.end(row, 'rejected', ['support_check_failed', ...why], receipts, [
        ...history.closing,
        { runId: draft.runId, state: 'failed' },
        ...checkRuns,
      ]);
    const dropped = dropFlagged(draft.authored as AuthoredScroll, verdicts);
    if (dropped.kind === 'refused') return fail(`support_drop_${dropped.code}`);
    const compiled = stage.plan.compile(
      dropped.authored,
      { runId: draft.runId, attemptIds: draft.attemptIds, model: deps.model },
      'after_check',
    );
    if (compiled.kind === 'refused') return fail('support_drop_compile_refused');
    return ops.publish(
      stage.subject,
      row,
      [...receipts, { role: 'checks', kind: 'sentences_dropped', dropped: dropped.dropped }],
      dropped.authored,
      compiled,
      draft.runId,
      [...history.closing, ...checkRuns],
    );
  }

  /**
   * The one revision an unsupported first draft earns: the writer sees the findings and its draft, and the new draft is checked
   * in turn. A revision refused for copying a passage has one repair of its own; any other refusal of it ends the job (D-297).
   */
  async function repairUnsupported(
    stage: Stage,
    draft: Draft,
    sentences: readonly SentenceUnderCheck[],
    unsupported: readonly UnsupportedVerdict[],
    history: History,
  ): Promise<ProduceScrollResult> {
    const { row } = stage;
    const repaired = await supportCheck.repair({
      jobId: row.id,
      policyVersion: productionVersionOf(stage.subject.key),
      writer: stage.plan.afterCheckRole ?? stage.plan.role,
      writerItems: stage.items,
      sentences,
      unsupported,
      previousDraft: draft.authored,
      signal: stage.signal,
    });
    if (repaired.kind === 'advanced') return ops.replayCurrent(row);
    if (repaired.kind === 'paused') return paused(row, repaired.code);
    if (repaired.kind === 'ended')
      return ops.end(
        row,
        repaired.state,
        [repaired.code],
        [...history.receipts, repaired.receipt],
        [...history.closing, { runId: repaired.runId, state: 'failed' }],
      );
    const second = await acceptDraft(stage, repaired.runId, 2, repaired.writer, history);
    return isResult(second) ? second : supportCheckDraft(stage, second, history);
  }

  /** The first draft is in: a v2 library Scroll or the answer to a question is checked, any other is published as it is. */
  async function settleFirstDraft(stage: Stage, writer: Proposed): Promise<ProduceScrollResult> {
    const draft = await acceptDraft(stage, stage.row.writer_run_id, 1, writer, NO_HISTORY);
    if (isResult(draft)) return draft;
    if (hasAnswerCheck(stage.subject)) return checkDraft(stage, draft, NO_HISTORY);
    if (hasSupportCheck(stage.subject)) return supportCheckDraft(stage, draft, NO_HISTORY);
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
    return settleFirstDraft({ subject, row, plan, items, passages, signal }, writer);
  };
}
