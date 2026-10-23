import { describe, expect, it, vi } from 'vitest';
import type { ReadRecordingPolicy, RecordingPolicyRead, SetRecordingPolicy } from '@knowscroll/contracts';
import type { ApiClient } from './api-client';
import type { ScopedStorage, StorageDurability } from './account-scope';
import { createRecordingPolicySession } from './recording-policy';

const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const account = { accountId: id(1), universeId: id(2), privacyEpoch: 4, email: 'fixture@recording.test' };
function fixture(storage?: ScopedStorage) {
  let next = 10;
  let generation = 1;
  let revision = 0;
  let failSet = false;
  let failRead = false;
  let gate: Promise<void> | undefined;
  let setGate: Promise<void> | undefined;
  let rewrite = (value: RecordingPolicyRead): RecordingPolicyRead => value;
  const commands: SetRecordingPolicy[] = [];
  const reads: ReadRecordingPolicy[] = [];
  const receipts = new Map<
    string,
    {
      commandId: string;
      requestedPrivacyEpoch: number;
      on: boolean;
      fromGeneration: number;
      toGeneration: number;
      changed: boolean;
      recordedAt: string;
    }
  >();
  let end: (() => void) | undefined;
  let active = true;
  const session = createRecordingPolicySession(
    {
      account,
      ...(storage ? { storage } : {}),
      get active() {
        return active;
      },
      onEnd: (listener) => {
        end = listener;
        return () => undefined;
      },
      api: {
        recording: {
          read: async (input: ReadRecordingPolicy) => {
            reads.push(input);
            const base = {
              version: 'recording-policy.v1' as const,
              readId: input.readId,
              target: input.target,
              scope: { accountId: account.accountId, privacyEpoch: account.privacyEpoch },
              revision,
              policy: { generation, on: generation % 2 === 1 },
            };
            const receipt = input.target.kind === 'command' ? receipts.get(input.target.commandId) : undefined;
            const result: RecordingPolicyRead =
              input.target.kind === 'current'
                ? { ...base, target: input.target }
                : receipt
                  ? { ...base, target: input.target, status: 'recorded', receipt }
                  : { ...base, target: input.target, status: 'not_recorded' };
            await gate;
            if (failRead) throw new Error('fixture offline');
            return rewrite(result);
          },
          set: async (input: SetRecordingPolicy) => {
            await Promise.resolve();
            commands.push(input);
            let receipt = receipts.get(input.commandId);
            const replayed = !!receipt;
            if (!receipt) {
              const fromGeneration = generation;
              if (input.on !== (generation % 2 === 1)) {
                generation++;
                revision++;
              }
              receipt = {
                commandId: input.commandId,
                requestedPrivacyEpoch: input.expectedPrivacyEpoch,
                on: input.on,
                fromGeneration,
                toGeneration: generation,
                changed: generation !== fromGeneration,
                recordedAt: '2026-10-23T00:00:00.000Z',
              };
              receipts.set(input.commandId, receipt);
            }
            await setGate;
            if (failSet) throw new Error('fixture lost response');
            return {
              version: 'recording-policy.v1',
              operation: 'privacy.recording-set',
              outcome: 'accepted',
              receipt,
              replayed,
            };
          },
        },
      } as unknown as ApiClient,
    },
    () => id(next++),
  );
  return {
    session,
    commands,
    reads,
    receipts,
    advance: (g: number) => {
      generation = g;
      revision++;
    },
    holdSet: (value?: Promise<void>) => {
      setGate = value;
    },
    setFail: (value: boolean) => {
      failSet = value;
    },
    readFail: (value: boolean) => {
      failRead = value;
    },
    rewrite: (value: typeof rewrite) => {
      rewrite = value;
    },
    gate: (value?: Promise<void>) => {
      gate = value;
    },
    end: () => {
      active = false;
      end?.();
    },
  };
}
describe('current recording authority and immutable historical choices (CI fixtures)', () => {
  it('starts closed; current reads permit odd/on and preserve even/off for necessary commands', async () => {
    const f = fixture();
    expect(f.session.getState().collecting).toBe(false);
    expect(await f.session.generation()).toBe(1);
    expect(f.session.getState().collecting).toBe(true);
    f.advance(2);
    await f.session.refresh();
    expect(await f.session.generation()).toBe(2);
    expect(f.session.getState().collecting).toBe(false);
  });
  it('inhibits before Pause transport, retains the exact body after an unknown result, and rejects opposite intent', async () => {
    const f = fixture();
    await f.session.refresh();
    f.setFail(true);
    const sending = f.session.set(false);
    expect(f.session.getState().collecting).toBe(false);
    await sending;
    expect(f.session.getState().retryOriginal).toBe(true);
    expect(await f.session.set(true)).toBe(false);
    f.advance(5);
    f.setFail(false);
    await f.session.retryOriginal();
    expect(f.commands[1]).toBe(f.commands[0]);
    expect(f.session.getState().receipt?.toGeneration).toBe(2);
    expect(f.session.getState().policy?.generation).toBe(5);
    expect(f.reads.at(-1)?.target).toEqual({ kind: 'current' });
  });
  it('a historical on ACK cannot override a newer paused policy', async () => {
    const f = fixture();
    f.advance(2);
    await f.session.refresh();
    f.setFail(true);
    await f.session.set(true);
    f.advance(4);
    f.setFail(false);
    await f.session.retryOriginal();
    expect(f.session.getState()).toMatchObject({
      collecting: false,
      policy: { on: false, generation: 4 },
      receipt: { on: true, toGeneration: 3 },
    });
  });
  it('not_recorded never abandons an in-flight original choice or enables collection', async () => {
    const f = fixture();
    await f.session.refresh();
    f.setFail(true);
    await f.session.set(false);
    f.receipts.clear();
    await f.session.checkOriginal();
    expect(f.session.getState()).toMatchObject({ status: 'unknown', retryOriginal: true, collecting: false });
    await expect(f.session.generation()).rejects.toThrow();
  });
  it('command receipt recovery requires a separate correlated current read', async () => {
    const f = fixture();
    await f.session.refresh();
    f.setFail(true);
    await f.session.set(false);
    await f.session.checkOriginal();
    expect(f.reads.slice(-2).map((read) => read.target.kind)).toEqual(['command', 'current']);
    expect(f.session.getState()).toMatchObject({ status: 'current', collecting: false, retryOriginal: false });
  });
  it.each(['readId', 'scope', 'revision', 'generation', 'target'] as const)(
    'fails closed on a mismatched %s reply',
    async (field) => {
      const f = fixture();
      await f.session.refresh();
      f.rewrite(
        (answer) =>
          ({
            ...answer,
            ...(field === 'readId' ? { readId: id(999) } : {}),
            ...(field === 'scope' ? { scope: { ...answer.scope, privacyEpoch: 3 } } : {}),
            ...(field === 'revision' ? { revision: -1 } : {}),
            ...(field === 'generation' ? { policy: { on: false, generation: 1 } } : {}),
            ...(field === 'target' ? { target: { kind: 'command', commandId: id(99) }, status: 'not_recorded' } : {}),
          }) as RecordingPolicyRead,
      );
      expect(await f.session.refresh()).toBe(false);
      expect(f.session.getState().collecting).toBe(false);
    },
  );
  it('a slower old read cannot overwrite a later current snapshot', async () => {
    const f = fixture();
    let release!: () => void;
    f.gate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const old = f.session.refresh();
    f.gate();
    f.advance(2);
    await f.session.refresh();
    release();
    await old;
    expect(f.session.getState()).toMatchObject({ status: 'current', policy: { generation: 2 }, collecting: false });
  });
  it('background invalidation, failed refresh and scope end synchronously fence collection and late replies', async () => {
    const f = fixture();
    await f.session.refresh();
    f.session.invalidate();
    expect(f.session.getState().collecting).toBe(false);
    f.readFail(true);
    await f.session.refresh();
    expect(f.session.getState().collecting).toBe(false);
    f.readFail(false);
    let release!: () => void;
    f.gate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const read = f.session.refresh();
    f.end();
    release();
    await read;
    expect(f.session.getState()).toEqual({ status: 'ended', collecting: false, retryOriginal: false });
  });
  it('no-op acceptance keeps the generation; exhaustion is never wrapped or inferred', async () => {
    const f = fixture();
    f.advance(2147483647);
    await f.session.refresh();
    await f.session.set(true);
    expect(f.commands[0]?.expectedRecordingGeneration).toBe(2147483647);
    expect(f.session.getState().receipt).toMatchObject({ changed: false, toGeneration: 2147483647 });
  });
});

