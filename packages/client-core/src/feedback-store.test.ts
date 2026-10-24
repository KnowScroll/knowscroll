import { QueryClient } from '@tanstack/react-query';
import { ORPCError } from '@orpc/client';
import { describe, expect, it, vi } from 'vitest';
import { problemDetails, type ProblemCode } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { blocksRevisionKey } from './blocks';
import { createFeedbackStore, QUEUED_REPORT_LIMIT, UNDO_WINDOW_MS, type QueuedReport } from './feedback-store';
import type { OutboxTimers } from './recorder/outbox';

const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
let counter = 100;
const newId = () => id(counter++);
const assetId = id(1);

/** Timers the test moves by hand: a callback runs when `advance` passes its time. */
function manualTimers(): OutboxTimers & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let next = 0;
  const waiting = new Map<number, { at: number; callback: () => void }>();
  return {
    setTimeout(callback, ms) {
      const handle = next++;
      waiting.set(handle, { at: now + ms, callback });
      return handle;
    },
    clearTimeout(handle) {
      waiting.delete(handle as number);
    },
    advance(ms) {
      now += ms;
      for (const [handle, timer] of [...waiting]) {
        if (timer.at <= now) {
          waiting.delete(handle);
          timer.callback();
        }
      }
    },
    pending: () => waiting.size,
  };
}

const problem = (code: ProblemCode) => {
  const details = problemDetails(code);
  return new ORPCError(code, { status: details.status, message: details.title, data: details });
};
const receiptFor = (commandId: string) => ({
  commandId,
  reportId: id(7),
  receivedAt: '2026-10-24T22:11:00.000Z',
  replayed: false,
});
const abuse = (commandId = id(50)): QueuedReport => ({
  kind: 'abuse',
  request: { commandId, category: 'harassment', target: { kind: 'person', personId: id(9) } },
});

function fixture(api: Record<string, unknown> = {}) {
  const storage = new Map<string, string>();
  const feedback = {
    notInterested: vi.fn((input: { commandId: string; assetId: string }) =>
      Promise.resolve({ ...input, expiresAt: '2026-11-07T12:00:00.000Z', replayed: false }),
    ),
    undoNotInterested: vi.fn((input: { commandId: string; assetId: string }) =>
      Promise.resolve({ ...input, replayed: false }),
    ),
    reportAbuse: vi.fn((input: { commandId: string }) => Promise.resolve(receiptFor(input.commandId))),
    reportContentError: vi.fn((input: { commandId: string }) => Promise.resolve(receiptFor(input.commandId))),
    ...api,
  };
  const scope = {
    active: true,
    api: {
      feedback,
      sharing: {
        pair: vi.fn(() => Promise.resolve({ status: 'available', pair: { pairRevision: 3 } })),
        block: vi.fn(() => Promise.resolve({})),
      },
    },
    storage: {
      get: (key: string) => storage.get(key),
      set: (key: string, value: string) => void storage.set(key, value),
      remove: (key: string) => void storage.delete(key),
    },
    queryClient: new QueryClient(),
    queryKey: (...parts: readonly (string | number)[]) => ['scope', 'test', ...parts],
    onEnd: vi.fn(),
  } as unknown as AccountScope;
  const timers = manualTimers();
  const store = createFeedbackStore({ scope, newId, timers, random: () => 0 });
  return { store, scope, feedback, storage, timers };
}

