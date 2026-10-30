import { describe, expect, it } from 'vitest';
import type { CallLockRequest } from '@knowscroll/contracts';
import type { ScrollCallFacts } from '../../content/public.js';
import type {
  FencePersonalRecording,
  PersonalAuthority,
  PersonalScopeTx,
  RecordingScopeTx,
  WithPersonalScope,
} from '../../identity/public.js';
import { NO_PLAY, type Tally } from '../domain/results.js';
import { makeLockCall } from './lock-call.js';
import { makeReadResults } from './read-results.js';
import type { NewCall, PlayPorts, ReceiptKey, ReceiptLookup, StoredCall } from './ports.js';

const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const authority: PersonalAuthority = {
  universeId: id(1),
  privacyEpoch: 1,
  actor: { kind: 'account', accountId: id(2) },
};
const scope = { authority } as unknown as PersonalScopeTx;
const recordingScope = { personal: scope, generation: 1 } as unknown as RecordingScopeTx;
const assetId = id(10);

/** The calls of a labelled CI Scroll: two Call its (answers 1 and 0), and a Final call. */
const calls: readonly ScrollCallFacts[] = [
  { stopId: 'call-one', kind: 'call_it', optionCount: 3, answer: 1 },
  { stopId: 'call-two', kind: 'call_it', optionCount: 2, answer: 0 },
  { stopId: 'final', kind: 'final_call', optionCount: 3, answer: 2 },
];

interface Options {
  readonly recording?: 'on' | 'paused' | 'stale';
  readonly exposure?: boolean;
  readonly revisionCalls?: readonly ScrollCallFacts[] | undefined;
  readonly lookup?: ReceiptLookup;
}

/** Ports over memory: reads answer what the test says and every write is logged. */
function fixture(options: Options = {}) {
  const stored = new Map<string, StoredCall>();
  let tally: Tally = NO_PLAY;
  const order: string[] = [];
  const receipts = new Map<string, { key: ReceiptKey; outcome?: Record<string, unknown> }>();
  const writes: string[] = [];
  const fenceRecording: FencePersonalRecording = (_scope, generation) => {
    if (options.recording === 'paused') return Promise.resolve({ kind: 'paused', currentGeneration: generation ?? 1 });
    if (options.recording === 'stale') return Promise.resolve({ kind: 'stale', currentGeneration: 7 });
    return Promise.resolve({ kind: 'recording', scope: recordingScope });
  };
  const withPersonalScope: WithPersonalScope = (_authority, work) =>
    work(scope).then((value) => ({ kind: 'entered', value }));
  const ports: PlayPorts = {
    withPersonalScope,
    fenceOwn: () =>
      Promise.resolve({ kind: 'active', owner: { accountId: id(2), universeId: id(1), privacyEpoch: 1 } }),
    fenceRecording,
    hash: (operation, request) => `${operation}:${JSON.stringify(request)}`,
    findReceipt: (_scope, key) => {
      if (options.lookup) return Promise.resolve(options.lookup);
      const earlier = receipts.get(key.commandId);
      if (earlier === undefined) return Promise.resolve({ kind: 'new' });
      return Promise.resolve(
        earlier.key.requestHash === key.requestHash
          ? { kind: 'replay', outcome: earlier.outcome }
          : { kind: 'key_reused' },
      );
    },
    insertReceipt: (_scope, key) => {
      writes.push('receipt');
      receipts.set(key.commandId, { key });
      return Promise.resolve();
    },
    completeReceipt: (_scope, commandId, outcome) => {
      receipts.get(commandId)!.outcome = { ...outcome };
      return Promise.resolve();
    },
    hasActivatedExposure: () => Promise.resolve(options.exposure ?? true),
    readCalls: () => Promise.resolve('revisionCalls' in options ? options.revisionCalls : calls),
    store: {
      readPlay: () => Promise.resolve({ calls: order.map((stopId) => stored.get(stopId)!), tally }),
      insertCall: (_scope, call: NewCall, next) => {
        writes.push('call');
        order.push(call.stopId);
        stored.set(call.stopId, { stopId: call.stopId, option: call.option, correct: call.correct });
        tally = next;
        return Promise.resolve();
      },
    },
  };
  return { ports, writes, lock: makeLockCall(ports), read: makeReadResults(ports) };
}

const lockRequest = (over: Partial<CallLockRequest> = {}): CallLockRequest => ({
  commandId: id(100),
  assetId,
  revision: 1,
  stopId: 'call-one',
  option: 1,
  recordingGeneration: 1,
  ...over,
});

