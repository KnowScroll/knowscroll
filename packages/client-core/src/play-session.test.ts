import { ORPCError } from '@orpc/client';
import { describe, expect, it, vi } from 'vitest';
import { problemDetails, type CallLockRequest, type CallLockResponse, type ProblemCode } from '@knowscroll/contracts';
import { tallyOf } from '@knowscroll/scroll-model';
import { ScopeEndedError, type AccountScope } from './account-scope';
import { createPlaySession, PLAY_RETRY_DELAYS_MS, playSessionFor } from './play-session';
import type { OutboxTimers } from './recorder/outbox';

const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
let counter = 100;
const newId = () => id(counter++);
const assetId = id(1);
const calls = [
  { stopId: 'call-june', answer: 1 },
  { stopId: 'call-angle', answer: 0 },
  { stopId: 'call-final', answer: 2, finalCall: true },
];
const landmark = { key: 'the-ci-landmark', name: 'The CI Landmark' };

/** Timers the test moves by hand. */
function manualTimers(): OutboxTimers & { advance(ms: number): void } {
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
  };
}

const problem = (code: ProblemCode) => {
  const details = problemDetails(code);
  return new ORPCError(code, { status: details.status, message: details.title, data: details });
};

/** What the server keeps, judged as the real one does: the first lock of a call stands. */
function server() {
  const kept: { stopId: string; option: number; correct: boolean }[] = [];
  const results = () => {
    const tally = tallyOf(
      kept.map((call) => ({
        correct: call.correct,
        finalCall: calls.find((c) => c.stopId === call.stopId)?.finalCall,
      })),
    );
    const final = kept.find((call) => calls.find((c) => c.stopId === call.stopId)?.finalCall === true);
    return {
      assetId,
      revision: 1,
      calls: kept.map((call) => ({ ...call })),
      ...tally,
      ...(final === undefined
        ? {}
        : { landmark: { ...landmark, tier: final.correct ? ('gold' as const) : ('plain' as const) } }),
    };
  };
  const lockCall = vi.fn((request: CallLockRequest): Promise<CallLockResponse> => {
    const answer = calls.find((call) => call.stopId === request.stopId)!.answer;
    let standing = kept.find((call) => call.stopId === request.stopId);
    const newlyLocked = standing === undefined;
    if (standing === undefined) {
      standing = { stopId: request.stopId, option: request.option, correct: request.option === answer };
      kept.push(standing);
    }
    return Promise.resolve({
      recorded: true,
      commandId: request.commandId,
      assetId: request.assetId,
      revision: request.revision,
      stopId: request.stopId,
      option: standing.option,
      correct: standing.correct,
      newlyLocked,
      results: results(),
      replayed: false,
    });
  });
  const readResults = vi.fn(() => Promise.resolve(results()));
  return { kept, lockCall, readResults };
}

function fixture(
  api: { lockCall?: unknown; readResults?: unknown } = {},
  recording: 'on' | 'paused' = 'on',
  named: { readonly key: string; readonly name: string } | undefined = undefined,
) {
  const base = server();
  const ended: (() => void)[] = [];
  const policy = { on: recording === 'on', generation: recording === 'on' ? 1 : 2 };
  const generation = vi.fn(() => Promise.resolve(policy.generation));
  const refresh = vi.fn(() => Promise.resolve(true));
  const policyListeners = new Set<() => void>();
  const scope = {
    active: true,
    api: { play: { lockCall: base.lockCall, readResults: base.readResults, ...api } },
    recording: {
      getState: () => ({ status: 'current', policy, retryOriginal: false, collecting: true }),
      generation,
      refresh,
      subscribe: (listener: () => void) => {
        policyListeners.add(listener);
        return () => policyListeners.delete(listener);
      },
    },
    onEnd: (listener: () => void) => {
      ended.push(listener);
      return () => undefined;
    },
  } as unknown as AccountScope & { active: boolean };
  const timers = manualTimers();
  const session = createPlaySession({ scope, assetId, revision: 1, calls, landmark: named, newId, timers });
  return {
    base,
    scope,
    timers,
    session,
    generation,
    refresh,
    /** The person turns recording back on: the policy changes and whoever watches it is told. */
    resume: () => {
      policy.on = true;
      policy.generation = 3;
      for (const listener of [...policyListeners]) listener();
    },
    end: () => {
      (scope as { active: boolean }).active = false;
      for (const listener of ended) listener();
    },
  };
}

