import { describe, expect, it } from 'vitest';
import type { PersonalRecordingPurpose } from '../../../reasoning/public.js';
import type { PersonalScopeTx, RecordingScopeTx } from '../../identity/public.js';
import { makeCheckRoomsRecordingRun } from './check-recording-run.js';
import type { AiTurnRow } from './ports.js';

const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const UNIVERSE = id(1);
const ACCOUNT = id(2);
const TURN = id(40);

/** A Rooms proof, with fields overridden: some tests build pairs the type would not allow, to see them refused. */
const purpose = (over: Record<string, unknown> = {}): PersonalRecordingPurpose => ({
  version: 'personal-role-purpose.v1',
  accountId: ACCOUNT,
  universeId: UNIVERSE,
  privacyEpoch: 1,
  ownerModule: 'rooms',
  purpose: 'inhabitant-contribution',
  businessRunId: TURN,
  recordingGeneration: 3,
  contextSha256: 'a'.repeat(64),
  modelContextSha256: 'a'.repeat(64),
  claimId: TURN,
  ...over,
});
const scopeAt = (generation: number, universeId = UNIVERSE, privacyEpoch = 1) =>
  ({
    generation,
    personal: { authority: { universeId, privacyEpoch, actor: { kind: 'system', purpose: 'rooms.contribute' } } },
  }) as unknown as RecordingScopeTx;

const turn = (over: Partial<AiTurnRow> = {}): AiTurnRow =>
  ({ turnId: TURN, state: 'queued', requestedByAccountId: ACCOUNT, ...over }) as unknown as AiTurnRow;

const checkWith = (row: AiTurnRow | undefined) =>
  makeCheckRoomsRecordingRun({
    ai: { forJob: (_scope: PersonalScopeTx, key: string) => Promise.resolve(key === TURN ? row : undefined) },
  });

describe('the owner check of Rooms’ recording runs (D-270)', () => {
  it('finds an inhabitant’s answer current while the asker’s ask is still queued', async () => {
    expect(await checkWith(turn())(scopeAt(3), purpose())).toBe('current');
  });

  it('finds it unavailable once the ask is settled, gone, or was asked by someone else', async () => {
    for (const state of ['completed', 'declined', 'failed'] as const)
      expect(await checkWith(turn({ state }))(scopeAt(3), purpose())).toBe('unavailable');
    expect(await checkWith(undefined)(scopeAt(3), purpose())).toBe('unavailable');
    expect(await checkWith(turn({ requestedByAccountId: id(9) }))(scopeAt(3), purpose())).toBe('unavailable');
    expect(await checkWith(turn({ requestedByAccountId: null }))(scopeAt(3), purpose())).toBe('unavailable');
  });

  it('finds a run unavailable for a step it does not list, another owner’s purpose, another universe, epoch or generation', async () => {
    const check = checkWith(turn());
    expect(await check(scopeAt(3), purpose({ purpose: 'not-a-step' }))).toBe('unavailable');
    expect(await check(scopeAt(3), purpose({ ownerModule: 'supply', purpose: 'ask-scope' }))).toBe('unavailable');
    expect(await check(scopeAt(3, id(9)), purpose())).toBe('unavailable');
    expect(await check(scopeAt(3, UNIVERSE, 2), purpose())).toBe('unavailable');
    expect(await check(scopeAt(5), purpose())).toBe('unavailable');
    expect(await check(scopeAt(3), { ...purpose(), recordingGeneration: 4 })).toBe('unavailable');
    expect(await check(scopeAt(3), { ...purpose(), extra: true } as unknown as PersonalRecordingPurpose)).toBe(
      'unavailable',
    );
  });
});
