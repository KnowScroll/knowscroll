import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PersonalAuthority, PersonalScopeTx, RecordingScopeTx } from '../../modules/identity/public.js';
import type { RecordingReasoningHarness } from './personal-recording.js';
import type { ProposeOutcome } from './propose.js';
import {
  applyClosingRun,
  closeStartedRun,
  closeStartedRunAlone,
  proposeAtGeneration,
  proposeWhenRecording,
  purposeOf,
  runToClose,
  startRunOwner,
  type RunOwner,
  type StepProposal,
} from './recording-runs.js';

const id = (n: number) => `0199f0a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const owner: RunOwner = {
  accountId: id(1),
  universeId: id(2),
  privacyEpoch: 4,
  recordId: id(3),
  recordingGeneration: 5,
};
const authority: PersonalAuthority = { universeId: id(2), privacyEpoch: 4, actor: { kind: 'system', purpose: 'test' } };
const proposal: StepProposal<{ ok: true }> = {
  run: { id: id(6), authority, ownerModule: 'scenarios', purpose: 'suggest', policyVersion: 'test.v1' },
  role: {
    id: 'test.role',
    version: 'v1',
    instructions: 'x',
    outputSchema: z.strictObject({ ok: z.literal(true) }),
    maxOutputTokens: 8,
  },
  context: { bundleRef: 'test:1', items: [] },
};
const failed: ProposeOutcome<{ ok: true }> = { kind: 'failed', attemptId: id(7), code: 'HTTP_500' };

/** A harness stand-in that records what it was asked; each test overrides what it needs. */
function harnessWith(over: Partial<RecordingReasoningHarness> = {}) {
  const calls = { proposePersonal: vi.fn(), withPersonalApply: vi.fn(), closePersonalRun: vi.fn() };
  const harness = {
    contextDigest: () => 'd'.repeat(64),
    currentOwner: () => Promise.resolve({ accountId: owner.accountId, generation: 5 }),
    proposePersonal: (input: unknown) => {
      calls.proposePersonal(input);
      return Promise.resolve(failed);
    },
    withPersonalApply: async (
      _authority: unknown,
      purpose: unknown,
      work: (scope: RecordingScopeTx) => Promise<unknown>,
    ) => {
      calls.withPersonalApply(purpose);
      return { kind: 'entered', value: await work({ personal: { tag: 'personal' } } as unknown as RecordingScopeTx) };
    },
    closePersonalRun: (...args: unknown[]) => {
      calls.closePersonalRun(...args);
      return Promise.resolve('closed');
    },
    ...over,
  } as unknown as RecordingReasoningHarness;
  return { harness, calls };
}
const scope = { authority } as unknown as PersonalScopeTx;

describe('the recording runs of a module’s personal steps (D-270)', () => {
  it('starts a run for the person the scope belongs to, at the generation recording is at now', async () => {
    const { harness } = harnessWith();
    expect(await startRunOwner(harness, scope, id(3))).toEqual(owner);
  });

  it('starts nothing while recording is paused or the owner is not active', async () => {
    const { harness } = harnessWith({ currentOwner: () => Promise.resolve(undefined) });
    expect(await startRunOwner(harness, scope, id(3))).toBeUndefined();
  });

  it('stamps the proof with the account, the generation, the record and the digest of what the model is sent, for both hashes', () => {
    expect(purposeOf('rooms', owner, 'inhabitant-contribution', id(6), 'd'.repeat(64))).toEqual({
      version: 'personal-role-purpose.v1',
      accountId: owner.accountId,
      universeId: owner.universeId,
      privacyEpoch: 4,
      ownerModule: 'rooms',
      purpose: 'inhabitant-contribution',
      businessRunId: id(6),
      recordingGeneration: 5,
      contextSha256: 'd'.repeat(64),
      modelContextSha256: 'd'.repeat(64),
      claimId: owner.recordId,
    });
  });

  it('proposes with the proof of the run’s own owner module and step, and hands the proof back', async () => {
    const { harness, calls } = harnessWith();
    const result = await proposeAtGeneration(harness, owner, proposal, new AbortController().signal);
    expect(result.outcome).toEqual(failed);
    expect(result.purpose).toMatchObject({ ownerModule: 'scenarios', purpose: 'suggest', recordingGeneration: 5 });
    expect(calls.proposePersonal).toHaveBeenCalledWith(expect.objectContaining({ recordingPurpose: result.purpose }));
  });

  it('refuses without a run and without a model call when there is no owner to run for', async () => {
    const { harness, calls } = harnessWith();
    const result = await proposeWhenRecording(harness, undefined, proposal, new AbortController().signal);
    expect(result).toEqual({ outcome: { kind: 'refused', reason: 'scope_refused' } });
    expect(calls.proposePersonal).not.toHaveBeenCalled();
    const started = await proposeWhenRecording(harness, owner, proposal, new AbortController().signal);
    expect(started.purpose).toBeDefined();
    expect(calls.proposePersonal).toHaveBeenCalledOnce();
  });

  it('closes only a run that was started and has a conclusive end', () => {
    const purpose = purposeOf('composer', owner, 'jev-assessment', id(6), 'd'.repeat(64));
    expect(runToClose(id(6), purpose, 'failed')).toEqual({ runId: id(6), purpose, end: 'failed' });
    expect(runToClose(id(6), purpose, undefined)).toBeUndefined();
    expect(runToClose(id(6), undefined, 'completed')).toBeUndefined();
  });

  it('closes a run in the transaction that applies its result, and not a run with no end', async () => {
    const { harness, calls } = harnessWith();
    const purpose = purposeOf('composer', owner, 'jev-assessment', id(6), 'd'.repeat(64));
    const rec = { personal: scope } as unknown as RecordingScopeTx;
    await closeStartedRun(harness, rec, { runId: id(6), purpose });
    expect(calls.closePersonalRun).not.toHaveBeenCalled();
    await closeStartedRun(harness, rec, { runId: id(6), purpose, end: 'completed' });
    expect(calls.closePersonalRun).toHaveBeenCalledWith(rec, {
      runId: id(6),
      state: 'completed',
      recordingPurpose: purpose,
    });
    await closeStartedRunAlone(harness, authority, { runId: id(6), purpose });
    expect(calls.withPersonalApply).not.toHaveBeenCalled();
    await closeStartedRunAlone(harness, authority, { runId: id(6), purpose, end: 'failed' });
    expect(calls.withPersonalApply).toHaveBeenCalledOnce();
  });

  it('applies a result and closes its run together, under the fence', async () => {
    const { harness, calls } = harnessWith();
    const purpose = purposeOf('scenarios', owner, 'suggest', id(6), 'd'.repeat(64));
    const apply = vi.fn((_scope: PersonalScopeTx) => Promise.resolve('stored'));
    const result = await applyClosingRun(harness, authority, { runId: id(6), purpose, end: 'completed' }, apply);
    expect(result).toEqual({ kind: 'applied', value: 'stored' });
    expect(calls.closePersonalRun).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
    // The close comes first, so the owner's check still finds the record waiting.
    expect(calls.closePersonalRun.mock.invocationCallOrder[0]).toBeLessThan(apply.mock.invocationCallOrder[0]!);
  });

  it('applies nothing and reports it dropped when the fence refuses', async () => {
    const { harness, calls } = harnessWith({
      withPersonalApply: () => Promise.resolve({ kind: 'refused', refusal: { kind: 'scope_refused' } }),
    });
    const purpose = purposeOf('scenarios', owner, 'suggest', id(6), 'd'.repeat(64));
    const apply = vi.fn(() => Promise.resolve('stored'));
    expect(await applyClosingRun(harness, authority, { runId: id(6), purpose, end: 'completed' }, apply)).toEqual({
      kind: 'dropped',
    });
    expect(apply).not.toHaveBeenCalled();
    expect(calls.closePersonalRun).not.toHaveBeenCalled();
  });
});