it('restores only the exact unresolved command after reload, never an authority snapshot or automatic send (CI storage fixture)', async () => {
  const values = new Map<string, string>();
  const storage = {
    get: (key: string) => values.get(key),
    set: (key: string, value: string) => {
      values.set(key, value);
    },
    remove: (key: string) => {
      values.delete(key);
    },
  };
  const command: SetRecordingPolicy = {
    version: 'recording-policy.v1',
    commandId: id(90),
    expectedPrivacyEpoch: 4,
    expectedRecordingGeneration: 1,
    on: false,
  };
  storage.set('recording.policy.pending.v1', JSON.stringify(command));
  let sends = 0;
  let next = 100;
  const api = {
    recording: {
      read: (input: ReadRecordingPolicy) =>
        Promise.resolve({
          ...input,
          scope: { accountId: account.accountId, privacyEpoch: 4 },
          revision: 0,
          policy: { on: true, generation: 1 },
        }),
      set: (input: SetRecordingPolicy) => {
        sends++;
        expect(input).toEqual(command);
        return Promise.reject(new Error('fixture still unknown'));
      },
    },
  } as unknown as ApiClient;
  const restored = createRecordingPolicySession({ api, account, active: true, storage }, () => id(next++));
  expect(restored.getState()).toMatchObject({ retryOriginal: true, collecting: false });
  await restored.refresh();
  expect(sends).toBe(0);
  expect(await restored.set(true)).toBe(false);
  await restored.retryOriginal();
  expect(sends).toBe(1);
  expect(JSON.parse(storage.get('recording.policy.pending.v1')!)).toEqual(command);
  storage.set('recording.policy.pending.v1', 'corrupt unknown command');
  const corrupt = createRecordingPolicySession({ api, account, active: true, storage }, () => id(next++));
  expect(await corrupt.refresh()).toBe(false);
  expect(corrupt.getState().collecting).toBe(false);
  await expect(corrupt.generation()).rejects.toThrow();
});

