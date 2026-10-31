import type { ReasoningHarness } from '../../../reasoning/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { MAX_CARD_PASSAGES, MIN_CARD_PASSAGES, type CardPassage } from '../domain/answer-card.js';
import type { WriteAnswerJob } from '../events.js';
import {
  answerContext,
  answerRole,
  answerVerdict,
  ANSWER_POLICY_VERSION,
  premiseTextsOf,
  type AnswerVerdict,
} from './answer-role.js';
import type { AnswerWorkerPorts } from './ports.js';

/** Writes the short answer of one waiting what-if branch; the worker's consumer calls it. */
export type WriteAnswerStep = (job: WriteAnswerJob, signal: AbortSignal) => Promise<void>;

/** The harness refuses with this fixed message when a run can no longer be closed legitimately. */
const HARNESS_REFUSAL = 'PERSONAL_REASONING_AUTHORITY_REFUSED';

type Prepared =
  /** Nothing to do: the branch is gone, removed, answered, not a what-if, or belongs to another scope. */
  | { readonly kind: 'skip' }
  /** No short answer can be written: the starter no longer takes part, or nothing can be cited. */
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'ready';
      readonly threadId: string;
      readonly passages: readonly CardPassage[];
      readonly premiseTexts: readonly string[];
      readonly context: ReturnType<typeof answerContext>;
    };

/**
 * The step that writes the short answer of a what-if branch (D-211). The answer-card writer is a role on the shared
 * harness: the branch's checked premise, the public subject and the claims of the Scroll the thread rests on go in, a
 * short answer comes out, and code checks it with the card's own rules (`answerRefusals`) before it can be shown.
 * It commissions nothing and reads nothing a member wrote.
 *
 * Authority: a `system` actor for the starter's universe and epoch, rechecked under the personal lock in both
 * transactions; the starter must still take part in the thread, because their allowance pays. Steps: (1) one
 * transaction reads the still-waiting branch, the starter's place and the context; (2) outside any transaction the
 * harness makes one model call (plus at most one repair) on the branch's own run; (3) one transaction closes the run,
 * rechecks the branch still stands and its answer is still waited for, and stores the outcome. A branch removed
 * meanwhile, or whose wait the sweep already ended, gets nothing stored: the late answer is dropped.
 * Failure/retry: the run ID is the branch ID, so a redelivery answers from the ledger and never pays twice, and an
 * attempt of unknown outcome is never resent: the card ends as unavailable and the run stays open for an operator.
 * With fewer than two claims to cite no model is asked at all.
 */
export function makeWriteAnswer(p: AnswerWorkerPorts, harness: ReasoningHarness): WriteAnswerStep {
  async function prepare(scope: PersonalScopeTx, nodeId: string): Promise<Prepared> {
    const node = await p.store.readNode(scope, nodeId);
    if (node?.kind !== 'what_if' || node.status === 'removed' || node.answer?.state !== 'making')
      return { kind: 'skip' };
    const visit = await p.guest.enterAsMember(scope, node.threadId, 'read');
    // The starter no longer takes part in the thread: their allowance cannot pay for their branch.
    if (visit === undefined) return { kind: 'unavailable' };
    // The job names the starter's universe: another member's scope never pays for, or ends, someone else's card.
    if (visit.self.accountId !== node.startedByAccountId) return { kind: 'skip' };
    const [subject] = await p.readContent(scope, [visit.root]);
    if (subject?.status !== 'available') return { kind: 'unavailable' };
    const claims = (await p.readEvidence(scope, visit.root)).slice(0, MAX_CARD_PASSAGES);
    if (claims.length < MIN_CARD_PASSAGES) return { kind: 'unavailable' };
    const passages = claims.map((claim, index): CardPassage => ({
      handle: `e${String(index + 1)}`,
      claimId: claim.claimId,
      text: claim.text,
    }));
    const facts = { title: node.title, changes: node.changes, kept: node.kept, assumptions: node.assumptions };
    return {
      kind: 'ready',
      threadId: node.threadId,
      passages,
      premiseTexts: premiseTextsOf(facts),
      context: answerContext({
        nodeId,
        ...facts,
        subject: { title: subject.metadata.title, summary: subject.metadata.summary },
        passages,
      }),
    };
  }

  /** Stores the outcome if the branch still stands and its answer is still waited for. Returns the thread to tell. */
  async function apply(scope: PersonalScopeTx, nodeId: string, verdict: AnswerVerdict): Promise<string | undefined> {
    if (verdict.end !== undefined) {
      try {
        await harness.closeRun(scope, { runId: nodeId, state: verdict.end });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== HARNESS_REFUSAL) throw error;
      }
    }
    const node = await p.store.lockNode(scope, nodeId);
    // A removal, or the sweep ending a wait that took too long, wins: the late answer is dropped.
    if (node === undefined || node.status === 'removed' || node.answer?.state !== 'making') return undefined;
    // The starter's allowance paid for it: if they left while the model thought, the answer is not shown.
    const stands = await p.standing({ scope }, node.startedByAccountId ?? '', node.threadId);
    const settlement =
      verdict.kind === 'ready' && stands
        ? ({ kind: 'ready', stored: verdict.stored } as const)
        : ({ kind: 'unavailable' } as const);
    return (await p.store.finishAnswer(scope, nodeId, settlement, p.now())) ? node.threadId : undefined;
  }

  return async (job, signal) => {
    const authority = {
      universeId: job.universeId,
      privacyEpoch: job.privacyEpoch,
      actor: { kind: 'system', purpose: 'scenarios.answer' },
    } as const;
    const prepared = await p.withScope(authority, (scope) => prepare(scope, job.nodeId));
    if (prepared.kind !== 'entered' || prepared.value.kind === 'skip') return;
    const { value } = prepared;
    let told: string | undefined;
    if (value.kind === 'unavailable') {
      const settled = await p.withScope(authority, (scope) => apply(scope, job.nodeId, { kind: 'unavailable' }));
      told = settled.kind === 'entered' ? settled.value : undefined;
    } else {
      const outcome = await harness.propose(
        {
          run: {
            id: job.nodeId,
            authority,
            ownerModule: 'scenarios',
            purpose: 'answer',
            policyVersion: ANSWER_POLICY_VERSION,
          },
          role: answerRole(value.passages, value.premiseTexts),
          context: value.context,
          limits: { allowRepair: true },
        },
        signal,
      );
      const settled = await p.withScope(authority, (scope) =>
        apply(scope, job.nodeId, answerVerdict(outcome, value.passages)),
      );
      told = settled.kind === 'entered' ? settled.value : undefined;
    }
    // After the commit; a lost hint costs speed, never correctness, because the screens poll.
    if (told !== undefined) await p.announce(told).catch(() => undefined);
  };
}
