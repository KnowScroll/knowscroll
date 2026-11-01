import { stableUuid } from '../../../infrastructure/ids/index.js';
import type {
  ContextItem,
  ProductionAttemptAccounting,
  ProductionAuthority,
  ProductionReasoningHarness,
  ProposeOutcome,
  ReasoningRole,
  WithProductionScope,
} from '../../../reasoning/public.js';
import {
  ASK_SUPPORT_MAX_BATCHES,
  batchesOf,
  checkedRecord,
  uncheckedRecord,
  type SentenceUnderCheck,
  type SentenceVerdict,
  type SupportRecord,
  type UnsupportedVerdict,
} from '../domain/ask-support.js';
import { pauseCode, uncheckedCode } from './answer-check-step.js';
import {
  askSupportContext,
  askSupportRole,
  supportRepairItems,
  supportRepairRole,
  verdictsOf,
  type AskSupportAnswer,
  type SupportPassage,
} from './ask-support.js';
import type { EvidencePassage } from './evidence.js';
import { withAccounting, writerReceipt } from './receipts.js';
import type { ClosingRun, RoleReceipt } from './types.js';

/**
 * The run of the checker for one batch of one draft, derived from the job: a redelivery asks the ledger for the answer
 * it already holds instead of paying for the question again. Each draft, and each batch of a long answer, has a run of
 * its own.
 */
export const askSupportRunId = (jobId: string, draft: 1 | 2, batch: number): string =>
  stableUuid(`content.ask-support-check:${jobId}:${String(draft)}:${String(batch)}`);

/** The run of the one writer repair an unsupported sentence earns, derived from the job for the same reason. */
export const askSupportRepairRunId = (jobId: string): string => stableUuid(`content.ask-support-repair:${jobId}`);

/** The finding of the copy rule, the one refusal the revision's own repair is for (D-297). */
const COPIED_PASSAGE_CODE = 'copied_passage';

/** What asking the checker about one batch came to. */
type BatchOutcome =
  | { readonly kind: 'verdicts'; readonly verdicts: readonly SentenceVerdict[]; readonly repaired: boolean }
  | { readonly kind: 'nothing'; readonly code: string }
  | { readonly kind: 'paused'; readonly code: string }
  | { readonly kind: 'advanced' };

export interface AskSupportStepDependencies {
  readonly authority: ProductionAuthority;
  readonly withScope: WithProductionScope;
  readonly harness: ProductionReasoningHarness;
}

/** The checker's role for one batch of sentences. Production always uses {@link askSupportRole}. */
export type CheckerRoleOf = (
  sentences: readonly SentenceUnderCheck[],
  passages: readonly SupportPassage[],
) => ReasoningRole<AskSupportAnswer>;

/** What asking the checker about one draft came to. */
export type SupportCheckOutcome =
  /**
   * The checker answered for every batch (`record.kind` `checked`) or gave nothing usable (`unchecked`: one batch had no
   * usable reply, so none of the answer is known). The runs are finished either way; `runs` are those the check opened.
   */
  | {
      readonly kind: 'done';
      readonly record: SupportRecord;
      readonly verdicts: readonly SentenceVerdict[];
      readonly receipt: RoleReceipt;
      readonly runs: readonly ClosingRun[];
    }
  /** A daily budget or the provider's quota is used up: nothing was sent and the job stays open. */
  | { readonly kind: 'paused'; readonly code: string }
  /** The run was already closed: another delivery finished the job. */
  | { readonly kind: 'advanced' };

export interface SupportCheckInput {
  readonly jobId: string;
  readonly policyVersion: string;
  readonly draft: 1 | 2;
  readonly sentences: readonly SentenceUnderCheck[];
  readonly passages: readonly EvidencePassage[];
  readonly signal: AbortSignal;
}

/** What the writer's one repair after a finding came to. */
export type SupportRepairOutcome =
  | {
      readonly kind: 'proposed';
      readonly runId: string;
      readonly writer: Extract<ProposeOutcome<unknown>, { kind: 'proposed' }>;
    }
  | { readonly kind: 'paused'; readonly code: string }
  | { readonly kind: 'advanced' }
  /** The repair ended in a verdict about the job: `rejected`, or `unknown` when an attempt may have reached the provider. */
  | {
      readonly kind: 'ended';
      readonly state: 'rejected' | 'unknown';
      readonly code: string;
      readonly receipt: RoleReceipt;
      readonly runId: string;
    };

export interface SupportRepairInput {
  readonly jobId: string;
  readonly policyVersion: string;
  /** The writer's role for the job; the repair uses it with the revision notice added. */
  readonly writer: ReasoningRole<unknown>;
  /** The writer's own context (the brief and the evidence), unchanged. */
  readonly writerItems: readonly ContextItem[];
  readonly sentences: readonly SentenceUnderCheck[];
  readonly unsupported: readonly UnsupportedVerdict[];
  /** The authored draft the verdicts refer to. */
  readonly previousDraft: unknown;
  readonly signal: AbortSignal;
}

/**
 * The two model steps the support check adds to an ask order's production job (D-250): asking the checker about a
 * draft, and the one writer repair a draft with unsupported sentences earns. Both go through the production harness,
 * so each request has an attempt in the ledger and counts against the production caps; neither holds a transaction.
 * They return what happened and decide nothing: the writer stage does.
 *
 * `checkerRoleOf` says which role asks the checker. The production job and the Quick answer leave it out and get the
 * production role; only the operator's replay passes another, to try candidate instructions (D-280).
 */
