import { describe, expect, it } from 'vitest';
import type { ContentThreadRef, ThreadCall } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { createThreadCalls } from './thread-calls';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const thread: ContentThreadRef = { threadId: id(1), membershipId: id(2), membershipRevision: 1 };
const offline = () => new TypeError('network');

const open: ThreadCall = {
  stage: 'open',
  part: 2,
  assetId: id(40),
  assetRevision: 1,
  prompt: 'When are tides biggest?',
  options: ['Full and new moon', 'Half moon', 'Always the same'],
  called: 1,
  of: 3,
};

/**
 * A server of one thread's calls, as far as the client needs: it keeps the caller's own pick and answers the
 * stage that follows. `recording` is what the device last read of the person's recording policy.
 */
function fakeServer(options: { recording?: 'collecting' | 'paused' | 'unknown' } = {}) {
  const requests: { name: string; input: Record<string, unknown> }[] = [];
  const state: { pick?: number; stale: number; failNext: Error[] } = { stale: 0, failNext: [] };
  const recording = { mode: options.recording ?? 'collecting', serverPaused: false, refreshed: 0 };
  const threads = {
    calls: (input: Record<string, unknown>) => {
      requests.push({ name: 'calls', input });
      const failure = state.failNext.shift();
      if (failure !== undefined) return Promise.reject(failure);
      const call: ThreadCall =
        state.pick === undefined ? open : { ...open, stage: 'locked', option: state.pick, called: open.called + 1 };
      return Promise.resolve({ status: 'ready', thread, calls: [call] });
    },
    lockCall: (input: Record<string, unknown>) => {
      requests.push({ name: 'lockCall', input });
      const failure = state.failNext.shift();
      if (failure !== undefined) return Promise.reject(failure);
      if (state.stale > 0) {
        state.stale -= 1;
        return Promise.resolve({ recorded: false, reason: 'recording_generation_stale', currentGeneration: 3 });
      }
      if (recording.mode === 'paused' || recording.serverPaused)
        return Promise.resolve({ recorded: false, reason: 'recording_paused', currentGeneration: 2 });
      state.pick ??= input['option'] as number;
      return Promise.resolve({ recorded: true, result: 'locked' });
    },
  };
  const ended: (() => void)[] = [];
  const scope = {
    active: true,
    api: { threads },
    onEnd: (listener: () => void) => {
      ended.push(listener);
      return () => undefined;
    },
    get recording() {
      return recording.mode === 'unknown'
        ? undefined
        : {
            getState: () => ({
              collecting: recording.mode === 'collecting',
              policy: { on: recording.mode === 'collecting', generation: 1 },
            }),
            generation: () => Promise.resolve(recording.mode === 'collecting' ? 1 : 2),
            refresh: () => {
              recording.refreshed += 1;
              return Promise.resolve(true);
            },
          };
    },
  } as unknown as AccountScope;
  const end = () => {
    (scope as { active: boolean }).active = false;
    for (const listener of ended) listener();
  };
  return { scope, requests, state, recording, end, sent: () => requests.filter((call) => call.name === 'lockCall') };
}

let counter = 1000;
const newId = () => id(counter++);

describe('a thread’s calls on the client', () => {
  it('reads the calls this person may see', async () => {
    const server = fakeServer();
    const controller = createThreadCalls({ scope: server.scope, thread, newId });
    expect(controller.getState().phase).toBe('loading');
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'ready', calls: [{ stage: 'open', part: 2 }] });
  });

  it('locks a pick with the part, the option and the recording generation, and nothing else', async () => {
    const server = fakeServer();
    const controller = createThreadCalls({ scope: server.scope, thread, newId });
    await controller.lock(2, 1);
    const [sent] = server.sent();
    expect(Object.keys(sent!.input).toSorted()).toEqual(['option', 'part', 'recordingGeneration', 'thread', 'version']);
    expect(sent!.input).toMatchObject({ part: 2, option: 1, recordingGeneration: 1 });
    // The calls are read again after the answer, so the card shows what the server holds.
    expect(controller.getState()).toMatchObject({ locking: undefined, calls: [{ stage: 'locked', option: 1 }] });
  });

  it('sends nothing while recording is paused, and says so', async () => {
    const server = fakeServer({ recording: 'paused' });
    const controller = createThreadCalls({ scope: server.scope, thread, newId });
    await controller.lock(2, 0);
    expect(server.sent()).toEqual([]);
    expect(controller.getState().notice).toEqual({ part: 2, reason: 'paused' });
  });

  it('says so when the server found recording paused though the device had not heard yet', async () => {
    const server = fakeServer();
    const controller = createThreadCalls({ scope: server.scope, thread, newId });
    server.recording.serverPaused = true;
    await controller.lock(2, 0);
    expect(server.sent()).toHaveLength(1);
    expect(controller.getState().notice).toEqual({ part: 2, reason: 'paused' });
    expect(controller.getState().calls[0]).toMatchObject({ stage: 'open' });
  });

  it('reads the policy again and sends the same pick once when the generation was stale', async () => {
    const server = fakeServer();
    server.state.stale = 1;
    const controller = createThreadCalls({ scope: server.scope, thread, newId });
    await controller.lock(2, 2);
    expect(server.sent().map((call) => call.input['option'])).toEqual([2, 2]);
    expect(server.recording.refreshed).toBe(1);
    expect(controller.getState()).toMatchObject({ notice: undefined, calls: [{ stage: 'locked', option: 2 }] });
  });

  it('may be pressed again after a lost answer: the first lock stands on the server', async () => {
    const server = fakeServer();
    const controller = createThreadCalls({ scope: server.scope, thread, newId });
    server.state.failNext.push(offline());
    await controller.lock(2, 1);
    expect(controller.getState()).toMatchObject({ locking: undefined, notice: { part: 2, reason: 'failed' } });
    await controller.lock(2, 1);
    expect(controller.getState()).toMatchObject({ notice: undefined, calls: [{ stage: 'locked', option: 1 }] });
  });

  it('ignores a second press while one lock is on its way', async () => {
    const server = fakeServer();
    const controller = createThreadCalls({ scope: server.scope, thread, newId });
    await Promise.all([controller.lock(2, 1), controller.lock(2, 2)]);
    expect(server.sent()).toHaveLength(1);
  });

  it('keeps what it showed when a later read fails, and says failed only when it never had anything', async () => {
    const server = fakeServer();
    const controller = createThreadCalls({ scope: server.scope, thread, newId });
    server.state.failNext.push(offline());
    await controller.load();
    expect(controller.getState().phase).toBe('failed');
    await controller.load();
    expect(controller.getState().phase).toBe('ready');
    server.state.failNext.push(offline());
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'ready', calls: [{ stage: 'open' }] });
  });

  it('drops what it read, including other members’ picks, when the account scope ends, and shows nothing after', async () => {
    const server = fakeServer();
    const controller = createThreadCalls({ scope: server.scope, thread, newId });
    await controller.load();
    let heard = 0;
    controller.subscribe(() => (heard += 1));
    server.end();
    expect(controller.getState()).toMatchObject({ phase: 'loading', calls: [] });
    await controller.load();
    await controller.lock(2, 0);
    expect(controller.getState()).toMatchObject({ phase: 'loading', calls: [] });
    expect(heard).toBe(0);
  });
});
