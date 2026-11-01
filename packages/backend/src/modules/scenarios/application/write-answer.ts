import {
  applyClosingRun,
  proposeWhenRecording,
  runToClose,
  startRunOwner,
  type PersonalRecordingPurpose,
  type RecordingReasoningHarness,
  type RunOwner,
} from '../../../reasoning/public.js';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
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
import { servableAnswerOf } from './cards.js';
import type { AnswerWorkerPorts, AnswerSettlement } from './ports.js';

/** Writes the short answer of one waiting what-if branch; the worker's consumer calls it. */
export type WriteAnswerStep = (job: WriteAnswerJob, signal: AbortSignal) => Promise<void>;

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
      /** Absent while recording is paused: the answer is then refused without a run (D-270). */
      readonly owner: RunOwner | undefined;
    };

/**
 * The step that writes the short answer of a what-if branch (D-211). The answer-card writer is a role on the shared
 * harness: the branch's checked premise, the public subject and the claims of the Scroll the thread rests on go in, a
 * short answer comes out, and code checks it with the card's own rules (`answerRefusals`) before it can be shown.
 * It commissions nothing and reads nothing a member wrote.
 *
 * Authority: a `system` actor for the starter's universe and epoch, rechecked under the personal lock in both
 * transactions; the starter must still take part in the thread, because their allowance pays. Steps: (1) one
 * transaction reads the still-waiting branch, the starter's place, the context and the generation recording is at; (2)
 * outside any transaction the recording-aware harness makes one model call (plus at most one repair) on the branch's own run,
 * at that generation (D-270); (3) one transaction under the recording fence closes the run, rechecks the branch still stands
 * and its answer is still waited for, and stores the outcome. A branch removed meanwhile, or whose wait the sweep already
 * ended, gets nothing stored: the late answer is dropped. So is a reply that comes back after the person paused, resumed or
 * cleared recording: the card then ends as unavailable (a Clear leaves nothing to end), and while recording is paused the
 * card is refused without a call.
 * Failure/retry: the run ID is the branch ID, so a redelivery answers from the ledger and never pays twice, and an
 * attempt of unknown outcome is never resent: the card ends as unavailable and the run stays open for an operator.
 * With fewer than two claims to cite no model is asked at all.
 */
export function makeWriteAnswer(p: AnswerWorkerPorts, harness: RecordingReasoningHarness): WriteAnswerStep {
  async function prepare(scope: PersonalScopeTx, nodeId: string): Promise<Prepared> {
    // The account gate comes before any thread row is read or locked.
    const owner = await startRunOwner(harness, scope, nodeId);
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
      owner,
    };
  }

  /** Stores the outcome if the branch still stands and its answer is still waited for. Returns the thread to tell. */
  async function apply(scope: PersonalScopeTx, nodeId: string, verdict: AnswerVerdict): Promise<string | undefined> {
    const node = await p.store.lockNode(scope, nodeId);
    // A removal, or the sweep ending a wait that took too long, wins: the late answer is dropped.
    if (node === undefined || node.status === 'removed' || node.answer?.state !== 'making') return undefined;
    // The starter's allowance paid for it: if they left while the model thought, the answer is not shown.
    const stands = await p.standing({ scope }, node.startedByAccountId ?? '', node.threadId);
    const settledAt = p.now();
    // A card the contract would refuse is never stored as ready: it would fail every member's list.
    const settlement: AnswerSettlement =
      verdict.kind === 'ready' &&
      stands &&
      servableAnswerOf({ state: 'ready', settledAt, stored: verdict.stored }) !== undefined
        ? { kind: 'ready', stored: verdict.stored }
        : { kind: 'unavailable' };
    return (await p.store.finishAnswer(scope, nodeId, settlement, settledAt)) ? node.threadId : undefined;
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
      const { outcome, purpose } = await proposeWhenRecording(
        harness,
        value.owner,
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
      told = await settleAnswer(job, authority, answerVerdict(outcome, value.passages), purpose);
    }
    // After the commit; a lost hint costs speed, never correctness, because the screens poll.
    if (told !== undefined) await p.announce(told).catch(() => undefined);
  };

  /**
   * Stores the answer's outcome and closes its run under the recording fence; a run with no conclusive end is stored in a plain
   * transaction. When the fence no longer holds only the card's end is written. Returns the thread to tell.
   */
  async function settleAnswer(
    job: WriteAnswerJob,
    authority: PersonalAuthority,
    verdict: AnswerVerdict,
    purpose: PersonalRecordingPurpose | undefined,
  ): Promise<string | undefined> {
    const closing = runToClose(job.nodeId, purpose, verdict.end);
    let outcome = verdict;
    if (closing !== undefined) {
      const applied = await applyClosingRun(harness, authority, closing, (scope) => apply(scope, job.nodeId, verdict));
      if (applied.kind === 'applied') return applied.value;
      outcome = { kind: 'unavailable' };
    }
    const settled = await p.withScope(authority, (scope) => apply(scope, job.nodeId, outcome));
    return settled.kind === 'entered' ? settled.value : undefined;
  }
}