describe('Not interested', () => {
  it('saves, acknowledges with the place to come back to, and lets the Undo window lapse', async () => {
    const { store, feedback, timers } = fixture();
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getState().notInterested.status));
    expect(await store.markNotInterested(assetId, 'exposure-1')).toBe(true);
    expect(seen).toEqual(['saving', 'acknowledged']);
    expect(store.getState().notInterested).toEqual({ status: 'acknowledged', assetId, resume: 'exposure-1' });
    expect(feedback.notInterested).toHaveBeenCalledWith({ commandId: expect.any(String) as string, assetId });
    timers.advance(UNDO_WINDOW_MS - 1);
    expect(store.getState().notInterested.status).toBe('acknowledged');
    timers.advance(1);
    expect(store.getState().notInterested).toEqual({ status: 'idle' });
  });

  it('takes it back with Undo, in its own command, and says so only once the server has', async () => {
    const { store, feedback } = fixture();
    await store.markNotInterested(assetId, 'exposure-1');
    const markId = feedback.notInterested.mock.calls[0]![0].commandId;
    expect(await store.undoNotInterested()).toEqual({ done: true, resume: 'exposure-1' });
    expect(feedback.undoNotInterested).toHaveBeenCalledWith({ commandId: expect.any(String) as string, assetId });
    expect(feedback.undoNotInterested.mock.calls[0]![0].commandId).not.toBe(markId);
    expect(store.getState().notInterested).toEqual({ status: 'idle' });
    // Nothing is left to undo.
    expect(await store.undoNotInterested()).toEqual({ done: false, resume: undefined });
  });

  it('keeps the same command ID when a failed save is retried', async () => {
    const { store, feedback } = fixture();
    feedback.notInterested.mockRejectedValueOnce(new Error('offline'));
    expect(await store.markNotInterested(assetId)).toBe(false);
    expect(store.getState().notInterested).toEqual({ status: 'failed', assetId, step: 'mark' });
    expect(await store.retryNotInterested()).toEqual({ done: true, resume: undefined });
    const [first, second] = feedback.notInterested.mock.calls.map((call) => call[0].commandId);
    expect(second).toBe(first);
    expect(store.getState().notInterested.status).toBe('acknowledged');
  });

  it('keeps the same command ID when a failed Undo is retried, and stays acknowledged-less until it works', async () => {
    const { store, feedback } = fixture();
    await store.markNotInterested(assetId, 'exposure-1');
    feedback.undoNotInterested.mockRejectedValueOnce(new Error('offline'));
    expect(await store.undoNotInterested()).toEqual({ done: false, resume: 'exposure-1' });
    expect(store.getState().notInterested).toEqual({ status: 'failed', assetId, step: 'undo' });
    expect(await store.retryNotInterested()).toEqual({ done: true, resume: 'exposure-1' });
    const [first, second] = feedback.undoNotInterested.mock.calls.map((call) => call[0].commandId);
    expect(second).toBe(first);
    expect(store.getState().notInterested).toEqual({ status: 'idle' });
  });

  it('refuses an answer about another asset or command', async () => {
    const { store } = fixture({
      notInterested: () => Promise.resolve({ commandId: id(99), assetId, expiresAt: 'x', replayed: false }),
    });
    expect(await store.markNotInterested(assetId)).toBe(false);
    expect(store.getState().notInterested.status).toBe('failed');
  });

  it('can be dismissed without undoing it', async () => {
    const { store, feedback } = fixture();
    await store.markNotInterested(assetId);
    store.dismissNotInterested();
    expect(store.getState().notInterested).toEqual({ status: 'idle' });
    expect(feedback.undoNotInterested).not.toHaveBeenCalled();
  });
});

