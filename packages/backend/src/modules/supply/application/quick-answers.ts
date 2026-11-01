import {
  AskQuickAnswerResultSchema,
  AskQuickAnswerSchema,
  DismissQuickAnswerResultSchema,
  DismissQuickAnswerSchema,
  QUICK_ANSWER_LABEL,
  QuickAnswerStatusSchema,
  ReadQuickAnswerSchema,
  type AskQuickAnswer,
  type AskQuickAnswerResult,
  type QuickAnswerRefusalReason,
} from '@knowscroll/contracts';
import type { PersonalScopeTx } from '../../identity/public.js';
import { MAX_OPEN_QUICK_ANSWERS, expiryOf, isFromStop, utcDayStart } from '../domain/quick-answer.js';
import type {
  AskQuickAnswerUseCase,
  DismissQuickAnswerUseCase,
  QuickAnswerPorts,
  QuickAnswerRow,
  ReadQuickAnswerForReport,
  ReadQuickAnswerUseCase,
} from './quick-answer-ports.js';

/**
 * How long a worker has to answer before the card gives up. A Quick answer that takes longer is no use to a person who
 * is reading on, so a late answer is dropped, not shown (D-253).
 */
export const QUICK_ANSWER_WAIT_LIMIT_MS = 180_000;

/** Whether a row may still be read by its owner: not dismissed and not past its day. */
const readable = (row: QuickAnswerRow | undefined, now: Date): row is QuickAnswerRow =>
  row !== undefined && row.state !== 'dismissed' && row.expiresAt.getTime() > now.getTime();

/**
 * Why no Quick answer may be started now, or nothing. The world's day is checked first: it also covers a world that has
 * Quick answers turned off (a cap of 0). Counted under the caps lock, so two people asking at once cannot both take the
 * last place.
 */
async function refusalReason(
  p: QuickAnswerPorts,
  scope: PersonalScopeTx,
  now: Date,
): Promise<QuickAnswerRefusalReason | undefined> {
  await p.store.lockCaps(scope);
  const startOfDay = utcDayStart(now);
  if ((await p.ledger.countSince(scope, startOfDay)) >= p.caps.perDay) return 'not_available';
  if ((await p.store.countSince(scope, startOfDay)) >= p.caps.perPersonPerDay) return 'person_limit';
  if ((await p.store.countWaiting(scope)) >= MAX_OPEN_QUICK_ANSWERS) return 'too_many_open';
  return undefined;
}

/**
 * `POST /v1/quick-answers`: stores one Quick answer and sends the job that answers it. No model is called here.
 *
 * Authority: the person's own personal root, the owner active, recording on at the client's generation (D-254), and an
 * exposure of exactly this Scroll revision. The Scroll's stop must be a read stop of that exact revision and the words
 * must be from it. Effects: one row (the words, kept only until the answer settles), one ledger row, the answering job,
 * the receipt and a revision bump, all in one transaction. Failure: a refusal writes nothing, and a full day or a full
 * queue is an honest `unavailable` outcome with no receipt, so the same command may be sent again. An identical retry
 * answers the first receipt.
 */
export function makeAskQuickAnswer(p: QuickAnswerPorts): AskQuickAnswerUseCase {
  return async (authority, command) => {
    const asked = AskQuickAnswerSchema.parse(command);
    const result = await p.withScope(authority, async (scope) => {
      if (!(await p.ownerActive(scope))) return { kind: 'refused', reason: 'scope_refused' } as const;
      const previous = await p.receipts.find(scope, asked.commandId, asked);
      if (previous.kind === 'replay')
        return {
          kind: 'ok',
          value: AskQuickAnswerResultSchema.parse({
            ...(previous.outcome as Record<string, unknown>),
            replayed: true,
          }),
        } as const;
      if (previous.kind === 'refused') return { kind: 'refused', reason: previous.reason } as const;
      const gate = await p.fenceRecording(scope, asked.recordingGeneration);
      if (gate.kind === 'paused') return { kind: 'refused', reason: 'recording_paused' } as const;
      if (gate.kind === 'stale') return { kind: 'refused', reason: 'recording_stale' } as const;
      if (gate.kind !== 'recording') return { kind: 'refused', reason: 'scope_refused' } as const;
      const source = await sourceOf(p, scope, asked);
      if (!source) return { kind: 'refused', reason: 'source_unavailable' } as const;
      const now = p.now();
      const reason = await refusalReason(p, scope, now);
      if (reason !== undefined)
        return {
          kind: 'ok',
          value: AskQuickAnswerResultSchema.parse({
            version: 'quick-answer-receipt.v1',
            outcome: 'unavailable',
            reason,
          }),
        } as const;
      const id = p.newId();
      await p.receipts.insert(scope, asked.commandId, asked);
      await p.store.insert(scope, {
        id,
        ...source,
        passage: asked.passage,
        question: asked.question,
        createdAt: now,
        expiresAt: expiryOf(now),
      });
      await p.ledger.insert(scope, id);
      await p.enqueue(scope, id);
      const revision = await p.advance(scope);
      const receipt: AskQuickAnswerResult = AskQuickAnswerResultSchema.parse({
        version: 'quick-answer-receipt.v1',
        outcome: 'accepted',
        commandId: asked.commandId,
        quickAnswerId: id,
        recordedAt: now.toISOString(),
        privacyEpoch: scope.authority.privacyEpoch,
        replayed: false,
      });
      await p.receipts.complete(scope, asked.commandId, receipt);
      await p.notify(scope, revision, id);
      return { kind: 'ok', value: receipt } as const;
    });
    return result.kind === 'entered' ? result.value : { kind: 'refused', reason: 'scope_refused' };
  };
}

