import { describe, expect, it, vi } from 'vitest';
import type { PersonalRecordingPurpose } from '../../../reasoning/public.js';
import type { RecordingScopeTx } from '../../identity/public.js';
import { makeCheckComposerRecordingRun } from './check-recording-run.js';

const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const UNIVERSE = id(1);
const EXPOSURE = id(40);

/** A Composer proof, with fields overridden: some tests build pairs the type would not allow, to see them refused. */
const purpose = (over: Record<string, unknown> = {}): PersonalRecordingPurpose => ({
  version: 'personal-role-purpose.v1',
  accountId: id(2),
  universeId: UNIVERSE,
  privacyEpoch: 1,
  ownerModule: 'composer',
  purpose: 'jev-assessment',
  businessRunId: id(41),
  recordingGeneration: 3,
  contextSha256: 'a'.repeat(64),
  modelContextSha256: 'a'.repeat(64),
  claimId: EXPOSURE,
  ...over,
});
const scopeAt = (generation: number, universeId = UNIVERSE, privacyEpoch = 1) =>
  ({
    generation,
    personal: {
      authority: { universeId, privacyEpoch, actor: { kind: 'system', purpose: 'composer.prepare-buffer' } },
    },
  }) as unknown as RecordingScopeTx;

const checkWith = (activated: boolean) => {
  const exposureActivated = vi.fn((_scope: unknown, exposureId: string) =>
    Promise.resolve(activated && exposureId === EXPOSURE),
  );
  return { check: makeCheckComposerRecordingRun({ exposureActivated }), exposureActivated };
};

describe('the owner check of the Composer’s recording runs (D-270)', () => {
  it('finds Jev’s run current while the exposure its buffer job was made for is activated', async () => {
    const { check, exposureActivated } = checkWith(true);
    expect(await check(scopeAt(3), purpose())).toBe('current');
    expect(exposureActivated).toHaveBeenCalledWith(expect.anything(), EXPOSURE);
  });

  it('finds it unavailable once the exposure is gone or was never activated, or names another exposure', async () => {
    expect(await checkWith(false).check(scopeAt(3), purpose())).toBe('unavailable');
    expect(await checkWith(true).check(scopeAt(3), purpose({ claimId: id(99) }))).toBe('unavailable');
  });

  it('finds a run unavailable for a step it does not list, another owner’s purpose, another universe, epoch or generation, and asks Experience nothing', async () => {
    const { check, exposureActivated } = checkWith(true);
    expect(await check(scopeAt(3), purpose({ purpose: 'not-a-step' }))).toBe('unavailable');
    expect(await check(scopeAt(3), purpose({ ownerModule: 'supply', purpose: 'ask-scope' }))).toBe('unavailable');
    expect(await check(scopeAt(3, id(9)), purpose())).toBe('unavailable');
    expect(await check(scopeAt(3, UNIVERSE, 2), purpose())).toBe('unavailable');
    expect(await check(scopeAt(5), purpose())).toBe('unavailable');
    expect(await check(scopeAt(3), { ...purpose(), recordingGeneration: 4 })).toBe('unavailable');
    expect(await check(scopeAt(3), { ...purpose(), extra: true } as unknown as PersonalRecordingPurpose)).toBe(
      'unavailable',
    );
    expect(exposureActivated).not.toHaveBeenCalled();
  });
});
