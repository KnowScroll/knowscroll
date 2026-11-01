import { ORPCError } from '@orpc/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QUICK_ANSWER_LABEL,
  problemDetails,
  type AskQuickAnswer,
  type AskQuickAnswerResult,
  type ProblemCode,
  type QuickAnswerStatus,
} from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { createQueryClient } from './query-client';
import { createQuickAnswerSession, quickAnswerSessionFor } from './quick-answer-session';

const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const assetId = id(1);
const answerId = id(50);
let counter = 100;
const newId = () => id(counter++);

const problem = (code: ProblemCode) => {
  const details = problemDetails(code);
  return new ORPCError(code, { status: details.status, message: details.title, data: details });
};
const accepted = (command: AskQuickAnswer): AskQuickAnswerResult => ({
  version: 'quick-answer-receipt.v1',
  outcome: 'accepted',
  commandId: command.commandId,
  quickAnswerId: answerId,
  recordedAt: '2026-11-01T10:00:00.000Z',
  privacyEpoch: 1,
  replayed: false,
});
const waiting: QuickAnswerStatus = {
  version: 'quick-answer-status.v1',
  quickAnswerId: answerId,
  privacyEpoch: 1,
  status: 'waiting',
};
const answered: QuickAnswerStatus = {
  version: 'quick-answer-status.v1',
  quickAnswerId: answerId,
  privacyEpoch: 1,
  status: 'answered',
  label: QUICK_ANSWER_LABEL,
  question: 'Why does it keep pointing?',
  answer: 'Nothing turns the axis during a year.',
  covered: true,
};

interface Api {
  ask?: (command: AskQuickAnswer) => Promise<AskQuickAnswerResult>;
  read?: (input: { quickAnswerId: string }) => Promise<QuickAnswerStatus>;
  dismiss?: (input: { quickAnswerId: string }) => Promise<unknown>;
}

