import type { PersonalScopeTx } from '../../identity/public.js';
import { handleOf, type CitablePassage, type QuickAnswerAsk } from '../domain/quick-answer.js';
import { answerAndCheck, type PipelineResult } from './quick-answer-pipeline.js';
import { quickAnswerContext } from './quick-answer-role.js';
import type { QuickAnswerSupportCheck } from './quick-answer-support.js';
import { QUICK_ANSWER_WAIT_LIMIT_MS } from './quick-answers.js';
import {
  accountOf,
  closeStartedRun,
  closeStartedRunAlone,
  type RecordingRuns,
  type RunOwner,
} from './recording-runs.js';
import type {
  AnswerQuickAnswerUseCase,
  QuickAnswerPorts,
  QuickAnswerRow,
  QuickAnswerSettlement,
} from './quick-answer-ports.js';

type Authority = Parameters<QuickAnswerPorts['withScope']>[0];

type Prepared =
  /** Nothing to do: the answer is gone, dismissed or settled, or belongs to another scope. */
  | { readonly kind: 'skip' }
  /**
   * No model is asked and the card closes as unavailable, its words cleared: the Scroll can no longer be read for it
   * (withdrawn or held), or the job came too late (the wait limit or the day is over), so nobody is waiting for it.
   */
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'ready';
      readonly owner: RunOwner;
      readonly ask: QuickAnswerAsk;
      readonly passages: readonly CitablePassage[];
      readonly title: string;
      /** When the person asked: their wait ends a fixed time after it. */
      readonly createdAt: Date;
    };

/**
 * The step that writes one Quick answer (D-253); the worker's consumer calls it. The Scroll's title, the words the person selected,
 * their question if they typed one, and the passages of the Scroll up to their stop go to the writer, a role on the personal
 * reasoning harness. What it proposes passes code's rules (`quickAnswerRefusals`) and then a support check, a second model
 * that reads each sentence against the passages the answer cites (`quick-answer-support.ts`); only an answer the check cleared is
 * shown, and the card of a question the passages do not cover shows a sentence code owns. It never reads a later stop, never
 * writes evidence and never touches the Universe.
 *
 * `support` is required and the step fails closed: a worker built without one is refused at construction, a check that gave no
 * usable answer shows nothing, and an exception from it stores nothing and leaves the delivery to be retried.
 *
 * Authority: a `system` actor for the person's universe and epoch, rechecked under the personal lock in every transaction. Every
 * run is stamped with the recording generation the answer was asked at and fenced to it (D-264): a person who paused and resumed
 * gets answers, and a run in flight across a pause or a Clear stores nothing. Steps: (1) one transaction reads the still-waiting
 * row and the passages; (2) outside any transaction the harness makes the writer's call, the check, and at most one rewrite and
 * its check, all on runs named from the answer's ID; (3) one transaction under the recording fence closes the writer's run,
 * rechecks the row is still waiting and inside its wait limit, and settles it. A card dismissed, erased or given up on meanwhile
 * gets nothing stored: the late answer is dropped. When the fence no longer holds the card closes as unavailable and the model's
 * answer is dropped.
 * Failure/retry: a redelivery answers every step from the ledger and never pays twice, and an attempt of unknown outcome is
 * never resent: the card ends as unavailable and its run stays open for an operator. A job that comes after the wait is over
 * settles the card as unavailable and clears the words, asking no model.
 */