const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('locking a call on the device', () => {
  it('shows the lock at once, judged from the document, with its spark and combo', () => {
    const { session } = fixture();
    session.lock('call-june', 1);
    expect(session.getSnapshot()).toMatchObject({
      sparks: 1,
      combo: 1,
      locks: [{ stopId: 'call-june', option: 1, correct: true, combo: 1, keeping: 'waiting' }],
    });
    session.lock('call-angle', 2);
    expect(session.getSnapshot()).toMatchObject({ sparks: 1, combo: 0 });
    expect(session.getSnapshot().locks.map((lock) => lock.correct)).toEqual([true, false]);
  });

  it('ignores a call that is not a Call it, one that is already locked and an option that cannot be', async () => {
    const { session, base } = fixture();
    session.lock('final', 0);
    session.lock('call-june', -1);
    session.lock('call-june', 1.5);
    session.lock('call-june', 0);
    session.lock('call-june', 1);
    expect(session.getSnapshot().locks).toHaveLength(1);
    expect(session.getSnapshot().locks[0]).toMatchObject({ option: 0, correct: false });
    await settled();
    expect(base.lockCall).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers of each change and stops after unsubscribe', async () => {
    const { session } = fixture();
    const listener = vi.fn();
    const off = session.subscribe(listener);
    session.lock('call-june', 1);
    expect(listener).toHaveBeenCalledTimes(1);
    await settled();
    const heard = listener.mock.calls.length;
    expect(heard).toBeGreaterThan(1);
    off();
    session.lock('call-angle', 0);
    await settled();
    expect(listener).toHaveBeenCalledTimes(heard);
  });
});