export function makeAskSupportStep(deps: AskSupportStepDependencies, checkerRoleOf: CheckerRoleOf = askSupportRole) {
  /** Every paid attempt of a run with its usage, for the job's receipt; none when the ledger cannot say. */
  async function attemptsOf(runId: string) {
    const accounted = await deps.withScope(deps.authority, (scope) =>
      deps.harness.readProductionRunAccounting(scope, runId),
    );
    return accounted.kind === 'entered' && accounted.value.kind === 'accounted' ? accounted.value.attempts : [];
  }

  /** One request about one batch of sentences, in the batch's own run. */
  async function askBatch(
    input: SupportCheckInput,
    batch: readonly SentenceUnderCheck[],
    batchIndex: number,
    repairAllowed: boolean,
  ): Promise<BatchOutcome> {
    const result = await deps.harness.proposeProduction(
      {
        run: {
          id: askSupportRunId(input.jobId, input.draft, batchIndex),
          authority: deps.authority,
          ownerModule: 'content',
          purpose: 'ask-support-check',
          policyVersion: input.policyVersion,
        },
        role: checkerRoleOf(batch, input.passages),
        context: {
          bundleRef: `scroll:${input.jobId}:ask-support:${String(input.draft)}:${String(batchIndex)}`,
          items: askSupportContext(batch, input.passages),
        },
        limits: { allowRepair: repairAllowed },
      },
      input.signal,
    );
    if (result.kind === 'refused' && result.reason === 'run_closed') return { kind: 'advanced' };
    if (result.kind === 'budget_exhausted' || result.kind === 'quota_unavailable')
      return { kind: 'paused', code: pauseCode(result) };
    if (result.kind !== 'proposed') return { kind: 'nothing', code: uncheckedCode(result) };
    return { kind: 'verdicts', verdicts: verdictsOf(result.output), repaired: result.repaired };
  }

  /** The outcome of a check that is over: the record, the receipt with every paid attempt, and the runs to close. */
  function finished(
    input: SupportCheckInput,
    batches: number,
    verdicts: readonly SentenceVerdict[],
    unusableCode: string | undefined,
    runs: readonly ClosingRun[],
    attempts: readonly ProductionAttemptAccounting[],
  ): SupportCheckOutcome {
    const record =
      unusableCode === undefined
        ? checkedRecord(input.draft, verdicts, batches)
        : uncheckedRecord(input.draft, input.sentences.length, batches, unusableCode);
    const receipt = withAccounting(
      {
        role: 'support_check',
        kind: record.kind,
        draft: input.draft,
        sentences: record.sentences,
        batches: record.batches,
        unsupported: record.unsupported,
        ...(record.code === undefined ? {} : { code: record.code }),
      },
      attempts,
    );
    return { kind: 'done', record, verdicts: unusableCode === undefined ? verdicts : [], receipt, runs };
  }

  /**
   * Asks the checker about a draft, a batch of sentences at a time (D-267), one after the other. The first batch with no
   * usable reply makes the whole check unusable and the later batches are not asked. The harness repairs one unusable
   * reply in the whole check, wherever it happens, so a draft costs its batches plus one.
   */
  async function check(input: SupportCheckInput): Promise<SupportCheckOutcome> {
    const batches = batchesOf(input.sentences);
    if (batches.length > ASK_SUPPORT_MAX_BATCHES) return finished(input, batches.length, [], 'answer_too_long', [], []);
    const verdicts: SentenceVerdict[] = [];
    const runs: ClosingRun[] = [];
    const attempts: ProductionAttemptAccounting[] = [];
    let repairAllowed = true;
    for (const [index, batch] of batches.entries()) {
      const outcome = await askBatch(input, batch, index, repairAllowed);
      if (outcome.kind === 'advanced' || outcome.kind === 'paused') return outcome;
      const runId = askSupportRunId(input.jobId, input.draft, index);
      attempts.push(...(await attemptsOf(runId)));
      if (outcome.kind === 'nothing') {
        runs.push({ runId, state: 'failed' });
        return finished(input, batches.length, [], outcome.code, runs, attempts);
      }
      runs.push({ runId, state: 'completed' });
      verdicts.push(...outcome.verdicts);
      repairAllowed = repairAllowed && !outcome.repaired;
    }
    return finished(input, batches.length, verdicts, undefined, runs, attempts);
  }

  async function repair(input: SupportRepairInput): Promise<SupportRepairOutcome> {
    const runId = askSupportRepairRunId(input.jobId);
    const result = await deps.harness.proposeProduction(
      {
        run: {
          id: runId,
          authority: deps.authority,
          ownerModule: 'content',
          purpose: 'ask-support-repair',
          policyVersion: input.policyVersion,
        },
        role: supportRepairRole(input.writer),
        context: {
          bundleRef: `scroll:${input.jobId}:ask-support-repair`,
          items: [...input.writerItems, ...supportRepairItems(input.sentences, input.unsupported, input.previousDraft)],
        },
        // The revision may be repaired once, and only for copying a passage (D-297): any other refusal of it ends the job.
        limits: { repairOnlyFor: [COPIED_PASSAGE_CODE] },
      },
      input.signal,
    );
    if (result.kind === 'proposed') return { kind: 'proposed', runId, writer: result };
    if (result.kind === 'refused' && result.reason === 'run_closed') return { kind: 'advanced' };
    if (result.kind === 'budget_exhausted' || result.kind === 'quota_unavailable')
      return { kind: 'paused', code: pauseCode(result) };
    return {
      kind: 'ended',
      state: result.kind === 'unknown' ? 'unknown' : 'rejected',
      code: `support_repair_${uncheckedCode(result)}`,
      receipt: withAccounting(
        { ...writerReceipt(result), role: 'checks', kind: `support_repair_${result.kind}` },
        await attemptsOf(runId),
      ),
      runId,
    };
  }

  return { check, repair };
}
