import { describe, expect, it } from 'vitest';
import type { CallLockRequest } from '@knowscroll/contracts';
import type { ScrollCallFacts, ScrollPlayFacts } from '../../content/public.js';
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
import type {
  NewCall,
  NewLandmark,
  PlayPorts,
  ReceiptKey,
  ReceiptLookup,
  StoredCall,
  StoredLandmark,
} from './ports.js';

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
const callFacts = (
  stopId: string,
  kind: ScrollCallFacts['kind'],
  optionCount: number,
  answer: number,
): ScrollCallFacts => ({
  stopId,
  kind,
  optionCount,
  prompt: `CI question ${stopId}`,
  options: Array.from({ length: optionCount }, (_unused, index) => `CI option ${String(index)}`),
  answer,
  explain: 'CI explanation.',
  twist: 'CI twist.',
  commonGuess: undefined,
});
const calls: readonly ScrollCallFacts[] = [
  callFacts('call-one', 'call_it', 3, 1),
  callFacts('call-two', 'call_it', 2, 0),
  callFacts('final', 'final_call', 3, 2),
];

const landmarkNamed = { key: 'the-ci-landmark', name: 'The CI Landmark' };

interface Options {
  readonly recording?: 'on' | 'paused' | 'stale';
  readonly exposure?: boolean;
  /** What the revision reads as; `undefined` is a revision that is not there. Default: the three calls and no landmark. */
  readonly revisionFacts?: ScrollPlayFacts | undefined;
  readonly lookup?: ReceiptLookup;
}

/** Ports over memory: reads answer what the test says and every write is logged. */
function fixture(options: Options = {}) {
  const stored = new Map<string, StoredCall>();
  let landmark: StoredLandmark | undefined;
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
    readFacts: () =>
      Promise.resolve('revisionFacts' in options ? options.revisionFacts : { calls, landmark: undefined }),
    readTopics: () => Promise.resolve([]),
    store: {
      readPlay: () => Promise.resolve({ calls: order.map((stopId) => stored.get(stopId)!), tally, landmark }),
      insertLandmark: (_scope, awarded: NewLandmark) => {
        writes.push('landmark');
        landmark = { key: awarded.key, name: awarded.name, tier: awarded.tier };
        return Promise.resolve();
      },
      listLandmarks: () => Promise.resolve([]),
      readPlayDays: () => Promise.resolve({ today: '2026-11-02', playedDays: [] }),
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

  it('refuses a stop that is not a call of that revision, and a revision that is not there', async () => {
    const play = fixture();
    expect(await play.lock(authority, lockRequest({ stopId: 'not-a-stop' }))).toEqual({
      kind: 'refused',
      reason: 'call_not_found',
    });
    expect(await fixture({ revisionFacts: undefined }).lock(authority, lockRequest())).toEqual({
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

describe('locking the Final call (D-187, D-188)', () => {
  const lockFinal = (option: number, over: Partial<CallLockRequest> = {}) =>
    lockRequest({ commandId: id(200), stopId: 'final', option, ...over });
  const withLandmark = { revisionFacts: { calls, landmark: landmarkNamed } };

  /** Locks both Call its right, so a combo of two is waiting for the Final call. */
  async function withComboWaiting(play: ReturnType<typeof fixture>) {
    await play.lock(authority, lockRequest());
    await play.lock(authority, lockRequest({ commandId: id(101), stopId: 'call-two', option: 0 }));
  }

  it('judges it on the server like any call, and a right one earns a spark', async () => {
    const play = fixture();
    expect(await play.lock(authority, lockFinal(2))).toMatchObject({
      kind: 'saved',
      outcome: { stopId: 'final', correct: true, newlyLocked: true, results: { sparks: 1, combo: 1 } },
    });
    const wrong = fixture();
    expect(await wrong.lock(authority, lockFinal(0))).toMatchObject({
      kind: 'saved',
      outcome: { correct: false, results: { sparks: 0, combo: 0 } },
    });
  });

  it('earns two sparks when it is right after a combo of two, and one when the combo was broken', async () => {
    const comboed = fixture();
    await withComboWaiting(comboed);
    expect(await comboed.lock(authority, lockFinal(2))).toMatchObject({
      outcome: { correct: true, results: { sparks: 4, combo: 3 } },
    });
    const broken = fixture();
    await broken.lock(authority, lockRequest());
    await broken.lock(authority, lockRequest({ commandId: id(101), stopId: 'call-two', option: 1 }));
    expect(await broken.lock(authority, lockFinal(2))).toMatchObject({
      outcome: { correct: true, results: { sparks: 2, combo: 1 } },
    });
  });

  it('awards a gold landmark for a right answer, in the same step as the call', async () => {
    const play = fixture(withLandmark);
    const answer = await play.lock(authority, lockFinal(2));
    expect(answer).toMatchObject({
      kind: 'saved',
      outcome: { results: { landmark: { ...landmarkNamed, tier: 'gold' } } },
    });
    expect(play.writes).toEqual(['receipt', 'call', 'landmark']);
  });

  it('awards a plain landmark for a wrong answer: the Final call never costs the landmark', async () => {
    const play = fixture(withLandmark);
    expect(await play.lock(authority, lockFinal(1))).toMatchObject({
      outcome: { correct: false, results: { landmark: { ...landmarkNamed, tier: 'plain' } } },
    });
  });

  it('awards nothing when the Scroll names no landmark, and never for a Call it', async () => {
    const none = fixture();
    const answer = await none.lock(authority, lockFinal(2));
    expect(answer).toMatchObject({ kind: 'saved' });
    expect(answer.kind === 'saved' ? answer.outcome.results.landmark : 'unexpected').toBeUndefined();
    expect(none.writes).not.toContain('landmark');
    const named = fixture(withLandmark);
    await named.lock(authority, lockRequest());
    expect(named.writes).not.toContain('landmark');
  });

  it('awards once: a retry answers the same landmark, and another command locking again changes nothing', async () => {
    const play = fixture(withLandmark);
    await play.lock(authority, lockFinal(2));
    const retry = await play.lock(authority, lockFinal(2));
    expect(retry).toMatchObject({ outcome: { replayed: true, results: { landmark: { tier: 'gold' } } } });
    const again = await play.lock(authority, lockFinal(0, { commandId: id(201) }));
    expect(again).toMatchObject({
      outcome: { newlyLocked: false, correct: true, results: { landmark: { tier: 'gold' } } },
    });
    expect(play.writes.filter((write) => write === 'landmark')).toHaveLength(1);
  });

  it('awards nothing without an activated exposure, and nothing while recording is paused', async () => {
    const unexposed = fixture({ ...withLandmark, exposure: false });
    expect(await unexposed.lock(authority, lockFinal(2))).toEqual({ kind: 'refused', reason: 'exposure_required' });
    expect(unexposed.writes).toEqual([]);
    const paused = fixture({ ...withLandmark, recording: 'paused' });
    expect(await paused.lock(authority, lockFinal(2))).toMatchObject({ kind: 'not_saved' });
    expect(paused.writes).toEqual([]);
  });

  it('refuses a forged option of the Final call, and awards nothing', async () => {
    const play = fixture(withLandmark);
    expect(await play.lock(authority, lockFinal(3))).toEqual({ kind: 'refused', reason: 'option_invalid' });
    expect(play.writes).toEqual([]);
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