function fixture(api: Api = {}, recording: 'on' | 'paused' = 'on') {
  const ask = vi.fn(api.ask ?? ((command: AskQuickAnswer) => Promise.resolve(accepted(command))));
  const read = vi.fn(api.read ?? (() => Promise.resolve(waiting)));
  const dismiss = vi.fn(
    api.dismiss ?? (() => Promise.resolve({ version: 'quick-answer-dismissed.v1', quickAnswerId: answerId })),
  );
  const refresh = vi.fn(() => Promise.resolve(true));
  const ended: (() => void)[] = [];
  const queryClient = createQueryClient();
  const scope = {
    active: true,
    account: { privacyEpoch: 1 },
    queryClient,
    queryKey: (...parts: (string | number)[]) => ['scope', 'ci', ...parts],
    api: { quickAnswers: { ask, read, dismiss } },
    recording: {
      getState: () => ({
        status: 'current',
        policy: { on: recording === 'on', generation: 1 },
        retryOriginal: false,
        collecting: true,
      }),
      generation: () => Promise.resolve(1),
      refresh,
    },
    onEnd: (listener: () => void) => {
      ended.push(listener);
      return () => undefined;
    },
  } as unknown as AccountScope & { active: boolean };
  const session = createQuickAnswerSession({ scope, assetId, revision: 3, newId, pollMs: 1000, maxPolls: 4 });
  return {
    scope,
    session,
    ask,
    read,
    dismiss,
    refresh,
    queryClient,
    end: () => {
      (scope as { active: boolean }).active = false;
      ended.forEach((listener) => listener());
    },
  };
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const stop = (snapshot: ReturnType<ReturnType<typeof fixture>['session']['getSnapshot']>, stopId = 'one') =>
  snapshot.cards[stopId];

describe('a Quick answer session', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks once for the selected words, waits for the worker, then shows the labelled answer', async () => {
    const { session, ask, read } = fixture({
      read: vi.fn().mockResolvedValueOnce(waiting).mockResolvedValue(answered),
    });
    await session.ask({ stopId: 'one', passage: 'keeps pointing' });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]![0]).toMatchObject({
      version: 'quick-answer-ask.v1',
      source: { assetId, assetRevision: 3 },
      stopId: 'one',
      passage: 'keeps pointing',
      recordingGeneration: 1,
    });
    expect(ask.mock.calls[0]![0]).not.toHaveProperty('question');
    expect(stop(session.getSnapshot())).toMatchObject({ phase: 'waiting', id: answerId });
    await vi.advanceTimersByTimeAsync(1000);
    expect(stop(session.getSnapshot())).toMatchObject({ phase: 'waiting' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(stop(session.getSnapshot())).toMatchObject({
      phase: 'answered',
      label: 'Quick answer · not a checked Scroll',
      question: 'Why does it keep pointing?',
      answer: 'Nothing turns the axis during a year.',
      covered: true,
    });
    // It stops reading once there is an answer.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reads at once when a hint marks the answer stale, without waiting for the timer', async () => {
    const { session, read, queryClient } = fixture({
      read: vi.fn().mockResolvedValueOnce(waiting).mockResolvedValue(answered),
    });
    await session.ask({ stopId: 'one', passage: 'keeps pointing' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(1);
    await queryClient.invalidateQueries({ queryKey: ['scope', 'ci'] });
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    expect(stop(session.getSnapshot())).toMatchObject({ phase: 'answered' });
  });

  it('sends nothing while recording is paused, and says so (D-254)', async () => {
    const { session, ask } = fixture({}, 'paused');
    await session.ask({ stopId: 'one', passage: 'keeps pointing' });
    expect(ask).not.toHaveBeenCalled();
    expect(stop(session.getSnapshot())).toMatchObject({ phase: 'unavailable', reason: 'paused' });
  });

  it('says honestly when the day, the person or the queue is full', async () => {
    for (const reason of ['not_available', 'person_limit', 'too_many_open'] as const) {
      const { session } = fixture({
        ask: () => Promise.resolve({ version: 'quick-answer-receipt.v1', outcome: 'unavailable', reason }),
      });
      await session.ask({ stopId: 'one', passage: 'words' });
      expect(stop(session.getSnapshot())).toMatchObject({ phase: 'unavailable', reason });
    }
  });

  it('reads a refusal for pause as paused and refreshes the policy, other refusals as no answer, and a lost connection as offline', async () => {
    const paused = fixture({ ask: () => Promise.reject(problem('RECORDING_PAUSED')) });
    await paused.session.ask({ stopId: 'one', passage: 'words' });
    expect(stop(paused.session.getSnapshot())).toMatchObject({ phase: 'unavailable', reason: 'paused' });
    expect(paused.refresh).toHaveBeenCalled();
    const refused = fixture({ ask: () => Promise.reject(problem('ASSET_NOT_FOUND')) });
    await refused.session.ask({ stopId: 'one', passage: 'words' });
    expect(stop(refused.session.getSnapshot())).toMatchObject({ phase: 'unavailable', reason: 'could_not_answer' });
    const offline = fixture({ ask: () => Promise.reject(new TypeError('network')) });
    await offline.session.ask({ stopId: 'one', passage: 'words' });
    expect(stop(offline.session.getSnapshot())).toMatchObject({ phase: 'unavailable', reason: 'offline' });
  });

  it('gives up honestly when the answer never comes, and when the server no longer has it', async () => {
    const slow = fixture();
    await slow.session.ask({ stopId: 'one', passage: 'words' });
    await vi.advanceTimersByTimeAsync(6000);
    expect(stop(slow.session.getSnapshot())).toMatchObject({ phase: 'unavailable', reason: 'could_not_answer' });
    const gone = fixture({ read: () => Promise.reject(problem('NOT_FOUND')) });
    await gone.session.ask({ stopId: 'one', passage: 'words' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(stop(gone.session.getSnapshot())).toMatchObject({ phase: 'unavailable', reason: 'could_not_answer' });
  });

  it('closes a card and asks the server to erase its words, and drops an answer that arrives after', async () => {
    const { session, dismiss, read } = fixture({ read: vi.fn().mockResolvedValue(answered) });
    await session.ask({ stopId: 'one', passage: 'words' });
    session.dismiss('one');
    expect(session.getSnapshot().cards).toEqual({});
    expect(dismiss).toHaveBeenCalledWith({ quickAnswerId: answerId });
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).not.toHaveBeenCalled();
    expect(session.getSnapshot().cards).toEqual({});
  });

  it('lets a later ask at the same stop replace the earlier one, so a slow first answer cannot overwrite it', async () => {
    let first: (value: AskQuickAnswerResult) => void = () => undefined;
    const sent: AskQuickAnswer[] = [];
    const { session } = fixture({
      ask: (command) => {
        sent.push(command);
        if (sent.length === 1) return new Promise((resolve) => (first = resolve));
        return Promise.resolve({ ...accepted(command), quickAnswerId: id(51) });
      },
    });
    const firstAsk = session.ask({ stopId: 'one', passage: 'first words' });
    await session.ask({ stopId: 'one', passage: 'second words', question: 'And then?' });
    first(accepted(sent[0]!));
    await firstAsk;
    expect(stop(session.getSnapshot())).toMatchObject({ phase: 'waiting', id: id(51), passage: 'second words' });
    expect(sent[1]).toMatchObject({ question: 'And then?' });
  });

  it('keeps one card per stop and publishes nothing once its scope has ended', async () => {
    const { session, end } = fixture();
    await session.ask({ stopId: 'one', passage: 'words' });
    await session.ask({ stopId: 'two', passage: 'other words' });
    expect(Object.keys(session.getSnapshot().cards)).toEqual(['one', 'two']);
    const before = session.getSnapshot();
    end();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(session.getSnapshot()).toBe(before);
  });

  it('is the same session for the same Scroll revision in one scope, and another for another revision', () => {
    const { scope } = fixture();
    const options = { scope, assetId, revision: 3, newId };
    expect(quickAnswerSessionFor(options)).toBe(quickAnswerSessionFor(options));
    expect(quickAnswerSessionFor({ ...options, revision: 4 })).not.toBe(quickAnswerSessionFor(options));
  });
});