describe('keeping a lock', () => {
  it("sends it with the recording generation, and the server's answer says it is kept", async () => {
    const { session, base } = fixture();
    session.lock('call-june', 1);
    await settled();
    expect(base.lockCall).toHaveBeenCalledWith(
      expect.objectContaining({ assetId, revision: 1, stopId: 'call-june', option: 1, recordingGeneration: 1 }),
    );
    expect(session.getSnapshot().locks[0]).toMatchObject({ keeping: 'saved' });
  });

  it("lets the first lock that the server has stand over the device's own", async () => {
    const { session, base } = fixture();
    base.kept.push({ stopId: 'call-june', option: 0, correct: false });
    session.lock('call-june', 1);
    await settled();
    expect(session.getSnapshot()).toMatchObject({
      sparks: 0,
      locks: [{ stopId: 'call-june', option: 0, correct: false, keeping: 'saved' }],
    });
  });

  it('saves nothing and sends nothing while recording is paused, and says so', async () => {
    const { session, base, generation } = fixture({}, 'paused');
    session.lock('call-june', 1);
    await settled();
    expect(base.lockCall).not.toHaveBeenCalled();
    expect(generation).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({ sparks: 1, locks: [{ keeping: 'recording_paused' }] });
  });

  it('believes the server when it says recording is paused, though the device had not heard', async () => {
    const lockCall = vi.fn(() =>
      Promise.resolve({ recorded: false, reason: 'recording_paused', currentGeneration: 2 }),
    );
    const { session } = fixture({ lockCall });
    session.lock('call-june', 1);
    await settled();
    expect(session.getSnapshot().locks[0]).toMatchObject({ keeping: 'recording_paused' });
    expect(lockCall).toHaveBeenCalledTimes(1);
  });

  it('reads the policy again when it is stale and sends the same lock', async () => {
    const stale = { recorded: false, reason: 'recording_generation_stale', currentGeneration: 3 };
    const { session, base, refresh, timers } = fixture({
      lockCall: vi
        .fn<(request: CallLockRequest) => Promise<unknown>>()
        .mockResolvedValueOnce(stale)
        .mockImplementation((request) => server().lockCall(request)),
    });
    expect(base.lockCall).not.toHaveBeenCalled();
    session.lock('call-june', 1);
    await settled();
    expect(refresh).toHaveBeenCalled();
    expect(session.getSnapshot().locks[0]).toMatchObject({ keeping: 'waiting' });
    timers.advance(PLAY_RETRY_DELAYS_MS[0]!);
    await settled();
    expect(session.getSnapshot().locks[0]).toMatchObject({ keeping: 'saved' });
  });

  it('keeps an unreached lock, sends it again with the same command ID, and gives up after its retries', async () => {
    const lockCall = vi.fn((_request: CallLockRequest) => Promise.reject(new TypeError('network')));
    const { session, timers } = fixture({ lockCall });
    session.lock('call-june', 1);
    await settled();
    expect(session.getSnapshot().locks[0]).toMatchObject({ keeping: 'waiting' });
    for (const delay of PLAY_RETRY_DELAYS_MS) {
      timers.advance(delay);
      await settled();
    }
    expect(lockCall).toHaveBeenCalledTimes(1 + PLAY_RETRY_DELAYS_MS.length);
    expect(new Set(lockCall.mock.calls.map(([request]) => request.commandId)).size).toBe(1);
    timers.advance(60_000);
    await settled();
    expect(lockCall).toHaveBeenCalledTimes(1 + PLAY_RETRY_DELAYS_MS.length);
    expect(session.getSnapshot().sparks).toBe(1);
  });

  it('does not try again what the server refuses', async () => {
    const lockCall = vi.fn(() => Promise.reject(problem('NOT_FOUND')));
    const { session, timers } = fixture({ lockCall });
    session.lock('call-june', 1);
    await settled();
    timers.advance(60_000);
    await settled();
    expect(lockCall).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().locks[0]).toMatchObject({ keeping: 'refused' });
  });

  it('sends locks in the order they were made, one at a time', async () => {
    const { session, base } = fixture();
    session.lock('call-june', 1);
    session.lock('call-angle', 0);
    await settled();
    await settled();
    expect(base.lockCall.mock.calls.map(([request]) => request.stopId)).toEqual(['call-june', 'call-angle']);
    expect(session.getSnapshot().locks.map((lock) => lock.keeping)).toEqual(['saved', 'saved']);
  });
});

describe('pausing and resuming in one sitting', () => {
  it("counts what was earned while paused on the device, then shows only the server's numbers once recording resumes", async () => {
    const { session, base, resume } = fixture({}, 'paused');
    session.lock('call-june', 1);
    await settled();
    // While paused the dock shows what was just earned, on the device.
    expect(session.getSnapshot()).toMatchObject({
      sparks: 1,
      combo: 1,
      locks: [{ keeping: 'recording_paused', combo: 1 }],
    });
    // Resumed: nothing was stored, so the server's numbers are zero and the dock says so at once.
    resume();
    expect(session.getSnapshot()).toMatchObject({
      sparks: 0,
      combo: 0,
      locks: [{ keeping: 'recording_paused', combo: 0 }],
    });
    // The next right call is kept: one spark and a combo of one, not a combo of two over a lock the server never held.
    session.lock('call-angle', 0);
    await settled();
    expect(base.kept).toEqual([{ stopId: 'call-angle', option: 0, correct: true }]);
    expect(session.getSnapshot()).toMatchObject({
      sparks: 1,
      combo: 1,
      locks: [
        // What the server holds comes first, then what was only on the device.
        { stopId: 'call-angle', keeping: 'saved', combo: 1 },
        { stopId: 'call-june', keeping: 'recording_paused', combo: 0 },
      ],
    });
  });

  it('tells whoever is watching when the policy changes, and stops when the scope ends', async () => {
    const { session, resume, end } = fixture({}, 'paused');
    session.lock('call-june', 1);
    await settled();
    const listener = vi.fn();
    session.subscribe(listener);
    resume();
    expect(listener).toHaveBeenCalledTimes(1);
    end();
    expect(session.getSnapshot()).toEqual({ locks: [], sparks: 0, combo: 0 });
  });
});