describe('locking a call', () => {
  it('recomputes correctness itself, and earns a spark for a right pick', async () => {
    const play = fixture();
    const right = await play.lock(authority, lockRequest());
    expect(right).toMatchObject({
      kind: 'saved',
      outcome: { correct: true, option: 1, newlyLocked: true, replayed: false, results: { sparks: 1, combo: 1 } },
    });
    const wrong = await play.lock(authority, lockRequest({ commandId: id(101), stopId: 'call-two', option: 1 }));
    expect(wrong).toMatchObject({
      kind: 'saved',
      outcome: {
        correct: false,
        results: { sparks: 1, combo: 0, calls: [{ stopId: 'call-one' }, { stopId: 'call-two' }] },
      },
    });
  });

  it('answers an identical retry from the receipt and changes nothing', async () => {
    const play = fixture();
    await play.lock(authority, lockRequest());
    const writesBefore = play.writes.length;
    const retried = await play.lock(authority, lockRequest());
    expect(retried).toMatchObject({ kind: 'saved', outcome: { replayed: true, newlyLocked: true, correct: true } });
    expect(play.writes).toHaveLength(writesBefore);
  });

  it('refuses the same command ID for another request', async () => {
    const play = fixture();
    await play.lock(authority, lockRequest());
    expect(await play.lock(authority, lockRequest({ option: 0 }))).toEqual({
      kind: 'refused',
      reason: 'command_key_reused',
    });
  });

  it('lets the first lock of a call stand when another command locks it again', async () => {
    const play = fixture();
    await play.lock(authority, lockRequest());
    const again = await play.lock(authority, lockRequest({ commandId: id(102), option: 0 }));
    expect(again).toMatchObject({
      kind: 'saved',
      outcome: { option: 1, correct: true, newlyLocked: false, results: { sparks: 1, combo: 1 } },
    });
    expect(play.writes.filter((write) => write === 'call')).toHaveLength(1);
  });

  it('refuses a forged option, and stores nothing', async () => {
    const play = fixture();
    expect(await play.lock(authority, lockRequest({ option: 2, stopId: 'call-two' }))).toEqual({
      kind: 'refused',
      reason: 'option_invalid',
    });
    expect(play.writes).toEqual([]);
  });

  it('refuses a stop that is not a Call it of that revision, the Final call included', async () => {
    const play = fixture();
    for (const stopId of ['not-a-stop', 'final'])
      expect(await play.lock(authority, lockRequest({ stopId }))).toEqual({
        kind: 'refused',
        reason: 'call_not_found',
      });
    expect(await fixture({ revisionCalls: undefined }).lock(authority, lockRequest())).toEqual({
      kind: 'refused',
      reason: 'call_not_found',
    });
    expect(play.writes).toEqual([]);
  });

  it('refuses a revision the person has no activated exposure to', async () => {
    const play = fixture({ exposure: false });
    expect(await play.lock(authority, lockRequest())).toEqual({ kind: 'refused', reason: 'exposure_required' });
    expect(play.writes).toEqual([]);
  });

  it('stores nothing and says so while recording is paused, or the policy moved on', async () => {
    const paused = fixture({ recording: 'paused' });
    expect(await paused.lock(authority, lockRequest())).toEqual({
      kind: 'not_saved',
      outcome: { recorded: false, reason: 'recording_paused', currentGeneration: 1 },
    });
    expect(paused.writes).toEqual([]);
    const stale = fixture({ recording: 'stale' });
    expect(await stale.lock(authority, lockRequest())).toEqual({
      kind: 'not_saved',
      outcome: { recorded: false, reason: 'recording_generation_stale', currentGeneration: 7 },
    });
    expect(stale.writes).toEqual([]);
  });

  it('treats a receipt from another epoch, or a newer release, as a refusal rather than applying it again', async () => {
    expect(await fixture({ lookup: { kind: 'epoch_mismatch' } }).lock(authority, lockRequest())).toEqual({
      kind: 'refused',
      reason: 'command_key_reused',
    });
    expect(await fixture({ lookup: { kind: 'outcome_version_newer' } }).lock(authority, lockRequest())).toEqual({
      kind: 'refused',
      reason: 'outcome_from_newer_release',
    });
  });
});

describe('reading results', () => {
  it('reads nothing locked as zeroes, and what was locked in the order it was', async () => {
    const play = fixture();
    expect(await play.read(authority, { assetId, revision: 1 })).toEqual({
      kind: 'results',
      results: { assetId, revision: 1, calls: [], sparks: 0, combo: 0 },
    });
    await play.lock(authority, lockRequest());
    await play.lock(authority, lockRequest({ commandId: id(101), stopId: 'call-two', option: 0 }));
    expect(await play.read(authority, { assetId, revision: 1 })).toEqual({
      kind: 'results',
      results: {
        assetId,
        revision: 1,
        calls: [
          { stopId: 'call-one', option: 1, correct: true },
          { stopId: 'call-two', option: 0, correct: true },
        ],
        sparks: 2,
        combo: 2,
      },
    });
  });
});