it('holds background inhibition through a Resume ACK and later current reads until foreground plus fresh read (CI fixture)', async () => {
  const f = fixture();
  f.advance(2);
  await f.session.refresh();
  let releaseAck!: () => void;
  f.holdSet(
    new Promise<void>((resolve) => {
      releaseAck = resolve;
    }),
  );
  const resume = f.session.set(true);
  await Promise.resolve();
  await f.session.setForeground(false);
  releaseAck();
  await resume;
  expect(f.session.getState()).toMatchObject({ policy: { on: true, generation: 3 }, collecting: false });
  const backgroundReads = f.reads.length;
  await f.session.refresh();
  expect(f.reads).toHaveLength(backgroundReads + 1);
  expect(f.session.getState().collecting).toBe(false);
  // A genuine foreground transition still cannot reuse that background snapshot.
  let releaseRead!: () => void;
  f.gate(
    new Promise<void>((resolve) => {
      releaseRead = resolve;
    }),
  );
  const foreground = f.session.setForeground(true);
  expect(f.session.getState().collecting).toBe(false);
  expect(f.reads.at(-1)?.target).toEqual({ kind: 'current' });
  releaseRead();
  await foreground;
  expect(f.session.getState()).toMatchObject({ policy: { generation: 3 }, collecting: true });
});

/** Commit acknowledgements are controlled here; these fixtures do not establish native persistence. */
function commitStorage() {
  const mirror = new Map<string, string>();
  const disk = new Map<string, string>();
  const listeners = new Set<() => void>();
  let gate: Promise<void> | undefined;
  let failed = false;
  const commits: Readonly<Record<string, string | undefined>>[] = [];
  const durability: StorageDurability = {
    async flush(expected) {
      commits.push(expected);
      const snapshot = new Map(mirror);
      await gate;
      if (failed) return false;
      disk.clear();
      for (const [key, value] of snapshot) disk.set(key, value);
      return Object.entries(expected).every(([key, value]) => disk.get(key) === value && mirror.get(key) === value);
    },
    group: (work) => work(),
    healthy: () => !failed,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    fence() {
      failed = true;
      for (const listener of listeners) listener();
    },
    purge: () => Promise.resolve(),
  };
  const storage: ScopedStorage = {
    durability,
    get: (key) => mirror.get(key),
    set: (key, value) => {
      mirror.set(key, value);
    },
    remove: (key) => {
      mirror.delete(key);
    },
  };
  return {
    storage,
    disk,
    mirror,
    commits,
    hold(value?: Promise<void>) {
      gate = value;
    },
    fail() {
      durability.fence();
    },
  };
}

