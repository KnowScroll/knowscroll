import { stableUuid } from '../../../infrastructure/ids/index.js';
import type {
  ContextItem,
  ProductionAuthority,
  ProductionReasoningHarness,
  ProposeOutcome,
  ReasoningRole,
  WithProductionScope,
} from '../../../reasoning/public.js';
import type { AnswerCheckRecord, CallVerdict } from '../domain/answer-check.js';
import {
  answerCheckContext,
  answerCheckRole,
  checkedRecord,
  checkRepairItems,
  checkRepairRole,
  uncheckedRecord,
  verdictsOf,
  type CallUnderCheck,
} from './answer-check.js';
import { withAccounting, writerReceipt } from './receipts.js';
import type { RoleReceipt } from './types.js';

/**
 * The run of the checker for one draft, derived from the job: a redelivery asks the ledger for the
 * answer it already holds instead of paying for the question again. Each draft has a run of its own.
 */
export const answerCheckRunId = (jobId: string, draft: 1 | 2): string =>
  stableUuid(`content.scroll-answer-check:${jobId}:${String(draft)}`);

/** The run of the one writer repair a flagged answer key earns, derived from the job for the same reason. */
export const checkRepairRunId = (jobId: string): string => stableUuid(`content.scroll-check-repair:${jobId}`);

export interface AnswerCheckStepDependencies {
  readonly authority: ProductionAuthority;
  readonly withScope: WithProductionScope;
  readonly harness: ProductionReasoningHarness;
}

/** What asking the checker about one draft came to. */
export type CheckOutcome =
  /** The checker answered (`record.kind` `checked`) or gave nothing usable (`unchecked`). The run is finished either way. */
  | { readonly kind: 'done'; readonly record: AnswerCheckRecord; readonly receipt: RoleReceipt; readonly runId: string }
  /** A daily budget or the provider's quota is used up: nothing was sent and the job stays open. */
  | { readonly kind: 'paused'; readonly code: string }
  /** The run was already closed: another delivery finished the job. */
  | { readonly kind: 'advanced' };

export interface CheckInput {
  readonly jobId: string;
  readonly policyVersion: string;
  readonly draft: 1 | 2;
  readonly calls: readonly CallUnderCheck[];
  readonly signal: AbortSignal;
}

/** What the writer's one repair after a flag came to. */
export type CheckRepairOutcome =
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

export interface CheckRepairInput {
  readonly jobId: string;
  readonly policyVersion: string;
  /** The writer's role for the job; the repair uses it with the revision notice added. */
  readonly writer: ReasoningRole<unknown>;
  /** The writer's own context (the brief and the evidence), unchanged. */
  readonly writerItems: readonly ContextItem[];
  readonly calls: readonly CallUnderCheck[];
  readonly flagged: readonly CallVerdict[];
  /** The authored draft the verdicts refer to. */
  readonly previousDraft: unknown;
  readonly signal: AbortSignal;
}

/** Why the checker gave nothing usable, as a code an operator can read. Never provider text. */
function uncheckedCode(result: Exclude<ProposeOutcome<unknown>, { kind: 'proposed' }>): string {
  switch (result.kind) {
    case 'invalid_output':
      return 'invalid_output';
    case 'failed':
      return 'provider_failed';
    case 'unknown':
      return 'outcome_unknown';
    case 'refused':
      return `refused_${result.reason}`;
    case 'budget_exhausted':
    case 'quota_unavailable':
      return result.kind;
  }
}

const pauseCode = (result: Extract<ProposeOutcome<unknown>, { kind: 'budget_exhausted' | 'quota_unavailable' }>) =>
  result.kind === 'budget_exhausted' ? `budget_${result.dimension}_${result.limit}` : result.kind;

/**
 * The two model steps the answer check adds to a production job (D-198): asking the checker about a draft,
 * and the one writer repair a flagged draft earns. Both go through the production harness, so each
 * request has an attempt in the ledger and counts against the production caps; neither holds a
 * transaction. They return what happened and decide nothing: the job (`produce.ts`) does.
 */
export function makeAnswerCheckStep(deps: AnswerCheckStepDependencies) {
  /** Every paid attempt of a run with its usage, for the job's receipt; none when the ledger cannot say. */
  async function attemptsOf(runId: string) {
    const accounted = await deps.withScope(deps.authority, (scope) =>
      deps.harness.readProductionRunAccounting(scope, runId),
    );
    return accounted.kind === 'entered' && accounted.value.kind === 'accounted' ? accounted.value.attempts : [];
  }

  async function check(input: CheckInput): Promise<CheckOutcome> {
    const runId = answerCheckRunId(input.jobId, input.draft);
    // A stored v2 document always has a Final call; a draft with no call to check is not asked about.
    if (input.calls.length === 0)
      return {
        kind: 'done',
        record: uncheckedRecord(input.draft, 'no_calls'),
        receipt: { role: 'answer_check', kind: 'unchecked', draft: input.draft, code: 'no_calls' },
        runId,
      };
    const result = await deps.harness.proposeProduction(
      {
        run: {
          id: runId,
          authority: deps.authority,
          ownerModule: 'content',
          purpose: 'scroll-answer-check',
          policyVersion: input.policyVersion,
        },
        role: answerCheckRole(input.calls.map((call) => call.id)),
        context: {
          bundleRef: `scroll:${input.jobId}:answer-check:${String(input.draft)}`,
          items: answerCheckContext(input.calls),
        },
      },
      input.signal,
    );
    if (result.kind === 'refused' && result.reason === 'run_closed') return { kind: 'advanced' };
    if (result.kind === 'budget_exhausted' || result.kind === 'quota_unavailable')
      return { kind: 'paused', code: pauseCode(result) };
    const record =
      result.kind === 'proposed'
        ? checkedRecord(input.draft, verdictsOf(result.output, input.calls))
        : uncheckedRecord(input.draft, uncheckedCode(result));
    const receipt: RoleReceipt = withAccounting(
      {
        role: 'answer_check',
        kind: record.kind,
        draft: input.draft,
        ...(record.verdicts === undefined ? {} : { verdicts: record.verdicts }),
        ...(record.code === undefined ? {} : { code: record.code }),
      },
      await attemptsOf(runId),
    );
    return { kind: 'done', record, receipt, runId };
  }

  async function repair(input: CheckRepairInput): Promise<CheckRepairOutcome> {
    const runId = checkRepairRunId(input.jobId);
    const result = await deps.harness.proposeProduction(
      {
        run: {
          id: runId,
          authority: deps.authority,
          ownerModule: 'content',
          purpose: 'scroll-writer-check-repair',
          policyVersion: input.policyVersion,
        },
        role: checkRepairRole(input.writer),
        context: {
          bundleRef: `scroll:${input.jobId}:check-repair`,
          items: [...input.writerItems, ...checkRepairItems(input.calls, input.flagged, input.previousDraft)],
        },
        // The first draft's single repair is this one: a refusal of this answer ends the job.
        limits: { allowRepair: false },
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
      code: `check_repair_${uncheckedCode(result)}`,
      receipt: withAccounting(
        { ...writerReceipt(result), role: 'checks', kind: `check_repair_${result.kind}` },
        await attemptsOf(runId),
      ),
      runId,
    };
  }

  return { check, repair };
}