export function makeAnswerQuickAnswer(
  p: QuickAnswerPorts,
  recording: RecordingRuns,
  support: QuickAnswerSupportCheck,
): AnswerQuickAnswerUseCase {
  if (typeof support !== 'function') throw new Error('QUICK_ANSWER_SUPPORT_CHECK_REQUIRED');

  async function prepare(scope: PersonalScopeTx, row: QuickAnswerRow | undefined): Promise<Prepared> {
    if (!(await p.ownerActive(scope))) return { kind: 'skip' };
    const now = p.now();
    if (row?.state !== 'waiting' || row.passage === undefined) return { kind: 'skip' };
    // A job that arrives after the person's wait is over (a stopped worker, a queue that was behind) settles the card and
    // clears the words now: left waiting they would stay up to a day and hold one of the person's places.
    if (row.expiresAt <= now || now.getTime() - row.createdAt.getTime() > QUICK_ANSWER_WAIT_LIMIT_MS)
      return { kind: 'unavailable' };
    const facts = await p.readFacts(scope, { assetId: row.assetId, assetRevision: row.assetRevision }, row.stopId);
    if (facts === undefined) return { kind: 'unavailable' };
    const accountId = await accountOf(recording.fenceOwn, scope);
    if (accountId === undefined) return { kind: 'skip' };
    // The plainer words of the reader's own stop are the Scroll's too (D-085): the reader may have selected inside them.
    const offered = [...facts.passages, { stopId: row.stopId, text: facts.anchorSimple }];
    const passages = offered.map((passage, index): CitablePassage => ({ handle: handleOf(index), ...passage }));
    const owner: RunOwner = {
      accountId,
      universeId: scope.authority.universeId,
      privacyEpoch: scope.authority.privacyEpoch,
      recordId: row.id,
      recordingGeneration: row.recordingGeneration,
    };
    return {
      kind: 'ready',
      owner,
      ask: { passage: row.passage, question: row.question },
      passages,
      title: facts.title,
      createdAt: row.createdAt,
    };
  }

  /**
   * Settles the answer if it still waits and is inside its limit: with the model's answer when the result is a shown one, and as
   * unavailable otherwise. True when the person's card changed.
   */
  async function settle(scope: PersonalScopeTx, id: string, result: PipelineResult): Promise<boolean> {
    const row = await p.store.read(scope, id);
    const now = p.now();
    if (row?.state !== 'waiting') return false;
    const late = now.getTime() - row.createdAt.getTime() > QUICK_ANSWER_WAIT_LIMIT_MS;
    const settlement: QuickAnswerSettlement =
      result.kind === 'shown' && !late ? { kind: 'answered', ...result.shown } : { kind: 'unavailable' };
    const settled = await p.store.settle(scope, id, settlement, now);
    if (settled) await p.notify(scope, await p.advance(scope), id);
    return settled;
  }

  /**
   * Stores the result and closes the writer's run in one transaction under the recording fence (the harness's applier rule).
   * Nothing is stored if the person's recording generation, the root or the card has moved on; the card then closes as
   * unavailable in a transaction of its own, which writes only the end of the card that was asked.
   */
  async function apply(authority: Authority, id: string, result: PipelineResult): Promise<void> {
    const [writer] = result.runs;
    if (writer?.end !== undefined) {
      const applied = await recording.harness.withPersonalApply(authority, writer.purpose, async (cap) => {
        await closeStartedRun(recording.harness, cap, writer);
        return settle(cap.personal, id, result);
      });
      if (applied.kind === 'entered') return;
    }
    await p.withScope(authority, async (scope) => {
      if (await p.ownerActive(scope)) await settle(scope, id, { kind: 'unavailable', runs: [] });
    });
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
    const result: PipelineResult =
      value.kind === 'unavailable'
        ? { kind: 'unavailable', runs: [] }
        : await answerAndCheck(
            { harness: recording.harness, support, idFor: p.idFor, now: p.now },
            {
              authority,
              owner: value.owner,
              quickAnswerId: job.quickAnswerId,
              ask: value.ask,
              passages: value.passages,
              context: quickAnswerContext({
                quickAnswerId: job.quickAnswerId,
                title: value.title,
                ask: value.ask,
                passages: value.passages,
              }),
              waitEndsAt: new Date(value.createdAt.getTime() + QUICK_ANSWER_WAIT_LIMIT_MS),
              signal,
            },
          );
    await apply(authority, job.quickAnswerId, result);
    // The checks and the rewrite each close in a transaction of their own. One that is not closed here (a stop between the two,
    // or a fence that no longer holds) is closed by the ledger's idle sweep: a redelivery finds the card settled and asks nothing.
    for (const run of result.runs.slice(1)) await closeStartedRunAlone(recording.harness, authority, run);
  };
}