/** The exact Scroll revision, stop and words this ask is about, or nothing when the person cannot ask about them. */
async function sourceOf(p: QuickAnswerPorts, scope: PersonalScopeTx, asked: AskQuickAnswer) {
  const { assetId, assetRevision } = asked.source;
  if (!(await p.hasActivatedExposure(scope, assetId, assetRevision))) return undefined;
  const facts = await p.readFacts(scope, { assetId, assetRevision }, asked.stopId);
  const anchor = facts?.passages.at(-1);
  if (facts === undefined || anchor === undefined) return undefined;
  if (!isFromStop(asked.passage, anchor.text) && !isFromStop(asked.passage, facts.anchorSimple)) return undefined;
  return { assetId, assetRevision, stopId: asked.stopId };
}

/**
 * `GET /v1/quick-answers/{id}`: the person's own answer as it stands. Reads change nothing and start no work. A
 * dismissed or expired answer is not found, and so is another person's. A wait past its limit reads as unavailable even if
 * the worker never closed it (a dead-lettered job, a stopped worker); a late answer is then dropped (`settle` needs the
 * row still waiting and the worker checks the limit).
 */
export function makeReadQuickAnswer(p: QuickAnswerPorts): ReadQuickAnswerUseCase {
  return async (authority, input) => {
    const { quickAnswerId } = ReadQuickAnswerSchema.parse(input);
    const result = await p.withScope(authority, async (scope) => {
      const row = await p.store.read(scope, quickAnswerId);
      const now = p.now();
      if (!readable(row, now)) return { kind: 'refused', reason: 'not_found' } as const;
      const base = { quickAnswerId, privacyEpoch: scope.authority.privacyEpoch } as const;
      const waitedTooLong = now.getTime() - row.createdAt.getTime() > QUICK_ANSWER_WAIT_LIMIT_MS;
      const status =
        row.state === 'answered' && row.shownQuestion !== undefined && row.answer !== undefined
          ? {
              ...base,
              version: 'quick-answer-status.v1',
              status: 'answered',
              label: QUICK_ANSWER_LABEL,
              question: row.shownQuestion,
              answer: row.answer,
              covered: row.covered === true,
            }
          : row.state === 'waiting' && !waitedTooLong
            ? { ...base, version: 'quick-answer-status.v1', status: 'waiting' }
            : { ...base, version: 'quick-answer-status.v1', status: 'unavailable', reason: 'could_not_answer' };
      return { kind: 'ok', value: QuickAnswerStatusSchema.parse(status) } as const;
    });
    return result.kind === 'entered' ? result.value : { kind: 'refused', reason: 'scope_refused' };
  };
}

/**
 * `POST /v1/quick-answers/dismiss`: closes the card and clears its words now, so nothing is kept longer than the person
 * wanted it. Idempotent and quiet: an unknown, foreign or already-dismissed answer succeeds, so the call says nothing about
 * what exists. A job still queued finds no waiting row and ends.
 */
export function makeDismissQuickAnswer(p: QuickAnswerPorts): DismissQuickAnswerUseCase {
  return async (authority, input) => {
    const { quickAnswerId } = DismissQuickAnswerSchema.parse(input);
    const result = await p.withScope(authority, async (scope) => {
      await p.store.dismiss(scope, quickAnswerId);
      return {
        kind: 'ok',
        value: DismissQuickAnswerResultSchema.parse({ version: 'quick-answer-dismissed.v1', quickAnswerId }),
      } as const;
    });
    return result.kind === 'entered' ? result.value : { kind: 'refused', reason: 'scope_refused' };
  };
}

/**
 * What a report about a Quick answer keeps (D-255): the question and the answer as the card showed them, so the safety
 * team can read what was wrong after the answer itself is gone. Read inside the reporter's own personal scope, only for
 * their own answer, only while it is answered and kept, and only for the Scroll revision the report names. Anything else
 * is nothing, and the report is refused like a report about a missing target.
 */
export function makeReadQuickAnswerForReport(p: QuickAnswerPorts): ReadQuickAnswerForReport {
  return async (scope, input) => {
    const row = await p.store.read(scope, input.quickAnswerId);
    if (
      !readable(row, p.now()) ||
      row.state !== 'answered' ||
      row.shownQuestion === undefined ||
      row.answer === undefined ||
      row.assetId !== input.assetId ||
      row.assetRevision !== input.assetRevision
    )
      return undefined;
    return `Q: ${row.shownQuestion}\nA: ${row.answer}`;
  };
}