describe('the Final call and the landmark (D-187, D-188)', () => {
  const lockAll = (session: ReturnType<typeof fixture>['session'], ...picks: [string, number][]) => {
    for (const [stopId, option] of picks) session.lock(stopId, option);
  };

  it('judges the Final call on the device like any call, and doubles a right one after a combo of two', () => {
    const { session } = fixture();
    lockAll(session, ['call-june', 1], ['call-angle', 0], ['call-final', 2]);
    expect(session.getSnapshot()).toMatchObject({
      sparks: 4,
      combo: 3,
      locks: [
        { stopId: 'call-june', earned: 1, finalCall: false },
        { stopId: 'call-angle', earned: 1, finalCall: false },
        { stopId: 'call-final', earned: 2, finalCall: true, combo: 3 },
      ],
    });
    const broken = fixture().session;
    lockAll(broken, ['call-june', 1], ['call-angle', 2], ['call-final', 2]);
    expect(broken.getSnapshot()).toMatchObject({ sparks: 2, combo: 1 });
    expect(broken.getSnapshot().locks.map((lock) => lock.earned)).toEqual([1, 0, 1]);
  });

  it('shows a gold landmark for a right Final call and a plain one for any other, only when the Scroll names one', () => {
    const gold = fixture({}, 'on', landmark).session;
    expect(gold.getSnapshot().landmark).toBeUndefined();
    lockAll(gold, ['call-final', 2]);
    expect(gold.getSnapshot().landmark).toEqual({ ...landmark, tier: 'gold' });
    const plain = fixture({}, 'on', landmark).session;
    lockAll(plain, ['call-final', 0]);
    expect(plain.getSnapshot().landmark).toEqual({ ...landmark, tier: 'plain' });
    const none = fixture().session;
    lockAll(none, ['call-final', 2]);
    expect(none.getSnapshot().landmark).toBeUndefined();
    // A Call it never awards it.
    const callIt = fixture({}, 'on', landmark).session;
    lockAll(callIt, ['call-june', 1]);
    expect(callIt.getSnapshot().landmark).toBeUndefined();
  });

  it('sends the Final call like any lock, with nothing the device judged, and the answer of the server wins', async () => {
    const { session, base } = fixture({}, 'on', landmark);
    lockAll(session, ['call-final', 0]);
    await settled();
    expect(Object.keys(base.lockCall.mock.calls[0]![0]).sort()).toEqual([
      'assetId',
      'commandId',
      'option',
      'recordingGeneration',
      'revision',
      'stopId',
    ]);
    expect(session.getSnapshot()).toMatchObject({ landmark: { tier: 'plain' }, locks: [{ keeping: 'saved' }] });
  });

  it('says on the device what it earned while recording is paused, and takes it back once recording resumes', async () => {
    const { session, base, resume } = fixture({}, 'paused', landmark);
    lockAll(session, ['call-final', 2]);
    await settled();
    expect(base.lockCall).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({
      sparks: 1,
      landmark: { tier: 'gold' },
      locks: [{ keeping: 'recording_paused', finalCall: true }],
    });
    // The server never held it, so it is not shown as earned any more (D-083).
    resume();
    expect(session.getSnapshot()).toMatchObject({ sparks: 0, locks: [{ keeping: 'recording_paused' }] });
    expect(session.getSnapshot().landmark).toBeUndefined();
  });

  it('shows the landmark that was kept when the Scroll is opened again', async () => {
    const { session, base } = fixture({}, 'on', landmark);
    base.kept.push({ stopId: 'call-final', option: 2, correct: true });
    await session.load();
    expect(session.getSnapshot()).toMatchObject({
      sparks: 1,
      landmark: { ...landmark, tier: 'gold' },
      locks: [{ stopId: 'call-final', finalCall: true, keeping: 'saved' }],
    });
  });
});

