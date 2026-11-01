import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import {
  makePersonalRecordingReasoningHarness,
  parsePersonalRecordingPurpose,
  parsePersonalRunAccountingBinding,
  recordingOwnerDispatcher,
  type PersonalRecordingPurpose,
} from './personal-recording.js';
import type { HarnessPorts, PersonalHarnessAccess, GuardedModelPort } from './ports.js';
import type { RecordingScopeTx } from '../../modules/identity/public.js';

// Pure protocol fixtures. No real owner proof/capability/provider or pipeline acceptance.
const id = (n: number) => `0199f0a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const context = {
  bundleRef: 'fixture.bundle:1',
  items: [{ ref: 'fixture:item', kind: 'evidence', text: 'private-fixture' }],
};
const purpose: PersonalRecordingPurpose = {
  version: 'personal-role-purpose.v1',
  accountId: id(1),
  universeId: id(2),
  privacyEpoch: 1,
  ownerModule: 'planner',
  purpose: 'personal-planner',
  businessRunId: id(3),
  recordingGeneration: 3,
  contextSha256: 'a'.repeat(64),
  modelContextSha256: canonicalSha256(context),
  claimId: id(4),
};
const input = () => ({
  recordingPurpose: { ...purpose },
  run: {
    id: id(3),
    authority: { universeId: id(2), privacyEpoch: 1, actor: { kind: 'system' as const, purpose: 'fixture.reasoning' } },
    ownerModule: 'planner',
    purpose: 'personal-planner',
    policyVersion: 'fixture.v1',
  },
  role: {
    id: 'fixture.echo',
    version: 'v1',
    instructions: 'Return the authored fixture object.',
    outputSchema: z.strictObject({ ok: z.literal(true) }),
    maxOutputTokens: 16,
  },
  context: { bundleRef: context.bundleRef, items: context.items.map((x) => ({ ...x })) },
});
function denied() {
  const read = vi.fn(() => Promise.resolve(undefined));
  const enter = vi.fn(() => Promise.resolve({ kind: 'refused' as const, refusal: { kind: 'scope_refused' } }));
  const quota = vi.fn(),
    send = vi.fn();
  const model = {
    provider: 'fixture',
    model: 'fixture',
    encode: () => new TextEncoder().encode('{"fixture":true}'),
    observeQuota: quota,
    send,
  } as unknown as GuardedModelPort;
  const access: PersonalHarnessAccess = {
    enter,
    check: vi.fn(),
    checkAttempt: vi.fn(),
    readProtected: read,
    apply: () => Promise.resolve({ kind: 'refused' as const, refusal: { kind: 'scope_refused' } }),
    close: vi.fn(),
    closeLegacy: vi.fn(),
    readAccounting: vi.fn(),
  };
  const ports = {
    personalAccess: access,
    model,
    ledger: { find: read, findLocked: read, purgeExpiredRequests: () => Promise.resolve(0) },
    withPersonalScope: vi.fn(),
    authorityHolds: vi.fn(),
    hashBytes: () => 'b'.repeat(64),
    redactRecorded: (x: Readonly<Record<string, unknown>>) => x,
    newId: () => id(5),
    now: () => 1,
    logEvent: vi.fn(),
    settings: {
      caps: { global: {}, scope: {}, roleDefault: {} },
      maxRequestBytes: 10000,
      requestRetentionSeconds: 60,
      purgeIntervalMs: 60000,
      dispatchedBy: 'ci-protocol-fixture',
    },
  } as unknown as HarnessPorts;
  const checkPlanner = vi.fn(() => Promise.resolve('unavailable' as const)),
    checkGeography = vi.fn(() => Promise.resolve('unavailable' as const)),
    checkSupply = vi.fn(() => Promise.resolve('unavailable' as const));
  const harness = makePersonalRecordingReasoningHarness({
    engine: ports,
    checkPlanner,
    checkGeography,
    checkSupply,
    hashContext: canonicalSha256,
  });
  return { harness, enter, read, model, quota, send, ports, checkPlanner, checkGeography, checkSupply };
}

describe('personal recording facade strict protocol (authored source fixtures only)', () => {
  it('requires an exact closed owner/purpose pair and every original proof field', () => {
    expect(parsePersonalRecordingPurpose(purpose)).toEqual(purpose);
    expect(Object.isFrozen(parsePersonalRecordingPurpose(purpose))).toBe(true);
    for (const key of Object.keys(purpose)) {
      expect(parsePersonalRecordingPurpose({ ...purpose, [key]: undefined })).toBeUndefined();
      const missing = { ...purpose } as Record<string, unknown>;
      delete missing[key];
      expect(parsePersonalRecordingPurpose(missing)).toBeUndefined();
    }
    for (const recordingGeneration of [0, 2, 4, -1, 1.5, '3', null, 2147483648])
      expect(parsePersonalRecordingPurpose({ ...purpose, recordingGeneration })).toBeUndefined();
    expect(parsePersonalRecordingPurpose({ ...purpose, purpose: 'personal-cartographer' })).toBeUndefined();
    expect(parsePersonalRecordingPurpose({ ...purpose, ownerModule: 'content' })).toBeUndefined();
    expect(parsePersonalRecordingPurpose({ ...purpose, contextSha256: 'A'.repeat(64) })).toBeUndefined();
    expect(parsePersonalRecordingPurpose({ ...purpose, claimId: 'not-a-claim' })).toBeUndefined();
    expect(parsePersonalRecordingPurpose({ ...purpose, extra: true })).toBeUndefined();
  });
  it('refuses getters, hidden properties, symbols and inherited data without invoking getters', () => {
    const getter = vi.fn(() => 3),
      value = { ...purpose };
    Object.defineProperty(value, 'recordingGeneration', { get: getter, enumerable: true });
    expect(parsePersonalRecordingPurpose(value)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
    const hidden = { ...purpose };
    Object.defineProperty(hidden, 'privateExtra', { value: 'secret', enumerable: false });
    expect(parsePersonalRecordingPurpose(hidden)).toBeUndefined();
    expect(parsePersonalRecordingPurpose({ ...purpose, [Symbol('private')]: true })).toBeUndefined();
    expect(parsePersonalRecordingPurpose(Object.create(purpose))).toBeUndefined();
  });
  it('requires closed complete accounting provenance, including explicit legacy NULL without adopting it', () => {
    const binding = {
      ownerModule: 'planner',
      purpose: 'personal-planner',
      accountId: id(1),
      privacyEpoch: 1,
      recordingGeneration: 3,
    };
    expect(parsePersonalRunAccountingBinding(binding)).toEqual(binding);
    expect(parsePersonalRunAccountingBinding({ ...binding, recordingGeneration: null })).toEqual({
      ...binding,
      recordingGeneration: null,
    });
    for (const key of Object.keys(binding)) {
      const missing = { ...binding } as Record<string, unknown>;
      delete missing[key];
      expect(parsePersonalRunAccountingBinding(missing)).toBeUndefined();
      expect(parsePersonalRunAccountingBinding({ ...binding, [key]: undefined })).toBeUndefined();
    }
    expect(parsePersonalRunAccountingBinding({ ...binding, purpose: 'personal-cartographer' })).toBeUndefined();
    expect(parsePersonalRunAccountingBinding({ ...binding, recordingGeneration: 2 })).toBeUndefined();
    const getter = vi.fn(() => 3),
      bad = { ...binding };
    Object.defineProperty(bad, 'recordingGeneration', { get: getter, enumerable: true });
    expect(parsePersonalRunAccountingBinding(bad)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
    const hidden = { ...binding };
    Object.defineProperty(hidden, 'hidden', { value: true });
    expect(parsePersonalRunAccountingBinding(hidden)).toBeUndefined();
    expect(parsePersonalRunAccountingBinding({ ...binding, [Symbol('extra')]: true })).toBeUndefined();
  });
  it('requires every real owner port at construction and selects only its exact closed pair', async () => {
    expect(() =>
      recordingOwnerDispatcher({ checkPlanner: undefined, checkGeography: undefined, checkSupply: undefined } as never),
    ).toThrow('PERSONAL_RECORDING_OWNERS_REQUIRED');
    const planner = vi.fn(() => Promise.resolve('unavailable' as const)),
      geography = vi.fn(() => Promise.resolve('unavailable' as const)),
      supply = vi.fn(() => Promise.resolve('unavailable' as const));
    expect(() => recordingOwnerDispatcher({ checkPlanner: planner, checkGeography: geography } as never)).toThrow(
      'PERSONAL_RECORDING_OWNERS_REQUIRED',
    );
    const dispatch = recordingOwnerDispatcher({
      checkPlanner: planner,
      checkGeography: geography,
      checkSupply: supply,
    });
    // This object tests dispatch selection only; the real adapter validates capability provenance first.
    const scope = {} as RecordingScopeTx;
    expect(await dispatch(scope, purpose)).toBe('unavailable');
    expect(planner).toHaveBeenCalledOnce();
    expect(geography).not.toHaveBeenCalled();
    expect(await dispatch(scope, { ...purpose, ownerModule: 'geography', purpose: 'personal-cartographer' })).toBe(
      'unavailable',
    );
    expect(geography).toHaveBeenCalledOnce();
    expect(supply).not.toHaveBeenCalled();
    expect(await dispatch(scope, { ...purpose, ownerModule: 'supply', purpose: 'ask-scope' })).toBe('unavailable');
    expect(supply).toHaveBeenCalledOnce();
    // A pair that is not one of the closed set reaches no owner at all.
    expect(await dispatch(scope, { ...purpose, purpose: 'personal-cartographer' })).toBe('unavailable');
    expect(await dispatch(scope, { ...purpose, ownerModule: 'planner', purpose: 'ask-scope' })).toBe('unavailable');
    expect(planner).toHaveBeenCalledOnce();
    expect(geography).toHaveBeenCalledOnce();
    expect(supply).toHaveBeenCalledOnce();
  });
  it('accepts a Supply step for Supply only, at an odd generation, and nothing else of its', () => {
    for (const supplyPurpose of ['ask-scope', 'step-two'])
      expect(parsePersonalRecordingPurpose({ ...purpose, ownerModule: 'supply', purpose: supplyPurpose })).toEqual({
        ...purpose,
        ownerModule: 'supply',
        purpose: supplyPurpose,
      });
    // The engine only checks that a Supply step is named by a code; the schema and Supply's owner hold the list.
    expect(parsePersonalRecordingPurpose({ ...purpose, ownerModule: 'supply', purpose: 'Ask Scope' })).toBeUndefined();
    expect(parsePersonalRecordingPurpose({ ...purpose, ownerModule: 'supply', purpose: '' })).toBeUndefined();
    expect(
      parsePersonalRecordingPurpose({ ...purpose, ownerModule: 'geography', purpose: 'ask-scope' }),
    ).toBeUndefined();
    expect(parsePersonalRecordingPurpose({ ...purpose, ownerModule: 'planner', purpose: 'ask-scope' })).toBeUndefined();
    expect(
      parsePersonalRecordingPurpose({
        ...purpose,
        ownerModule: 'supply',
        purpose: 'ask-scope',
        recordingGeneration: 4,
      }),
    ).toBeUndefined();
  });
  it('lets a role set its effort, and refuses one that is not a known effort, before any scope work', async () => {
    const accepted = denied();
    const low = { ...input(), role: { ...input().role, effort: 'low' as const } };
    expect(await accepted.harness.proposePersonal(low, new AbortController().signal)).toEqual({
      kind: 'refused',
      reason: 'scope_refused',
    });
    expect(accepted.enter).toHaveBeenCalledOnce();
    const unknown = denied();
    const frantic = { ...input(), role: { ...input().role, effort: 'frantic' } } as never;
    expect(await unknown.harness.proposePersonal(frantic, new AbortController().signal)).toEqual({
      kind: 'refused',
      reason: 'run_invalid',
    });
    expect(unknown.enter).not.toHaveBeenCalled();
  });
  it('rejects changed same-ref model text and forged purpose before any private scope/query', async () => {
    const c = denied(),
      changed = input();
    changed.context.items[0]!.text = 'different-private-input';
    expect(await c.harness.proposePersonal(changed, new AbortController().signal)).toEqual({
      kind: 'refused',
      reason: 'run_mismatch',
    });
    const original = input();
    const mismatched = {
      ...original,
      recordingPurpose: { ...original.recordingPurpose, accountId: id(9) },
      run: {
        ...original.run,
        authority: { ...original.run.authority, actor: { kind: 'account' as const, accountId: id(1) } },
      },
    };
    expect(await c.harness.proposePersonal(mismatched, new AbortController().signal)).toEqual({
      kind: 'refused',
      reason: 'run_mismatch',
    });
    expect(c.enter).not.toHaveBeenCalled();
    expect(c.read).not.toHaveBeenCalled();
  });
  it('refuses an accessor context before hashes, admission or provider work', async () => {
    const c = denied(),
      value = input(),
      getter = vi.fn(() => 'private');
    Object.defineProperty(value.context.items[0]!, 'text', { get: getter, enumerable: true });
    expect(await c.harness.proposePersonal(value, new AbortController().signal)).toEqual({
      kind: 'refused',
      reason: 'run_invalid',
    });
    expect(getter).not.toHaveBeenCalled();
    expect(c.enter).not.toHaveBeenCalled();
    expect(c.read).not.toHaveBeenCalled();
  });
  it('carries a role’s budget class to the engine and refuses an unknown class before any scope work', async () => {
    const accepted = denied();
    const background = { ...input(), role: { ...input().role, budgetClass: 'background' as const } };
    expect(await accepted.harness.proposePersonal(background, new AbortController().signal)).toEqual({
      kind: 'refused',
      reason: 'scope_refused',
    });
    expect(accepted.enter).toHaveBeenCalledOnce();
    const unknown = denied();
    const urgent = { ...input(), role: { ...input().role, budgetClass: 'urgent' } } as never;
    expect(await unknown.harness.proposePersonal(urgent, new AbortController().signal)).toEqual({
      kind: 'refused',
      reason: 'run_invalid',
    });
    expect(unknown.enter).not.toHaveBeenCalled();
  });
  it('fresh denied scope never reaches the engine private find, protected bytes, quota or send', async () => {
    const c = denied();
    expect(await c.harness.proposePersonal(input(), new AbortController().signal)).toEqual({
      kind: 'refused',
      reason: 'scope_refused',
    });
    expect(c.enter).toHaveBeenCalledOnce();
    expect(c.read).not.toHaveBeenCalled();
    expect(c.quota).not.toHaveBeenCalled();
    expect(c.send).not.toHaveBeenCalled();
  });
});
