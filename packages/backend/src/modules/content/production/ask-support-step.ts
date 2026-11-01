import { stableUuid } from '../../../infrastructure/ids/index.js';
import type {
  ContextItem,
  ProductionAuthority,
  ProductionReasoningHarness,
  ProposeOutcome,
  ReasoningRole,
  WithProductionScope,
} from '../../../reasoning/public.js';
import type { SentenceUnderCheck, SupportRecord, UnsupportedVerdict } from '../domain/ask-support.js';
import { pauseCode, uncheckedCode } from './answer-check-step.js';
import {
  askSupportContext,
  askSupportRole,
  recordOfNothing,
  recordOfReply,
  supportRepairItems,
  supportRepairRole,
  verdictsOf,
} from './ask-support.js';
import type { EvidencePassage } from './evidence.js';
import { withAccounting, writerReceipt } from './receipts.js';
import type { RoleReceipt } from './types.js';
import type { SentenceVerdict } from '../domain/ask-support.js';

/**
 * The run of the checker for one draft, derived from the job: a redelivery asks the ledger for the answer it already
 * holds instead of paying for the question again. Each draft has a run of its own.
 */
export const askSupportRunId = (jobId: string, draft: 1 | 2): string =>
  stableUuid(`content.ask-support-check:${jobId}:${String(draft)}`);

/** The run of the one writer repair an unsupported sentence earns, derived from the job for the same reason. */
export const askSupportRepairRunId = (jobId: string): string => stableUuid(`content.ask-support-repair:${jobId}`);

export interface AskSupportStepDependencies {
  readonly authority: ProductionAuthority;
  readonly withScope: WithProductionScope;
  readonly harness: ProductionReasoningHarness;
}

/** What asking the checker about one draft came to. */
export type SupportCheckOutcome =
  /** The checker answered (`record.kind` `checked`) or gave nothing usable (`unchecked`). The run is finished either way. */
  | {
      readonly kind: 'done';
      readonly record: SupportRecord;
      readonly verdicts: readonly SentenceVerdict[];
      readonly receipt: RoleReceipt;
      readonly runId: string;
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
 */
export function makeAskSupportStep(deps: AskSupportStepDependencies) {
  /** Every paid attempt of a run with its usage, for the job's receipt; none when the ledger cannot say. */
  async function attemptsOf(runId: string) {
    const accounted = await deps.withScope(deps.authority, (scope) =>
      deps.harness.readProductionRunAccounting(scope, runId),
    );
    return accounted.kind === 'entered' && accounted.value.kind === 'accounted' ? accounted.value.attempts : [];
  }

  async function check(input: SupportCheckInput): Promise<SupportCheckOutcome> {
    const runId = askSupportRunId(input.jobId, input.draft);
    const result = await deps.harness.proposeProduction(
      {
        run: {
          id: runId,
          authority: deps.authority,
          ownerModule: 'content',
          purpose: 'ask-support-check',
          policyVersion: input.policyVersion,
        },
        role: askSupportRole(input.sentences, input.passages),
        context: {
          bundleRef: `scroll:${input.jobId}:ask-support:${String(input.draft)}`,
          items: askSupportContext(input.sentences, input.passages),
        },
      },
      input.signal,
    );
    if (result.kind === 'refused' && result.reason === 'run_closed') return { kind: 'advanced' };
    if (result.kind === 'budget_exhausted' || result.kind === 'quota_unavailable')
      return { kind: 'paused', code: pauseCode(result) };
    const verdicts = result.kind === 'proposed' ? verdictsOf(result.output) : [];
    const record =
      result.kind === 'proposed'
        ? recordOfReply(input.draft, result.output)
        : recordOfNothing(input.draft, input.sentences.length, uncheckedCode(result));
    const receipt: RoleReceipt = withAccounting(
      {
        role: 'support_check',
        kind: record.kind,
        draft: input.draft,
        sentences: record.sentences,
        unsupported: record.unsupported,
        ...(record.code === undefined ? {} : { code: record.code }),
      },
      await attemptsOf(runId),
    );
    return { kind: 'done', record, verdicts, receipt, runId };
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