describe('loading what was kept', () => {
  it('shows what the server kept, in the order locked, as already revealed', async () => {
    const { session, base } = fixture();
    base.kept.push(
      { stopId: 'call-angle', option: 0, correct: true },
      { stopId: 'call-june', option: 0, correct: false },
    );
    await session.load();
    expect(session.getSnapshot()).toMatchObject({
      sparks: 1,
      combo: 0,
      locks: [
        { stopId: 'call-angle', correct: true, combo: 1, keeping: 'saved' },
        { stopId: 'call-june', correct: false, combo: 0, keeping: 'saved' },
      ],
    });
  });

  it('keeps a lock made on the device while the read was on its way', async () => {
    const { session, base } = fixture({ lockCall: vi.fn(() => new Promise(() => undefined)) });
    base.kept.push({ stopId: 'call-angle', option: 0, correct: true });
    session.lock('call-june', 1);
    await session.load();
    expect(session.getSnapshot().locks.map((lock) => lock.stopId)).toEqual(['call-angle', 'call-june']);
  });

  it("leaves the device's own play when the read cannot be made", async () => {
    const { session } = fixture({ readResults: vi.fn(() => Promise.reject(new TypeError('offline'))) });
    session.lock('call-june', 1);
    await session.load();
    expect(session.getSnapshot().sparks).toBe(1);
  });
});

describe('the end of the account scope', () => {
  it('empties the session and sends nothing more', async () => {
    const lockCall = vi.fn((_request: CallLockRequest) => Promise.reject(new TypeError('network')));
    const { session, timers, end } = fixture({ lockCall });
    session.lock('call-june', 1);
    await settled();
    end();
    expect(session.getSnapshot()).toEqual({ locks: [], sparks: 0, combo: 0 });
    timers.advance(60_000);
    await settled();
    expect(lockCall).toHaveBeenCalledTimes(1);
    session.lock('call-angle', 0);
    expect(session.getSnapshot().locks).toEqual([]);
  });

  it('drops an answer that arrives after the scope ended', async () => {
    let answer: (value: CallLockResponse) => void = () => undefined;
    const lockCall = vi.fn(
      (_request: CallLockRequest) => new Promise<CallLockResponse>((resolve) => (answer = resolve)),
    );
    const { session, end } = fixture({ lockCall });
    session.lock('call-june', 1);
    await settled();
    const commandId = lockCall.mock.calls[0]![0].commandId;
    end();
    answer({
      recorded: true,
      commandId,
      assetId,
      revision: 1,
      stopId: 'call-june',
      option: 1,
      correct: true,
      newlyLocked: true,
      results: {
        assetId,
        revision: 1,
        calls: [{ stopId: 'call-june', option: 1, correct: true }],
        sparks: 1,
        combo: 1,
      },
      replayed: false,
    });
    await settled();
    expect(session.getSnapshot().locks).toEqual([]);
  });

  it('treats a request that failed because the scope ended as nothing to retry', async () => {
    const lockCall = vi.fn(() => Promise.reject(new ScopeEndedError()));
    const { session, timers } = fixture({ lockCall });
    session.lock('call-june', 1);
    await settled();
    timers.advance(60_000);
    await settled();
    expect(lockCall).toHaveBeenCalledTimes(1);
  });
});

describe('one session for a Scroll in a scope', () => {
  it('is the same object for the same revision, and another for another', () => {
    const { scope } = fixture();
    const options = { scope, assetId, revision: 1, calls, newId };
    expect(playSessionFor(options)).toBe(playSessionFor(options));
    expect(playSessionFor({ ...options, revision: 2 })).not.toBe(playSessionFor(options));
  });
});