describe('sending a report', () => {
  it('delivers it and keeps nothing', async () => {
    const { store, storage } = fixture();
    const outcome = await store.sendReport(abuse());
    expect(outcome).toMatchObject({ status: 'received', receipt: { reportId: id(7) } });
    expect(store.getState().queued).toBe(0);
    expect(storage.size).toBe(0);
  });

  it('keeps a report that got no answer, says it is queued, and sends it again with the same command ID', async () => {
    const { store, feedback, storage, timers } = fixture();
    feedback.reportAbuse.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await store.sendReport(abuse(id(50)))).toEqual({ status: 'queued' });
    expect(store.getState().queued).toBe(1);
    expect(JSON.parse(storage.get('feedback.reports.v1')!)).toHaveLength(1);

    timers.advance(1_000);
    await vi.waitFor(() => expect(feedback.reportAbuse).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(store.getState().queued).toBe(0));
    expect(feedback.reportAbuse.mock.calls.map((call) => call[0].commandId)).toEqual([id(50), id(50)]);
    expect(storage.size).toBe(0);
  });

  it('backs off between attempts while there is no answer', async () => {
    const { store, feedback, timers } = fixture();
    feedback.reportAbuse.mockRejectedValue(new TypeError('Failed to fetch'));
    await store.sendReport(abuse());
    timers.advance(1_000);
    await vi.waitFor(() => expect(feedback.reportAbuse).toHaveBeenCalledTimes(2));
    // The next attempt waits twice as long.
    await vi.waitFor(() => expect(timers.pending()).toBe(1));
    timers.advance(1_999);
    expect(feedback.reportAbuse).toHaveBeenCalledTimes(2);
    timers.advance(1);
    await vi.waitFor(() => expect(feedback.reportAbuse).toHaveBeenCalledTimes(3));
    expect(store.getState().queued).toBe(1);
  });

  it('settles every answer: busy server, too many, and a target that is gone', async () => {
    for (const [code, expected] of [
      ['SERVICE_UNAVAILABLE', { status: 'refused', reason: 'try_again' }],
      ['INTERNAL', { status: 'refused', reason: 'try_again' }],
      ['TOO_MANY_REQUESTS', { status: 'refused', reason: 'too_many' }],
      ['NOT_FOUND', { status: 'refused', reason: 'unavailable' }],
      ['COMMAND_KEY_REUSED', { status: 'refused', reason: 'unavailable' }],
    ] as const) {
      const { store, feedback, storage } = fixture();
      feedback.reportAbuse.mockRejectedValueOnce(problem(code));
      expect(await store.sendReport(abuse()), code).toEqual(expected);
      // An answer settles it: nothing is kept to send again behind the person's back.
      expect(store.getState().queued, code).toBe(0);
      expect(storage.size, code).toBe(0);
    }
  });

  it('sends a content error through its own route', async () => {
    const { store, feedback } = fixture();
    const report: QueuedReport = {
      kind: 'content_error',
      request: { commandId: id(60), target: { assetId, assetRevision: 2 }, category: 'wrong' },
    };
    expect(await store.sendReport(report)).toMatchObject({ status: 'received' });
    expect(feedback.reportContentError).toHaveBeenCalledWith(report.request);
    expect(feedback.reportAbuse).not.toHaveBeenCalled();
  });

  it('refuses a receipt for another command', async () => {
    const { store } = fixture({ reportAbuse: () => Promise.resolve(receiptFor(id(99))) });
    // A mismatched receipt is not an answer to this report: it is treated as trouble, not as received.
    const outcome = await store.sendReport(abuse(id(50)));
    expect(outcome.status).not.toBe('received');
  });

  it('keeps at most ten waiting reports, dropping the oldest', async () => {
    const { store, feedback } = fixture();
    feedback.reportAbuse.mockRejectedValue(new TypeError('Failed to fetch'));
    for (let sent = 0; sent < QUEUED_REPORT_LIMIT + 2; sent++) await store.sendReport(abuse(id(200 + sent)));
    expect(store.getState().queued).toBe(QUEUED_REPORT_LIMIT);
  });

  it('reads what an earlier run left and sends it, dropping anything it cannot read', async () => {
    const { store, feedback, storage } = fixture();
    storage.set(
      'feedback.reports.v1',
      JSON.stringify([
        abuse(id(70)),
        { kind: 'abuse', request: { commandId: 'not-a-uuid' } },
        { kind: 'something_else', request: {} },
      ]),
    );
    store.resume();
    await vi.waitFor(() => expect(feedback.reportAbuse).toHaveBeenCalledTimes(1));
    expect(feedback.reportAbuse.mock.calls[0]![0].commandId).toBe(id(70));
    await vi.waitFor(() => expect(store.getState().queued).toBe(0));
    expect(storage.size).toBe(0);
  });

  it('survives a corrupt store', () => {
    const { store, storage } = fixture();
    storage.set('feedback.reports.v1', '{not json');
    store.resume();
    expect(store.getState().queued).toBe(0);
  });
});

describe('blocking after a report', () => {
  it('blocks through the existing command and lets screens know', async () => {
    const { store, scope } = fixture();
    expect(await store.blockPerson(id(9))).toBe(true);
    expect(scope.queryClient.getQueryData(blocksRevisionKey(scope))).toBe(1);
  });

  it('says so when the block did not go through', async () => {
    const { store, scope } = fixture();
    (scope.api.sharing.block as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offline'));
    expect(await store.blockPerson(id(9))).toBe(false);
    expect(scope.queryClient.getQueryData(blocksRevisionKey(scope))).toBeUndefined();
  });
});