it('native policy choices wait for exact-body commit before transport and committed removal before the fresh read (CI port fixture)', async () => {
  const s = commitStorage();
  const f = fixture(s.storage);
  await f.session.refresh();
  let releaseCommit!: () => void;
  s.hold(
    new Promise<void>((resolve) => {
      releaseCommit = resolve;
    }),
  );
  const pause = f.session.set(false);
  await vi.waitFor(() => expect(s.commits).toHaveLength(1));
  expect(f.commands).toEqual([]);
  expect(f.session.getState()).toMatchObject({ collecting: false, retryOriginal: true });
  const original = s.mirror.get('recording.policy.pending.v1')!;
  let releaseAck!: () => void;
  f.holdSet(
    new Promise<void>((resolve) => {
      releaseAck = resolve;
    }),
  );
  releaseCommit();
  await vi.waitFor(() => expect(f.commands).toHaveLength(1));
  expect(s.disk.get('recording.policy.pending.v1')).toBe(original);
  expect(f.commands[0]).toEqual(JSON.parse(original));
  let releaseRemoval!: () => void;
  s.hold(
    new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    }),
  );
  releaseAck();
  await vi.waitFor(() => expect(s.commits).toHaveLength(2));
  expect(s.commits[1]).toEqual({ 'recording.policy.pending.v1': undefined });
  expect(f.reads).toHaveLength(1);
  expect(f.session.getState().retryOriginal).toBe(true);
  releaseRemoval();
  expect(await pause).toBe(true);
  expect(s.disk.has('recording.policy.pending.v1')).toBe(false);
  expect(f.reads.at(-1)?.target).toEqual({ kind: 'current' });
  expect(f.session.getState()).toMatchObject({ retryOriginal: false, collecting: false, policy: { generation: 2 } });
});

it('native commit failure sends nothing and retains the unresolved original without granting collection (CI port fixture)', async () => {
  const s = commitStorage();
  const f = fixture(s.storage);
  await f.session.refresh();
  let release!: () => void;
  s.hold(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const pause = f.session.set(false);
  await vi.waitFor(() => expect(s.commits).toHaveLength(1));
  s.fail();
  release();
  expect(await pause).toBe(false);
  expect(f.commands).toEqual([]);
  expect(f.session.getState()).toMatchObject({ status: 'unknown', retryOriginal: true, collecting: false });
  expect(await f.session.set(true)).toBe(false);
  expect(await f.session.refresh()).toBe(false);
  await expect(f.session.generation()).rejects.toThrow();
});

it('an accepted native choice with unconfirmed removal stays inhibited and preserves the exact durable retry body (CI port fixture)', async () => {
  const s = commitStorage();
  const f = fixture(s.storage);
  await f.session.refresh();
  let releaseAck!: () => void;
  f.holdSet(
    new Promise<void>((resolve) => {
      releaseAck = resolve;
    }),
  );
  const pause = f.session.set(false);
  await vi.waitFor(() => expect(f.commands).toHaveLength(1));
  const original = s.disk.get('recording.policy.pending.v1');
  s.fail();
  releaseAck();
  expect(await pause).toBe(false);
  expect(s.disk.get('recording.policy.pending.v1')).toBe(original);
  expect(s.mirror.get('recording.policy.pending.v1')).toBe(original);
  expect(f.reads).toHaveLength(1);
  expect(f.session.getState()).toMatchObject({ retryOriginal: true, collecting: false, status: 'unknown' });
  expect(await f.session.set(true)).toBe(false);
  const restartedStorage = { ...s.storage, durability: undefined, get: (key: string) => s.disk.get(key) };
  const restarted = fixture(restartedStorage).session;
  expect(restarted.getState()).toMatchObject({ status: 'unknown', retryOriginal: true, collecting: false });
});
