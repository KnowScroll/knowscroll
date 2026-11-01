import type { ReasoningHarness } from '../../../reasoning/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { handleOf, type CitablePassage, type QuickAnswerAsk } from '../domain/quick-answer.js';
import { QUICK_ANSWER_WAIT_LIMIT_MS } from './quick-answers.js';
import {
  QUICK_ANSWER_POLICY_VERSION,
  quickAnswerContext,
  quickAnswerRole,
  quickAnswerVerdict,
  type QuickAnswerVerdict,
} from './quick-answer-role.js';
import type {
  AnswerQuickAnswerUseCase,
  QuickAnswerPorts,
  QuickAnswerRow,
  QuickAnswerSettlement,
} from './quick-answer-ports.js';

/** The harness refuses with this fixed message when a run can no longer be closed legitimately. */
const HARNESS_REFUSAL = 'PERSONAL_REASONING_AUTHORITY_REFUSED';

type Prepared =
  /** Nothing to do: the answer is gone, dismissed, expired, settled or belongs to another scope. */
  | { readonly kind: 'skip' }
  /** The Scroll can no longer be read for it (withdrawn or held), so no model is asked. */
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'ready';
      readonly ask: QuickAnswerAsk;
      readonly passages: readonly CitablePassage[];
      readonly context: ReturnType<typeof quickAnswerContext>;
    };

/**
 * The step that writes one Quick answer (D-253); the worker's consumer calls it. The writer is a role on the personal
 * reasoning harness: the Scroll's title, the words the person selected, their question if they typed one, and the
 * passages of the Scroll up to their stop go in; a short answer comes out, and code checks it with the answer's own rules
 * (`quickAnswerRefusals`) before it can be shown. It never reads a later stop, never writes evidence and never touches
 * the Universe.
 *
 * Authority: a `system` actor for the person's universe and epoch, rechecked under the personal lock in both
 * transactions. Steps: (1) one transaction reads the still-waiting row and the passages; (2) outside any transaction the
 * harness makes one model call (plus at most one repair) on the answer's own run, then the support seam judges the draft;
 * (3) one transaction closes the run, rechecks the row is still waiting and inside its wait limit, and settles it. A card
 * dismissed, erased or given up on meanwhile gets nothing stored: the late answer is dropped.
 * Failure/retry: the run ID is the answer's ID, so a redelivery answers from the ledger and never pays twice, and an
 * attempt of unknown outcome is never resent: the card ends as unavailable and the run stays open for an operator.
 */
export function makeAnswerQuickAnswer(p: QuickAnswerPorts, harness: ReasoningHarness): AnswerQuickAnswerUseCase {
  async function prepare(scope: PersonalScopeTx, row: QuickAnswerRow | undefined): Promise<Prepared> {
    if (!(await p.ownerActive(scope))) return { kind: 'skip' };
    const now = p.now();
    if (
      row?.state !== 'waiting' ||
      row.passage === undefined ||
      row.expiresAt <= now ||
      now.getTime() - row.createdAt.getTime() > QUICK_ANSWER_WAIT_LIMIT_MS
    )
      return { kind: 'skip' };
    const facts = await p.readFacts(scope, { assetId: row.assetId, assetRevision: row.assetRevision }, row.stopId);
    if (facts === undefined) return { kind: 'unavailable' };
    const passages = facts.passages.map((passage, index): CitablePassage => ({
      handle: handleOf(index),
      stopId: passage.stopId,
      text: passage.text,
    }));
    const ask = { passage: row.passage, question: row.question };
    return {
      kind: 'ready',
      ask,
      passages,
      context: quickAnswerContext({ quickAnswerId: row.id, title: facts.title, ask, passages }),
    };
  }

  /** Settles the answer if it still waits and is inside its limit. True when the person's card changed. */
  async function apply(scope: PersonalScopeTx, id: string, verdict: QuickAnswerVerdict): Promise<boolean> {
    if (verdict.end !== undefined) {
      try {
        await harness.closeRun(scope, { runId: id, state: verdict.end });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== HARNESS_REFUSAL) throw error;
      }
    }
    if (!(await p.ownerActive(scope))) return false;
    const row = await p.store.read(scope, id);
    const now = p.now();
    if (row?.state !== 'waiting') return false;
    const late = now.getTime() - row.createdAt.getTime() > QUICK_ANSWER_WAIT_LIMIT_MS;
    const settlement: QuickAnswerSettlement =
      verdict.kind === 'ready' && !late
        ? {
            kind: 'answered',
            question: verdict.draft.question,
            answer: verdict.draft.answer,
            covered: verdict.draft.covered,
          }
        : { kind: 'unavailable' };
    const settled = await p.store.settle(scope, id, settlement, now);
    if (settled) await p.notify(scope, await p.advance(scope), id);
    return settled;
  }

  return async (job, signal) => {
    const authority = {
      universeId: job.universeId,
      privacyEpoch: job.privacyEpoch,
      actor: { kind: 'system', purpose: 'supply.quick-answer' },
    } as const;
    const prepared = await p.withScope(authority, async (scope) =>
      prepare(scope, await p.store.read(scope, job.quickAnswerId)),
    );
    if (prepared.kind !== 'entered' || prepared.value.kind === 'skip') return;
    const { value } = prepared;
    if (value.kind === 'unavailable') {
      await p.withScope(authority, (scope) => apply(scope, job.quickAnswerId, { kind: 'unavailable' }));
      return;
    }
    const outcome = await harness.propose(
      {
        run: {
          id: job.quickAnswerId,
          authority,
          ownerModule: 'supply',
          purpose: 'quick-answer',
          policyVersion: QUICK_ANSWER_POLICY_VERSION,
        },
        role: quickAnswerRole(value.passages, value.ask),
        context: value.context,
        limits: { allowRepair: true },
      },
      signal,
    );
    const verdict = await supported(p, quickAnswerVerdict(outcome), value.passages, signal);
    await p.withScope(authority, (scope) => apply(scope, job.quickAnswerId, verdict));
  };
}

/** The support seam: a draft the checker does not support is shown to nobody and closes as unavailable. */
async function supported(
  p: QuickAnswerPorts,
  verdict: QuickAnswerVerdict,
  passages: readonly CitablePassage[],
  signal: AbortSignal,
): Promise<QuickAnswerVerdict> {
  if (verdict.kind !== 'ready') return verdict;
  const judged = await p.supportCheck({ draft: verdict.draft, passages, signal });
  return judged === 'supported' ? verdict : { kind: 'unavailable', end: 'completed' };
}
