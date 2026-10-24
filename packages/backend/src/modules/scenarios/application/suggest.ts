import type { ReasoningHarness } from '../../../reasoning/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { ROOT_PARENT, type ParentFacts, type ScenarioKind } from '../domain/exploration.js';
import type { SuggestDraftJob } from '../events.js';
import {
  plannerContext,
  plannerRole,
  PLANNER_POLICY_VERSION,
  suggestVerdict,
  WINDOW_MESSAGES,
  type SuggestVerdict,
} from './planner-role.js';
import type { DraftRow, DraftWorkerPorts } from './ports.js';

/** Asks the Scenario Planner about one waiting draft; the worker's consumer calls it. */
export type SuggestStep = (job: SuggestDraftJob, signal: AbortSignal) => Promise<void>;

/** The harness refuses with this fixed message when a run can no longer be closed legitimately. */
const HARNESS_REFUSAL = 'PERSONAL_REASONING_AUTHORITY_REFUSED';

type Prepared =
  /** Nothing to do: the draft is gone, answered, chosen or expired, or belongs to another scope. */
  | { readonly kind: 'skip' }
  /** The member no longer takes part in the thread: the draft goes. */
  | { readonly kind: 'withdrawn' }
  /** The branch it continues or the explanation under it is gone: the draft cannot be answered. */
  | { readonly kind: 'unusable' }
  | {
      readonly kind: 'ready';
      readonly draftKind: ScenarioKind;
      readonly parent: ParentFacts;
      readonly context: ReturnType<typeof plannerContext>;
    };

/**
 * The scenario step that turns a waiting draft into proposed directions (blueprint §14, §16). The
 * Scenario Planner is a role on the shared harness: a bounded, authorised window of the thread
 * goes in, a few directions come out, and code checks every one with the same rules a choice uses.
 * It commissions nothing: only a member's choice does (D-006 i).
 *
 * Authority: a `system` actor for the requester's universe and epoch, rechecked under the personal
 * lock in both transactions. Steps: (1) one transaction reads the still-waiting draft, the
 * requester's place in the thread and the context; (2) outside any transaction the harness makes
 * one model call (plus at most one repair) on the draft's own run; (3) one transaction closes the
 * run, rechecks the draft is still waiting and the member still takes part, and stores the
 * outcome. A member who left meanwhile gets nothing stored: the late answer is dropped.
 * Failure/retry: the run ID is the draft ID, so a redelivery answers from the ledger and never pays
 * twice, and an attempt of unknown outcome is never resent: the draft closes as `could_not_suggest`
 * and the run stays open for an operator.
 */
export function makeSuggestDraft(p: DraftWorkerPorts, harness: ReasoningHarness): SuggestStep {
  async function prepare(scope: PersonalScopeTx, draftId: string): Promise<Prepared> {
    const draft = await p.store.readDraft(scope, draftId);
    if (
      draft?.state !== 'thinking' ||
      draft.requesterUniverseId !== scope.authority.universeId ||
      draft.privacyEpoch !== scope.authority.privacyEpoch ||
      draft.expiresAt <= p.now()
    )
      return { kind: 'skip' };
    const visit = await p.guest.enterAsMember(scope, draft.threadId, 'read');
    if (visit?.self.accountId !== draft.requesterAccountId) return { kind: 'withdrawn' };
    const parent = await parentOf(scope, draft);
    const [subject] = await p.readContent(scope, [visit.root]);
    if (parent === undefined || subject?.status !== 'available') return { kind: 'unusable' };
    const window = await p.guest.window(visit, {
      limit: WINDOW_MESSAGES,
      ...(draft.origin.kind === 'root' ? {} : { originMessageId: draft.origin.messageId }),
    });
    return {
      kind: 'ready',
      draftKind: draft.kind,
      parent: parent.facts,
      context: plannerContext({
        draftId: draft.draftId,
        kind: draft.kind,
        requestText: draft.requestText,
        subject: { title: subject.metadata.title, summary: subject.metadata.summary },
        parent: parent.facts,
        origin: draft.origin,
        window,
      }),
    };
  }

  async function parentOf(scope: PersonalScopeTx, draft: DraftRow) {
    if (draft.parentNodeId === undefined) return { facts: ROOT_PARENT };
    const node = await p.store.readNode(scope, draft.parentNodeId);
    if (node?.status !== 'ready') return undefined;
    return {
      facts: {
        hypothetical: node.hypothetical,
        speculative: node.speculative,
        assumptions: node.assumptions,
        title: node.title,
        ...(node.lens === undefined ? {} : { lens: node.lens }),
      },
    };
  }

  async function apply(scope: PersonalScopeTx, draftId: string, verdict: SuggestVerdict): Promise<void> {
    if (verdict.end !== undefined) {
      try {
        await harness.closeRun(scope, { runId: draftId, state: verdict.end });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== HARNESS_REFUSAL) throw error;
      }
    }
    const draft = await p.store.lockDraft(scope, draftId);
    // A choice made while the model thought, or an expiry, wins: the late answer is dropped.
    if (draft?.state !== 'thinking') return;
    // The member may have left while the model thought. Their draft goes with their place.
    if (!(await p.standing({ scope }, draft.requesterAccountId, draft.threadId)))
      return p.store.deleteDraft(scope, draftId);
    await p.store.finishDraft(
      scope,
      draftId,
      verdict.kind === 'ready'
        ? { kind: 'ready', mode: verdict.mode, options: verdict.options }
        : { kind: 'failed', failure: verdict.failure },
    );
  }

  return async (job, signal) => {
    const authority = {
      universeId: job.universeId,
      privacyEpoch: job.privacyEpoch,
      actor: { kind: 'system', purpose: 'scenarios.suggest' },
    } as const;
    const prepared = await p.withScope(authority, (scope) => prepare(scope, job.draftId));
    if (prepared.kind !== 'entered' || prepared.value.kind === 'skip') return;
    const { value } = prepared;
    if (value.kind !== 'ready') {
      await p.withScope(authority, (scope) =>
        value.kind === 'withdrawn'
          ? p.store.deleteDraft(scope, job.draftId)
          : apply(scope, job.draftId, { kind: 'failed', failure: 'could_not_suggest' }),
      );
      return;
    }
    const outcome = await harness.propose(
      {
        run: {
          id: job.draftId,
          authority,
          ownerModule: 'scenarios',
          purpose: 'suggest',
          policyVersion: PLANNER_POLICY_VERSION,
        },
        role: plannerRole(value.draftKind, value.parent),
        context: value.context,
        limits: { allowRepair: true },
      },
      signal,
    );
    await p.withScope(authority, (scope) => apply(scope, job.draftId, suggestVerdict(outcome, value.draftKind)));
  };
}
